"""A private working copy of a deck. Edits go to the copy; Save writes them back to the original.

The Windows counterpart of apps/macos/Sources/Manimble/Workspace.swift. Where the Mac app uses symlinks to mirror
the deck's surroundings (assets, media, data ...), this uses directory junctions, which need no administrator rights.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import uuid
from pathlib import Path

from .agent_instructions import FILES as AGENT_FILES, TEXT as AGENT_TEXT

GENERATED = {"slides", "media", "__pycache__", ".manimble"}   # made by Manimble or Manim Slides: never saved


def base() -> Path:
    root = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "Manimble"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _hash(path: Path) -> str:
    return hashlib.sha256(str(path).lower().encode("utf-8")).hexdigest()[:12]


def cache_dir(deck: Path) -> Path:
    d = base() / "cache" / f"{deck.name}-{_hash(deck)}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def is_link(p: Path | str) -> bool:
    return os.path.islink(p) or os.path.isjunction(p)


def _link_dir(link: Path, target: Path) -> bool:
    try:
        import _winapi
        _winapi.CreateJunction(str(target), str(link))
        return True
    except Exception:  # noqa: BLE001
        return False


def _holds_python(d: Path) -> bool:
    for cur, dirs, files in os.walk(d):
        dirs[:] = [x for x in dirs if x not in GENERATED and not x.startswith(".")]
        if any(f.endswith(".py") for f in files):
            return True
    return False


def remove_tree(root: Path) -> None:
    """Delete a working copy without ever following a junction or symlink into the original project."""
    if not root.exists() and not is_link(root):
        return
    for cur, dirs, files in os.walk(root, topdown=True):
        keep = []
        for d in dirs:
            p = os.path.join(cur, d)
            if is_link(p):
                try:
                    os.rmdir(p) if os.path.isjunction(p) else os.unlink(p)     # removes the link, not its target
                except OSError:
                    try:
                        os.unlink(p)
                    except OSError:
                        pass
            else:
                keep.append(d)
        dirs[:] = keep
        for f in files:
            try:
                os.chmod(os.path.join(cur, f), 0o666)
                os.unlink(os.path.join(cur, f))
            except OSError:
                pass
    for cur, dirs, _ in os.walk(root, topdown=False):
        for d in dirs:
            p = os.path.join(cur, d)
            if not is_link(p):
                try:
                    os.rmdir(p)
                except OSError:
                    pass
    try:
        os.rmdir(root)
    except OSError:
        pass


class Workspace:
    def __init__(self, deck: str):
        self.original = Path(deck).resolve()
        if not self.original.is_dir():
            raise FileNotFoundError(f"No deck folder at {self.original}")
        project = self.original.parent
        self.name = f"{project.name}-{self.original.name}"
        self.root = base() / "work" / f"{self.original.name}-{_hash(self.original)}-{uuid.uuid4().hex[:8]}"
        wproject = self.root / project.name
        self.work = wproject / self.original.name
        self.work.mkdir(parents=True)
        self.own_files: set[str] = set()     # written here for coding agents; never saved to the original
        self._compared: dict[str, tuple] = {}

        # the deck's siblings (assets, media, data ...) appear next to the copy, so relative paths keep working
        for e in project.iterdir():
            if e.name == self.original.name or e.name.startswith("."):
                continue
            if e.is_dir():
                _link_dir(wproject / e.name, e)
        for e in self.original.iterdir():
            if e.name.startswith(".") or e.name == "__pycache__":
                continue
            dest = self.work / e.name
            if e.is_dir():
                if e.name == "slides":
                    shutil.copytree(e, dest, dirs_exist_ok=True)       # builds from edited code never touch the original's
                elif e.name not in GENERATED and _holds_python(e):
                    shutil.copytree(e, dest, ignore=shutil.ignore_patterns("__pycache__", ".manimble"))
                else:
                    _link_dir(dest, e)
            else:
                shutil.copy2(e, dest)
        self.baseline: dict[str, bytes] = {}
        for rel in self.deck_files():
            try:
                self.baseline[rel] = (self.original / rel).read_bytes()
            except OSError:
                pass
        for name in AGENT_FILES:                # what a coding agent started in the terminal reads first
            p = self.work / name
            if not p.exists():
                try:
                    p.write_text(AGENT_TEXT, encoding="utf-8")
                    self.own_files.add(name)
                except OSError:
                    pass

    def deck_files(self) -> list[str]:
        """Every file Save writes back, by path in the deck folder."""
        out = []
        for cur, dirs, files in os.walk(self.work):
            dirs[:] = [d for d in dirs if d not in GENERATED and not d.startswith(".")
                       and not is_link(os.path.join(cur, d))]
            for f in files:
                rel = os.path.relpath(os.path.join(cur, f), self.work).replace("\\", "/")
                if f.startswith(".") or rel in self.own_files or rel.endswith(".manimble.tmp"):
                    continue
                out.append(rel)
        return sorted(out)

    def _differs(self, rel: str) -> bool:
        p = self.work / rel
        try:
            st = p.stat()
        except OSError:
            return True
        c = self._compared.get(rel)
        if c and c[0] == st.st_size and c[1] == st.st_mtime_ns:
            return not c[2]
        b = self.baseline.get(rel)
        same = b is not None and len(b) == st.st_size and p.read_bytes() == b
        self._compared[rel] = (st.st_size, st.st_mtime_ns, same)
        return not same

    @property
    def changed_files(self) -> list[str]:
        present = self.deck_files()
        return [r for r in present if self._differs(r)] + sorted(set(self.baseline) - set(present))

    @property
    def conflict_files(self) -> list[str]:
        """Files of the original that someone else changed since the copy was made."""
        out = []
        for rel in self.changed_files:
            try:
                cur = (self.original / rel).read_bytes()
            except OSError:
                cur = None
            if cur != self.baseline.get(rel):
                out.append(rel)
        return out

    def save(self) -> list[str]:
        if not self.original.is_dir():
            raise FileNotFoundError(
                f"The deck folder is no longer at {self.original}: it was moved, renamed or deleted since it was "
                "opened. Your edits are still in the working copy.")
        done = []
        for rel in self.changed_files:
            src, dest = self.work / rel, self.original / rel
            if src.exists():
                data = src.read_bytes()
                dest.parent.mkdir(parents=True, exist_ok=True)
                tmp = dest.with_name(dest.name + ".manimble.tmp")
                tmp.write_bytes(data)
                os.replace(tmp, dest)
                self.baseline[rel] = data
            else:
                if dest.exists():
                    dest.unlink()
                self.baseline.pop(rel, None)
            self._compared.pop(rel, None)
            done.append(rel)
        return done

    def revert(self) -> list[str]:
        done = []
        for rel in self.changed_files:
            p = self.work / rel
            b = self.baseline.get(rel)
            if b is not None:
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(b)
            else:
                try:
                    p.unlink()
                except OSError:
                    pass
            self._compared.pop(rel, None)
            done.append(rel)
        return done

    def discard(self) -> None:
        remove_tree(self.root)
