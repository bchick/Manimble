/* Edit-menu tools: deck themes (and the themed New Deck dialog), and find and replace.
   Both are thin UI over engine requests: `theme` (engine/manimble/theme.py) and `find` / `replace` (find.py). */
"use strict";

/** A modal with custom content. `build(close)` returns the nodes to show; resolves with what `close(value)` is given. */
function dialogBox(build, wide = false) {
  return new Promise(resolve => {
    const box = el("div", { className: "modal" + (wide ? " wide" : "") });
    const back = el("div", { className: "modalback" }, box);
    const close = v => { back.remove(); resolve(v); };
    box.append(...build(close));
    back.onmousedown = ev => { if (ev.target === back) close(null); };
    back.addEventListener("keydown", ev => { ev.stopPropagation(); if (ev.key === "Escape") close(null); });
    document.body.append(back);
    const first = $("input, select, button.primary", box); if (first) first.focus();
  });
}

// ------------------------------------------------------------------ themes
let themeList = null;
async function loadThemes() {
  if (!themeList) themeList = (await rpc("app.themes")).themes;
  return themeList;
}
function themeCard(t) {
  const c = el("button", { className: "themecard", title: t.font || "" });
  const sw = el("div", { className: "sw" }, el("b", { textContent: "Title" }), el("u"), el("i", { textContent: "Subtitle text" }));
  sw.style.background = t.background; sw.style.fontFamily = `"${t.font}", "Segoe UI", sans-serif`;
  $("b", sw).style.color = t.text; $("i", sw).style.color = t.muted; $("u", sw).style.background = t.accent;
  c.append(sw, el("div", { className: "nm", textContent: t.name }));
  return c;
}

async function chooseTheme() {
  if (!S.name) return;
  const list = await attempt(loadThemes, "Themes"); if (!list) return;
  const scene = S.name;
  const cur = await attempt(() => rpc("theme", { op: "get", current: scene }, true)) || {};
  let chosen = list.find(t => t.name === (cur.slide_theme || cur.theme)) || list[0];
  const crosses = {}, previews = {};
  let gen = 0;

  const picked = await dialogBox(close => {
    const grid = el("div", { className: "themegrid" });
    const img = el("img", { alt: "" }), err = el("div", { className: "err" });
    const prev = el("div", { className: "themeprev" }, img, err);
    const one = el("input", { type: "checkbox" }), flip = el("input", { type: "checkbox", checked: true });
    const flipRow = el("label", {}, flip, "Swap whites and blacks, so plain white or black text stays readable");
    const detail = el("div", { className: "detail" });
    const apply = el("button", { className: "primary", textContent: "Apply" }), cancel = el("button", { textContent: "Cancel" });
    err.style.display = "none"; flipRow.style.display = "none";

    const flipping = () => flipRow.style.display !== "none" && flip.checked;
    async function preview() {
      const key = `${chosen.id}|${one.checked}|${flipping()}`, g = ++gen;
      err.style.display = "none";
      if (previews[key]) { img.src = previews[key]; prev.classList.remove("loading"); return; }
      prev.classList.add("loading");
      let r;
      try { r = await rpc("theme", { op: "preview", theme: chosen.id, scene, slide_only: one.checked, flip: flipping() }, true); }
      catch (e) { r = { ok: false, error: e.message }; }
      if (g !== gen) return;
      prev.classList.remove("loading");
      if (r.ok && r.png) { previews[key] = fileUrl(r.png) + "&v=" + Date.now(); img.src = previews[key]; }
      else { err.textContent = "This slide does not render with the theme:\n" + (r.error || ""); err.style.display = "block"; }
    }
    async function changed() {
      $$(".themecard", grid).forEach(c => c.classList.toggle("sel", c.dataset.id === chosen.id));
      detail.textContent = one.checked
        ? "This slide gets the theme's background, and its own code uses the theme's font and colours; helpers shared with other slides keep the deck's. Choosing the deck's own theme here takes the slide back to the deck's."
        : "The deck's font, text colour and accent (FONT, TEXT_COLOR, MUTED_COLOR, ACCENT) and its background are set to the theme's. Every slide is re-rendered. Undo reverts it in one step.";
      if (crosses[chosen.id] === undefined) {
        const id = chosen.id;
        const r = await attempt(() => rpc("theme", { op: "get", theme: id, current: scene }, true));
        crosses[id] = !!(r && r.crosses);
        if (chosen.id !== id) return;
      }
      flipRow.style.display = !one.checked && crosses[chosen.id] ? "flex" : "none";
      preview();
    }
    for (const t of list) {
      const c = themeCard(t); c.dataset.id = t.id;
      c.onclick = () => { chosen = t; changed(); };
      c.ondblclick = () => apply.click();
      grid.append(c);
    }
    one.onchange = changed; flip.onchange = preview;
    apply.onclick = () => close({ theme: chosen, slideOnly: one.checked, flip: flipping() });
    cancel.onclick = () => close(null);
    changed();
    return [el("div", { className: "msg", textContent: "Theme" + (cur.theme ? ` · the deck uses ${cur.theme}` : "") }),
      el("div", { className: "themes" }, grid, el("div", { className: "themeside" }, prev, el("label", {}, one, "This slide only"), flipRow, detail,
        el("div", { className: "row" }, el("span", { className: "spacer" }), cancel, apply)))];
  }, true);
  if (!picked) return;

  status(`Applying the ${picked.theme.name} theme…`);
  const r = await act("theme", { theme: picked.theme.id, flip: picked.flip, slide_only: picked.slideOnly, current: scene }, "Theme");
  status("");
  if (!r) return;
  toast(r.message === "no change" ? (picked.slideOnly ? "The slide already has this theme" : "The deck already has this theme")
    : `${picked.theme.name} theme applied` + (picked.slideOnly ? " to this slide" : ""));
  S.thumbKey = "";
  await refreshState();
  await loadScene(true);
}
handlers.darkmode = m => { if (m.phase === "building") status(`Recolouring ${m.done ?? ""}/${m.total ?? ""} ${m.scene || ""}`); };
actions.themes = chooseTheme;

// New Deck, with a theme to start from
actions.new = async () => {
  const list = await attempt(loadThemes, "Themes") || [];
  const r = await dialogBox(close => {
    const name = el("input", { type: "text", value: "My Deck", spellcheck: false });
    const grid = el("div", { className: "themegrid" }); grid.style.gridTemplateColumns = "repeat(4, 1fr)";
    let chosen = list[0] ? list[0].id : null;
    for (const t of list) {
      const c = themeCard(t); c.classList.toggle("sel", t.id === chosen);
      c.onclick = () => { chosen = t.id; $$(".themecard", grid).forEach(x => x.classList.toggle("sel", x === c)); };
      grid.append(c);
    }
    const ok = el("button", { className: "primary", textContent: "Choose Folder…" }), cancel = el("button", { textContent: "Cancel" });
    ok.onclick = () => { if (name.value.trim()) close({ name: name.value.trim(), theme: chosen }); };
    cancel.onclick = () => close(null);
    name.addEventListener("keydown", ev => { if (ev.key === "Enter") ok.click(); });
    return [el("div", { className: "msg", textContent: "Name of the new deck" }), name, el("div", { className: "msg", textContent: "Theme" }), grid,
      el("div", { className: "row", style: "margin-top:14px" }, el("span", { className: "spacer" }), cancel, ok)];
  }, true);
  if (!r) return;
  const info = await attempt(() => rpc("app.new_deck", r), "New deck");
  if (info && !info.cancelled) deckOpened(info);
};

// ------------------------------------------------------- find and replace
const F = { matches: [], i: -1, timer: null, gen: 0, key: "" };
const findOpts = () => ({ query: $("#find-q").value, case: $("#find-case").checked, word: $("#find-word").checked,
  regex: $("#find-regex").checked, notes: $("#find-notes").checked });

function openFind(replace) {
  if (!S.info || !S.info.deck) return;
  const bar = $("#findbar");
  bar.classList.add("open"); bar.classList.toggle("replace", !!replace || bar.classList.contains("replace") && replace !== false);
  layoutFrame();
  const q = $("#find-q"); q.focus(); q.select();
  if (q.value) runFind(false);
}
function closeFind() {
  $("#findbar").classList.remove("open"); F.matches = []; F.i = -1; layoutFrame(); drawOverlay();
}
/** Search again. `keep` stays on the match at the same place in the list (after a replace); otherwise the first
    match on or after the slide on screen is chosen, without leaving it until the user steps. */
async function runFind(keep) {
  const o = findOpts(), g = ++F.gen;
  const count = $("#find-count"), note = $("#find-note");
  note.textContent = "";
  if (!o.query) { F.matches = []; F.i = -1; count.textContent = ""; count.classList.remove("none"); return; }
  let r;
  try { r = await rpc("find", o, true); } catch (e) { r = { ok: false, error: e.message }; }
  if (g !== F.gen) return;
  if (!r.ok) { F.matches = []; F.i = -1; count.textContent = "error"; count.classList.add("none"); note.textContent = r.error || ""; return; }
  F.matches = r.matches || [];
  if (!F.matches.length) { F.i = -1; count.textContent = "No matches"; count.classList.add("none"); return; }
  count.classList.remove("none");
  if (keep) F.i = clamp(F.i, 0, F.matches.length - 1);
  else {
    const order = S.state ? S.state.scenes.map(s => s.name) : [], here = order.indexOf(S.name);
    const j = F.matches.findIndex(m => order.indexOf(m.scene) >= here);
    F.i = j >= 0 ? j : 0;
  }
  showCount();
  if (keep) await gotoMatch();
}
function showCount() {
  const m = F.matches[F.i];
  $("#find-count").textContent = F.matches.length ? `${F.i + 1} of ${F.matches.length}` : "";
  $("#find-note").textContent = !m ? "" : m.kind === "notes" ? "in the slide's notes" : m.kind === "buildNotes" ? "in a build's notes"
    : m.editable === false ? "made by code: Replace skips it" : "";
}
async function gotoMatch() {
  const m = F.matches[F.i]; if (!m) return;
  showCount();
  if (m.scene !== S.name) {
    if (codeDirty() && !await confirmBox("Discard the code you typed for this slide?", "Discard")) return;
    S.name = m.scene; S.scene = null; S.sel.clear(); S.thumbKey = "";
    renderNav();
    await loadScene(true);
  }
  if (!S.scene) return;
  S.stop = clamp(m.stop || 0, 0, Math.max(0, S.scene.stops.length - 1));
  S.sel.clear();
  if (m.oid >= 0 && S.scene.objects[m.oid]) S.sel.add(m.oid);
  renderScene();
}
async function findStep(d) {
  if (!F.matches.length) { await runFind(false); if (!F.matches.length) return; return gotoMatch(); }
  const on = F.matches[F.i], shown = on && on.scene === S.name && (on.oid < 0 || S.sel.has(on.oid));
  if (shown || d < 0) F.i = (F.i + d + F.matches.length) % F.matches.length;      // the first Enter shows the match found
  await gotoMatch();
}
async function replaceOne() {
  if (!F.matches.length) await runFind(false);
  const m = F.matches[F.i]; if (!m) return;
  if (m.editable === false) { toast("This text is made by code, so it cannot be replaced here. Edit it in the code pane.", true); return; }
  const r = await act("replace", { ...findOpts(), replacement: $("#find-r").value, scene: m.scene, oid: m.oid, index: m.index, stop: m.stop, kind: m.kind }, "Replace");
  if (!r) return;
  S.thumbKey = "";
  await refreshState();
  if (m.scene === S.name) await loadScene(true);
  await runFind(true);
}
async function replaceAll() {
  const o = findOpts(); if (!o.query) return;
  if (!F.matches.length) await runFind(false);
  if (!F.matches.length) return;
  if (!await confirmBox(`Replace every match of "${o.query}" with "${$("#find-r").value}" in the whole deck?`, "Replace All")) return;
  const r = await act("replace", { ...o, replacement: $("#find-r").value, all: true }, "Replace All");
  if (!r) return;
  toast(r.message || `Replaced ${r.count} match${r.count === 1 ? "" : "es"}` + (r.skipped ? `, skipped ${r.skipped} made by code` : ""));
  S.thumbKey = "";
  await refreshState();
  await loadScene(true);
  await runFind(false);
}
Object.assign(actions, {
  find: () => openFind(false), "find-replace": () => openFind(true), "find-close": closeFind,
  "find-next": () => findStep(1), "find-prev": () => findStep(-1), "find-replace-one": replaceOne, "find-replace-all": replaceAll,
});
$("#find-q").addEventListener("input", () => { clearTimeout(F.timer); F.timer = setTimeout(() => runFind(false), 250); });
for (const id of ["case", "word", "regex", "notes"]) $("#find-" + id).addEventListener("change", () => runFind(false));
$("#findbar").addEventListener("keydown", ev => {
  if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeFind(); }
  else if (ev.key === "Enter") {
    ev.preventDefault(); ev.stopPropagation();
    if (ev.target.id === "find-r") replaceOne(); else { clearTimeout(F.timer); (F.matches.length ? Promise.resolve() : runFind(false)).then(() => findStep(ev.shiftKey ? -1 : 1)); }
  }
});
document.addEventListener("keydown", ev => {
  if (!(ev.ctrlKey || ev.metaKey) || showOpen() || $(".modalback")) return;
  const k = ev.key.toLowerCase();
  if (k !== "f" && k !== "h") return;
  if (ev.target.closest && ev.target.closest("#term")) return;                 // the terminal keeps its own Ctrl+F / Ctrl+H
  ev.preventDefault(); ev.stopPropagation();
  openFind(k === "h");
}, true);

// ------------------------------------------------------- movie export options
/** Size, and whether to include the script (offered when the deck has one). Null when cancelled. */
async function movieOptions() {
  await ensureScript();
  const scripted = SC.data.steps.length > 0;
  return dialogBox(close => {
    const size = el("select", {}, ...[[720, "1280 × 720"], [1080, "1920 × 1080"], [1440, "2560 × 1440"], [2160, "3840 × 2160"]].map(([h, t]) => el("option", { value: h, textContent: t, selected: h === 1080 })));
    const withScript = el("input", { type: "checkbox", checked: scripted, disabled: !scripted });
    const ok = el("button", { className: "primary", textContent: "Choose File…" }), cancel = el("button", { textContent: "Cancel" });
    ok.onclick = () => close({ height: +size.value, script: scripted && withScript.checked });
    cancel.onclick = () => close(null);
    return [el("div", { className: "msg", textContent: "Export Movie" }), size,
      el("label", { className: "check" }, withScript, "Export with script"),
      el("div", { className: "detail", textContent: scripted
        ? "Each build's clip plays, then its last frame is held while its script runs: the narration becomes the movie's soundtrack and the pointer is drawn over the slide."
        : "This deck has no script, so every build is held for two seconds. Write one with the Script button to narrate the movie." }),
      el("div", { className: "row" }, el("span", { className: "spacer" }), cancel, ok)];
  });
}
