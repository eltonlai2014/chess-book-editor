"""Process-level SQLite connection pool (T2-3).

Both DB consumers — ``eval_service`` (read-only positions.db) and
``chessdb_service`` (read-only positions.db + the editor's own writable cache) —
used to open a brand-new ``sqlite3.connect`` on **every** lookup. On a busy
navigation that's one connect/close per FEN batch and per cloud query. This
module keeps one connection per (path, mode) for the life of the process so the
hot paths reuse it.

Why this is safe here:
  * **Single-user local tool.** No external writer contends for the editor
    cache; positions.db is opened ``?mode=ro`` and the AI repo owns writes.
  * **Serialized SQLite.** Python's sqlite3 is built in serialized threading
    mode; with ``check_same_thread=False`` one connection can be shared across
    Flask's worker threads (``threaded=True``) — SQLite's own mutex serialises
    concurrent statements. Read-only queries never block each other; the lone
    writable cache serialises its rare INSERTs.
  * **Path-keyed.** The eval DB path can change at runtime (settings picker);
    a new path just gets its own pooled connection. The stale one lingers
    (one idle fd) until process exit — acceptable for a tool whose DB rarely
    moves; no invalidation machinery to get wrong.

Connections are intentionally **never closed** — that's the whole point. Callers
must NOT call ``.close()`` on a pooled connection (it would break every other
holder). One-shot validation of an *arbitrary* candidate file (e.g.
``eval_service.db_info`` vetting a path the user is merely browsing) should keep
using its own short-lived connection, not the pool.
"""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

_cache: dict[str, sqlite3.Connection] = {}
_lock = threading.Lock()


def _key(path: Path, mode: str) -> str:
    return f"{mode}:{Path(path).as_posix()}"


def get_ro(path: Path) -> sqlite3.Connection:
    """Pooled read-only connection (URI ``?mode=ro`` — a missing file errors
    clearly instead of silently creating an empty one). Shared across threads."""
    key = _key(path, "ro")
    with _lock:
        con = _cache.get(key)
        if con is None:
            uri = f"file:{Path(path).as_posix()}?mode=ro"
            con = sqlite3.connect(uri, uri=True, check_same_thread=False)
            con.row_factory = sqlite3.Row
            _cache[key] = con
        return con


def get_rw(path: Path, init_sql: str | None = None) -> sqlite3.Connection:
    """Pooled writable connection. ``init_sql`` (e.g. ``CREATE TABLE IF NOT
    EXISTS``) runs once, when the connection is first created — not on every
    call. Creates the parent directory if needed."""
    key = _key(path, "rw")
    with _lock:
        con = _cache.get(key)
        if con is None:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            con = sqlite3.connect(str(path), check_same_thread=False)
            con.row_factory = sqlite3.Row
            if init_sql:
                con.execute(init_sql)
                con.commit()
            _cache[key] = con
        return con
