"""The bridge between the web front end and the Manimble engine.

One local HTTP server (127.0.0.1 only, guarded by a random token):

    /            the editor (static files in web/)
    /ws          JSON messages: engine requests are forwarded as they are (docs/developers/protocol.md), requests
                 whose cmd starts with "app." are handled here (open, save, dialogs, PDF ...); engine events are pushed
    /file?p=     pictures and clips the engine made (only from the working copy, the cache and the temp folder)
    /term        a terminal (ConPTY through pywinpty) running in the working copy
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from aiohttp import WSMsgType, web

from . import workspace as wsmod
from .workspace import Workspace

HERE = Path(__file__).resolve().parent
WEB = HERE / "web"
REPO = HERE.parents[2]
ENGINE = REPO / "engine"
VERSION = (REPO / "VERSION").read_text().strip() if (REPO / "VERSION").exists() else "dev"

DIALOG = r"""
import sys, json, tkinter as tk
from tkinter import filedialog
a = json.loads(sys.argv[1])
r = tk.Tk(); r.withdraw(); r.attributes('-topmost', True); r.update()
k = {x: a[x] for x in ('title', 'initialdir', 'initialfile', 'defaultextension') if a.get(x)}
if a.get('filetypes'): k['filetypes'] = [tuple(t) for t in a['filetypes']]
if a['kind'] == 'dir':
    k.pop('initialfile', None); k.pop('defaultextension', None); k.pop('filetypes', None)
    p = filedialog.askdirectory(parent=r, mustexist=True, **k)
elif a['kind'] == 'save': p = filedialog.asksaveasfilename(parent=r, **k)
else: p = filedialog.askopenfilename(parent=r, **k)
sys.stdout.reconfigure(encoding='utf-8'); print(json.dumps(p or ''))
"""

NEW_COMMON = '''"""Shared base class for the deck."""

from pathlib import Path

from manim import *
from manim_slides import Slide

ASSETS = Path(__file__).resolve().parent.parent / "assets"


class Deck(Slide):
    skip_reversing = True
'''

NEW_SLIDES = '''"""Slides of the deck."""

from common import *


class Title(Deck):
    def construct(self):
        title = Text({title}, font_size=64).move_to((0, 0.7, 0))  # manimble
        self.add(title)  # manimble
        subtitle = Text("Subtitle", font_size=32, color=GREY_B).move_to((0, -0.8, 0))  # manimble
        self.add(subtitle)  # manimble
'''

NEW_CFG = "[CLI]\nbackground_color = #000000\npixel_width = 1280\npixel_height = 720\nframe_rate = 30\n"

THEMES = ENGINE / "manimble" / "themes"
# What stands in on Windows for the macOS fonts the themes name (the engine's theme.py holds the same table).
WINDOWS_FONTS = {"Helvetica Neue": "Segoe UI", "Avenir Next": "Segoe UI", "Chalkboard SE": "Comic Sans MS",
                 "Palatino": "Palatino Linotype", "Menlo": "Consolas"}


def themes() -> list[dict]:
    """The engine's deck themes: [{id, name, background, font, text, muted, accent}], Midnight (the default) first."""
    import ast
    out = []
    for f in sorted(THEMES.glob("*.py")):
        v = {}
        try:
            for st in ast.parse(f.read_text(encoding="utf-8")).body:
                if (isinstance(st, ast.Assign) and len(st.targets) == 1 and isinstance(st.targets[0], ast.Name)
                        and isinstance(st.value, ast.Constant)):
                    v[st.targets[0].id] = st.value.value
        except (OSError, SyntaxError):
            continue
        if "THEME" in v and "BACKGROUND" in v:
            out.append({"id": f.stem, "name": v["THEME"], "background": v["BACKGROUND"],
                        "font": WINDOWS_FONTS.get(v.get("FONT"), v.get("FONT")), "text": v.get("TEXT_COLOR", "#FFFFFF"),
                        "muted": v.get("MUTED_COLOR", "#888888"), "accent": v.get("ACCENT", "#4C8DFF")})
    out.sort(key=lambda t: (t["id"] != "midnight", t["name"]))
    return out


def theme_source(theme_id: str) -> str:
    """A theme's common.py for a new deck, with its font replaced by one Windows has."""
    import re
    if not re.fullmatch(r"[\w-]+", theme_id) or not (THEMES / f"{theme_id}.py").is_file():
        raise RuntimeError(f"no theme {theme_id}")
    src = (THEMES / f"{theme_id}.py").read_text(encoding="utf-8")
    for mac, win in WINDOWS_FONTS.items():
        src = src.replace(f'FONT = "{mac}"', f'FONT = "{win}"')
    return src


NEW_SLIDES_THEMED = '''"""Slides of the deck."""

from common import *


class Title(Deck):
    def construct(self):
        title = Text({title}, font_size=64, font=FONT, color=TEXT_COLOR).move_to((0, 0.7, 0))  # manimble
        self.add(title)  # manimble
        subtitle = Text("Subtitle", font_size=32, font=FONT, color=MUTED_COLOR).move_to((0, -0.8, 0))  # manimble
        self.add(subtitle)  # manimble
'''

IMAGE_TYPES = [["Pictures", "*.png *.jpg *.jpeg *.gif *.tif *.tiff *.bmp *.webp *.svg"], ["All files", "*.*"]]


class Engine:
    """The engine process: JSON lines on its stdin/stdout, replies matched to futures by id."""

    def __init__(self, loop: asyncio.AbstractEventLoop, on_event):
        self.loop, self.on_event = loop, on_event
        self.proc: subprocess.Popen | None = None
        self.pending: dict[int, asyncio.Future] = {}
        self.seq = 0
        self.wlock = threading.Lock()
        self.log = wsmod.base() / "engine.log"

    def start(self):
        if self.proc and self.proc.poll() is None:
            return
        env = dict(os.environ, PYTHONPATH=str(ENGINE), MANIMBLE_PYTHON=sys.executable, PYTHONUTF8="1",
                   PYTHONIOENCODING="utf-8")
        err = open(self.log, "ab", buffering=0)
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "manimble.rpc"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err,
            text=True, encoding="utf-8", bufsize=1, env=env, cwd=str(ENGINE),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        threading.Thread(target=self._read, args=(self.proc,), daemon=True).start()

    def _read(self, proc):
        for line in proc.stdout:
            try:
                m = json.loads(line)
            except ValueError:
                continue
            self.loop.call_soon_threadsafe(self._got, m)
        self.loop.call_soon_threadsafe(self._died, proc)

    def _got(self, m: dict):
        if "id" in m and m["id"] in self.pending:
            fut = self.pending.pop(m["id"])
            if not fut.done():
                fut.set_result(m)
        elif "event" in m:
            self.on_event(m)

    def _died(self, proc):
        if proc is not self.proc:
            return
        for fut in self.pending.values():
            if not fut.done():
                fut.set_result({"error": "The engine stopped. See " + str(self.log)})
        self.pending.clear()
        self.on_event({"event": "engine_died"})

    async def raw(self, req: dict) -> dict:
        """Send a request; the reply as {"result": ...} or {"error": ...}."""
        self.start()
        self.seq += 1
        i = self.seq
        fut = self.loop.create_future()
        self.pending[i] = fut
        line = json.dumps({**req, "id": i}) + "\n"

        def write():
            with self.wlock:
                self.proc.stdin.write(line)
                self.proc.stdin.flush()
        try:
            await asyncio.to_thread(write)
        except OSError as exc:
            self.pending.pop(i, None)
            return {"error": f"The engine is not running ({exc})"}
        return await fut

    async def call(self, cmd: str, **args):
        r = await self.raw({"cmd": cmd, **args})
        if "error" in r:
            raise RuntimeError(r["error"])
        return r["result"]

    def stop(self):
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.stdin.close()
                self.proc.wait(timeout=3)
            except Exception:  # noqa: BLE001
                self.proc.kill()


class App:
    def __init__(self, token: str | None = None):
        self.token = token or secrets.token_urlsafe(24)
        self.clients: set[web.WebSocketResponse] = set()
        self.workspace: Workspace | None = None
        self.engine: Engine | None = None
        self.port = 0
        self.recent_file = wsmod.base() / "recent.json"
        self.audience = None        # set by the desktop app: opens, closes and swaps the audience window

    # ------------------------------------------------------------ plumbing
    def broadcast(self, m: dict):
        s = json.dumps(m)
        for c in list(self.clients):
            asyncio.ensure_future(self._send(c, s))

    async def _send(self, c, s):
        try:
            await c.send_str(s)
        except Exception:  # noqa: BLE001
            self.clients.discard(c)

    def authed(self, request: web.Request) -> bool:
        if not secrets.compare_digest(request.query.get("t", ""), self.token):
            return False
        origin = request.headers.get("Origin")
        return origin is None or origin in (f"http://127.0.0.1:{self.port}", f"http://localhost:{self.port}")

    def allowed(self, path: str) -> bool:
        """Only what Manimble made is served: files in its own folder (working copies, caches) and the temp folder.
        Both spellings of a root count, since Windows can show an app's data folder under a redirected path."""
        p = os.path.normcase(os.path.abspath(path))
        roots = set()
        for r in (wsmod.base(), Path(tempfile.gettempdir())):
            roots.add(os.path.normcase(os.path.abspath(r)))
            roots.add(os.path.normcase(os.path.realpath(r)))
        return any(p.startswith(r + os.sep) for r in roots)

    # ------------------------------------------------------------ helpers
    async def dialog(self, kind: str, **opts) -> str:
        def run():
            r = subprocess.run([sys.executable, "-c", DIALOG, json.dumps({"kind": kind, **opts})],
                               capture_output=True, text=True, encoding="utf-8",
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            try:
                return json.loads(r.stdout.strip().splitlines()[-1])
            except Exception:  # noqa: BLE001
                raise RuntimeError("The file dialog failed: " + (r.stderr.strip()[-300:] or "no output"))
        p = await asyncio.to_thread(run)
        return os.path.normpath(p) if p else ""

    def recent(self) -> list[str]:
        try:
            return [p for p in json.loads(self.recent_file.read_text(encoding="utf-8")) if os.path.isdir(p)][:10]
        except Exception:  # noqa: BLE001
            return []

    def remember(self, deck: str):
        r = [deck] + [p for p in self.recent() if os.path.normcase(p) != os.path.normcase(deck)]
        try:
            self.recent_file.write_text(json.dumps(r[:10]), encoding="utf-8")
        except OSError:
            pass

    def info(self) -> dict:
        w = self.workspace
        d = None
        if w:
            changed = w.changed_files
            d = {"original": str(w.original), "work": str(w.work), "name": w.original.parent.name
                 if w.original.name == "deck" else w.original.name, "modified": bool(changed), "changed": changed}
        return {"version": VERSION, "deck": d, "recent": self.recent(), "python": sys.executable,
                "sample": str(REPO / "examples" / "hello" / "deck")}

    @staticmethod
    def find_deck(path: str) -> str:
        """The deck folder for what the user picked: the folder itself, or its `deck` subfolder."""
        p = Path(path)
        if not any(p.glob("*.py")) and (p / "deck").is_dir():
            p = p / "deck"
        if not any(p.glob("*.py")):
            raise RuntimeError(f"No slides found in {path}: a deck is a folder of Python files (often named 'deck').")
        return str(p)

    async def open_deck(self, path: str) -> dict:
        deck = self.find_deck(path)
        new = await asyncio.to_thread(Workspace, deck)
        try:
            await self.engine.call("open", deck=str(new.work), cache=str(wsmod.cache_dir(new.original)))
        except Exception:
            await asyncio.to_thread(new.discard)
            raise
        old, self.workspace = self.workspace, new
        if old:
            await asyncio.to_thread(old.discard)
        self.remember(str(new.original))
        self.broadcast({"event": "deck_changed"})
        return self.info()

    # ------------------------------------------------------- app commands
    async def app_cmd(self, cmd: str, a: dict):
        w = self.workspace
        if cmd == "app.info":
            return self.info()
        if cmd == "app.themes":
            return {"themes": themes()}
        if cmd == "app.relay":                  # one window to the others: the presenter tells the audience window
            self.broadcast({"event": "relay", "m": a.get("m")})
            return {"ok": True}
        if cmd in ("app.audience_open", "app.audience_close", "app.audience_swap"):
            if self.audience is None:           # no desktop window: the page opens a browser window itself
                return {"popup": True}
            return await asyncio.to_thread(self.audience, cmd.rsplit("_", 1)[1])
        if cmd == "app.open":
            path = a.get("path") or await self.dialog("dir", title="Open a deck folder")
            if not path:
                return {"cancelled": True}
            return await self.open_deck(path)
        if cmd == "app.new_deck":
            name = (a.get("name") or "").strip() or "My Deck"
            parent = a.get("parent") or await self.dialog("dir", title=f"Choose where to make the '{name}' project folder")
            if not parent:
                return {"cancelled": True}
            deck = Path(parent) / name / "deck"
            if deck.exists():
                raise RuntimeError(f"{deck.parent} already exists")
            deck.mkdir(parents=True)
            (deck.parent / "assets").mkdir(exist_ok=True)
            theme = next((t for t in themes() if t["id"] == a.get("theme")), None)
            common = theme_source(theme["id"]) if theme else NEW_COMMON
            slides = (NEW_SLIDES_THEMED if theme else NEW_SLIDES).format(title=json.dumps(name))
            cfg = NEW_CFG.replace("#000000", theme["background"]) if theme else NEW_CFG
            (deck / "common.py").write_text(common, encoding="utf-8", newline=chr(10))
            (deck / "slides.py").write_text(slides, encoding="utf-8", newline=chr(10))
            (deck / "order.txt").write_text("Title\n", encoding="utf-8")
            (deck / "manim.cfg").write_text(cfg, encoding="utf-8", newline=chr(10))
            return await self.open_deck(str(deck))
        if cmd == "app.dialog":
            return {"path": await self.dialog(a.get("kind", "open"), **{k: v for k, v in a.items()
                                                                       if k in ("title", "filetypes", "initialfile",
                                                                                "defaultextension", "initialdir")})}
        if cmd == "app.import":
            src = a.get("src") or await self.dialog("open", title="Import a presentation", filetypes=[
                ["Presentations", "*.pptx *.tex *.ltx"], ["All files", "*.*"]])
            if not src:
                return {"cancelled": True}
            dest = Path(src).with_suffix("")
            n = 1
            while dest.exists():
                n += 1
                dest = Path(src).with_name(f"{Path(src).stem} {n}")
            self.engine.start()
            await self.engine.call("import", src=src, dest=str(dest))
            return {"ok": True, "dest": str(dest)}
        if w is None:
            raise RuntimeError("no deck open")
        if cmd == "app.script_get":             # the presentation script: script.json beside the deck's code
            f = w.work / "script.json"
            try:
                return {"script": json.loads(f.read_text(encoding="utf-8")) if f.is_file() else None}
            except ValueError as exc:
                raise RuntimeError(f"script.json cannot be read: {exc}")
        if cmd == "app.script_set":
            f, d = w.work / "script.json", a.get("script") or {}
            plain = not d.get("steps") and all(d.get(k) is None for k in ("voice", "winVoice", "rate", "hold"))
            if plain and "script.json" not in w.baseline:       # nothing in it, and the deck had none: leave no file
                f.unlink(missing_ok=True)
            else:
                f.write_text(json.dumps({**d, "version": d.get("version", 1)}, indent=2, sort_keys=True,
                                        ensure_ascii=False) + "\n", encoding="utf-8", newline=chr(10))
            return {"ok": True}
        if cmd == "app.status":
            changed = w.changed_files
            return {"modified": bool(changed), "changed": changed}
        if cmd == "app.save":
            conflicts = w.conflict_files
            if conflicts and not a.get("force"):
                return {"ok": False, "conflicts": conflicts}
            return {"ok": True, "saved": await asyncio.to_thread(w.save)}
        if cmd == "app.revert":
            done = await asyncio.to_thread(w.revert)
            try:
                await self.engine.call("clear_history")
            except Exception:  # noqa: BLE001
                pass
            return {"ok": True, "reverted": done}
        if cmd == "app.add_image":
            src = a.get("path") or await self.dialog("open", title="Choose a picture to insert", filetypes=IMAGE_TYPES)
            if not src:
                return {"cancelled": True}
            s = Path(src)
            dest, n = w.work / s.name, 1
            while dest.exists():
                dest = w.work / f"{s.stem}_{n}{s.suffix}"
                n += 1
            await asyncio.to_thread(shutil.copy2, s, dest)
            return {"file": dest.name}
        if cmd == "app.export_pdf":
            path = a.get("path") or await self.dialog("save", title="Export PDF", defaultextension=".pdf",
                                                      initialfile=self.info()["deck"]["name"] + ".pdf",
                                                      filetypes=[["PDF", "*.pdf"]])
            if not path:
                return {"cancelled": True}
            pages = (await self.engine.call("pages", builds=bool(a.get("builds"))))["pages"]

            def write():
                from PIL import Image
                ims = [Image.open(p).convert("RGB") for p in pages]
                if not ims:
                    raise RuntimeError("no slides to export")
                ims[0].save(path, "PDF", save_all=True, append_images=ims[1:], resolution=96.0)
            await asyncio.to_thread(write)
            return {"ok": True, "path": path, "pages": len(pages)}
        if cmd == "app.reveal":
            p = a.get("path") or str(w.original)
            if os.path.isdir(p):
                subprocess.Popen(["explorer", os.path.normpath(p)])
            else:
                subprocess.Popen(["explorer", "/select,", os.path.normpath(p)])
            return {"ok": True}
        raise RuntimeError(f"unknown command {cmd}")

    # ------------------------------------------------------------- routes
    async def index(self, request: web.Request):
        if not self.authed(request):
            return web.Response(status=403, text="Open Manimble from its launcher.")
        html = (WEB / "index.html").read_text(encoding="utf-8").replace("__TOKEN__", self.token)
        return web.Response(text=html, content_type="text/html", headers={"Cache-Control": "no-store"})

    async def file(self, request: web.Request):
        p = request.query.get("p", "")
        if not self.authed(request) or not p or not self.allowed(p) or not os.path.isfile(p):
            return web.Response(status=404)
        return web.FileResponse(p, headers={"Cache-Control": "no-cache"})

    async def ws(self, request: web.Request):
        if not self.authed(request):
            return web.Response(status=403)
        sock = web.WebSocketResponse(max_msg_size=64 * 1024 * 1024, heartbeat=30)
        await sock.prepare(request)
        self.clients.add(sock)

        async def handle(req: dict):
            i, cmd = req.get("id"), req.get("cmd", "")
            try:
                if cmd.startswith("app."):
                    out = {"id": i, "result": await self.app_cmd(cmd, req)}
                else:
                    r = await self.engine.raw({k: v for k, v in req.items() if k != "id"})
                    out = {"id": i, **{k: r[k] for k in ("result", "error") if k in r}}
            except Exception as exc:  # noqa: BLE001
                out = {"id": i, "error": str(exc) or exc.__class__.__name__}
            await self._send(sock, json.dumps(out))
        try:
            async for msg in sock:
                if msg.type == WSMsgType.TEXT:
                    asyncio.ensure_future(handle(json.loads(msg.data)))
        finally:
            self.clients.discard(sock)
        return sock

    async def term(self, request: web.Request):
        if not self.authed(request):
            return web.Response(status=403)
        sock = web.WebSocketResponse(heartbeat=30)
        await sock.prepare(request)
        from winpty import PtyProcess
        w = self.workspace
        cwd = str(w.work) if w else str(Path.home())
        env = dict(os.environ)
        env["PATH"] = str(Path(sys.executable).parent) + os.pathsep + env.get("PATH", "")
        env["MANIMBLE_PYTHON"] = sys.executable
        if w:
            env["MANIMBLE_DECK"], env["MANIMBLE_ORIGINAL_DECK"] = str(w.work), str(w.original)
        shell = shutil.which("pwsh") or shutil.which("powershell") or "cmd.exe"
        cols, rows = int(request.query.get("cols", 100)), int(request.query.get("rows", 24))
        pty = PtyProcess.spawn([shell, "-NoLogo"] if "cmd" not in os.path.basename(shell).lower() else [shell],
                               cwd=cwd, env=env, dimensions=(rows, cols))
        loop = asyncio.get_running_loop()

        def pump():
            try:
                while True:
                    data = pty.read(8192)
                    if data:
                        asyncio.run_coroutine_threadsafe(sock.send_str(data), loop)
            except Exception:  # noqa: BLE001  (EOFError when the shell exits)
                pass
            asyncio.run_coroutine_threadsafe(sock.close(), loop)
        threading.Thread(target=pump, daemon=True).start()
        try:
            async for msg in sock:
                if msg.type != WSMsgType.TEXT:
                    continue
                m = json.loads(msg.data)
                if m.get("t") == "i":
                    await asyncio.to_thread(pty.write, m["d"])
                elif m.get("t") == "r":
                    try:
                        pty.setwinsize(int(m["rows"]), int(m["cols"]))
                    except Exception:  # noqa: BLE001
                        pass
        finally:
            try:
                pty.terminate(force=True)
            except Exception:  # noqa: BLE001
                pass
        return sock

    # ---------------------------------------------------------- lifecycle
    def build(self) -> web.Application:
        app = web.Application()
        app.router.add_get("/", self.index)
        app.router.add_get("/ws", self.ws)
        app.router.add_get("/term", self.term)
        app.router.add_get("/file", self.file)
        app.router.add_static("/static/", WEB)

        async def started(_):
            self.engine = Engine(asyncio.get_running_loop(), self.broadcast)
            self.engine.start()

        async def cleanup(_):
            self.shutdown()
        app.on_startup.append(started)
        app.on_cleanup.append(cleanup)
        return app

    def shutdown(self):
        if self.engine:
            self.engine.stop()
        if self.workspace and not self.workspace.changed_files:
            self.workspace.discard()            # an unsaved working copy is kept on disk rather than lost

    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/?t={self.token}"


def serve(app: App, port: int = 0, ready: threading.Event | None = None, open_path: str | None = None):
    """Run the server on this thread until interrupted."""
    import socket
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    sock = socket.socket()
    sock.bind(("127.0.0.1", port))
    app.port = sock.getsockname()[1]
    runner = web.AppRunner(app.build())
    loop.run_until_complete(runner.setup())
    loop.run_until_complete(web.SockSite(runner, sock).start())
    app.loop = loop
    if open_path:
        async def first():
            try:
                await app.open_deck(open_path)
            except Exception as exc:  # noqa: BLE001
                print("could not open", open_path, exc, file=sys.stderr)
        loop.create_task(first())
    if ready:
        ready.set()
    try:
        loop.run_forever()
    finally:
        loop.run_until_complete(runner.cleanup())


def cleanup_stale():
    """Working copies left by a crash, older than a week and with nothing to recover, would pile up."""
    work = wsmod.base() / "work"
    if not work.is_dir():
        return
    for d in work.iterdir():
        try:
            if time.time() - d.stat().st_mtime > 30 * 86400:
                wsmod.remove_tree(d)
        except OSError:
            pass
