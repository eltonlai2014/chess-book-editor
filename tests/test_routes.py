"""Route-contract tests for the Flask backend — no network, no real engine, no
required data files. The first automated safety net for the JSON contracts the
frontend depends on (until now ONLY persistence round-trips were covered).

Covers the three most drift-prone request/response shapes:
  POST /api/xqf/move-info   -> {ok, notation, side} | 400
  POST /api/eval/batch      -> {db_path, evals:{fen:{...}}} | 400 | 500
  GET  /api/chessdb?fen=    -> {status, moves, best, source} | 400 | graceful-error

Determinism + politeness:
  * chessdb's live network call (`chessdb_service.query_chessdb`) is
    monkeypatched, so the suite NEVER hits chessdb.cn (honours the ~5 req/s
    rule, see docs/CHESSDB_CLOUD_QUERY.md) and doesn't depend on positions.db
    or the editor cache.
  * eval/batch's data layer is monkeypatched for the shape assertions; a real
    positions.db, if present, gets one extra smoke check (skipped otherwise).

Run:
    .\.venv\Scripts\python.exe tests\test_routes.py
"""
import sqlite3
import sys
import tempfile
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cchess import FULL_INIT_FEN  # noqa: E402
from backend import app as app_module  # noqa: E402
from backend import chessdb_service  # noqa: E402

app = app_module.app
app.testing = True

# The editor's FEN contract is `<board> <side>` (no move counters) — test with
# exactly that, since the whole app couples to it.
START = " ".join(FULL_INIT_FEN.split()[:2])

_failures = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        _failures.append(name)


# --------------------------------------------------------------------------- #
# POST /api/xqf/move-info
# --------------------------------------------------------------------------- #
def test_move_info():
    print("[/api/xqf/move-info]")
    c = app.test_client()

    # Happy path: standard red first move 炮二平五 (h2->e2).
    r = c.post("/api/xqf/move-info", json={"fen": START, "iccs": "h2e2"})
    body = r.get_json()
    check("legal move -> 200", r.status_code == 200, f"got {r.status_code} {body}")
    check("legal move ok:true", body.get("ok") is True, body)
    check("legal move has notation", isinstance(body.get("notation"), str) and bool(body.get("notation")), body)
    check("legal move side == red", body.get("side") == "red", body)

    # Contract note: move-info validates GEOMETRY + reports the MOVING piece's
    # side; it does NOT enforce whose turn it is (turn is gated in the UI). A
    # black-piece move from the red-to-move start position is still accepted and
    # tagged side:black. (If turn-enforcement is ever wanted, this test flips.)
    r = c.post("/api/xqf/move-info", json={"fen": START, "iccs": "h7e7"})
    body = r.get_json()
    check("black-piece move accepted, side==black",
          r.status_code == 200 and body.get("ok") is True and body.get("side") == "black", body)

    # Empty source square e4 -> no piece -> illegal.
    r = c.post("/api/xqf/move-info", json={"fen": START, "iccs": "e4e5"})
    check("empty-source move -> 400", r.status_code == 400, f"got {r.status_code} {r.get_json()}")

    # Malformed iccs -> 400 (not a 500).
    r = c.post("/api/xqf/move-info", json={"fen": START, "iccs": "zzzz"})
    check("garbage iccs -> 400", r.status_code == 400, f"got {r.status_code} {r.get_json()}")

    # Missing fen -> 400.
    r = c.post("/api/xqf/move-info", json={"iccs": "h2e2"})
    check("missing fen -> 400", r.status_code == 400, f"got {r.status_code} {r.get_json()}")


# --------------------------------------------------------------------------- #
# POST /api/eval/batch
# --------------------------------------------------------------------------- #
def _fake_eval_batch(db, fens):
    return {f: {"d12": {"score": 10, "mate": None}} for f in fens}


def _raise_db_error(db, fens):
    raise sqlite3.DatabaseError("simulated db read failure")


def test_eval_batch():
    print("[/api/eval/batch]")
    c = app.test_client()

    # Bad input is rejected BEFORE any DB access -> deterministic 400.
    r = c.post("/api/eval/batch", json={"fens": "not-a-list"})
    check("non-list fens -> 400", r.status_code == 400, f"got {r.status_code} {r.get_json()}")

    # Response-shape contract via a stubbed data layer (no DB needed).
    orig = app_module.eval_lookup_batch
    app_module.eval_lookup_batch = _fake_eval_batch
    try:
        r = c.post("/api/eval/batch", json={"fens": ["x w", "y b"]})
        body = r.get_json()
        check("valid batch -> 200", r.status_code == 200, f"got {r.status_code} {body}")
        check("has db_path", "db_path" in body, body)
        check("evals is dict", isinstance(body.get("evals"), dict), body)
        check("evals covers requested fens", set(body.get("evals", {})) == {"x w", "y b"}, body)

        # Empty list -> 200 with empty evals (deterministic under the stub).
        r = c.post("/api/eval/batch", json={"fens": []})
        check("empty fens -> 200 {}", r.status_code == 200 and r.get_json().get("evals") == {}, r.get_json())

        # Non-string entries are filtered out before lookup.
        r = c.post("/api/eval/batch", json={"fens": ["x w", 123, "", None]})
        check("filters non-str fens", set(r.get_json().get("evals", {})) == {"x w"}, r.get_json())
    finally:
        app_module.eval_lookup_batch = orig

    # A DB read error surfaces as 500 (not a crash).
    app_module.eval_lookup_batch = _raise_db_error
    try:
        r = c.post("/api/eval/batch", json={"fens": ["x w"]})
        check("db error -> 500", r.status_code == 500, f"got {r.status_code} {r.get_json()}")
    finally:
        app_module.eval_lookup_batch = orig

    # Optional smoke check against a real positions.db, if one is configured.
    try:
        db = app_module._get_eval_db()
        if db and Path(db).exists():
            r = c.post("/api/eval/batch", json={"fens": [START]})
            check("real-db smoke -> 200 + dict evals",
                  r.status_code == 200 and isinstance(r.get_json().get("evals"), dict),
                  r.get_json())
        else:
            print("  SKIP  real-db smoke (no positions.db configured)")
    except Exception as e:
        print(f"  SKIP  real-db smoke ({e})")


# --------------------------------------------------------------------------- #
# GET /api/chessdb
# --------------------------------------------------------------------------- #
def _fake_query_ok(fen, timeout=10):
    return {"status": "ok", "moves": [
        {"iccs": "h2e2", "score": 30, "rank": 1, "note": "", "winrate": 60.0},
        {"iccs": "b2e2", "score": 12, "rank": 2, "note": "", "winrate": 53.0},
    ]}


def _raise_network(fen, timeout=10):
    raise RuntimeError("simulated network failure")


def test_chessdb():
    print("[/api/chessdb]")
    c = app.test_client()

    # Missing fen -> 400.
    r = c.get("/api/chessdb")
    check("missing fen -> 400", r.status_code == 400, f"got {r.status_code} {r.get_json()}")

    # Isolate the cache to a temp file and force the live path (no positions.db,
    # empty editor cache) so the mocked query_chessdb always decides the result.
    tmp_cache = Path(tempfile.mkdtemp()) / "cache.db"
    orig_cache = app_module.CHESSDB_CACHE_PATH
    orig_db = app_module._get_eval_db
    orig_q = chessdb_service.query_chessdb
    app_module.CHESSDB_CACHE_PATH = tmp_cache
    app_module._get_eval_db = lambda: Path("___no_positions_db___.db")
    fen_q = urllib.parse.quote(START)
    try:
        # Live hit -> shaped {status, moves, best, source:'live'}.
        chessdb_service.query_chessdb = _fake_query_ok
        r = c.get(f"/api/chessdb?fen={fen_q}")
        body = r.get_json()
        check("live hit -> 200", r.status_code == 200, f"got {r.status_code} {body}")
        check("status ok", body.get("status") == "ok", body)
        check("source live", body.get("source") == "live", body)
        check("best == moves[0]", (body.get("best") or {}).get("iccs") == "h2e2", body)
        check("moves is list w/ iccs", isinstance(body.get("moves"), list)
              and body["moves"] and body["moves"][0].get("iccs") == "h2e2", body)

        # Live network failure degrades to 200 + status:error (never 500).
        chessdb_service.query_chessdb = _raise_network
        # fresh=1 so it skips the row just written to the temp cache and re-queries.
        r = c.get(f"/api/chessdb?fen={fen_q}&fresh=1")
        body = r.get_json()
        check("network failure -> 200 (not 500)", r.status_code == 200, f"got {r.status_code} {body}")
        check("network failure status error", body.get("status") == "error", body)
        check("network failure moves []", body.get("moves") == [], body)
    finally:
        chessdb_service.query_chessdb = orig_q
        app_module._get_eval_db = orig_db
        app_module.CHESSDB_CACHE_PATH = orig_cache


def main():
    test_move_info()
    test_eval_batch()
    test_chessdb()
    print()
    if _failures:
        print(f"FAILED: {len(_failures)} check(s): {', '.join(_failures)}")
        return 1
    print("ALL ROUTE CONTRACT CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
