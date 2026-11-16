/* Presenting: the full-screen show, and Presenter View (a console in this window, the show in an audience window).

   A page is one build of one slide: {scene, sn (slide number), bn (build number), builds, img | file, kind, loop,
   autoNext, rate, notes, buildNotes}. The presenter's window decides what is on screen and tells the audience
   window through the bridge's `app.relay`, so the two stay in step. */
"use strict";

const AUDIENCE = new URLSearchParams(location.search).get("view") === "audience";
const CID = Math.random().toString(36).slice(2);
const P = { pages: [], i: 0, anim: false, presenter: false, wantScene: null, t0: 0, black: false, tick: null, popup: null };

const playerDisplay = () => ({ img: $("#player-img"), vid: $("#player-video") });
const isClip = p => p && p.file && !p.img && p.kind !== "image";

/** Draw a page on a display. `play` runs a clip from its start; otherwise it shows the clip's last frame. */
function drawPage(d, p, play, onEnded) {
  const { img, vid } = d;
  if (!p) { img.style.display = "none"; vid.style.display = "none"; vid.pause(); return; }
  if (!isClip(p)) {
    vid.pause(); vid.style.display = "none"; img.style.display = "block";
    const u = fileUrl(p.img || p.file); if (img.dataset.u !== u) { img.dataset.u = u; img.src = u; }
  } else {
    img.style.display = "none"; vid.style.display = "block";
    vid.muted = true; vid.loop = !!p.loop && play; vid.onloadedmetadata = null; vid.onended = onEnded || null;
    vid.src = fileUrl(p.file); vid.playbackRate = p.rate || 1;
    if (play) vid.play().catch(() => {});
    else vid.onloadedmetadata = () => { vid.currentTime = Math.max(0, vid.duration - 0.05); };
  }
}
function skipClip(d) {            // jump to the end of a clip that is still playing; false when there was nothing to skip
  const v = d.vid;
  if (v.style.display !== "none" && !v.loop && !v.ended && !v.paused && v.duration) { v.currentTime = v.duration; return true; }
  return false;
}
const relay = m => rpc("app.relay", { m: { ...m, from: CID } }, true).catch(() => {});

// ------------------------------------------------------------ starting a show
async function present(fromStart, anim, presenter = false, scripted = false) {
  if (!S.name || showOpen()) return;
  P.presenter = presenter; P.scripted = scripted && !presenter; P.anim = anim; P.wantScene = fromStart ? null : S.name; P.wantStop = fromStart ? 0 : S.stop;
  if (anim) {
    status("Building the animations… this renders every slide with Manim and can take a while.");
    P.waiting = true;
    const r = await act("present", { height: 1080 }, "Present");
    if (!r) { status(""); P.waiting = false; }
    return;                                                 // the `present` event starts the show
  }
  status("Preparing the slides…");
  const r = await attempt(() => rpc("deck_pages", { current: S.name }), "Present");
  status("");
  if (!r) return;
  P.pages = [];
  r.slides.forEach((s, k) => s.pages.forEach((img, b) => P.pages.push({
    scene: s.scene, sn: k + 1, bn: b, builds: s.pages.length, img, notes: s.notes || "", buildNotes: (s.buildNotes || [])[b] || "" })));
  startShow();
}
handlers.present = m => {
  if (!P.waiting) return;
  if (m.phase === "building") status(`Building animations ${m.done ?? ""}/${m.total ?? ""} ${m.scene || ""}`);
  else if (m.phase === "error") { status(""); P.waiting = false; toast("Could not build the animations: " + m.error, true); }
  else if (m.phase === "ready") {
    status(""); P.waiting = false;
    const count = {};
    m.slides.forEach(s => { count[s.sceneIndex] = (count[s.sceneIndex] || 0) + 1; });
    const seen = {};
    P.pages = m.slides.map(s => {
      const bn = seen[s.sceneIndex] = (seen[s.sceneIndex] ?? -1) + 1;
      return { scene: s.scene, sn: s.sceneIndex + 1, bn, builds: count[s.sceneIndex], file: s.file, kind: s.kind, loop: s.loop,
        autoNext: s.autoNext, rate: s.rate || 1, notes: s.notes || "", buildNotes: s.buildNotes || "" };
    });
    startShow();
  }
};
function startShow() {
  if (!P.pages.length) { toast("There is nothing to present yet.", true); return; }
  let start = 0;
  if (P.wantScene) {
    const first = P.pages.findIndex(p => p.scene === P.wantScene);
    if (first >= 0) start = first + clamp(P.wantStop || 0, 0, P.pages[first].builds - 1);
  }
  P.black = false; P.t0 = Date.now();
  if (P.presenter) openPresenter(start); else openPlayer(start);
}
const showOpen = () => $("#player").classList.contains("open") || $("#presenter").classList.contains("open");

// ------------------------------------------------------------ the plain show
function openPlayer(i) {
  const player = $("#player");
  player.classList.add("open");
  if (window.pywebview && pywebview.api) pywebview.api.set_fullscreen(true);
  else if (player.requestFullscreen) player.requestFullscreen().catch(() => {});
  goTo(i, true);
}

// ------------------------------------------------------------ moving through it
function goTo(i, play) {
  P.i = clamp(i, 0, P.pages.length - 1);
  const p = P.pages[P.i];
  const ended = () => { if (p.autoNext && P.i < P.pages.length - 1) goTo(P.i + 1, true); else if (P.presenter) badge(); };
  if (P.presenter) { drawPresenter(play, ended); relay({ kind: "show", i: P.i, play }); }
  else {
    $("#player-info").textContent = `${P.i + 1} / ${P.pages.length}`;
    drawPage(playerDisplay(), p, play, P.scripted ? null : ended);
    if (P.scripted) scriptPage(p, play);                    // its script runs, then the show goes on by itself
  }
}
function step(d) {
  if (d > 0) {
    const live = P.presenter ? pvDisplay("#pv-cur") : playerDisplay();
    if (isClip(P.pages[P.i]) && skipClip(live)) { if (P.presenter) relay({ kind: "skip" }); return; }
    if (P.i < P.pages.length - 1) goTo(P.i + 1, true);
  } else if (P.i > 0) goTo(P.i - 1, false);
}
function nextSlide(d) {
  const sn = P.pages[P.i].sn;
  let j = d > 0 ? P.pages.findIndex((p, k) => k > P.i && p.sn !== sn) : P.pages.findIndex(p => p.sn === sn - 1);
  if (d < 0 && P.pages[P.i].bn > 0) j = P.pages.findIndex(p => p.sn === sn);
  if (j >= 0) goTo(j, d > 0);
}
function showKey(ev) {
  if (ev.target && ev.target.closest && ev.target.closest(".modal")) return;
  ev.preventDefault();
  const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  if (k === "Escape" || k === "q") return endShow();
  if (P.scripted && (k === " " || k === "k")) return scriptToggle();
  if (["ArrowRight", "ArrowDown", " ", "Enter", "PageDown"].includes(k)) step(1);
  else if (["ArrowLeft", "ArrowUp", "Backspace", "PageUp"].includes(k)) step(-1);
  else if (k === "n") nextSlide(1);
  else if (k === "p") nextSlide(-1);
  else if (k === "Home") goTo(0, true);
  else if (k === "End") goTo(P.pages.length - 1, false);
  else if (k === "b" || k === ".") blackOut();
  else if (k === "r") { if (P.presenter) { P.t0 = Date.now(); clock(); } else goTo(P.i, true); }
}
function blackOut() {
  P.black = !P.black;
  if (P.presenter) { relay({ kind: "black", on: P.black }); $("#pv-cur").classList.toggle("black", P.black); $("[data-act=pv-black]").classList.toggle("on", P.black); }
  else $("#player").classList.toggle("black", P.black);
}
function endShow() {
  const p = P.pages[P.i];
  if (P.presenter) {
    relay({ kind: "end" });
    rpc("app.audience_close", {}, true).catch(() => {});
    if (P.popup && !P.popup.closed) P.popup.close();
    P.popup = null;
    clearInterval(P.tick);
    $("#presenter").classList.remove("open");
    for (const s of ["#pv-cur", "#pv-next"]) pvDisplay(s).vid.pause();
  } else {
    if (P.scripted) { stopRun(); const a = $("#player-pointer .scriptpointer"); if (a) a.style.display = "none"; }
    P.scripted = false; P.stage = null;
    $("#player").classList.remove("open", "black", "paused"); $("#player-video").pause();
    if (window.pywebview && pywebview.api) pywebview.api.set_fullscreen(false);
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  P.presenter = false;
  if (p && p.scene !== S.name) selectSlide(p.scene);
}

// ------------------------------------------------------------ presenter view
const pvDisplay = sel => ({ img: $(sel + " img"), vid: $(sel + " video") });
async function openPresenter(i) {
  $("#presenter").classList.add("open");
  $("#pv-cur").classList.remove("black"); $("[data-act=pv-black]").classList.remove("on");
  buildList();
  clearInterval(P.tick); P.tick = setInterval(clock, 500); clock();
  goTo(i, true);
  const r = await attempt(() => rpc("app.audience_open"), "Presenter View");
  if (r && r.popup) {                    // no desktop window (the server run on its own): a browser window instead
    P.popup = window.open(`/?t=${encodeURIComponent(T)}&view=audience`, "manimble-audience", "width=960,height=540");
    if (!P.popup) toast("The browser blocked the audience window. Allow pop-ups for this page and start again.", true);
  }
  $("#pv-hint").textContent = r && r.windowed ? (r.second ? "The show is on your other display." :
    "One display found: the show is in its own window. Drag it to the screen your audience sees.") : "";
}
function buildList() {
  const thumbs = Object.fromEntries((S.state ? S.state.scenes : []).map(s => [s.name, s.thumb]));
  const kids = [];
  let cur = null;
  P.pages.forEach((p, k) => {
    if (!cur || cur.dataset.sn !== String(p.sn)) {
      cur = el("div", { className: "pv-slide" });
      cur.dataset.sn = p.sn;
      const im = thumbs[p.scene] ? el("img", { src: fileUrl(thumbs[p.scene]), draggable: false }) : el("div", { className: "ph" });
      im.onclick = () => goTo(k, true);
      cur.append(im, el("div", { className: "cap" }, el("span", { className: "n", textContent: String(p.sn) }), el("span", { className: "nm", textContent: p.scene })),
        el("div", { className: "chips" }));
      kids.push(cur);
    }
    if (p.builds > 1) {
      const c = el("button", { className: "chip", textContent: String(p.bn + 1), onclick: () => goTo(k, true) });
      c.dataset.k = k;
      $(".chips", cur).append(c);
    }
  });
  $("#pv-list").replaceChildren(...kids);
}
function drawPresenter(play, ended) {
  const p = P.pages[P.i], next = P.pages[P.i + 1];
  drawPage(pvDisplay("#pv-cur"), p, play, ended);
  drawPage(pvDisplay("#pv-next"), next, false);
  $("#pv-next").classList.toggle("none", !next);
  $("#pv-nextlabel").textContent = !next ? "End of the show" : next.sn !== p.sn ? `Next · slide ${next.sn}` : `Next · build ${next.bn + 1} of ${next.builds}`;
  $("#pv-notes").textContent = p.notes || ""; $("#pv-notes").classList.toggle("empty", !p.notes);
  $("#pv-bnotes").textContent = p.buildNotes || ""; $("#pv-bnotes").classList.toggle("empty", !p.buildNotes);
  $("#pv-count").textContent = `Slide ${p.sn} of ${P.pages[P.pages.length - 1].sn}` + (p.builds > 1 ? ` · build ${p.bn + 1} of ${p.builds}` : "");
  $$("#pv-list .pv-slide").forEach(s => s.classList.toggle("sel", s.dataset.sn === String(p.sn)));
  $$("#pv-list .chip").forEach(c => c.classList.toggle("on", c.dataset.k === String(P.i)));
  const sel = $("#pv-list .pv-slide.sel"); if (sel) sel.scrollIntoView({ block: "nearest" });
  badge();
}
function badge() {
  const v = $("#pv-cur video"), p = P.pages[P.i], b = $("#pv-badge");
  b.textContent = !isClip(p) ? "" : v.loop ? "looping" : (v.paused || v.ended) ? "done" : "playing";
  if (isClip(p) && !v.paused && !v.ended) setTimeout(badge, 400);
}
function clock() {
  const s = Math.floor((Date.now() - P.t0) / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  $("#pv-timer").textContent = (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s % 60).padStart(2, "0");
  $("#pv-clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
async function swapDisplays() {
  const r = await attempt(() => rpc("app.audience_swap"), "Swap Displays");
  if (r && r.ok === false) toast(r.error || "Swap Displays needs a second display.", true);
}
handlers.relay = ev => {
  const m = ev.m || {};
  if (m.from === CID) return;
  if (AUDIENCE) return audienceGot(m);
  if (!P.presenter) return;
  if (m.kind === "ready") relay({ kind: "load", pages: P.pages, i: P.i, black: P.black });
  else if (m.kind === "key") showKey({ key: m.key, preventDefault() {} });
};

// ------------------------------------------------------------ the audience window
function audienceGot(m) {
  if (m.kind === "load") { P.pages = m.pages; drawPage(playerDisplay(), P.pages[m.i], false); $("#player").classList.toggle("black", !!m.black); }
  else if (m.kind === "show") drawPage(playerDisplay(), P.pages[m.i], m.play);
  else if (m.kind === "skip") skipClip(playerDisplay());
  else if (m.kind === "black") $("#player").classList.toggle("black", !!m.on);
  else if (m.kind === "end") { P.pages = []; drawPage(playerDisplay(), null); window.close(); }
}
async function bootAudience() {
  document.body.classList.add("audience");
  document.title = "Manimble Show";
  $("#player").classList.add("open");
  await connect();
  document.addEventListener("keydown", ev => { ev.preventDefault(); relay({ kind: "key", key: ev.key }); });
  document.addEventListener("click", () => relay({ kind: "key", key: "ArrowRight" }));
  document.addEventListener("contextmenu", ev => { ev.preventDefault(); relay({ kind: "key", key: "ArrowLeft" }); });
  relay({ kind: "ready" });
}

// ------------------------------------------------------------ wiring
$("#player").addEventListener("click", () => { if (!AUDIENCE) step(1); });
$("#player").addEventListener("contextmenu", ev => { ev.preventDefault(); if (!AUDIENCE) step(-1); });
document.addEventListener("fullscreenchange", () => { if (!AUDIENCE && !document.fullscreenElement && $("#player").classList.contains("open")) endShow(); });
$("#pv-cur").addEventListener("click", () => step(1));
$("#pv-cur").addEventListener("contextmenu", ev => { ev.preventDefault(); step(-1); });
$("#pv-timer").addEventListener("click", () => { P.t0 = Date.now(); clock(); });

if (AUDIENCE) bootAudience(); else boot();
