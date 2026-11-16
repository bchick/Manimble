/* Manimble for Windows: the editor front end. Talks to the bridge (server.py) over one WebSocket; engine requests
   follow docs/developers/protocol.md. */
"use strict";

const T = window.MANIMBLE_TOKEN;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
};
const fileUrl = p => p ? `/file?t=${encodeURIComponent(T)}&p=${encodeURIComponent(p)}` : "";
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------------ rpc
let sock, seq = 0, busy = 0;
const waiting = new Map();
const handlers = {};

function connect() {
  return new Promise(resolve => {
    sock = new WebSocket(`ws://${location.host}/ws?t=${encodeURIComponent(T)}`);
    sock.onopen = resolve;
    sock.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id != null && waiting.has(m.id)) {
        const w = waiting.get(m.id); waiting.delete(m.id);
        if ("error" in m) w.reject(new Error(m.error)); else w.resolve(m.result);
      } else if (m.event && handlers[m.event]) handlers[m.event](m);
    };
    sock.onclose = () => { status("Disconnected from Manimble. Close this window and start it again.", true); };
  });
}

function rpc(cmd, args = {}, quiet = false) {
  const id = ++seq;
  if (!quiet) setBusy(1);
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    sock.send(JSON.stringify({ id, cmd, ...args }));
  }).finally(() => { if (!quiet) setBusy(-1); });
}
function setBusy(d) { busy += d; $("#st-busy").textContent = busy > 0 ? "● working…" : ""; }

// ---------------------------------------------------------------- state
const S = {
  info: null, state: null, name: null, scene: null, stop: 0, sel: new Set(), tool: null,
  thumbKey: "", codeBase: "", drag: null, hover: null, loading: 0,
};
let cm, term, termSock, fit;

function toast(text, error = false, action = null) {
  const t = el("div", { className: "toast" + (error ? " error" : "") }, text);
  if (action) t.append(el("button", { textContent: action.label, onclick: action.run }));
  $("#toasts").append(t);
  setTimeout(() => t.remove(), error ? 9000 : 4000);
}
function status(text, error = false) { const s = $("#st-msg"); s.textContent = text || ""; s.style.color = error ? "var(--danger)" : ""; }
async function attempt(fn, what) {
  try { return await fn(); } catch (e) { toast((what ? what + ": " : "") + e.message, true); return null; }
}
/** An engine request whose reply is {ok, error?, message?}; reports failure, returns the reply or null. */
async function act(cmd, args, what) {
  const r = await attempt(() => rpc(cmd, args), what);
  if (!r) return null;
  if (r.ok === false) { toast(r.error || (what || cmd) + " failed", true); return null; }
  return r;
}

/** A small modal: `ask` resolves to the typed text (null when cancelled), `confirmBox` to true or false. */
function modal(message, { value = null, okLabel = "OK", multiline = false } = {}) {
  return new Promise(resolve => {
    const input = value == null ? null : el(multiline ? "textarea" : "input", { value, rows: 3, spellcheck: false });
    const ok = el("button", { className: "primary", textContent: okLabel }), cancel = el("button", { textContent: "Cancel" });
    const back = el("div", { className: "modalback" }, el("div", { className: "modal" }, el("div", { className: "msg", textContent: message }),
      input || "", el("div", { className: "row" }, el("span", { className: "spacer" }), cancel, ok)));
    const done = v => { back.remove(); resolve(v); };
    ok.onclick = () => done(input ? input.value : true);
    cancel.onclick = () => done(input ? null : false);
    back.onmousedown = ev => { if (ev.target === back) cancel.onclick(); };
    back.addEventListener("keydown", ev => {
      ev.stopPropagation();
      if (ev.key === "Escape") cancel.onclick();
      else if (ev.key === "Enter" && (!multiline || ev.ctrlKey || !ev.shiftKey)) { ev.preventDefault(); ok.onclick(); }
    });
    document.body.append(back);
    (input || ok).focus(); if (input) input.select();
  });
}
const ask = (message, value = "", multiline = false) => modal(message, { value, multiline });
const confirmBox = (message, okLabel = "OK") => modal(message, { okLabel });

// ------------------------------------------------------------ deck/open
function applyInfo(info) {
  S.info = info;
  $("#ver").textContent = info.version;
  $("#app").classList.toggle("nodeck", !info.deck);
  const d = info.deck;
  $("#st-deck").textContent = d ? d.original : "";
  $("#st-deck").classList.toggle("modified", !!(d && d.modified));
  document.title = d ? `${d.name} — Manimble` : "Manimble";
  for (const box of [$("#recent"), $("#welcome-recent")]) {
    box.replaceChildren(...info.recent.map(p => el("button", { textContent: p, title: p, onclick: () => openDeck(p) })));
  }
}
async function openDeck(path) {
  closeMenus();
  status("Opening…");
  const info = await attempt(() => rpc("app.open", path ? { path } : {}), "Open");
  status("");
  if (!info || info.cancelled) return;
  await deckOpened(info);
}
async function deckOpened(info) {
  applyInfo(info);
  S.name = null; S.scene = null; S.sel.clear(); S.stop = 0; S.thumbKey = "";
  await refreshState();
  if (term) restartTerminal();
}

async function refreshState(quiet = true) {
  if (!S.info || !S.info.deck) return;
  let st;
  try { st = await rpc("state", S.name ? { current: S.name } : {}, quiet); } catch (e) { return; }
  S.state = st;
  const all = st.scenes.concat(st.unusedScenes || []);
  if (!S.name || !all.some(s => s.name === S.name)) {
    S.name = st.scenes.length ? st.scenes[0].name : (all[0] && all[0].name) || null;
    S.scene = null; S.stop = 0; S.sel.clear();
    if (S.name) loadScene();
  }
  renderNav();
  $("#btn-undo").disabled = !st.canUndo; $("#btn-redo").disabled = !st.canRedo;
  $("#btn-undo").title = "Undo" + (st.undoLabel ? " " + st.undoLabel : "") + " (Ctrl+Z)";
  // the slide on screen changed underneath (a file edit from the terminal, say): show its new render
  const cur = all.find(s => s.name === S.name);
  if (cur && S.scene && !S.drag && !S.loading) {
    const ready = cur.status === "ready" || cur.status === "error";
    const was = S.scene._statusAtLoad + "|" + (S.scene._thumbAtLoad || ""), now = cur.status + "|" + (cur.thumb || "");
    if (ready && !S.scene.optimistic && was !== now) loadScene();
  }
}

function renderNav() {
  const st = S.state, box = $("#slides");
  const key = JSON.stringify([st.scenes, st.unusedScenes, S.name]);
  if (key === S.thumbKey) return;
  S.thumbKey = key;
  const card = (s, i, unused) => {
    const c = el("div", { className: "slide" + (s.name === S.name ? " sel" : "") + (s.hidden ? " hiddenslide" : "") + (unused ? " unused" : "") });
    c.append(s.thumb ? el("img", { src: fileUrl(s.thumb), draggable: false }) : el("div", { className: "ph" }));
    c.append(el("div", { className: "cap" }, el("span", { className: "dot " + s.status, title: s.status + (s.error ? ": " + s.error : "") }),
      el("span", { className: "n", textContent: unused ? "–" : String(i + 1) }), el("span", { className: "nm", textContent: s.name, title: s.name })));
    c.onclick = () => selectSlide(s.name);
    return c;
  };
  const kids = st.scenes.map((s, i) => card(s, i, false));
  if ((st.unusedScenes || []).length) {
    kids.push(el("div", { className: "navsep", textContent: "Not in the show" }));
    kids.push(...st.unusedScenes.map((s, i) => card(s, i, true)));
  }
  box.replaceChildren(...kids);
  const sel = $(".slide.sel", box);
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

async function selectSlide(name) {
  if (name === S.name) return;
  if (codeDirty() && !await confirmBox("Discard the code you typed for this slide?", "Discard")) return;
  S.name = name; S.stop = 0; S.sel.clear(); S.scene = null; S.thumbKey = "";
  renderNav();
  loadScene(true);
}

async function loadScene(resetCode = false) {
  const name = S.name;
  if (!name) return;
  S.loading++;
  let sc;
  try { sc = await rpc("scene", { name }, true); }
  catch (e) { sc = { name, status: "error", error: e.message, stops: [], objects: {}, size: [1280, 720] }; }
  finally { S.loading--; }
  if (name !== S.name) return;
  sc.stops = sc.stops || []; sc.objects = sc.objects || {};
  // what the slide list said when this was loaded: `refreshState` reloads the slide when that changes
  let st = null;
  try { st = await rpc("state", {}, true); } catch (e) { /* keep the old list */ }
  if (name !== S.name) return;
  if (st) { S.state = st; renderNav(); }
  const cur = S.state && S.state.scenes.concat(S.state.unusedScenes || []).find(s => s.name === name);
  sc._thumbAtLoad = cur ? cur.thumb : null; sc._statusAtLoad = cur ? cur.status : null;
  S.scene = sc;
  S.stop = clamp(S.stop, 0, Math.max(0, sc.stops.length - 1));
  for (const oid of [...S.sel]) if (!(oid in sc.objects)) S.sel.delete(oid);
  renderScene();
  setCode(sc, resetCode);
}

// --------------------------------------------------------------- canvas
const frameEl = $("#frame"), overlay = $("#overlay"), composite = $("#composite"), pngEl = $("#png");
let scale = 1;
function size() { return (S.scene && S.scene.size) || [1280, 720]; }
function stopData() { return S.scene && S.scene.stops[S.stop]; }

function layoutFrame() {
  const [w, h] = size(), wrap = $("#stagewrap");
  const pad = 28, aw = wrap.clientWidth - pad * 2, ah = wrap.clientHeight - pad * 2;
  scale = Math.max(0.05, Math.min(aw / w, ah / h));
  frameEl.style.width = w + "px"; frameEl.style.height = h + "px";
  frameEl.style.transform = `translate(${(wrap.clientWidth - w * scale) / 2}px, ${(wrap.clientHeight - h * scale) / 2}px) scale(${scale})`;
}

function renderScene() {
  const sc = S.scene;
  layoutFrame();
  const err = $("#sceneerror");
  if (!sc || sc.status === "error" || !sc.stops.length) {
    err.style.display = sc && (sc.error || sc.status === "error") ? "block" : "none";
    err.textContent = sc ? "This slide does not render:\n\n" + (sc.error || "unknown error") : "";
    frameEl.style.visibility = "hidden";
    renderBuilds(); renderInspector();
    return;
  }
  err.style.display = "none"; frameEl.style.visibility = "visible";
  const st = stopData();
  const comp = !!sc.optimistic || !!S.drag;
  pngEl.style.display = comp ? "none" : "block";
  composite.style.display = comp ? "block" : "none";
  if (!comp) { if (pngEl.dataset.p !== st.png) { pngEl.dataset.p = st.png; pngEl.src = fileUrl(st.png); } }
  else drawComposite();
  drawOverlay();
  renderBuilds();
  renderInspector();
}

function drawComposite() {
  const st = stopData(); if (!st) return;
  const kids = [el("img", { src: fileUrl(st.bg), style: "width:100%;height:100%" })];
  const d = S.drag;
  for (const sp of [...st.sprites].sort((a, b) => a.z - b.z)) {
    const img = el("img", { src: fileUrl(sp.file) });
    img.style.width = sp.w + "px"; img.style.height = sp.h + "px";
    let tf = `translate(${sp.x}px, ${sp.y}px)`;
    const xf = st.xforms && st.xforms[sp.oid];
    if (xf) tf = `matrix(${xf.join(",")}) ` + tf;
    if (d && d.moved && S.sel.has(sp.oid)) {
      if (d.mode === "move") tf = `translate(${d.dx}px, ${d.dy}px) ` + tf;
      else if (d.mode === "resize") {
        const c = d.center;
        tf = `translate(${c[0]}px, ${c[1]}px) scale(${d.ratio}) translate(${-c[0]}px, ${-c[1]}px) ` + tf;
      }
    }
    img.style.transform = tf;
    kids.push(img);
  }
  composite.replaceChildren(...kids);
}

/** The box a client selects an object by on this build: its text frame when it has one, else its ink. */
function boxOf(oid) {
  const st = stopData(); if (!st) return null;
  const o = S.scene.objects[oid];
  const v = st.visible.find(r => r[0] === oid);
  if (!v) return null;
  if (o && o.frame) return o.frame.slice();
  return v.slice(1);
}
function members(oid) {
  const o = S.scene.objects[oid];
  if (!o || o.group == null) return [oid];
  const st = stopData();
  return st.visible.map(r => r[0]).filter(i => (S.scene.objects[i] || {}).group === o.group);
}
function hit(x, y) {
  const st = stopData(); if (!st) return null;
  const z = Object.fromEntries(st.sprites.map(s => [s.oid, s.z]));
  let best = null, bestZ = -Infinity;
  for (const [oid] of st.visible) {
    const ln = st.lines && st.lines[oid];
    let inside;
    if (ln) {
      const [sx, sy, ex, ey, w] = ln, dx = ex - sx, dy = ey - sy, L = dx * dx + dy * dy || 1;
      const t = clamp(((x - sx) * dx + (y - sy) * dy) / L, 0, 1);
      inside = Math.hypot(x - sx - t * dx, y - sy - t * dy) <= Math.max(8, (w || 4) / 2 + 6) / Math.min(1, scale);
    } else {
      const b = boxOf(oid), m = 4;
      inside = b && x >= b[0] - m && x <= b[2] + m && y >= b[1] - m && y <= b[3] + m;
    }
    if (inside && (z[oid] ?? 0) >= bestZ) { best = oid; bestZ = z[oid] ?? 0; }
  }
  return best;
}

function drawOverlay() {
  const sc = S.scene, st = stopData();
  const kids = [];
  if (!sc || !st) { overlay.replaceChildren(); return; }
  for (const ph of sc.placeholders || []) {
    const [x0, y0, x1, y1] = ph.box;
    const p = el("div", { className: "placeholder", textContent: ph.prompt || "Click to add text" });
    Object.assign(p.style, { left: x0 + "px", top: y0 + "px", width: (x1 - x0) + "px", height: (y1 - y0) + "px" });
    p.onmousedown = ev => ev.stopPropagation();
    p.onclick = () => fillPlaceholder(ph);
    kids.push(p);
  }
  const d = S.drag;
  const box = (b, cls) => {
    const e = el("div", { className: cls });
    Object.assign(e.style, { left: b[0] + "px", top: b[1] + "px", width: (b[2] - b[0]) + "px", height: (b[3] - b[1]) + "px",
      borderWidth: (1.5 / scale) + "px" });
    return e;
  };
  if (S.hover != null && !S.sel.has(S.hover) && !d) { const b = boxOf(S.hover); if (b) kids.push(box(b, "selbox hover")); }
  for (const oid of S.sel) {
    let b = boxOf(oid); if (!b) continue;
    if (d && d.moved && d.mode === "move") b = [b[0] + d.dx, b[1] + d.dy, b[2] + d.dx, b[3] + d.dy];
    if (d && d.moved && d.mode === "resize") {
      const c = d.center, r = d.ratio;
      b = [c[0] + (b[0] - c[0]) * r, c[1] + (b[1] - c[1]) * r, c[0] + (b[2] - c[0]) * r, c[1] + (b[3] - c[1]) * r];
    }
    const e = box(b, "selbox");
    if (S.sel.size === 1 && !(st.lines && st.lines[oid])) {
      for (const [cls, hx, hy] of [["nw", 0, 0], ["ne", 1, 0], ["sw", 0, 1], ["se", 1, 1]]) {
        const hs = 10 / scale;
        const h = el("div", { className: "handle " + cls });
        Object.assign(h.style, { width: hs + "px", height: hs + "px", left: `calc(${hx * 100}% - ${hs / 2}px)`, top: `calc(${hy * 100}% - ${hs / 2}px)`,
          borderWidth: (1.5 / scale) + "px" });
        h.onmousedown = ev => startResize(ev, oid);
        e.append(h);
      }
    }
    kids.push(e);
  }
  if (d && d.mode === "draw" && d.moved) {
    if (["line", "arrow", "darrow"].includes(S.tool)) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "rubberline");
      const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
      for (const [k, v] of Object.entries({ x1: d.x0, y1: d.y0, x2: d.x, y2: d.y, stroke: "#4c8dff", "stroke-width": 2 / scale })) l.setAttribute(k, v);
      svg.append(l); kids.push(svg);
    } else kids.push(box([Math.min(d.x0, d.x), Math.min(d.y0, d.y), Math.max(d.x0, d.x), Math.max(d.y0, d.y)], "rubber"));
  }
  if (d && d.mode === "marquee" && d.moved)
    kids.push(box([Math.min(d.x0, d.x), Math.min(d.y0, d.y), Math.max(d.x0, d.x), Math.max(d.y0, d.y)], "rubber"));
  overlay.replaceChildren(...kids);
}

function pt(ev) {
  const r = frameEl.getBoundingClientRect();
  return [(ev.clientX - r.left) / scale, (ev.clientY - r.top) / scale];
}

frameEl.addEventListener("mousedown", ev => {
  if (ev.button !== 0 || !stopData() || $("#inline")) return;
  const [x, y] = pt(ev);
  if (S.tool) { S.drag = { mode: "draw", x0: x, y0: y, x, y, moved: false }; return; }
  const oid = hit(x, y);
  if (oid == null) {
    if (!ev.shiftKey) S.sel.clear();
    S.drag = { mode: "marquee", x0: x, y0: y, x, y, moved: false };
  } else {
    const ms = members(oid);
    if (ev.shiftKey) { if (S.sel.has(oid)) ms.forEach(i => S.sel.delete(i)); else ms.forEach(i => S.sel.add(i)); }
    else if (!S.sel.has(oid)) { S.sel.clear(); ms.forEach(i => S.sel.add(i)); }
    if (S.sel.has(oid)) S.drag = { mode: "move", x0: x, y0: y, dx: 0, dy: 0, moved: false };
  }
  drawOverlay(); renderInspector();
});
function startResize(ev, oid) {
  ev.stopPropagation(); ev.preventDefault();
  const b = boxOf(oid), [x, y] = pt(ev), c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  S.drag = { mode: "resize", oid, center: c, d0: Math.max(4, Math.hypot(x - c[0], y - c[1])), ratio: 1, moved: false };
}
window.addEventListener("mousemove", ev => {
  const d = S.drag;
  if (!d) {
    if (ev.target === frameEl || frameEl.contains(ev.target)) {
      const [x, y] = pt(ev), h = S.tool ? null : hit(x, y);
      if (h !== S.hover) { S.hover = h; drawOverlay(); }
    } else if (S.hover != null) { S.hover = null; drawOverlay(); }
    return;
  }
  const [x, y] = pt(ev);
  if (d.mode === "move") {
    d.dx = x - d.x0; d.dy = y - d.y0;
    if (ev.shiftKey) { if (Math.abs(d.dx) > Math.abs(d.dy)) d.dy = 0; else d.dx = 0; }
    if (!d.moved && Math.hypot(d.dx, d.dy) * scale > 3) { d.moved = true; renderScene(); return; }
    if (d.moved) { drawComposite(); drawOverlay(); }
  } else if (d.mode === "resize") {
    d.ratio = clamp(Math.hypot(x - d.center[0], y - d.center[1]) / d.d0, 0.05, 20);
    if (!d.moved && Math.abs(d.ratio - 1) > 0.01) { d.moved = true; renderScene(); return; }
    if (d.moved) { drawComposite(); drawOverlay(); }
  } else {
    d.x = x; d.y = y;
    if (Math.hypot(x - d.x0, y - d.y0) * scale > 3) d.moved = true;
    drawOverlay();
  }
});
window.addEventListener("mouseup", async ev => {
  const d = S.drag;
  if (!d) return;
  if (d.mode === "draw") { S.drag = null; drawOverlay(); await insertDrawn(d); return; }
  if (d.mode === "marquee") {
    S.drag = null;
    if (d.moved) {
      const [a, b, c, e] = [Math.min(d.x0, d.x), Math.min(d.y0, d.y), Math.max(d.x0, d.x), Math.max(d.y0, d.y)];
      for (const [oid] of stopData().visible) {
        const bx = boxOf(oid);
        if (bx && bx[0] >= a && bx[1] >= b && bx[2] <= c && bx[3] <= e) S.sel.add(oid);
      }
    }
    drawOverlay(); renderInspector(); return;
  }
  if (!d.moved) { S.drag = null; return; }
  // keep showing the dragged composite until the engine's optimistic scene replaces it
  const oids = [...S.sel];
  if (d.mode === "move") await editMany(oids, { op: "move", dx: Math.round(d.dx * 100) / 100, dy: Math.round(d.dy * 100) / 100 }, "move");
  else await editMany([d.oid], { op: "resize", ratio: Math.round(d.ratio * 10000) / 10000 }, "resize");
  S.drag = null;
  await loadScene();
});

frameEl.addEventListener("dblclick", ev => {
  if (S.tool) return;
  const [x, y] = pt(ev), oid = hit(x, y);
  if (oid != null) inlineEdit(oid);
});

async function editMany(oids, args, label) {
  const sc = S.name, stop = S.stop;
  let mark = null;
  if (oids.length > 1) mark = (await attempt(() => rpc("undo_mark"))) || null;
  let okAll = true;
  for (const oid of oids) {
    const r = await act("edit", { scene: sc, stop, oid, ...args }, label);
    if (!r) { okAll = false; break; }
  }
  if (mark && mark.mark != null) await attempt(() => rpc("undo_merge", { mark: mark.mark, label }));
  refreshState();
  return okAll;
}
async function edit(oid, args, label) {
  const ok = await editMany([oid], args, label);
  await loadScene();
  return ok;
}

function inlineEdit(oid) {
  const o = S.scene.objects[oid], b = boxOf(oid);
  if (!o || !b) return;
  if (o.kind !== "text" && o.kind !== "tex") return;
  if (o.textOk === false) { toast(o.textNote || "This text is made by code; edit it in the code pane.", true); return; }
  const ta = el("textarea", { id: "inline", value: o.value || "", spellcheck: false });
  const fs = clamp((o.kind === "tex" ? 20 : (b[3] - b[1]) / Math.max(1, (o.value || "").split("\n").length) * 0.7), 14, 80);
  Object.assign(ta.style, { left: (b[0] - 6) + "px", top: (b[1] - 4) + "px", minWidth: Math.max(160, b[2] - b[0] + 40) + "px",
    minHeight: (b[3] - b[1] + 10) + "px", fontSize: fs + "px", fontFamily: o.kind === "tex" ? "Consolas, monospace" : "" });
  let done = false;
  const finish = async commit => {
    if (done) return; done = true;
    const v = ta.value; ta.remove();
    if (commit && v !== (o.value || "")) await edit(oid, { op: "text", value: v }, "text");
  };
  ta.onkeydown = ev => {
    ev.stopPropagation();
    if (ev.key === "Escape") finish(false);
    else if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); finish(true); }
  };
  ta.onmousedown = ev => ev.stopPropagation();
  ta.onblur = () => finish(true);
  frameEl.append(ta);
  ta.focus(); ta.select();
}

async function fillPlaceholder(ph) {
  const text = await ask(ph.prompt || "Text", "", true);
  if (!text) return;
  if (await act("placeholder", { scene: S.name, line: ph.line, text }, "placeholder")) { refreshState(); await loadScene(); }
}

// ---------------------------------------------------------------- insert
function setTool(t) {
  S.tool = S.tool === t ? null : t;
  $$("#tools [data-tool]").forEach(b => b.classList.toggle("on", b.dataset.tool === S.tool));
  frameEl.classList.toggle("tool", !!S.tool);
  status(S.tool ? (["text", "formula"].includes(S.tool) ? "Click on the slide to place it. Esc cancels." : "Drag on the slide to draw it. Esc cancels.") : "");
}
async function insert(kind, extra = {}) {
  if (!S.name) return;
  const r = await act("insert", { scene: S.name, stop: S.stop, kind, ...extra }, "insert");
  if (r) { refreshState(); await loadScene(); }
  return r;
}
async function insertDrawn(d) {
  const kind = S.tool; setTool(kind);
  const extra = {};
  if (kind === "text" || kind === "formula") {
    const v = await ask(kind === "text" ? "Text" : "Formula (LaTeX)", kind === "text" ? "Text" : "x^2 + y^2 = z^2", true);
    if (v == null || v === "") return;
    Object.assign(extra, kind === "text" ? { value: v } : { tex: v }, { sx: d.x0, sy: d.y0, ex: d.x0, ey: d.y0 });
  } else if (d.moved) Object.assign(extra, { sx: d.x0, sy: d.y0, ex: d.x, ey: d.y });
  else if (["line", "arrow", "darrow"].includes(kind)) Object.assign(extra, { sx: d.x0 - 120, sy: d.y0, ex: d.x0 + 120, ey: d.y0 });
  else Object.assign(extra, { sx: d.x0 - 130, sy: d.y0 - 80, ex: d.x0 + 130, ey: d.y0 + 80 });
  await insert(kind, extra);
}

// ------------------------------------------------------------- inspector
const hex = c => (typeof c === "string" && /^#[0-9a-f]{6}/i.test(c)) ? c.slice(0, 7) : "#ffffff";
function renderInspector() {
  const box = $("#inspector"), sc = S.scene;
  if (document.activeElement && box.contains(document.activeElement) && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)
      && box.dataset.key === inspectorKey()) return;
  box.dataset.key = inspectorKey();
  if (!sc) { box.replaceChildren(); return; }
  const f = (label, ...kids) => el("div", { className: "f" }, el("label", { textContent: label }), ...kids);
  const kids = [];
  if (S.sel.size === 0) {
    kids.push(el("h3", { textContent: "Slide · " + sc.name }));
    const notes = el("textarea", { rows: 4, value: sc.notes || "", placeholder: "Speaker notes for this slide" });
    notes.onchange = async () => { if (await act("notes", { op: "set", scene: sc.name, text: notes.value }, "notes")) { refreshState(); loadScene(); } };
    kids.push(notes);
    if (sc.status !== "error") kids.push(el("div", { className: "loc", textContent: "Click an object to select it. Double-click text to retype it." }));
  } else if (S.sel.size > 1) {
    kids.push(el("h3", { textContent: S.sel.size + " objects" }));
    kids.push(f("Arrange", btn("Group", () => groupSel(true)), btn("Ungroup", () => groupSel(false)), btn("Delete", deleteSel)));
  } else {
    const oid = [...S.sel][0], o = sc.objects[oid] || {};
    const isText = o.kind === "text" || o.kind === "tex";
    kids.push(el("h3", { textContent: ({ text: "Text", tex: "Formula", image: "Picture", line: "Line", shape: o.shape || "Shape", table: "Table" })[o.kind] || o.kind || "Object" }));
    if (isText) {
      if (o.textOk === false) kids.push(el("div", { className: "note", textContent: o.textNote || "This text is made by code." }));
      const ta = el("textarea", { rows: Math.min(6, (o.value || "").split("\n").length + 1), value: o.value || "", disabled: o.textOk === false });
      ta.onchange = () => { if (ta.value !== (o.value || "")) edit(oid, { op: "text", value: ta.value }, "text"); };
      ta.onkeydown = ev => { ev.stopPropagation(); if (ev.key === "Enter" && ev.ctrlKey) ta.blur(); };
      kids.push(ta);
      const fs = el("input", { type: "number", min: 4, max: 400, step: 1, value: Math.round(o.fontSize || 0) });
      fs.onchange = () => { const v = +fs.value; if (v > 0 && o.fontSize) edit(oid, { op: "resize", ratio: v / o.fontSize }, "font size"); };
      const row = [fs];
      if (o.kind === "text") {
        const bold = /BOLD|HEAVY/i.test(o.weight || ""), ital = /ITALIC|OBLIQUE/i.test(o.slant || "");
        const b = btn("B", () => edit(oid, { op: "style", weight: bold ? "NORMAL" : "BOLD" }, "bold")); b.style.fontWeight = "700"; b.classList.toggle("on", bold);
        const i = btn("I", () => edit(oid, { op: "style", slant: ital ? "NORMAL" : "ITALIC" }, "italic")); i.style.fontStyle = "italic"; i.classList.toggle("on", ital);
        row.push(b, i);
        const al = (o.format || {}).align;
        for (const [a, g] of [["left", "⇤"], ["center", "↔"], ["right", "⇥"]]) {
          const x = btn(g, () => edit(oid, { op: "align", value: a }, "align")); x.title = "Align " + a; x.classList.toggle("on", al === a); row.push(x);
        }
      }
      kids.push(f("Size", ...row));
      if (o.kind === "text") {
        const font = el("input", { type: "text", value: o.font || "", placeholder: sc.font || "font family", style: "flex:1" });
        font.onchange = () => { if (font.value.trim()) edit(oid, { op: "style", font: font.value.trim() }, "font"); };
        font.onkeydown = ev => ev.stopPropagation();
        kids.push(f("Font", font));
      }
    }
    if (o.kind !== "image") {
      const col = el("input", { type: "color", value: hex(o.color) });
      col.onchange = () => edit(oid, { op: "color", value: col.value.toUpperCase() }, "color");
      kids.push(f("Colour", col, el("span", { className: "loc", textContent: o.color || "" })));
    }
    if (o.dims) {
      const w = el("input", { type: "number", value: Math.round(o.dims[0]), min: 1 }), h = el("input", { type: "number", value: Math.round(o.dims[1]), min: 1 });
      w.onchange = () => edit(oid, { op: "size", width: +w.value }, "width");
      h.onchange = () => edit(oid, { op: "size", height: +h.value }, "height");
      kids.push(f("W × H", w, h));
    }
    const rot = el("input", { type: "number", value: Math.round((o.rotation || 0) * 10) / 10, step: 5 });
    rot.onchange = () => edit(oid, { op: "rotate", degrees: +rot.value }, "rotate");
    kids.push(f("Rotation", rot, el("span", { className: "loc", textContent: "degrees" })));
    kids.push(f("Order", ...["front", "forward", "backward", "back"].map(v => btn(v[0].toUpperCase() + v.slice(1), () => edit(oid, { op: "order", value: v }, "order")))));
    kids.push(f("", btn("Delete", deleteSel), o.loc ? btn("Show in Code", () => showLoc(o.loc)) : ""));
    if (o.loc) kids.push(el("div", { className: "loc", textContent: o.loc }));
  }
  box.replaceChildren(...kids.filter(Boolean));
}
function inspectorKey() { return [S.name, S.stop, ...S.sel].join(","); }
function btn(text, fn) { return el("button", { textContent: text, onclick: fn }); }
async function deleteSel() {
  const oids = [...S.sel]; if (!oids.length) return;
  S.sel.clear();
  await editMany(oids, { op: "delete" }, "delete");
  await loadScene();
}
async function groupSel(on) {
  const oids = [...S.sel];
  await edit(oids[0], { op: on ? "group" : "ungroup", oids }, on ? "group" : "ungroup");
}
function showLoc(loc) {
  const m = /:(\d+)$/.exec(loc), src = S.scene.source;
  if (!m || !src) return;
  const line = +m[1] - src.start;
  if (line >= 0 && line < cm.lineCount()) { cm.setCursor(line, 0); cm.scrollIntoView({ line, ch: 0 }, 80); cm.focus(); }
}

// ---------------------------------------------------------------- builds
function renderBuilds() {
  const box = $("#builds"), sc = S.scene;
  const n = sc ? sc.stops.length : 0;
  const kids = [el("span", { className: "lbl", textContent: n > 1 ? "Builds" : "" })];
  if (n > 1) for (let i = 0; i < n; i++) {
    const b = el("button", { className: "b" + (i === S.stop ? " on" : ""), textContent: String(i + 1) });
    b.onclick = () => { S.stop = i; S.sel.clear(); renderScene(); };
    kids.push(b);
  }
  kids.push(el("span", { className: "spacer" }));
  if (sc && sc.optimistic) kids.push(el("span", { className: "lbl", textContent: "checking the edit…" }));
  box.replaceChildren(...kids);
}

// ------------------------------------------------------------------ code
function codeDirty() { return cm && S.scene && S.scene.source && cm.getValue() !== S.codeBase; }
function setCode(sc, force) {
  const src = sc.source;
  $("#codefile").textContent = src ? `${src.file}  ·  lines ${src.start}–${src.end}` : "";
  if (!src) return;
  if (!force && codeDirty() && S.codeScene === sc.name) { return; }           // keep what the user is typing
  S.codeExpected = src.text; S.codeScene = sc.name; S.codeCRLF = src.text.includes("\r\n");
  const pos = cm.getScrollInfo();
  cm.setValue(src.text);
  S.codeBase = cm.getValue();                      // as the editor holds it (line ends normalised)
  cm.setOption("firstLineNumber", src.start || 1);
  cm.clearHistory();
  if (!force) cm.scrollTo(pos.left, pos.top);
  $("#codeerror").style.display = "none";
}
async function applyCode() {
  const sc = S.scene; if (!sc || !sc.source || !codeDirty()) return;
  const r = await attempt(() => rpc("edit_source", { scene: sc.name, file: sc.source.file, expected: S.codeExpected,
    text: S.codeCRLF ? cm.getValue().replace(/\n/g, "\r\n") : cm.getValue() }), "Apply");
  if (!r) return;
  const err = $("#codeerror");
  if (r.ok === false && !r.changed) { err.textContent = r.error || "The edit was rejected."; err.style.display = "block"; return; }
  S.codeBase = cm.getValue();
  err.textContent = r.error || ""; err.style.display = r.error ? "block" : "none";
  S.thumbKey = "";
  await refreshState();
  await loadScene(!r.error);
}

// ---------------------------------------------------------------- slides
async function slideOp(op, extra = {}) {
  if (!S.name && op !== "new") return;
  if (op === "delete" && !await confirmBox(`Delete the slide ${S.name}?`, "Delete")) return;
  const r = await act("slide", { op, scene: S.name, ...extra }, "slide");
  if (!r) return;
  if (r.select && r.select !== S.name) { S.name = r.select; S.stop = 0; S.sel.clear(); S.scene = null; }
  S.thumbKey = "";
  await refreshState();
  await loadScene(true);
}

// --------------------------------------------------------------- actions
async function save() {
  let r = await attempt(() => rpc("app.save"), "Save");
  if (r && r.ok === false && r.conflicts) {
    if (!await confirmBox("These files changed in the original deck since it was opened:\n\n" + r.conflicts.join("\n") + "\n\nOverwrite them?", "Overwrite")) return;
    r = await attempt(() => rpc("app.save", { force: true }), "Save");
  }
  if (r && r.ok) { toast(r.saved.length ? `Saved ${r.saved.length} file${r.saved.length > 1 ? "s" : ""} to the original deck` : "Nothing to save"); pollStatus(); }
}
async function undo(redo) {
  const r = await act(redo ? "redo" : "undo", {}, redo ? "Redo" : "Undo");
  if (r) { S.thumbKey = ""; await refreshState(); await loadScene(true); }
}
async function exportTo(kind) {
  const name = S.info.deck.name;
  const ask = (ext, label) => rpc("app.dialog", { kind: "save", title: "Export " + label, defaultextension: ext, initialfile: name + ext, filetypes: [[label, "*" + ext]] });
  if (kind === "pdf" || kind === "pdf-builds") {
    status("Exporting PDF…");
    const r = await attempt(() => rpc("app.export_pdf", { builds: kind === "pdf-builds" }), "Export");
    status("");
    if (r && r.ok) exported(r.path);
  } else if (kind === "pptx") {
    const p = await attempt(() => ask(".pptx", "PowerPoint")); if (!p || !p.path) return;
    await act("export", { kind: "pptx", path: p.path, editable: true }, "Export");
  } else if (kind === "mp4") {
    const p = await attempt(() => ask(".mp4", "Movie")); if (!p || !p.path) return;
    await act("export_movie", { path: p.path, height: 1080 }, "Export");
  } else if (kind === "py") {
    const p = await attempt(() => ask(".py", "Python")); if (!p || !p.path) return;
    const r = await act("export_python", { path: p.path }, "Export");
    if (r) exported(r.path || p.path);
  }
}
function exported(path) { toast("Exported " + path, false, { label: "Show", run: () => rpc("app.reveal", { path }) }); }
const progress = label => m => {
  if (m.phase === "building" || m.phase === "encoding") status(`${label}: ${m.phase} ${m.done ?? ""}${m.total ? "/" + m.total : ""} ${m.scene || ""}`);
  else if (m.phase === "done") { status(""); if (m.path) exported(m.path); if (m.pdfError) toast(m.pdfError, true); }
  else if (m.phase === "error") { status(""); toast(`${label} failed: ${m.error}`, true); }
  else if (m.phase === "cancelled") status("");
};
handlers.export = progress("Export");
handlers.export_movie = progress("Movie");
handlers.import = m => {
  if (m.phase === "building") status(`Importing ${m.done ?? ""}/${m.total ?? ""} ${m.scene || ""}`);
  else if (m.phase === "done") { status(""); if ((m.warnings || []).length) toast("Imported with notes:\n" + m.warnings.slice(0, 8).join("\n")); openDeck(m.deck); }
  else if (m.phase === "error") { status(""); toast("Import failed: " + m.error, true); }
};
handlers.rendered = m => { S.thumbKey = ""; refreshState(); if (m.name === S.name && !S.drag) loadScene(); };
handlers.edit_failed = m => { toast("The edit did not hold and was undone: " + (m.error || ""), true); if (m.name === S.name) loadScene(); refreshState(); };
handlers.engine_died = () => toast("The engine stopped. Reopen the deck to restart it.", true);
handlers.deck_changed = () => {};

const actions = {
  new: async () => {
    const name = await ask("Name of the new deck", "My Deck"); if (!name) return;
    const info = await attempt(() => rpc("app.new_deck", { name }), "New deck");
    if (info && !info.cancelled) deckOpened(info);
  },
  open: () => openDeck(),
  "open-sample": () => openDeck(S.info.sample),
  save, revert: async () => {
    if (!await confirmBox("Throw away every change since the deck was last saved?", "Revert")) return;
    if (await attempt(() => rpc("app.revert"), "Revert")) { S.thumbKey = ""; await refreshState(); await loadScene(true); pollStatus(); }
  },
  reveal: () => rpc("app.reveal"),
  import: async () => { const r = await attempt(() => rpc("app.import"), "Import"); if (r && r.ok) status("Importing…"); },
  "export-pdf": () => exportTo("pdf"), "export-pdf-builds": () => exportTo("pdf-builds"), "export-pptx": () => exportTo("pptx"),
  "export-mp4": () => exportTo("mp4"), "export-py": () => exportTo("py"),
  undo: () => undo(false), redo: () => undo(true),
  "slide-new": b => slideOp("new", { layout: b.dataset.layout }),
  "slide-duplicate": () => slideOp("duplicate"), "slide-up": () => slideOp("up"), "slide-down": () => slideOp("down"),
  "slide-delete": () => slideOp("delete"),
  "slide-hide": () => { const s = S.state.scenes.find(x => x.name === S.name); slideOp(s && s.hidden ? "unhide" : "hide"); },
  "build-new": async () => { const r = await act("new_build", { scene: S.name, stop: S.stop }, "New build"); if (r) { S.stop = r.stop ?? S.stop + 1; await loadScene(true); } },
  "build-delete": async () => { const r = await act("delete_build", { scene: S.name, stop: S.stop }, "Delete build"); if (r) { S.stop = r.stop ?? 0; await loadScene(true); } },
  "insert-image": async () => { const r = await attempt(() => rpc("app.add_image"), "Picture"); if (r && r.file) insert("image", { file: r.file }); },
  "insert-table": async () => {
    const v = await ask("Table size: rows x columns", "3x3"); const m = v && /(\d+)\s*[x×,]\s*(\d+)/.exec(v);
    if (m) insert("table", { rows: +m[1], cols: +m[2], style: "word" });
  },
  terminal: () => toggleTerminal(), "terminal-restart": () => restartTerminal(),
  present: () => present(false, false), "present-start": () => present(true, false), "present-anim": () => present(false, true),
};
function closeMenus() { $$(".drop.open").forEach(d => d.classList.remove("open")); }
document.addEventListener("click", ev => {
  const m = ev.target.closest("[data-menu]"), a = ev.target.closest("[data-act]"), t = ev.target.closest("[data-tool]");
  if (m) { const d = $("#menu-" + m.dataset.menu), was = d.classList.contains("open"); closeMenus(); d.classList.toggle("open", !was); return; }
  closeMenus();
  if (a && actions[a.dataset.act]) actions[a.dataset.act](a);
  else if (t) setTool(t.dataset.tool);
});

document.addEventListener("keydown", ev => {
  if ($("#player").classList.contains("open")) return playerKey(ev);
  const tag = (ev.target.tagName || "").toLowerCase();
  const typing = tag === "input" || tag === "textarea" || ev.target.closest(".CodeMirror, #term");
  const ctrl = ev.ctrlKey || ev.metaKey;
  if (ctrl && ev.key.toLowerCase() === "s") { ev.preventDefault(); if (ev.target.closest(".CodeMirror") && codeDirty()) applyCode().then(save); else save(); return; }
  if (ctrl && ev.key === "`") { ev.preventDefault(); toggleTerminal(); return; }
  if (ev.key === "F5") { ev.preventDefault(); present(ev.shiftKey, false); return; }
  if (typing || !S.info || !S.info.deck) return;
  if (ev.key === "Escape") { if (S.tool) setTool(S.tool); S.sel.clear(); S.drag = null; renderScene(); return; }
  if (ctrl && ev.key.toLowerCase() === "z") { ev.preventDefault(); undo(ev.shiftKey); return; }
  if (ctrl && ev.key.toLowerCase() === "y") { ev.preventDefault(); undo(true); return; }
  if (ctrl && ev.key.toLowerCase() === "a") { ev.preventDefault(); const st = stopData(); if (st) { st.visible.forEach(r => S.sel.add(r[0])); drawOverlay(); renderInspector(); } return; }
  if ((ev.key === "Delete" || ev.key === "Backspace") && S.sel.size) { ev.preventDefault(); deleteSel(); return; }
  if (ev.key === "Enter" && S.sel.size === 1) { ev.preventDefault(); inlineEdit([...S.sel][0]); return; }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[ev.key]) {
    ev.preventDefault();
    if (S.sel.size) {
      const k = ev.shiftKey ? 10 : 1, [dx, dy] = arrows[ev.key];
      editMany([...S.sel], { op: "move", dx: dx * k, dy: dy * k }, "nudge").then(() => loadScene());
    } else if (S.state) {
      const names = S.state.scenes.map(s => s.name), i = names.indexOf(S.name);
      const j = clamp(i + (ev.key === "ArrowUp" || ev.key === "ArrowLeft" ? -1 : 1), 0, names.length - 1);
      if (j !== i && i >= 0) selectSlide(names[j]);
    }
    return;
  }
  if (ev.key === "PageDown" || ev.key === "PageUp") {
    const n = S.scene ? S.scene.stops.length : 0, j = clamp(S.stop + (ev.key === "PageDown" ? 1 : -1), 0, n - 1);
    if (j !== S.stop) { S.stop = j; S.sel.clear(); renderScene(); }
  }
});

// -------------------------------------------------------------- terminal
function toggleTerminal() {
  const d = $("#drawer"), open = !d.classList.contains("open");
  d.classList.toggle("open", open); $("#btn-term").classList.toggle("on", open);
  if (open) { if (!term) startTerminal(); else { fit.fit(); term.focus(); } }
  layoutFrame();
}
function startTerminal() {
  term = new Terminal({ fontFamily: "Cascadia Mono, Consolas, monospace", fontSize: 13, cursorBlink: true, theme: { background: "#000000" } });
  fit = new FitAddon.FitAddon(); term.loadAddon(fit);
  term.open($("#term")); fit.fit();
  term.onData(d => { if (termSock && termSock.readyState === 1) termSock.send(JSON.stringify({ t: "i", d })); });
  term.onResize(({ cols, rows }) => { if (termSock && termSock.readyState === 1) termSock.send(JSON.stringify({ t: "r", cols, rows })); });
  term.attachCustomKeyEventHandler(ev => {
    if (ev.type === "keydown" && ev.ctrlKey && ev.key.toLowerCase() === "v") { navigator.clipboard.readText().then(t => term.paste(t)).catch(() => {}); return false; }
    if (ev.type === "keydown" && ev.ctrlKey && ev.key.toLowerCase() === "c" && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()).catch(() => {}); return false; }
    if (ev.ctrlKey && ev.key === "`") return false;
    return true;
  });
  connectTerminal(); term.focus();
}
function connectTerminal() {
  const s = new WebSocket(`ws://${location.host}/term?t=${encodeURIComponent(T)}&cols=${term.cols}&rows=${term.rows}`);
  termSock = s;
  s.onmessage = ev => term.write(ev.data);
  s.onclose = () => { if (termSock === s) term.write("\r\n\x1b[90m[the shell ended — press Restart]\x1b[0m\r\n"); };
}
function restartTerminal() {
  if (!term) return;
  const old = termSock; termSock = null; if (old) old.close();
  term.reset(); connectTerminal();
}

// ------------------------------------------------------------- presenting
const P = { pages: [], i: 0, anim: false };
async function present(fromStart, anim) {
  if (!S.name) return;
  const player = $("#player");
  if (anim) {
    status("Building the animations… this renders every slide with Manim and can take a while.");
    P.anim = true; P.wantScene = fromStart ? null : S.name;
    const r = await act("present", { height: 1080 }, "Present");
    if (!r) status("");
    return;                                                 // the `present` event opens the player
  }
  status("Preparing the slides…");
  const r = await attempt(() => rpc("deck_pages", { current: S.name }), "Present");
  status("");
  if (!r) return;
  P.anim = false; P.pages = []; let start = 0;
  for (const s of r.slides) {
    if (s.scene === S.name && !fromStart) start = P.pages.length + (S.stop < s.pages.length ? S.stop : 0);
    for (const p of s.pages) P.pages.push({ scene: s.scene, img: p });
  }
  if (!P.pages.length) { toast("There is nothing to present yet.", true); return; }
  openPlayer(start);
}
handlers.present = m => {
  if (!P.anim) return;
  if (m.phase === "building") status(`Building animations ${m.done ?? ""}/${m.total ?? ""} ${m.scene || ""}`);
  else if (m.phase === "error") { status(""); toast("Could not build the animations: " + m.error, true); }
  else if (m.phase === "ready") {
    status("");
    P.pages = m.slides.map(s => ({ scene: s.scene, file: s.file, kind: s.kind, loop: s.loop, autoNext: s.autoNext, rate: s.rate || 1 }));
    let start = P.pages.findIndex(p => p.scene === P.wantScene);
    openPlayer(Math.max(0, start));
  }
};
function openPlayer(i) {
  const player = $("#player");
  player.classList.add("open");
  if (window.pywebview && pywebview.api) pywebview.api.set_fullscreen(true);
  else if (player.requestFullscreen) player.requestFullscreen().catch(() => {});
  showPage(i, true);
}
function showPage(i, play) {
  P.i = clamp(i, 0, P.pages.length - 1);
  const p = P.pages[P.i], img = $("#player-img"), vid = $("#player-video");
  $("#player-info").textContent = `${P.i + 1} / ${P.pages.length}`;
  if (p.img || p.kind === "image") {
    vid.pause(); vid.style.display = "none"; img.style.display = "block"; img.src = fileUrl(p.img || p.file);
  } else {
    img.style.display = "none"; vid.style.display = "block";
    vid.loop = !!p.loop; vid.src = fileUrl(p.file); vid.playbackRate = p.rate || 1;
    vid.onended = () => { if (p.autoNext && P.i < P.pages.length - 1) showPage(P.i + 1, true); };
    if (play) vid.play().catch(() => {});
    else vid.onloadedmetadata = () => { vid.currentTime = Math.max(0, vid.duration - 0.05); };
  }
}
function closePlayer() {
  $("#player").classList.remove("open"); $("#player-video").pause();
  if (window.pywebview && pywebview.api) pywebview.api.set_fullscreen(false);
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  const p = P.pages[P.i]; if (p && p.scene !== S.name) selectSlide(p.scene);
}
function playerKey(ev) {
  ev.preventDefault();
  if (ev.key === "Escape" || ev.key.toLowerCase() === "q") return closePlayer();
  if (["ArrowRight", "ArrowDown", " ", "Enter", "PageDown", "n"].includes(ev.key)) {
    const vid = $("#player-video"), p = P.pages[P.i];
    if (p && p.file && !p.img && p.kind !== "image" && !vid.loop && !vid.ended && !vid.paused) { vid.currentTime = vid.duration || 1e6; return; }   // skip to the build's end
    if (P.i < P.pages.length - 1) showPage(P.i + 1, true);
  } else if (["ArrowLeft", "ArrowUp", "Backspace", "PageUp", "p"].includes(ev.key)) { if (P.i > 0) showPage(P.i - 1, false); }
  else if (ev.key === "Home") showPage(0, true);
  else if (ev.key === "End") showPage(P.pages.length - 1, false);
}
$("#player").addEventListener("click", () => playerKey({ key: "ArrowRight", preventDefault() {} }));
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && $("#player").classList.contains("open")) closePlayer(); });

// ------------------------------------------------------------------ boot
async function pollStatus() {
  if (!S.info || !S.info.deck) return;
  try {
    const r = await rpc("app.status", {}, true);
    S.info.deck.modified = r.modified;
    $("#st-deck").classList.toggle("modified", r.modified);
    $("#btn-save").classList.toggle("primary", r.modified);
  } catch (e) { /* no deck */ }
}
async function boot() {
  cm = CodeMirror($("#code"), { mode: "python", theme: "material-darker", lineNumbers: true, indentUnit: 4, tabSize: 4,
    extraKeys: { "Ctrl-Enter": applyCode, Tab: c => c.execCommand("indentMore"), "Shift-Tab": c => c.execCommand("indentLess") } });
  $("#code-apply").onclick = applyCode;
  $("#code-revert").onclick = () => { if (S.scene) setCode(S.scene, true); };
  cm.on("change", () => { $("#code-apply").disabled = !codeDirty(); });
  await connect();
  applyInfo(await rpc("app.info"));
  if (S.info.deck) await refreshState();
  setInterval(() => { if (!document.hidden) { refreshState(); pollStatus(); } }, 2000);
  new ResizeObserver(() => { layoutFrame(); drawOverlay(); if (fit && $("#drawer").classList.contains("open")) fit.fit(); }).observe($("#stagewrap"));
  window.addEventListener("beforeunload", ev => { if (S.info && S.info.deck && S.info.deck.modified) { ev.preventDefault(); ev.returnValue = ""; } });
}
boot();
