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
- Presenter View (Alt+F5): the show goes full screen on a second display, or into its own window with one display;
  this window shows the current slide, the next build, slide and build notes, a timer and clock, and every slide
  and build to jump to. B blacks out the audience display, R resets the timer, Swap Displays trades the screens
- Themes (Edit ▸ Theme…): the seven deck themes, for the whole deck or one slide, with a live preview and the
  black/white swap when the background changes between dark and light; New Deck starts from a theme
- Scripted presentations (the Script button): per-build steps that speak words with a Windows text-to-speech
  voice, move an on-screen pointer along a point or traced path, or pause; the show then plays itself, with Space
  or K to pause. Scripts are stored in `script.json` in the macOS app's format
- Online voices for scripts (ElevenLabs, OpenAI): connect an account in the Script panel; the API key is kept in
  Windows Credential Manager and speech is cached in `%LOCALAPPDATA%Manimbleoice`
- Narrated movie export (Export Movie ▸ Export with script): the narration as the soundtrack and the pointer drawn
  over the slide. System voices are spoken by SAPI here, which has fewer voices than the live show (David and
  Zira on a stock install); a voice it lacks falls back to the default
- Find and replace (Ctrl+F, Ctrl+H) across text, formulas and speaker notes, with match case, whole words and
  regular expressions; Replace All is one undo step
- Import PowerPoint and Beamer; export PDF, PowerPoint, MP4 and a single Python file

## Not done yet

Editing notes and Feedback Mode inside Presenter View, dark mode on its own, slide
numbers, backgrounds, the icon library, feedback notes, copy and paste of objects, rulers and snapping guides, pen
drawing, and `.manimble` packages. The engine already implements most of these; they need UI here.
Keynote import and export use AppleScript and cannot work on Windows.

Themes applied here use Windows fonts. Decks written on a Mac often name Mac fonts (`Helvetica Neue`); Windows substitutes another font unless you change
`FONT` in the deck's `common.py` (to `Segoe UI` or `Arial`, say).

## How it is put together

```
apps/windows/
├── setup.ps1                 installs everything and makes the shortcuts
├── run.py                    starts the app from a checkout
├── requirements.txt          aiohttp, pywinpty, pywebview, keyring
├── tools/smoke_engine.py     renders a deck through the engine, without the UI
└── manimble_win/
    ├── __main__.py           the window (pywebview / WebView2), or `--serve` for the server alone
    ├── server.py             local bridge: WebSocket <-> engine JSON lines, file serving, dialogs, PDF, terminal
    ├── workspace.py          the working copy (junctions where the Mac app uses symlinks)
    ├── voices.py             online voices, their keys, and system speech to files
    ├── narrate.py            the narrated movie: holds, narration track and pointer overlay (ffmpeg)
    ├── agent_instructions.py what coding agents in the terminal are told about the deck
    └── web/                  the editor: index.html, app.js, tools.js (themes, find), script.js (scripted presentations),
                              present.js (shows, Presenter View),
                              style.css;
                              vendor/ holds CodeMirror and xterm.js
```

The bridge listens on `127.0.0.1` on a random port and requires a random token on every request, since one of its
endpoints is a shell. For development, `run.py --serve --port 8765 --token dev` runs it without a window; open
`http://localhost:8765/?t=dev` in a browser.

Working copies, render caches, the recent list and `engine.log` live in `%LOCALAPPDATA%\Manimble`.

The engine needed four small changes for Windows: a temp folder path (`worker.py`), reading `manim.cfg` without
translating CRLF line ends (`darkmode.py`), retrying a file replace that another process briefly blocks
(`srcedit.py`), and Windows stand-ins for the macOS fonts the themes name (`theme.py`).
