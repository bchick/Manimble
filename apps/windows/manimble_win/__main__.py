"""Manimble for Windows.

    python -m manimble_win [deck folder]            the app, in its own window
    python -m manimble_win --serve [--port N]       the server only: open the printed address in a browser
"""

from __future__ import annotations

import argparse
import sys
import threading

from .server import App, cleanup_stale, serve


def main():
    ap = argparse.ArgumentParser(prog="manimble")
    ap.add_argument("deck", nargs="?", help="deck folder to open")
    ap.add_argument("--serve", action="store_true", help="run without a window")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--token", help="fixed access token (development)")
    a = ap.parse_args()

    cleanup_stale()
    app = App(a.token)
    if a.serve:
        ready = threading.Event()
        t = threading.Thread(target=serve, args=(app, a.port, ready, a.deck), daemon=True)
        t.start()
        ready.wait()
        print(app.url(), flush=True)
        try:
            while t.is_alive():
                t.join(0.5)
        except KeyboardInterrupt:
            pass
        app.shutdown()
        return

    import webview
    ready = threading.Event()
    threading.Thread(target=serve, args=(app, a.port, ready, a.deck), daemon=True).start()
    ready.wait()
    class Api:
        """What the page can ask of the window (window.pywebview.api)."""
        full = False

        def set_fullscreen(self, on):
            if bool(on) != self.full:
                self.full = bool(on)
                window.toggle_fullscreen()

    window = webview.create_window("Manimble", app.url(), width=1500, height=950, min_size=(1000, 650),
                                   background_color="#1e1f22", js_api=Api())

    show = {"w": None}

    def screen_of(win):
        """The display a window is on (the one holding its centre), else the first."""
        try:
            cx, cy = win.x + win.width / 2, win.y + win.height / 2
            for s in webview.screens:
                if s.x <= cx < s.x + s.width and s.y <= cy < s.y + s.height:
                    return s
        except Exception:  # noqa: BLE001
            pass
        return webview.screens[0]

    def close_show():
        w, show["w"] = show["w"], None
        if w is not None:
            try:
                w.destroy()
            except Exception:  # noqa: BLE001
                pass

    def open_show(screen):
        url = app.url() + "&view=audience"
        if screen is not None:
            show["w"] = webview.create_window("Manimble Show", url, screen=screen, fullscreen=True,
                                              background_color="#000000")
        else:
            show["w"] = webview.create_window("Manimble Show", url, width=960, height=540, background_color="#000000")

    def audience(op):
        """Presenter View's audience window: on the other display, full screen, when there is one."""
        mine = screen_of(window)
        other = next((s for s in webview.screens if (s.x, s.y) != (mine.x, mine.y)), None)
        if op == "close":
            close_show()
            return {"ok": True}
        if op == "swap":
            if other is None:
                return {"ok": False, "error": "Swap Displays needs a second display."}
            close_show()
            window.restore()
            window.move(other.x + 60, other.y + 60)
            open_show(mine)
            return {"ok": True}
        close_show()
        open_show(other)
        return {"ok": True, "windowed": True, "second": other is not None}
    app.audience = audience

    def closing():
        w = app.workspace
        if w and w.changed_files:
            if not window.create_confirmation_dialog(
                    "Unsaved changes", "This deck has changes that were not saved to the original. Close anyway?"):
                return False
        close_show()
        return True
    window.events.closing += closing
    webview.start(private_mode=False, storage_path=None)
    app.shutdown()


if __name__ == "__main__":
    sys.exit(main())
