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
from backend import practice_service  # noqa: E402

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


def test_thresholds():
    print("[/api/eval/thresholds]")
    c = app.test_client()
    r = c.get("/api/eval/thresholds")
    body = r.get_json()
    check("thresholds -> 200", r.status_code == 200, f"got {r.status_code}")
    keys = {"skipOpeningPlies", "trapShallowMax", "trapDeepMin",
            "trapDeepMax", "brilliantMin", "brilliantMax"}
    check("has all threshold keys", isinstance(body, dict) and keys <= set(body), body)
    check("values are ints", all(isinstance(body.get(k), int) for k in keys), body)
    # It IS the single source -> route output must equal the module dict.
    check("route == eval_service.TRAP_THRESHOLDS",
          body == app_module.TRAP_THRESHOLDS, body)


def _seed_practice_db(path):
    """臨時 practice.db 塞兩題：A 書答=engine_best（h2e2），B engine_best≠書答。"""
    con = practice_service.connect(path)
    rows = [
        # (init_fen, side, answer_iccs, answer_zh, engine_best, verdict, difficulty)
        (START, "w", ["h2e2", "h9g7"], ["炮二平五", "馬８進７"], "h2e2", "match", 2),
        (START, "w", ["b2e2", "b9c7"], ["炮八平五", "馬２進３"], "c3c4", "alt", 3),
    ]
    import json as _json
    for fen, side, ai, az, eb, vd, diff in rows:
        con.execute(
            "INSERT INTO puzzles (source_rel, game_index, init_fen, side,"
            " answer_iccs, answer_zh, commentary, category, title, book_title,"
            " book_author, ply_count, engine_best, engine_verdict, difficulty,"
            " created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ("t.cbl", rows.index((fen, side, ai, az, eb, vd, diff)), fen, side,
             _json.dumps(ai), _json.dumps(az), "講解", "類", "題", "測試書",
             "", len(ai), eb, vd, diff, "2026-06-30 00:00:00"))
    con.commit()
    con.close()


def test_practice_routes():
    print("[/api/practice/*]")
    c = app.test_client()
    orig_path = practice_service.PRACTICE_DB_PATH
    with tempfile.TemporaryDirectory() as td:
        dbp = Path(td) / "practice.db"
        _seed_practice_db(dbp)
        practice_service.PRACTICE_DB_PATH = dbp
        practice_service._pooled_inited.discard(str(dbp))
        try:
            # info
            r = c.get("/api/practice/info")
            body = r.get_json()
            check("info -> 200", r.status_code == 200, f"{r.status_code} {body}")
            check("info exists true", body.get("exists") is True, body)
            check("info total == 2", body.get("total") == 2, body)
            check("info books shape", isinstance(body.get("books"), list)
                  and body["books"] and "count" in body["books"][0], body)

            # pick -> a puzzle with answer parsed to list
            r = c.get("/api/practice/pick")
            pz = r.get_json()
            check("pick -> 200", r.status_code == 200, f"{r.status_code} {pz}")
            check("pick has init_fen", bool(pz.get("init_fen")), pz)
            check("pick answer_iccs is list", isinstance(pz.get("answer_iccs"), list), pz)

            # check: correct first move (book) on puzzle 1
            r = c.post("/api/practice/check",
                       json={"puzzle_id": 1, "user_iccs": "h2e2", "time_ms": 1200})
            body = r.get_json()
            check("check book-correct -> 200", r.status_code == 200, body)
            check("check correct true", body.get("correct") is True, body)
            check("check via book", body.get("via") == "book", body)
            check("check returns answer list", isinstance(body.get("answer_iccs"), list), body)

            # check: engine-equivalent move (== engine_best, != book) on puzzle 2
            r = c.post("/api/practice/check",
                       json={"puzzle_id": 2, "user_iccs": "c3c4"})
            body = r.get_json()
            check("check engine-equiv correct", body.get("correct") is True, body)
            check("check via engine", body.get("via") == "engine", body)

            # check: wrong move
            r = c.post("/api/practice/check",
                       json={"puzzle_id": 1, "user_iccs": "a0a1"})
            body = r.get_json()
            check("check wrong -> correct false", body.get("correct") is False, body)
            check("check wrong still returns answer", body.get("expected_iccs") == "h2e2", body)

            # check: missing fields -> 400
            r = c.post("/api/practice/check", json={"puzzle_id": 1})
            check("check missing user_iccs -> 400", r.status_code == 400, r.status_code)

            # engine-move: missing fen -> 400 (validated before the engine spawns).
            r = c.post("/api/practice/engine-move", json={"moves": [], "depth": 8})
            check("engine-move missing fen -> 400", r.status_code == 400, r.status_code)

            # stats reflects the 3 attempts
            r = c.get("/api/practice/stats")
            body = r.get_json()
            check("stats -> 200", r.status_code == 200, body)
            check("stats attempts == 3", body.get("attempts") == 3, body)
            check("stats passed == 2", body.get("passed") == 2, body)
        finally:
            practice_service.PRACTICE_DB_PATH = orig_path
            practice_service._pooled_inited.discard(str(dbp))
            # db_pool keeps the WAL connection open (by design); close+evict it
            # so the temp dir can be removed on Windows (open handle = locked file).
            from backend import db_pool
            con = db_pool._cache.pop(db_pool._key(dbp, "rw"), None)
            if con is not None:
                con.close()


def main():
    test_move_info()
    test_eval_batch()
    test_chessdb()
    test_thresholds()
    test_practice_routes()
    print()
    if _failures:
        print(f"FAILED: {len(_failures)} check(s): {', '.join(_failures)}")
        return 1
    print("ALL ROUTE CONTRACT CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
