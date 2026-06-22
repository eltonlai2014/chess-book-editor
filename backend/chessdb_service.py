"""Live chessdb.cn cloud-library lookup with cache-first resolution.

The editor lets the user set up *arbitrary* positions, so the AI repo's
``positions.db`` (read-only, owned by chess-book-ai) will miss most of them.
This module fills the gap: when the cached DB has no row for a FEN, it queries
chessdb.cn live and caches the answer in the **editor's own** small SQLite —
never in positions.db (read-only) and never in the AI repo's
``chessdb_cache.json`` (that's the AI pipeline's source file).

Resolution order for ``lookup()``:
  1. positions.db ``chessdb`` table (read-only, exact-FEN then trimmed-FEN).
  2. editor's own cache DB (keyed by trimmed FEN).
  3. live chessdb.cn query → write to the editor cache → return.

Return shape matches what ``eval_service.lookup_batch`` puts under ``cdb`` so
the frontend renders identically regardless of source:

    {
      "status": "ok",                # or 'unknown'/'invalid board'/'checkmate'/...
      "moves":  [{iccs, score, rank, note, winrate}, ...],   # mover-POV score
      "best":   {iccs, score, winrate} | None,               # moves[0], if any
      "source": "db" | "cache" | "live",
    }

See docs/CHESSDB_CLOUD_QUERY.md for the protocol details and known traps
(NUL byte, FEN trimming, http-not-https, error states).
"""
from __future__ import annotations

import json
import sqlite3
import urllib.parse
import urllib.request
from pathlib import Path

from backend import db_pool

API = "http://www.chessdb.cn/chessdb.php"

# chessdb single-string error/status responses (not pipe-delimited move lists).
_ERR_STATES = ("invalid board", "unknown", "checkmate", "stalemate", "nobestmove")


def trim_fen(fen: str) -> str:
    """chessdb only accepts ``<position> <side>`` — drop halfmove/fullmove."""
    parts = fen.split()
    return " ".join(parts[:2]) if len(parts) >= 2 else fen


def _shape(status: str, moves: list, source: str) -> dict:
    """Normalise to the cdb shape the frontend expects (see module docstring)."""
    best = moves[0] if moves else None
    out = {"status": status, "moves": moves, "source": source}
    if best:
        out["best"] = {
            "iccs": best.get("iccs"),
            "score": best.get("score"),
            "winrate": best.get("winrate"),
        }
    else:
        out["best"] = None
    return out


def query_chessdb(fen: str, timeout: int = 10) -> dict:
    """Hit chessdb.cn live. Returns ``{status, moves}`` (no best/source — that's
    added by ``lookup``). ``moves`` scores are mover-POV centipawns.

    Handles the documented traps: NUL byte in the tail, missing score/winrate
    fields, and single-string error states.
    """
    q = urllib.parse.urlencode({"action": "queryall", "board": trim_fen(fen)})
    with urllib.request.urlopen(f"{API}?{q}", timeout=timeout) as r:
        text = r.read().decode("utf-8", errors="replace")
    text = text.replace("\x00", "").strip()          # NUL-byte guard (doc §5.1)
    if not text:
        return {"status": "unknown", "moves": []}
    if text in _ERR_STATES:
        return {"status": text, "moves": []}
    moves = []
    for chunk in text.split("|"):
        kv = {}
        for pair in chunk.split(","):
            if ":" in pair:
                k, v = pair.split(":", 1)
                kv[k] = v.strip()
        if "move" not in kv:
            continue
        moves.append({
            "iccs": kv.get("move"),
            "score": int(kv["score"]) if kv.get("score", "").lstrip("-").isdigit() else None,
            "rank": int(kv["rank"]) if kv.get("rank", "").isdigit() else None,
            "note": kv.get("note", ""),
            "winrate": float(kv["winrate"]) if kv.get("winrate") else None,
        })
    return {"status": "ok", "moves": moves}


# ---------- positions.db (read-only) lookup ----------------------------------

def _read_positions_db(db_path: Path, fen: str) -> dict | None:
    """Read one cdb row from the AI repo's read-only positions.db.

    Tries the exact editor FEN first (that's how eval_service keys it), then
    the trimmed FEN as a fallback (doc §2A: migrate keys vary). Returns the
    cdb-shaped dict on a hit, or None when the file/table/row is absent.
    Uses a pooled connection (db_pool) — never closes it."""
    if not db_path.exists():
        return None
    try:
        con = db_pool.get_ro(db_path)
        for key in (fen, trim_fen(fen)):
            row = con.execute(
                "SELECT status, moves_json FROM chessdb WHERE fen = ?", (key,)
            ).fetchone()
            if row is not None:
                moves = json.loads(row["moves_json"]) if row["moves_json"] else []
                return _shape(row["status"], moves, "db")
        return None
    except sqlite3.DatabaseError:
        return None


# ---------- editor-owned writable cache --------------------------------------

# Editor cache schema. Table created once when the pooled connection opens.
_CACHE_INIT_SQL = (
    "CREATE TABLE IF NOT EXISTS chessdb ("
    "  fen TEXT PRIMARY KEY,"      # trimmed FEN (<position> <side>)
    "  status TEXT,"
    "  moves_json TEXT"
    ")"
)


def _ensure_cache(cache_path: Path) -> sqlite3.Connection:
    """Pooled writable connection to the editor's own chessdb cache — the ONLY
    chessdb store the editor writes to (positions.db stays read-only). The table
    is created once on first open; the connection lives for the process (db_pool)
    so callers must NOT close it."""
    return db_pool.get_rw(cache_path, _CACHE_INIT_SQL)


def _read_cache(con: sqlite3.Connection, fen: str) -> dict | None:
    row = con.execute(
        "SELECT status, moves_json FROM chessdb WHERE fen = ?", (trim_fen(fen),)
    ).fetchone()
    if row is None:
        return None
    moves = json.loads(row["moves_json"]) if row["moves_json"] else []
    return _shape(row["status"], moves, "cache")


def _write_cache(con: sqlite3.Connection, fen: str, status: str, moves: list) -> None:
    con.execute(
        "INSERT OR REPLACE INTO chessdb (fen, status, moves_json) VALUES (?, ?, ?)",
        (trim_fen(fen), status, json.dumps(moves, ensure_ascii=False)),
    )
    con.commit()


def lookup(positions_db: Path, cache_db: Path, fen: str, timeout: int = 10,
           fresh: bool = False) -> dict:
    """Cache-first cloud-library lookup for a single FEN (see module docstring
    for the resolution order). Live results are written back to ``cache_db``.

    ``fresh=True`` skips BOTH caches (positions.db and the editor cache) and
    forces a live chessdb.cn query, overwriting the editor-cache row — used by
    the UI's 重查 button when the community data may have moved on."""
    if not fresh:
        hit = _read_positions_db(positions_db, fen)
        if hit is not None:
            return hit
    con = _ensure_cache(cache_db)   # pooled — do NOT close (see db_pool)
    if not fresh:
        hit = _read_cache(con, fen)
        if hit is not None:
            return hit
    live = query_chessdb(fen, timeout=timeout)
    _write_cache(con, fen, live["status"], live["moves"])
    return _shape(live["status"], live["moves"], "live")
