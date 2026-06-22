"""Isolated Flask launcher for the browser smoke test (tests/test_smoke_ui.py).

Run as a SUBPROCESS so the app's module-level globals can be redirected to temp
locations BEFORE any request is served — keeping the smoke test from ever
touching the user's real preferences.json / library / chessdb cache / eval DB,
and from ever reaching chessdb.cn over the network.

This is a test-only shim (no production code change): it imports the real app
and overrides a handful of module globals + stubs the single outbound call.

Argv: <port> <xqf_root> <prefs_path> <cache_path> <repo_root>
"""
import sys
from pathlib import Path


def main() -> None:
    port = int(sys.argv[1])
    xqf_root, prefs_path, cache_path, repo_root = sys.argv[2:6]
    sys.path.insert(0, repo_root)

    from backend import app as a
    from backend import chessdb_service as cdb

    # Redirect everything stateful to the temp sandbox (globals are read per
    # request: get_xqf_root() reads DEFAULT_XQF_ROOT, _read_prefs() reads
    # PREFS_PATH, the chessdb route reads CHESSDB_CACHE_PATH, eval reads
    # DEFAULT_EVAL_DB) — so these overrides fully isolate the run.
    a.DEFAULT_XQF_ROOT = Path(xqf_root)
    a.PREFS_PATH = Path(prefs_path)
    a.CHESSDB_CACHE_PATH = Path(cache_path)
    a.DEFAULT_EVAL_DB = Path(prefs_path).parent / "no_positions.db"   # absent -> eval degrades

    # Neutralise the ONLY outbound network call: navigation fires a cache-first
    # chessdb lookup, and on a miss it would hit chessdb.cn. Stub it to "unknown"
    # so the test stays offline + deterministic and honours the politeness rule.
    cdb.query_chessdb = lambda fen, timeout=10: {"status": "unknown", "moves": []}

    a.app.run(host="127.0.0.1", port=port, threaded=True)


if __name__ == "__main__":
    main()
