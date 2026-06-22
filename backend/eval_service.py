"""Read-only adapter onto chess-book-ai's SQLite eval database.

This module is the editor's sole bridge into the AI repo's analysis data.
**Strictly read-only**: no schema migrations, no INSERTs. The editor never
writes to positions.db; that's owned by chess-book-ai's build pipeline.

Default path is sibling repo: ``../chess-book-ai/output/positions.db``.
Override via preferences key ``evalDbPath``.

Returns a flat per-FEN dict so the frontend can render without joining:

    {
      "d12": {"score": -42, "mate": null, "best_iccs": "h2e2", "pv": [...]},
      "d22": {...},
      "d28": {...},
      "d32": {...},
      "cdb": {"status": "ok",
              "best": {"iccs": "h9h5", "score": 186, "winrate": 63.73},
              "moves": [...]}
    }

Missing depths / missing chessdb entries are absent from the dict (not None) —
caller can use `"d22" in evals` as the "have I got deep data" check.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from backend import db_pool

# Schema-known depth columns. Add new depths here when chess-book-ai starts
# producing them (e.g. 36, 40). The editor doesn't care about depth semantics,
# only that they exist as ints.
_DEPTHS = (12, 22, 28, 32)


def _open_ro(db_path: Path) -> sqlite3.Connection:
    """Open the eval DB read-only, SHORT-LIVED (caller closes). URI mode means a
    missing file errors clearly instead of silently creating an empty one. Used
    by ``db_info``, which also vets *arbitrary* candidate files (set_eval_db), so
    it must not pollute the long-lived pool — see ``db_pool``. The hot
    ``lookup_batch`` path uses the pool instead."""
    uri = f"file:{db_path.as_posix()}?mode=ro"
    con = sqlite3.connect(uri, uri=True, check_same_thread=False)
    con.row_factory = sqlite3.Row
    return con


def db_info(db_path: Path) -> dict:
    """Return a small summary so the UI can show whether eval data is wired."""
    out = {"path": str(db_path), "exists": db_path.exists()}
    if not db_path.exists():
        return out
    try:
        con = _open_ro(db_path)
        try:
            rows = con.execute(
                "SELECT depth, COUNT(*) AS n FROM evals GROUP BY depth"
            ).fetchall()
            out["evals_by_depth"] = {r["depth"]: r["n"] for r in rows}
            out["chessdb_rows"] = con.execute("SELECT COUNT(*) FROM chessdb").fetchone()[0]
        finally:
            con.close()
    except sqlite3.DatabaseError as e:
        out["error"] = str(e)
    return out


def lookup_batch(db_path: Path, fens: list[str]) -> dict:
    """Look up evals for a list of FENs. Missing FENs map to empty dicts.

    One SQL query per source table regardless of len(fens) — uses
    ``WHERE fen IN (...)`` with bound params (sqlite limit is 999 vars by
    default; we chunk to stay under).
    """
    out: dict[str, dict] = {fen: {} for fen in fens}
    if not fens or not db_path.exists():
        return out
    # Hot path (one batch per navigation) — reuse a pooled connection instead of
    # connect/close each call. Never close it (see db_pool).
    con = db_pool.get_ro(db_path)
    # Chunk fens to stay under SQLITE_MAX_VARIABLE_NUMBER (default 999).
    for chunk in _chunks(fens, 800):
        placeholders = ",".join("?" * len(chunk))
        # evals: one row per (fen, depth)
        for row in con.execute(
            f"SELECT fen, depth, score, mate, best_iccs, pv_json "
            f"FROM evals WHERE fen IN ({placeholders})",
            chunk,
        ):
            key = f"d{row['depth']}"
            out[row["fen"]][key] = {
                "score": row["score"],
                "mate": row["mate"],
                "best_iccs": row["best_iccs"],
                "pv": json.loads(row["pv_json"]) if row["pv_json"] else [],
            }
        # chessdb: at most one row per fen
        for row in con.execute(
            f"SELECT fen, status, moves_json FROM chessdb WHERE fen IN ({placeholders})",
            chunk,
        ):
            moves = json.loads(row["moves_json"]) if row["moves_json"] else []
            best = moves[0] if moves else None
            cdb = {"status": row["status"], "moves": moves}
            if best:
                cdb["best"] = {
                    "iccs": best.get("iccs"),
                    "score": best.get("score"),
                    "winrate": best.get("winrate"),
                }
            out[row["fen"]]["cdb"] = cdb
    return out


def _chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i : i + n]
