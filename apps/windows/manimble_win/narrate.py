"""The movie a scripted presentation would make (the Windows counterpart of ScriptMovie.swift).

Each build's clip plays, then its last frame is held while the build's script runs (its words spoken, its pointer
moves drawn) and 0.4 s more; a build with no script is held the script's hold. The narration is spoken to files
first so every hold is known, the engine encodes the movie with those holds (`export_movie`, `holds`), and the
narration and the pointer are then laid over it with ffmpeg.
"""

from __future__ import annotations

import asyncio
import json
import math
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path

from . import voices

GAP = 0.4                      # the pause between a build's script and the next build
SR = 44100                     # the narration track: mono, 16 bit
SIZES = {720: (1280, 720), 1080: (1920, 1080), 1440: (2560, 1440), 2160: (3840, 2160)}
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def find_ffmpeg() -> str:
    f = shutil.which("ffmpeg")
    if f:
        return f
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


class Motion:
    """A pointer move: along its track at a steady pace eased in and out, with a smooth wobble that fades in and
    out. The same arithmetic as the show's (script.js `movePointer`, ScriptMotion on macOS)."""

    def __init__(self, points: list, aspect: float, speed: float, noise: float, seed: str):
        self.points, self.aspect, self.noise = points, aspect, noise
        self.acc = [0.0]
        for a, b in zip(points, points[1:]):
            self.acc.append(self.acc[-1] + math.hypot(b[0] - a[0], (b[1] - a[1]) * aspect))
        self.total = self.acc[-1]
        self.duration = max(0.15, self.total / max(0.05, speed or 0.5))
        h = 1469598103934665603                     # FNV-1a over the step's id: the same wobble every time
        for c in seed.encode("utf-8"):
            h = ((h ^ c) * 1099511628211) & 0xFFFFFFFFFFFFFFFF
        self.phases = [((h >> (k * 16)) & 0xFFFF) / 65535 * 2 * math.pi for k in range(4)]

    def at(self, t: float) -> tuple[float, float]:
        u = min(1.0, max(0.0, t / self.duration))
        d = (1 - math.cos(math.pi * u)) / 2 * self.total
        k = 1
        while k < len(self.acc) - 1 and self.acc[k] < d:
            k += 1
        seg = (self.acc[k] - self.acc[k - 1]) or 1.0
        f = min(1.0, max(0.0, (d - self.acc[k - 1]) / seg))
        a, b = self.points[k - 1], self.points[k]
        x, y = a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f
        if self.noise > 0:
            amp, tau, p = self.noise * 0.012 * math.sin(math.pi * u), 2 * math.pi, self.phases
            x += amp * (0.6 * math.sin(tau * 1.3 * t + p[0]) + 0.4 * math.sin(tau * 3.1 * t + p[1]))
            y += amp / self.aspect * (0.6 * math.sin(tau * 1.7 * t + p[2]) + 0.4 * math.sin(tau * 2.6 * t + p[3]))
        return x, y


def _pcm(ffmpeg: str, src: str) -> bytes:
    """An audio file as mono 16-bit samples at SR."""
    r = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-i", src, "-f", "s16le", "-ac", "1",
                        "-ar", str(SR), "-"], capture_output=True, creationflags=NO_WINDOW)
    if r.returncode != 0:
        raise RuntimeError("could not read the speech: " + r.stderr.decode("utf-8", "replace")[-300:])
    return r.stdout


def _arrow(path: Path, height: float) -> tuple[int, int]:
    """The pointer as a PNG `height` pixels high; returns where its tip is in the picture."""
    from PIL import Image, ImageDraw
    k = 4                                                   # drawn large, then scaled down, for smooth edges
    h = max(8, round(height))
    w = max(6, round(h * 24 / 36))
    im = Image.new("RGBA", (w * k, h * k), (0, 0, 0, 0))
    sx, sy = w * k / 24, h * k / 36
    poly = [(2, 2), (2, 28), (8.5, 22), (13, 33), (17.5, 31), (13, 20.5), (22, 20.5)]
    pts = [(x * sx, y * sy) for x, y in poly]
    d = ImageDraw.Draw(im)
    d.polygon(pts, fill=(255, 255, 255, 255))
    d.line(pts + [pts[0]], fill=(0, 0, 0, 255), width=max(2, round(1.6 * sx)), joint="curve")
    im.resize((w, h), Image.LANCZOS).save(path)
    return round(2 * w / 24), round(2 * h / 36)


async def export(app, path: str, height: int = 1080, fps: int = 30) -> dict:
    """Write the narrated movie to `path`. Progress goes out as `export_movie` events, like the plain export's."""
    w = app.workspace
    emit = app.broadcast
    try:
        script = json.loads((w.work / "script.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        script = {}
    steps = [s for s in script.get("steps") or [] if isinstance(s, dict)]
    rate = float(script.get("rate") or voices.MAC_RATE)
    hold = float(script["hold"]) if isinstance(script.get("hold"), (int, float)) else 3.0
    cloud = script.get("voice") if voices.parse(script.get("voice")) else None
    if height not in SIZES:
        height = 1080
    fw, fh = SIZES[height]

    state = await app.engine.call("state")
    scenes = [s["name"] for s in state["scenes"] if not s.get("hidden")]
    if not scenes:
        raise RuntimeError("there are no slides to export")
    first = await app.engine.call("scene", name=scenes[0])
    sw, sh = (first.get("size") or [1280, 720])[:2]
    aspect = sh / sw
    slide_w = min(fw, fh / aspect)
    slide_h = slide_w * aspect
    ox, oy = (fw - slide_w) / 2, (fh - slide_h) / 2

    ffmpeg = find_ffmpeg()
    work = Path(tempfile.mkdtemp(prefix="manimble-script-movie-"))
    warnings: list[str] = []
    try:
        # ---- 1. speak the script to files
        speaking = [s for sc in scenes for s in steps if s.get("scene") == sc and s.get("kind") == "speak"
                    and (s.get("text") or "").strip()]
        audio: dict[str, bytes] = {}
        local: list[dict] = []
        for i, s in enumerate(speaking):
            emit({"event": "export_movie", "phase": "building", "done": i, "total": len(speaking), "scene": "narration"})
            text = s["text"].strip()
            if cloud:
                try:
                    audio[s["id"]] = await asyncio.to_thread(_pcm, ffmpeg, str(await voices.cloud_audio(cloud, text, rate)))
                    continue
                except Exception as exc:  # noqa: BLE001  (as in the show: the system voice reads it instead)
                    if not warnings:
                        warnings.append(f"The online voice could not be used ({exc}); a system voice read the script.")
            local.append(s)
        if local:
            items = [(s["text"].strip(), str(work / f"speech-{i}.wav")) for i, s in enumerate(local)]
            await asyncio.to_thread(voices.sapi_batch, items, script.get("winVoice"), rate)
            for s, (_, out) in zip(local, items):
                audio[s["id"]] = await asyncio.to_thread(_pcm, ffmpeg, out)

        # ---- 2. lay out every build's events, walking the pointer as the show does
        builds: dict[tuple[str, int], dict] = {}
        pointer = None
        for sc in scenes:
            mine = [s for s in steps if s.get("scene") == sc]
            for b in sorted({int(s.get("build") or 0) for s in mine}):
                t, events = 0.0, []
                for s in mine:
                    if int(s.get("build") or 0) != b:
                        continue
                    kind = s.get("kind")
                    if kind == "pause":
                        t += max(0.0, float(s.get("seconds") or 0))
                    elif kind == "speak" and s.get("id") in audio:
                        n = len(audio[s["id"]]) / 2 / SR
                        if n > 0:
                            events.append(("audio", t, audio[s["id"]]))
                            t += n
                    elif kind == "move":
                        pts = [p for p in s.get("path") or [] if isinstance(p, list) and len(p) >= 2]
                        if not pts:
                            continue
                        m = Motion([pointer or [0.5, 0.5]] + pts, aspect, float(s.get("speed") or 0.5),
                                   float(s.get("noise") or 0), str(s.get("id") or ""))
                        events.append(("move", t, m))
                        t += m.duration
                        pointer = pts[-1]
                builds[(sc, b)] = {"duration": t, "events": events}
        holds: dict[str, dict] = {}
        for (sc, b), v in builds.items():
            holds.setdefault(sc, {})[str(b)] = v["duration"] + GAP

        # ---- 3. the engine's movie, with those holds
        base = work / "show.mp4"
        loop = asyncio.get_running_loop()
        done: asyncio.Future = loop.create_future()

        def listen(m: dict) -> bool:
            if m.get("event") != "export_movie" or m.get("phase") not in ("done", "error", "cancelled"):
                return False
            if not done.done():
                done.set_result(m)
            return True                                  # not the end for the page: the narration is still to come
        app.listeners.append(listen)
        try:
            r = await app.engine.call("export_movie", path=str(base), height=height, fps=fps, hold=hold + GAP,
                                      holds=holds, scenes=scenes)
            if not r.get("ok"):
                raise RuntimeError(r.get("error") or "the movie could not be started")
            m = await done
        finally:
            app.listeners.remove(listen)
        if m["phase"] != "done":
            raise RuntimeError(m.get("error") or "cancelled")
        segments = m.get("segments") or []
        total = max((float(s["end"]) for s in segments), default=0.0)
        emit({"event": "export_movie", "phase": "encoding", "done": 0, "total": 1, "scene": "narration and pointer"})

        # ---- 4. the narration as one track, the pointer as overlay commands
        track = bytearray(int(total * SR) * 2 + 2)
        moves = []
        for seg in segments:
            b = builds.get((seg["scene"], int(seg["build"])))
            if not b:
                continue
            start = max(float(seg["start"]), float(seg["end"]) - float(seg["hold"]))     # where the hold begins
            for kind, at, what in b["events"]:
                if kind == "audio":
                    a = int((start + at) * SR) * 2
                    chunk = what[:max(0, len(track) - a)]
                    track[a:a + len(chunk)] = chunk
                else:
                    moves.append((start + at, what))
        has_audio = any(k == "audio" for b in builds.values() for k, _, _ in b["events"])
        if has_audio:
            with wave.open(str(work / "narration.wav"), "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(SR)
                wf.writeframes(bytes(track))

        command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", "show.mp4"]
        graph, vmap = [], "0:v"
        if moves:
            tip = _arrow(work / "arrow.png", slide_h * 0.055)
            lines = []
            for t0, mo in moves:
                n = max(1, math.ceil(mo.duration * fps))
                for i in range(n + 1):
                    t = min(mo.duration, i / fps)
                    x, y = mo.at(t)
                    lines.append(f"{t0 + t:.4f} overlay@ptr x {ox + x * slide_w - tip[0]:.1f}, "
                                 f"overlay@ptr y {oy + y * slide_h - tip[1]:.1f};")
            (work / "pointer.txt").write_text("\n".join(lines) + "\n", encoding="ascii")
            command += ["-loop", "1", "-framerate", str(fps), "-i", "arrow.png"]
            graph.append("[0:v]sendcmd=f=pointer.txt[base];"
                         "[base][1:v]overlay@ptr=x=-10000:y=-10000:eval=frame:shortest=1:format=auto,format=yuv420p[v]")
            vmap = "[v]"
        if has_audio:
            command += ["-i", "narration.wav"]
        if graph:
            (work / "graph.txt").write_text(graph[0], encoding="ascii")
            command += ["-filter_complex_script", "graph.txt"]
        command += ["-map", vmap]
        if has_audio:
            command += ["-map", f"{2 if moves else 1}:a", "-c:a", "aac", "-b:a", "192k"]
        command += (["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"] if moves else ["-c:v", "copy"])
        command += ["-t", f"{total:.3f}", "-movflags", "+faststart", "out.mp4"]
        r = await asyncio.to_thread(subprocess.run, command, cwd=work, capture_output=True, text=True, creationflags=NO_WINDOW)
        if r.returncode != 0:
            raise RuntimeError("could not lay the narration over the movie: " + "\n".join(r.stderr.strip().splitlines()[-4:]))
        dest = Path(path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(work / "out.mp4"), dest)
        return {"path": str(dest), "seconds": total, "spoken": len(audio), "moves": len(moves), "warnings": warnings}
    finally:
        shutil.rmtree(work, ignore_errors=True)
