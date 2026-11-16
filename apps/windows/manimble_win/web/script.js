/* Scripted presentations: steps (speak, pointer move, pause) attached to a build of a slide, played in order when a
   scripted show reaches that build. They live in script.json beside the deck (the macOS app's format), not in the
   Python, so writing a script never re-renders a slide.

   Speech is the system's text-to-speech through the Web Speech API. */
"use strict";

const SC = { data: { version: 1, steps: [] }, open: false, sel: null, capture: null, run: null, saveTimer: null, key: "", voices: [] };
const SPEEDS = [["Slow", 0.25], ["Medium", 0.5], ["Fast", 1.0], ["Very fast", 2.0]];
const MAC_RATE = 0.5;                       // AVSpeechUtteranceDefaultSpeechRate: the file's `rate` is on that scale
const sleep_ = ms => new Promise(r => setTimeout(r, ms));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).toUpperCase();

// ------------------------------------------------------------------ store
async function scriptLoad() {
  let d = null;
  try { d = (await rpc("app.script_get", {}, true)).script; } catch (e) { /* no deck */ }
  SC.data = d && Array.isArray(d.steps) ? d : { version: 1, steps: [] };
  SC.sel = null; SC.key = "";
  if (SC.open) renderScript();
}
function scriptSave() {
  clearTimeout(SC.saveTimer);
  SC.saveTimer = setTimeout(() => rpc("app.script_set", { script: SC.data }, true).then(() => pollStatus()).catch(e => toast("The script was not saved: " + e.message, true)), 250);
}
const stepsOf = (scene, build) => SC.data.steps.filter(s => s.scene === scene && (s.build || 0) === build);
const hold = () => (typeof SC.data.hold === "number" ? SC.data.hold : 3);
const speechRate = () => clamp((typeof SC.data.rate === "number" ? SC.data.rate : MAC_RATE) / MAC_RATE, 0.4, 2.5);

function addStep(kind) {
  const scene = S.name, build = S.stop;
  const s = { id: uuid(), scene, build, kind, text: "", seconds: 1, path: [], speed: 0.5, noise: 0 };
  if (kind === "move") { const last = stepsOf(scene, build).filter(x => x.kind === "move").pop(); if (last) { s.speed = last.speed; s.noise = last.noise; } }
  const all = SC.data.steps;
  let at = -1; all.forEach((x, i) => { if (x.scene === scene && (x.build || 0) === build) at = i; });
  if (at >= 0) all.splice(at + 1, 0, s); else all.push(s);
  SC.sel = s.id; scriptSave(); renderScript(true);
  if (kind === "move") startCapture(s.id);
  else { const f = $(`#scriptpane [data-id="${s.id}"] textarea, #scriptpane [data-id="${s.id}"] input`); if (f) f.focus(); }
}
function removeStep(id) { SC.data.steps = SC.data.steps.filter(s => s.id !== id); if (SC.sel === id) SC.sel = null; scriptSave(); renderScript(true); drawScriptLayer(); }
function shiftStep(id, d) {
  const s = SC.data.steps.find(x => x.id === id); if (!s) return;
  const ids = stepsOf(s.scene, s.build || 0).map(x => x.id), k = ids.indexOf(id);
  if (k + d < 0 || k + d >= ids.length) return;
  const all = SC.data.steps, a = all.findIndex(x => x.id === id), b = all.findIndex(x => x.id === ids[k + d]);
  [all[a], all[b]] = [all[b], all[a]];
  scriptSave(); renderScript(true);
}
/** Where the pointer is before a step runs: the end of the last move before it in its build. */
function pointerBefore(id) {
  const s = SC.data.steps.find(x => x.id === id); if (!s) return null;
  let p = null;
  for (const t of stepsOf(s.scene, s.build || 0)) { if (t.id === id) break; if (t.kind === "move" && t.path.length) p = t.path[t.path.length - 1]; }
  return p;
}

// ------------------------------------------------------------------ voices
function loadVoices() {
  if (!window.speechSynthesis) return;
  SC.voices = speechSynthesis.getVoices();
  if (SC.open) renderScript(true);
}
if (window.speechSynthesis) { speechSynthesis.addEventListener("voiceschanged", loadVoices); loadVoices(); }
const cloudVoice = () => (/^cloud:(elevenlabs|openai):/.test(SC.data.voice || "") ? SC.data.voice : null);
async function loadServices() {
  try { SC.services = (await rpc("app.voice_services", {}, true)).services; } catch (e) { SC.services = SC.services || []; }
}
function serviceOf(id) { const m = /^cloud:([a-z]+):/.exec(id || ""); return m && (SC.services || []).find(x => x.id === m[1]); }
/** Connect, replace the key of, or disconnect an online voice service. The key goes to Windows Credential Manager. */
async function connectService(svc) {
  const r = await dialogBox(close => {
    const key = el("input", { type: "password", placeholder: svc.connected ? "Paste a new key to replace it" : "API key", autocomplete: "off" });
    const link = el("button", { className: "link", textContent: `Get a key at ${new URL(svc.keyPage).host}…`, onclick: () => rpc("app.open_url", { url: svc.keyPage }).catch(() => {}) });
    const ok = el("button", { className: "primary", textContent: "Connect" }), cancel = el("button", { textContent: "Cancel" });
    const row = el("div", { className: "row" }, el("span", { className: "spacer" }));
    if (svc.connected) row.append(el("button", { textContent: "Disconnect", onclick: () => close({ disconnect: true }) }));
    row.append(cancel, ok);
    ok.onclick = () => close(key.value.trim() ? { key: key.value.trim() } : null);
    cancel.onclick = () => close(null);
    key.addEventListener("keydown", ev => { if (ev.key === "Enter") ok.click(); });
    return [el("div", { className: "msg", textContent: svc.connected ? `${svc.name} is connected` : `Connect ${svc.name}` }),
      el("div", { className: "detail", textContent: `Paste an API key from your ${svc.name} account. It is kept in Windows Credential Manager, never in the deck, and the words of the script are sent to ${svc.name} to be spoken (billed to that account). Speech is cached, so a show replays without calling it again.` }),
      key, link, row];
  });
  if (!r) return;
  status(r.disconnect ? "" : `Checking the key with ${svc.name}…`);
  try {
    const out = await rpc(r.disconnect ? "app.voice_disconnect" : "app.voice_connect", { service: svc.id, key: r.key });
    SC.services = out.services;
    toast(r.disconnect ? `${svc.name} disconnected` : `${svc.name} connected`);
  } catch (e) { toast(`${svc.name} did not accept the key: ${e.message}`, true); }
  status("");
  renderScript(true);
}
let cloudWarned = false;
/** Play an online voice's words; resolves when they are over. False when they could not be had. */
async function speakCloud(run, id, text) {
  let path;
  try { path = (await rpc("app.speech", { voice: id, text, rate: typeof SC.data.rate === "number" ? SC.data.rate : MAC_RATE }, true)).path; }
  catch (e) {
    if (!cloudWarned) { cloudWarned = true; toast(`The online voice could not be used (${e.message}); a system voice reads the script instead.`, true); }
    return false;
  }
  if (run.cancelled) return true;
  const a = new Audio(fileUrl(path));
  return new Promise(resolve => {
    let done = false;
    const finish = ok => { if (!done) { done = true; clearInterval(watch); a.pause(); resolve(ok); } };
    a.onended = () => finish(true);
    a.onerror = () => finish(false);
    const watch = setInterval(() => {
      if (run.cancelled) return finish(true);
      if (run.paused && !a.paused) a.pause(); else if (!run.paused && a.paused && !a.ended) a.play().catch(() => {});
    }, 100);
    a.play().catch(() => finish(false));
  });
}
function chosenVoice() {
  const want = SC.data.winVoice;
  return SC.voices.find(v => v.name === want) || SC.voices.find(v => v.default) || SC.voices[0] || null;
}

// ------------------------------------------------------------------ running steps
/** A stage is where the pointer is drawn: {layer, size() -> [w, h] in the layer's pixels, pos: [x, y] fractions}. */
function makeStage(layer, size) {
  const svg = '<svg viewBox="0 0 24 36" xmlns="http://www.w3.org/2000/svg"><path d="M2 2 L2 28 L8.5 22 L13 33 L17.5 31 L13 20.5 L22 20.5 Z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  let arrow = $(".scriptpointer", layer);
  if (!arrow) { arrow = el("div", { className: "scriptpointer", innerHTML: svg }); layer.append(arrow); }
  const st = { layer, size, pos: null, arrow,
    place(p) {
      st.pos = p;
      const [w, h] = size(), k = h * 0.055;
      Object.assign(arrow.style, { display: p ? "block" : "none", height: k + "px", width: k * 24 / 36 + "px" });
      if (p) arrow.style.transform = `translate(${p[0] * w - k * 2 / 36}px, ${p[1] * h - k * 2 / 36}px)`;
    } };
  return st;
}
const newRun = () => ({ cancelled: false, paused: false });
function stopRun() {
  if (SC.run) SC.run.cancelled = true;
  SC.run = null;
  if (window.speechSynthesis) speechSynthesis.cancel();
}
async function waitRun(run, ms) {             // a wait that pauses with the run and ends when it is cancelled
  let left = ms, t = performance.now();
  while (left > 0 && !run.cancelled) {
    await sleep_(Math.min(40, left));
    const n = performance.now();
    if (!run.paused) left -= n - t;
    t = n;
  }
}
async function speak(run, text) {
  text = (text || "").trim();
  if (!text) return;
  const cloud = cloudVoice();
  if (cloud && await speakCloud(run, cloud, text)) return;
  return speakSystem(run, text);
}
function speakSystem(run, text) {
  const words = text.split(/\s+/).length, guess = words / (2.6 * speechRate()) * 1000;
  if (!window.speechSynthesis || !SC.voices.length) return waitRun(run, guess + 400);       // no voice: keep the timing
  // short utterances: some voices stop being reported as finished on long ones
  const parts = text.match(/[^.!?\n]+[.!?]*\s*|\n+/g).map(s => s.trim()).filter(Boolean);
  return new Promise(resolve => {
    let i = 0, done = false, spoke = 0;
    const finish = () => { if (!done) { done = true; clearInterval(watch); resolve(); } };
    const next = () => {
      if (run.cancelled || i >= parts.length) return finish();
      const u = new SpeechSynthesisUtterance(parts[i++]);
      const v = chosenVoice(); if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = speechRate();
      u.onend = next; u.onerror = next;
      spoke = performance.now();
      speechSynthesis.speak(u);
    };
    const watch = setInterval(() => {
      if (run.cancelled) { speechSynthesis.cancel(); return finish(); }
      if (run.paused) { spoke = performance.now(); return; }
      if (!speechSynthesis.speaking && !speechSynthesis.pending && performance.now() - spoke > 1500) next();   // an end that was never reported
    }, 200);
    next();
  });
}
function hashPhases(seed) {                  // the same wobble every time a move plays (FNV-1a over the step's id)
  let h = 1469598103934665603n;
  for (const c of new TextEncoder().encode(seed)) h = ((h ^ BigInt(c)) * 1099511628211n) & 0xFFFFFFFFFFFFFFFFn;
  return [0, 1, 2, 3].map(k => Number((h >> BigInt(k * 16)) & 0xFFFFn) / 65535 * 2 * Math.PI);
}
async function movePointer(run, stage, step) {
  const target = (step.path || []).filter(p => p.length >= 2);
  if (!target.length) return;
  const [w, h] = stage.size(), aspect = w ? h / w : 9 / 16;
  const pts = [stage.pos || [0.5, 0.5], ...target], acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], (pts[i][1] - pts[i - 1][1]) * aspect));
  const total = acc[acc.length - 1], dur = Math.max(0.15, total / Math.max(0.05, step.speed || 0.5));
  const ph = hashPhases(step.id), noise = step.noise || 0;
  stage.place(pts[0]);
  let t = 0, last = performance.now();
  while (t < dur && !run.cancelled) {
    await new Promise(r => { let done = false; const f = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(f); setTimeout(f, 60); });   // a hidden window gets no frames
    const now = performance.now();
    if (!run.paused) t += (now - last) / 1000;
    last = now;
    const u = Math.min(1, t / dur), d = (1 - Math.cos(Math.PI * u)) / 2 * total;        // ease in and out
    let k = 1; while (k < acc.length - 1 && acc[k] < d) k++;
    const seg = acc[k] - acc[k - 1] || 1, f = clamp((d - acc[k - 1]) / seg, 0, 1);
    let x = pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * f, y = pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * f;
    if (noise > 0) {
      const amp = noise * 0.012 * Math.sin(Math.PI * u), tau = 2 * Math.PI;
      x += amp * (0.6 * Math.sin(tau * 1.3 * t + ph[0]) + 0.4 * Math.sin(tau * 3.1 * t + ph[1]));
      y += amp / aspect * (0.6 * Math.sin(tau * 1.7 * t + ph[2]) + 0.4 * Math.sin(tau * 2.6 * t + ph[3]));
    }
    stage.place([x, y]);
  }
  if (!run.cancelled) stage.place(target[target.length - 1]);
}
async function runSteps(run, stage, steps) {
  for (const s of steps) {
    if (run.cancelled) return;
    markRunning(s.id);
    if (s.kind === "speak") await speak(run, s.text);
    else if (s.kind === "move") await movePointer(run, stage, s);
    else if (s.kind === "pause") await waitRun(run, Math.max(0, +s.seconds || 0) * 1000);
  }
  markRunning(null);
}
function markRunning(id) { $$("#scriptpane .step").forEach(e => e.classList.toggle("running", e.dataset.id === id)); }

// ------------------------------------------------------------------ the editor's slide
function editorStage() {
  let layer = $("#scriptlayer");
  if (!layer) { layer = el("div", { id: "scriptlayer" }); frameEl.append(layer); }
  return makeStage(layer, () => size());
}
function drawScriptLayer() {
  const layer = $("#scriptlayer") || editorStage().layer;
  $$("svg.track", layer).forEach(e => e.remove());
  const s = SC.open && SC.data.steps.find(x => x.id === SC.sel);
  if (!SC.open || (SC.run == null)) { const a = $(".scriptpointer", layer); if (a && !SC.run) a.style.display = "none"; }
  if (!s || s.kind !== "move" || s.scene !== S.name || (s.build || 0) !== S.stop) return;
  const [w, h] = size(), from = pointerBefore(s.id) || [0.5, 0.5], pts = [from, ...s.path];
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "track"); svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const line = document.createElementNS(ns, "polyline");
  line.setAttribute("points", pts.map(p => `${p[0] * w},${p[1] * h}`).join(" "));
  svg.append(line);
  if (s.path.length) {
    const e = s.path[s.path.length - 1], dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", e[0] * w); dot.setAttribute("cy", e[1] * h); dot.setAttribute("r", 7 / scale);
    svg.append(dot);
  }
  svg.style.strokeWidth = 2.5 / scale + "px";
  layer.append(svg);
}
async function playSteps(steps, from) {
  stopRun();
  const run = SC.run = newRun(), stage = editorStage();
  stage.place(from || null);
  await runSteps(run, stage, steps);
  if (SC.run === run) { SC.run = null; await sleep_(600); if (!SC.run) { stage.place(null); drawScriptLayer(); } }
}

// "Set on Slide": a click sets the point the pointer goes to, a drag traces the path it follows
function startCapture(id) {
  SC.capture = { id, pts: null }; SC.sel = id;
  frameEl.classList.add("capture");
  status("Click the point the pointer should go to, or drag to trace its path. Esc cancels.");
  renderScript(true); drawScriptLayer();
}
function endCapture() { SC.capture = null; frameEl.classList.remove("capture"); status(""); renderScript(true); drawScriptLayer(); }
frameEl.addEventListener("mousedown", ev => {
  if (!SC.capture || ev.button !== 0) return;
  ev.stopImmediatePropagation(); ev.preventDefault();
  SC.capture.pts = [pt(ev)];
}, true);
window.addEventListener("mousemove", ev => {
  const c = SC.capture; if (!c || !c.pts) return;
  const p = pt(ev), q = c.pts[c.pts.length - 1];
  if (Math.hypot(p[0] - q[0], p[1] - q[1]) * scale >= 5) {
    c.pts.push(p);
    const s = SC.data.steps.find(x => x.id === c.id), [w, h] = size();
    if (s) { s.path = c.pts.map(a => [a[0] / w, a[1] / h]); drawScriptLayer(); }
  }
}, true);
window.addEventListener("mouseup", () => {
  const c = SC.capture; if (!c || !c.pts) return;
  const s = SC.data.steps.find(x => x.id === c.id), [w, h] = size();
  if (s) {
    let pts = c.pts;
    if (pts.length > 160) { const k = Math.ceil(pts.length / 160); pts = pts.filter((_, i) => i % k === 0 || i === pts.length - 1); }
    s.path = pts.map(a => [Math.round(clamp(a[0] / w, 0, 1) * 1e4) / 1e4, Math.round(clamp(a[1] / h, 0, 1) * 1e4) / 1e4]);
    scriptSave();
  }
  endCapture();
}, true);

// ------------------------------------------------------------------ the Script panel
async function ensureScript() {
  const deck = S.info && S.info.deck && S.info.deck.work;
  if (deck && SC.loadedFor !== deck) { await scriptLoad(); SC.loadedFor = deck; }
  if (!SC.services) await loadServices();
}
async function toggleScript(on) {
  const want = on == null ? !SC.open : !!on;
  if (want) await ensureScript();
  SC.open = want;
  $("#side").classList.toggle("script", SC.open);
  $("#btn-script").classList.toggle("on", SC.open);
  if (!SC.open) { stopRun(); if (SC.capture) endCapture(); }
  else S.sel.clear();
  SC.key = "";
  renderScript(); drawScriptLayer(); if (!SC.open) renderInspector();
}
function renderScript(force) {
  const box = $("#scriptpane");
  if (!SC.open || !S.scene) return;
  const steps = stepsOf(S.name, S.stop);
  const key = [S.name, S.stop, SC.sel, SC.capture && SC.capture.id, SC.voices.length, ...steps.map(s => s.id + s.kind)].join("|");
  if (!force && key === SC.key) return;
  SC.key = key;
  const n = S.scene.stops.length;
  const kids = [el("div", { className: "shead" }, el("h3", { textContent: `Script · ${S.name}` + (n > 1 ? ` · build ${S.stop + 1} of ${n}` : "") }),
    el("span", { className: "spacer" }), btn("Play Build", () => playSteps(stepsOf(S.name, S.stop))), btn("Done", () => toggleScript(false)))];
  if (!steps.length) kids.push(el("div", { className: "loc", textContent: "No steps on this build yet. Add words to say, a pointer movement or a pause; they run in order when a scripted presentation reaches this build." }));
  steps.forEach((s, i) => {
    const row = el("div", { className: "step" + (s.id === SC.sel ? " sel" : "") }); row.dataset.id = s.id;
    const head = el("div", { className: "sh" }, el("b", { textContent: `${i + 1}. ` + ({ speak: "Speak", move: "Mouse", pause: "Pause" })[s.kind] }), el("span", { className: "spacer" }));
    const mini = (t, title, fn) => { const b = btn(t, ev => { ev.stopPropagation(); fn(); }); b.title = title; b.className = "mini"; return b; };
    head.append(mini("▶", "Play this step on the slide", () => { SC.sel = s.id; renderScript(); playSteps([s], pointerBefore(s.id)); }),
      mini("▲", "Earlier", () => shiftStep(s.id, -1)), mini("▼", "Later", () => shiftStep(s.id, 1)), mini("✕", "Remove", () => removeStep(s.id)));
    row.append(head);
    if (s.kind === "speak") {
      const ta = el("textarea", { rows: Math.min(8, Math.max(2, (s.text || "").split("\n").length + 1)), value: s.text || "", placeholder: "Words to say" });
      ta.oninput = () => { s.text = ta.value; scriptSave(); };
      row.append(ta);
    } else if (s.kind === "pause") {
      const inp = el("input", { type: "number", min: 0, step: 0.5, value: s.seconds ?? 1 });
      inp.oninput = () => { s.seconds = Math.max(0, +inp.value || 0); scriptSave(); };
      row.append(el("div", { className: "f" }, inp, el("span", { className: "loc", textContent: "seconds" })));
    } else {
      const capturing = SC.capture && SC.capture.id === s.id;
      const set = btn(capturing ? "Click or drag on the slide…" : s.path.length ? "Set on Slide Again" : "Set on Slide", () => capturing ? endCapture() : startCapture(s.id));
      set.classList.toggle("on", !!capturing);
      const sp = el("select", {}, ...SPEEDS.map(([n2, v]) => el("option", { textContent: n2, value: v, selected: Math.abs((s.speed || 0.5) - v) < 1e-6 })));
      sp.onchange = () => { s.speed = +sp.value; scriptSave(); };
      const wob = el("input", { type: "range", min: 0, max: 1, step: 0.05, value: s.noise || 0, title: "Wobble" });
      wob.oninput = () => { s.noise = +wob.value; scriptSave(); };
      row.append(el("div", { className: "f" }, set, el("span", { className: "loc", textContent: !s.path.length ? "no point yet" : s.path.length === 1 ? "one point" : "a traced path" })),
        el("div", { className: "f" }, el("label", { textContent: "Speed" }), sp, el("label", { textContent: "Wobble" }), wob));
    }
    row.onmousedown = () => { if (SC.sel !== s.id) { SC.sel = s.id; $$("#scriptpane .step").forEach(e => e.classList.toggle("sel", e === row)); drawScriptLayer(); } };
    kids.push(row);
  });
  kids.push(el("div", { className: "f adds" }, el("label", { textContent: "Add" }), btn("Speak", () => addStep("speak")), btn("Mouse", () => addStep("move")), btn("Pause", () => addStep("pause"))));

  const cloud = cloudVoice();
  const voice = el("select", { style: "flex:1;min-width:0" });
  const sys = el("optgroup", { label: "On this computer" }, ...SC.voices.map(v => el("option", { textContent: `${v.name} (${v.lang})`, value: "sys:" + v.name, selected: !cloud && chosenVoice() === v })));
  if (!SC.voices.length) sys.append(el("option", { textContent: "No text-to-speech voices found", disabled: true }));
  voice.append(sys);
  for (const svc of SC.services || []) {
    const g = el("optgroup", { label: `${svc.name} (online${svc.connected ? "" : ", not connected"})` });
    const ids = svc.voices.map(v => `cloud:${svc.id}:${v.id}`);
    for (const v of svc.voices) g.append(el("option", { textContent: `✨ ${v.name}`, value: `cloud:${svc.id}:${v.id}`, selected: cloud === `cloud:${svc.id}:${v.id}` }));
    if (cloud && cloud.startsWith(`cloud:${svc.id}:`) && !ids.includes(cloud)) g.append(el("option", { textContent: `✨ ${cloud.split(":")[2]}`, value: cloud, selected: true }));
    voice.append(g);
  }
  voice.onchange = () => {
    const v = voice.value;
    if (v.startsWith("cloud:")) {
      SC.data.voice = v; cloudWarned = false;
      const svc = serviceOf(v);
      if (svc && !svc.connected) connectService(svc);
    } else {
      SC.data.winVoice = v.slice(4);
      if (cloudVoice()) delete SC.data.voice;             // a Mac system voice kept there stays as it is
    }
    scriptSave(); renderScript(true);
  };
  const rate = el("input", { type: "range", min: 0.25, max: 1, step: 0.025, value: typeof SC.data.rate === "number" ? SC.data.rate : MAC_RATE, title: "Speaking speed", style: "flex:1" });
  rate.oninput = () => { SC.data.rate = +rate.value; scriptSave(); };
  const hd = el("input", { type: "number", min: 0, step: 0.5, value: hold() });
  hd.oninput = () => { SC.data.hold = Math.max(0, +hd.value || 0); scriptSave(); };
  const test = btn("Test", () => { stopRun(); const run = SC.run = newRun(); speak(run, "This is the voice of your presentation.").then(() => { if (SC.run === run) SC.run = null; }); });
  kids.push(el("div", { className: "voice" }, el("h3", { textContent: "Voice · whole deck" }),
    el("div", { className: "f" }, el("label", { textContent: "Voice" }), voice, test),
    el("div", { className: "f" }, el("label", { textContent: "Online" }), ...(SC.services || []).map(svc => {
      const b = btn(svc.connected ? `${svc.name} ✓` : `Connect ${svc.name}…`, () => connectService(svc)); b.title = svc.connected ? "Connected: replace the key or disconnect" : "Use this service's voices"; return b; })),
    el("div", { className: "f" }, el("label", { textContent: "Speed" }), rate),
    el("div", { className: "f" }, el("label", { textContent: "No script" }), hd, el("span", { className: "loc", textContent: "seconds a build without a script stays up" }))));
  box.replaceChildren(...kids);
}

// ------------------------------------------------------------------ the scripted show
function playerStage() {
  let layer = $("#player-pointer");
  if (!layer) { layer = el("div", { id: "player-pointer" }); $("#player").append(layer); }
  const fit = () => {                                   // the slide's rectangle inside the letterboxed player
    const [w, h] = size(), pw = $("#player").clientWidth, ph = $("#player").clientHeight, k = Math.min(pw / w, ph / h);
    Object.assign(layer.style, { left: (pw - w * k) / 2 + "px", top: (ph - h * k) / 2 + "px", width: w * k + "px", height: h * k + "px" });
    return [w * k, h * k];
  };
  return makeStage(layer, fit);
}
/** Called by the show for every page it puts up: run that build's script, then go on. */
function scriptPage(page, play) {
  stopRun();
  if (!P.scripted) return;
  const run = SC.run = newRun(), at = P.i;
  const stage = P.stage || (P.stage = playerStage());
  stage.place(stage.pos);
  $("#player").classList.remove("paused");
  const vid = $("#player-video");
  const go = async () => {
    if (run.cancelled) return;
    const steps = stepsOf(page.scene, page.bn);
    if (steps.length) await runSteps(run, stage, steps); else await waitRun(run, hold() * 1000);
    if (run.cancelled || SC.run !== run || P.i !== at) return;
    if (P.i < P.pages.length - 1) goTo(P.i + 1, true);
    else { await waitRun(run, 1200); if (!run.cancelled) endShow(); }
  };
  if (isClip(page) && play && !vid.loop) {
    const wait = setInterval(() => {                    // the clip plays first; its script starts on its last frame
      if (run.cancelled) return clearInterval(wait);
      if (vid.ended || (vid.duration && vid.currentTime >= vid.duration - 0.05)) { clearInterval(wait); go(); }
    }, 60);
  } else go();
}
function scriptToggle() {
  const run = SC.run; if (!run) return;
  run.paused = !run.paused;
  if (window.speechSynthesis) { if (run.paused) speechSynthesis.pause(); else speechSynthesis.resume(); }
  const vid = $("#player-video");
  if (vid.style.display !== "none" && !vid.ended) { if (run.paused) vid.pause(); else vid.play().catch(() => {}); }
  $("#player").classList.toggle("paused", run.paused);
}
async function presentScripted(fromStart, anim) {
  await ensureScript();
  if (!SC.data.steps.length) toast("This deck has no script yet, so every build stays up for " + hold() + " seconds. Write one with the Script button.");
  await toggleScript(false);
  present(fromStart, anim, false, true);
}

// ------------------------------------------------------------------ wiring
Object.assign(actions, {
  script: () => toggleScript(),
  "present-script": () => presentScripted(true, false), "present-script-here": () => presentScripted(false, false),
  "present-script-anim": () => presentScripted(true, true),
});
{
  const base = renderScene;
  renderScene = function () { base(); if (SC.open) { renderScript(); drawScriptLayer(); } };       // follow the slide and build on screen
}
handlers.deck_changed = () => { stopRun(); SC.loadedFor = null; if (SC.open) toggleScript(false); };
document.addEventListener("keydown", ev => {
  if (ev.key === "Escape" && SC.capture) { ev.stopPropagation(); endCapture(); }
}, true);
