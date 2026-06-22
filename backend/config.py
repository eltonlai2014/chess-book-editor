"""Path / preferences / runtime config resolution (T2-2 split out of app.py).

Holds the frozen-vs-source path split, the DEFAULT_* roots, preferences.json
read/write, and the three runtime path getters (library root / eval DB /
Pikafish). Each getter re-reads preferences.json every call, so a change made
through the settings UI takes effect without restarting the server.

Frozen-build note (load-bearing): read-only bundled resources (the SPA) live
under ``_MEIPASS``; writable state (preferences.json, output/, and the staged
samples\\/engine\\) lives NEXT TO the .exe. ``_resource_base`` vs ``_data_base``
keep that split — see backend/app.py header + package.ps1.

The smoke test (tests/_smoke_server.py) redirects DEFAULT_XQF_ROOT / PREFS_PATH /
DEFAULT_EVAL_DB **on this module** (because the getters here read them) to
sandbox a run — keep these as module-level names the getters read by bare name.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def _resource_base() -> Path:
    """Root of read-only bundled resources (the ``frontend/`` SPA). Under a
    PyInstaller build these are unpacked to ``sys._MEIPASS``; in a source run
    it's the repo root (this file's grandparent)."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    return Path(__file__).resolve().parent.parent


def _data_base() -> Path:
    """Root for WRITABLE state (``preferences.json``, ``output/`` cache). Under
    a PyInstaller build this is the folder next to the .exe — NOT ``_MEIPASS``,
    which is a temp dir wiped on exit (onefile) and conceptually read-only."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


# Default library / engine / eval-DB roots, overridable via preferences.json.
# Frozen build: point at resources shipped NEXT TO the exe (samples\, engine\
# Windows\) so a fresh machine works with zero config — package.ps1 copies them
# in. Source run: master's sibling repos. The eval DB is never bundled (AI
# repo's data); an absent path degrades gracefully (eval/info exists:false).
if getattr(sys, "frozen", False):
    _APP_DIR = _data_base()
    DEFAULT_XQF_ROOT = _APP_DIR / "samples"
    DEFAULT_PIKAFISH = _APP_DIR / "engine" / "Windows" / "pikafish-avx2.exe"
    DEFAULT_EVAL_DB = _APP_DIR / "positions.db"
else:
    DEFAULT_XQF_ROOT = Path(r"D:\Elton\TestArea\chess-book")
    DEFAULT_EVAL_DB = (
        Path(__file__).resolve().parent.parent.parent
        / "chess-book-ai" / "output" / "positions.db"
    )
    DEFAULT_PIKAFISH = (
        Path(__file__).resolve().parent.parent.parent
        / "chess-book-ai" / "engine" / "Windows" / "pikafish-avx2.exe"
    )


FRONTEND_ROOT = _resource_base() / "frontend"
PREFS_PATH = _data_base() / "preferences.json"
# Editor's OWN writable chessdb cache for live chessdb.cn lookups. Kept apart
# from the read-only positions.db (AI repo) and the AI pipeline's
# chessdb_cache.json — see backend/chessdb_service.py.
CHESSDB_CACHE_PATH = _data_base() / "output" / "editor_chessdb_cache.db"


# ---------- user preferences --------------------------------------------------
# Lightweight key/value store kept as preferences.json. Persists UI state across
# sessions: splitter sizes, board theme, library root, eval DB / engine paths.
# Local-only tool, so no auth — anyone reaching the server can read/write it.

def _read_prefs() -> dict:
    if not PREFS_PATH.exists():
        return {}
    try:
        return json.loads(PREFS_PATH.read_text("utf-8"))
    except Exception:
        return {}


def _write_prefs(data: dict) -> None:
    PREFS_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def get_xqf_root() -> Path:
    """Resolve current XQF library root. Reads preferences each call so a
    change via POST /api/xqf/root takes effect without a restart."""
    prefs = _read_prefs()
    custom = prefs.get("xqfRoot")
    if custom:
        try:
            p = Path(custom).expanduser().resolve()
            if p.is_dir():
                return p
        except Exception:
            pass
    return DEFAULT_XQF_ROOT.resolve()


def _get_eval_db() -> Path:
    """Resolve current eval DB path. Pref override > default sibling repo."""
    prefs = _read_prefs()
    custom = prefs.get("evalDbPath")
    if custom:
        try:
            p = Path(custom).expanduser().resolve()
            return p
        except Exception:
            pass
    return DEFAULT_EVAL_DB.resolve()


def _get_pikafish() -> Path:
    """Resolve current Pikafish path. Pref override > default sibling build."""
    prefs = _read_prefs()
    custom = prefs.get("pikafishPath")
    if custom:
        try:
            return Path(custom).expanduser().resolve()
        except Exception:
            pass
    return DEFAULT_PIKAFISH.resolve()
