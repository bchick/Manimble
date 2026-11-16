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

    def closing():
        w = app.workspace
        if w and w.changed_files:
            return window.create_confirmation_dialog(
                "Unsaved changes", "This deck has changes that were not saved to the original. Close anyway?")
        return True
    window.events.closing += closing
    webview.start(private_mode=False, storage_path=None)
    app.shutdown()


if __name__ == "__main__":
    sys.exit(main())
