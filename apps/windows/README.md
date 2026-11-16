# Manimble for Windows

An unofficial Windows front end for Manimble. It is a second client of the shared Python engine in
[`../../engine`](../../engine), speaking the JSON protocol in
[`../../docs/developers/protocol.md`](../../docs/developers/protocol.md). The macOS app is the reference; this one
covers the core of it and is not at parity (see *Not done yet*).

## Install

Needs Windows 10 or 11 with `git` and `winget` (both normally present). In PowerShell:

```powershell
git clone -b windows <this repository's URL> Manimble
cd Manimble
powershell -ExecutionPolicy Bypass -File apps\windows\setup.ps1
```

The script is safe to run again and only adds what is missing:

- Python 3.12 for the current user (through winget), when no Python 3.11+ is installed
- a virtual environment in `.venv` with Manim, Manim Slides and the app's packages
- TinyTeX in `%APPDATA%\TinyTeX` when no LaTeX is installed, and the LaTeX packages Manim uses
- a **Manimble** shortcut on the Desktop and in the Start menu

Start it from the shortcut, or `.venv\Scripts\python.exe apps\windows\run.py [deck folder]`.
The window is drawn by WebView2, which ships with Windows 11 and current Windows 10.

To update: `git pull`, then run `setup.ps1` again.

## What works

- Open a deck, a new deck, recent decks; a private working copy with **Save to Original** and **Revert**
- Slide list with thumbnails; new slide (five layouts), duplicate, delete, move, hide; builds
- Canvas: select, move, resize, retype (double-click), nudge with the arrow keys, delete, multi-select, group
- Insert text, formulas, shapes, lines, arrows, pictures and tables; layout placeholders
- Inspector: text, size, bold and italic, alignment, font, colour, width and height, rotation, stacking order
- Code pane for the slide's class, with errors shown in place; undo and redo across all of it
- Terminal in the working copy (PowerShell through ConPTY), for Claude Code, Codex or Gemini CLI; their edits
  show on the slides within a couple of seconds
- Presenting full screen, as still builds or with the Manim animations
- Import PowerPoint and Beamer; export PDF, PowerPoint, MP4 and a single Python file

## Not done yet

Presenter View (notes, timer, second screen), narrated scripts, themes and dark mode, find and replace, slide
numbers, backgrounds, the icon library, feedback notes, copy and paste of objects, rulers and snapping guides, pen
drawing, and `.manimble` packages. The engine already implements most of these; they need UI here.
Keynote import and export use AppleScript and cannot work on Windows.

Decks written on a Mac often name Mac fonts (`Helvetica Neue`); Windows substitutes another font unless you change
`FONT` in the deck's `common.py` (to `Segoe UI` or `Arial`, say).

## How it is put together

```
apps/windows/
├── setup.ps1                 installs everything and makes the shortcuts
├── run.py                    starts the app from a checkout
├── requirements.txt          aiohttp, pywinpty, pywebview
├── tools/smoke_engine.py     renders a deck through the engine, without the UI
└── manimble_win/
    ├── __main__.py           the window (pywebview / WebView2), or `--serve` for the server alone
    ├── server.py             local bridge: WebSocket <-> engine JSON lines, file serving, dialogs, PDF, terminal
    ├── workspace.py          the working copy (junctions where the Mac app uses symlinks)
    ├── agent_instructions.py what coding agents in the terminal are told about the deck
    └── web/                  the editor: index.html, app.js, style.css; vendor/ holds CodeMirror and xterm.js
```

The bridge listens on `127.0.0.1` on a random port and requires a random token on every request, since one of its
endpoints is a shell. For development, `run.py --serve --port 8765 --token dev` runs it without a window; open
`http://localhost:8765/?t=dev` in a browser.

Working copies, render caches, the recent list and `engine.log` live in `%LOCALAPPDATA%\Manimble`.

The engine needed one change to run on Windows (a temp folder path in `worker.py`).
