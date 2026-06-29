"""Editor-owned writable cache for the whole-line engine sweep (AI 整局掃描).

The score-trend sweep (``engine_service.analyze_line_stream``) re-runs Pikafish
on every position of a line each time it's triggered. Re-opening the same file,
re-scanning after editing only the tail, or scanning branches that share an
opening prefix all recompute byte-identical ``(fen, depth)`` evals. This cache
stores each completed sweep record so those repeats skip the engine entirely —
when every position of a line is already cached the sweep never even spawns the
engine (``analyze_line_stream`` defers the spawn to the first miss).

Mirrors ``chessdb_service``'s editor cache exactly (``db_pool.get_rw``, ``INSERT
OR REPLACE``, a pooled connection that's never closed) — the ONLY differences are
the table and the key. The key includes BOTH the depth pair AND an engine
signature, because an eval is only valid for a fixed depth and a fixed engine
binary/NNUE: changing either must MISS (recompute) rather than serve a stale
score. See ``engine_service.engine_signature`` for what the signature covers.
``positions.db`` is NOT touched (read-only, the AI repo owns it); this editor
cache is the only engine-eval store the editor writes.

Single-user safety mirrors ``db_pool``'s rationale: no external writer contends,
and SQLite serialises the rare INSERTs across Flask's worker threads.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

from backend import db_pool

# One row per (position, depth pair, engine). Stores the whole record the sweep
# yields (minus the per-request ply/total) so a hit replays it verbatim. cp/mate
# (and cp2/mate2 for the dual depth) are red POV; best is the UCI bestmove, or
# NULL at a terminal position. depth2 is 0 for a single-depth sweep.
_CACHE_INIT_SQL = (
    "CREATE TABLE IF NOT EXISTS engine_eval ("
    "  fen TEXT NOT NULL,"        # trimmed editor FEN (<board> <side>)
    "  depth INTEGER NOT NULL,"
    "  depth2 INTEGER NOT NULL,"  # 0 when single-depth
    "  engine TEXT NOT NULL,"     # engine signature (binary + sibling NNUE stat)
    "  cp INTEGER,"
    "  mate INTEGER,"
    "  best TEXT,"
    "  cp2 INTEGER,"
    "  mate2 INTEGER,"
    "  PRIMARY KEY (fen, depth, depth2, engine)"
    ")"
)


def _trim(fen: str) -> str:
    """Editor FENs are already ``<board> <side>``; trim defensively to the first
    two tokens so a stray move-counter can't fragment the key."""
    parts = fen.split()
    return " ".join(parts[:2]) if len(parts) >= 2 else fen


def ensure(cache_path: Path) -> sqlite3.Connection:
    """Pooled writable connection; the table is created once on first open. Never
    close it (db_pool owns the lifetime for the process)."""
    return db_pool.get_rw(cache_path, _CACHE_INIT_SQL)


def read(con: sqlite3.Connection, fen: str, depth: int, depth2: int,
         engine: str) -> dict | None:
    """Cached sweep record for this ``(fen, depth, depth2, engine)``, or None on a
    miss. Shape matches one ``analyze_line_stream`` record minus ply/total (those
    are per-request — the caller fills them). cp2/mate2 only when ``depth2``."""
    row = con.execute(
        "SELECT cp, mate, best, cp2, mate2 FROM engine_eval"
        " WHERE fen = ? AND depth = ? AND depth2 = ? AND engine = ?",
        (_trim(fen), depth, depth2, engine),
    ).fetchone()
    if row is None:
        return None
    rec = {"cp": row["cp"], "mate": row["mate"], "best": row["best"]}
    if depth2:
        rec["cp2"] = row["cp2"]
        rec["mate2"] = row["mate2"]
    return rec


def read_line(con: sqlite3.Connection, fens: list[str], depth: int, depth2: int,
              engine: str) -> list[dict | None]:
    """Cache-only batch read for a whole line: the cached record (or None on a
    miss) for each fen, in order. Pure lookup — NO engine. Backs the AI tab's
    open-shows-prior-analysis path (``POST /api/engine/eval-cache``)."""
    return [read(con, f, depth, depth2, engine) for f in fens]


def write(con: sqlite3.Connection, fen: str, depth: int, depth2: int,
          engine: str, rec: dict) -> None:
    """Store one completed sweep record. INSERT OR REPLACE so a re-scan (e.g.
    ``fresh=1``) overwrites the row cleanly."""
    con.execute(
        "INSERT OR REPLACE INTO engine_eval"
        " (fen, depth, depth2, engine, cp, mate, best, cp2, mate2)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (_trim(fen), depth, depth2, engine,
         rec.get("cp"), rec.get("mate"), rec.get("best"),
         rec.get("cp2"), rec.get("mate2")),
    )
    con.commit()
