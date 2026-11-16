"""Speech for scripted presentations beyond the browser's own voices.

Online voices (ElevenLabs, OpenAI): a script voice for one of them is stored as `cloud:<service>:<voice>` in
script.json, as the macOS app does. The account's API key lives in Windows Credential Manager (through `keyring`),
never in the deck and never sent back to the page. Speech is cached, so replaying a show does not call the service
(or cost anything) again.

System voices to files (for the narrated movie): SAPI through PowerShell's System.Speech.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import subprocess
import tempfile
from pathlib import Path

import aiohttp

from . import workspace as wsmod

KEYRING = "Manimble voice"
MAC_RATE = 0.5                          # AVSpeechUtteranceDefaultSpeechRate: script.json's `rate` is on that scale

SERVICES = {
    "elevenlabs": {
        "name": "ElevenLabs", "keyPage": "https://elevenlabs.io/app/settings/api-keys",
        "voices": [["21m00Tcm4TlvDq8ikWAM", "Rachel"], ["pNInz6obpgDQGcFmaJgB", "Adam"], ["EXAVITQu4vr4xnSDxMaL", "Sarah"],
                   ["ErXwobaYiN019PkySvjV", "Antoni"], ["TxGEqnHWrfWFTfGW9XjX", "Josh"], ["XrExE9yKIg1WjnnlVkGX", "Matilda"]],
    },
    "openai": {
        "name": "OpenAI", "keyPage": "https://platform.openai.com/api-keys",
        "voices": [[v, v.capitalize()] for v in ("alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer")],
    },
}


class VoiceError(RuntimeError):
    pass


# ----------------------------------------------------------------------- keys
def get_key(service: str) -> str | None:
    try:
        import keyring
        return keyring.get_password(KEYRING, service) or None
    except Exception:  # noqa: BLE001
        return None


def set_key(service: str, key: str | None) -> None:
    import keyring
    try:
        keyring.delete_password(KEYRING, service)
    except Exception:  # noqa: BLE001
        pass
    if key:
        keyring.set_password(KEYRING, service, key)
    saved = _saved_voices()
    saved.pop(service, None)
    _voices_file().write_text(json.dumps(saved), encoding="utf-8")


def _voices_file() -> Path:
    return wsmod.base() / "voices.json"


def _saved_voices() -> dict:
    try:
        return json.loads(_voices_file().read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def services() -> list[dict]:
    saved = _saved_voices()
    return [{"id": sid, "name": s["name"], "keyPage": s["keyPage"], "connected": bool(get_key(sid)),
             "voices": [{"id": v[0], "name": v[1]} for v in (saved.get(sid) or s["voices"])]}
            for sid, s in SERVICES.items()]


def _check(status: int, body: bytes) -> None:
    if 200 <= status < 300:
        return
    if status == 401:
        raise VoiceError("The key was refused (401).")
    raise VoiceError(f"HTTP {status}: {body[:400].decode('utf-8', 'replace')}")


async def _get(url: str, headers: dict) -> bytes:
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as s, s.get(url, headers=headers) as r:
        body = await r.read()
        _check(r.status, body)
        return body


async def verify(service: str, key: str) -> None:
    """Check a key with a cheap call before keeping it."""
    if service == "elevenlabs":
        await _get("https://api.elevenlabs.io/v1/voices", {"xi-api-key": key})
    elif service == "openai":
        await _get("https://api.openai.com/v1/models", {"Authorization": f"Bearer {key}"})
    else:
        raise VoiceError(f"unknown service {service}")


async def refresh_voices(service: str) -> None:
    """The account's own voice list (ElevenLabs only; OpenAI's voices are fixed)."""
    key = get_key(service)
    if service != "elevenlabs" or not key:
        return
    data = json.loads(await _get("https://api.elevenlabs.io/v1/voices", {"xi-api-key": key}))
    rows = sorted(([v["voice_id"], v["name"]] for v in data.get("voices", [])), key=lambda r: r[1])
    if rows:
        saved = _saved_voices()
        saved[service] = rows
        _voices_file().write_text(json.dumps(saved), encoding="utf-8")


async def connect(service: str, key: str) -> None:
    if service not in SERVICES:
        raise VoiceError(f"unknown service {service}")
    key = (key or "").strip()
    if not key:
        raise VoiceError("Paste an API key.")
    await verify(service, key)
    await asyncio.to_thread(set_key, service, key)
    try:
        await refresh_voices(service)
    except Exception:  # noqa: BLE001
        pass


# --------------------------------------------------------------- cloud speech
def parse(identifier: str | None):
    """('elevenlabs', voice id) for `cloud:elevenlabs:<voice>`, else None."""
    parts = (identifier or "").split(":", 2)
    return (parts[1], parts[2]) if len(parts) == 3 and parts[0] == "cloud" and parts[1] in SERVICES else None


def _speed(service: str, rate: float) -> float:
    s = rate / MAC_RATE
    return min(1.2, max(0.7, s)) if service == "elevenlabs" else min(4.0, max(0.25, s))


def cache_file(identifier: str, text: str, rate: float) -> Path:
    service, _ = parse(identifier)
    key = f"{identifier}|{_speed(service, rate):.3f}|{text}"
    d = wsmod.base() / "voice"
    d.mkdir(parents=True, exist_ok=True)
    return d / (hashlib.sha256(key.encode("utf-8")).hexdigest() + ".mp3")


_in_flight: dict[Path, asyncio.Task] = {}


async def cloud_audio(identifier: str, text: str, rate: float) -> Path:
    """The words as an mp3, from the cache when they were made before."""
    if parse(identifier) is None:
        raise VoiceError(f"not an online voice: {identifier}")
    file = cache_file(identifier, text, rate)
    if file.is_file() and file.stat().st_size > 0:
        return file
    task = _in_flight.get(file)                     # one request per text, however many callers ask at once
    if task is None:
        task = _in_flight[file] = asyncio.ensure_future(_fetch(identifier, text, rate, file))
        task.add_done_callback(lambda _t: _in_flight.pop(file, None))
    return await task


async def _fetch(identifier: str, text: str, rate: float, file: Path) -> Path:
    service, voice = parse(identifier)
    key = get_key(service)
    if not key:
        raise VoiceError(f"{SERVICES[service]['name']} is not connected.")
    if service == "elevenlabs":
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=mp3_44100_128"
        headers = {"xi-api-key": key}
        body = {"text": text, "model_id": "eleven_multilingual_v2", "voice_settings": {"speed": _speed(service, rate)}}
    else:
        url = "https://api.openai.com/v1/audio/speech"
        headers = {"Authorization": f"Bearer {key}"}
        body = {"model": "tts-1-hd", "voice": voice, "input": text, "speed": _speed(service, rate), "response_format": "mp3"}
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60)) as s, s.post(url, headers=headers, json=body) as r:
        data = await r.read()
        _check(r.status, data)
    tmp = file.with_suffix(".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, file)
    return file


# -------------------------------------------------------------- system speech
SAPI = r"""
param([string]$jobs)
Add-Type -AssemblyName System.Speech
$j = Get-Content -Raw -Encoding UTF8 $jobs | ConvertFrom-Json
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($j.voice) {
    $want = ($j.voice -split ' - ')[0]
    $v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Name -like "$want*" } | Select-Object -First 1
    if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }
}
$s.Rate = [int]$j.rate
foreach ($i in $j.items) {
    $s.SetOutputToWaveFile($i.out)
    $s.Speak($i.text)
}
$s.SetOutputToNull()
$s.Dispose()
"""


def sapi_rate(rate: float) -> int:
    """SAPI's -10..10 (each step a constant factor, 10 is three times as fast) for the script's rate."""
    r = max(0.34, min(3.0, rate / MAC_RATE))
    return max(-10, min(10, round(10 * math.log(r) / math.log(3))))


def sapi_batch(items: list[tuple[str, str]], voice: str | None, rate: float) -> None:
    """Speak each (text, wav path) with a system voice. `voice` is the browser's name for it
    ("Microsoft David - English (United States)"); a voice SAPI does not have falls back to the default."""
    if not items:
        return
    with tempfile.TemporaryDirectory(prefix="manimble-sapi-") as d:
        ps, jobs = Path(d) / "speak.ps1", Path(d) / "jobs.json"
        ps.write_text(SAPI, encoding="utf-8-sig")
        jobs.write_text(json.dumps({"voice": voice or "", "rate": sapi_rate(rate),
                                    "items": [{"text": t, "out": o} for t, o in items]}), encoding="utf-8")
        r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps), str(jobs)],
                           capture_output=True, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if r.returncode != 0 or any(not os.path.isfile(o) for _, o in items):
        raise VoiceError("Windows text-to-speech failed: " + (r.stderr.strip()[-300:] or "no audio was written"))
