"""Smoke test: run the Manimble engine on a copy of a deck and render every slide.

    .venv\\Scripts\\python.exe apps\\windows\\tools\\smoke_engine.py [deck folder]
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
src = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "examples" / "hello" / "deck"
work = Path(tempfile.mkdtemp(prefix="manimble-smoke-"))
deck = work / "deck"
shutil.copytree(src, deck)

env = dict(os.environ, PYTHONPATH=str(ROOT / "engine"), MANIMBLE_PYTHON=sys.executable, PYTHONUTF8="1")
p = subprocess.Popen([sys.executable, "-m", "manimble.rpc"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     text=True, encoding="utf-8", bufsize=1, env=env)
replies, events = {}, []
cv = threading.Condition()


def reader():
    for line in p.stdout:
        m = json.loads(line)
        with cv:
            if "id" in m:
                replies[m["id"]] = m
            else:
                events.append(m)
            cv.notify_all()


threading.Thread(target=reader, daemon=True).start()
n = 0


def call(cmd, timeout=600, **a):
    global n
    n += 1
    i = n
    p.stdin.write(json.dumps({"id": i, "cmd": cmd, **a}) + "\n")
    p.stdin.flush()
    end = time.time() + timeout
    with cv:
        while i not in replies:
            if not cv.wait(max(0.1, end - time.time())) and time.time() > end:
                raise TimeoutError(cmd)
    r = replies[i]
    if "error" in r:
        raise RuntimeError(f"{cmd}: {r['error']}")
    return r["result"]


t0 = time.time()
print("open", call("open", deck=str(deck)))
st = call("state")
names = [s["name"] for s in st["scenes"]]
print("scenes", names)
bad = 0
for name in names:
    t = time.time()
    try:
        sc = call("scene", name=name)
    except Exception as e:  # noqa: BLE001
        bad += 1
        print("  FAIL", name, str(e)[:500])
        continue
    stops = sc.get("stops", [])
    err = sc.get("error")
    png = stops[0].get("png") if stops else None
    ok = bool(png and os.path.exists(png))
    bad += 0 if ok and not err else 1
    print(f"  {'ok ' if ok and not err else 'BAD'} {name}: status={sc.get('status')} builds={len(stops)} "
          f"objects={len(sc.get('objects', {}))} png={png} {time.time() - t:.1f}s {('error=' + str(err)[:400]) if err else ''}")
print(f"done in {time.time() - t0:.1f}s, {bad} bad; work dir {work}")
p.stdin.close()
sys.exit(1 if bad else 0)
