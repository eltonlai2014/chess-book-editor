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
    from backend import config as cfg
    from backend import chessdb_service as cdb

    # Redirect everything stateful to the temp sandbox. Since T2-2 the path/pref
    # resolution lives in backend/config.py — get_xqf_root() reads
    # cfg.DEFAULT_XQF_ROOT, _read_prefs() reads cfg.PREFS_PATH, _get_eval_db()
    # reads cfg.DEFAULT_EVAL_DB — so those overrides go on `cfg`. The chessdb
    # route reads CHESSDB_CACHE_PATH off the `app` module (imported there), so
    # override it on both to be safe.
    sandbox = Path(prefs_path).parent
    cfg.DEFAULT_XQF_ROOT = Path(xqf_root)
    cfg.PREFS_PATH = Path(prefs_path)
    cfg.DEFAULT_EVAL_DB = sandbox / "no_positions.db"   # absent -> eval degrades
    # Stub the engine too: /api/engine/info would otherwise EXEC the real Pikafish
    # (UCI handshake, slow NNUE load) — not what this frontend test exercises, and
    # a real binary may be absent in CI. Pointing at a missing path makes
    # engine/info return {exists:false} instantly (engine UI degrades gracefully),
    # keeping the boot/reload deterministic and offline. (test_engine_sse covers
    # the real engine separately and SKIPs without one.)
    cfg.DEFAULT_PIKAFISH = sandbox / "no_engine.exe"
    cfg.CHESSDB_CACHE_PATH = Path(cache_path)
    a.CHESSDB_CACHE_PATH = Path(cache_path)

    # Neutralise the ONLY outbound network call: navigation fires a cache-first
    # chessdb lookup, and on a miss it would hit chessdb.cn. Stub it to "unknown"
    # so the test stays offline + deterministic and honours the politeness rule.
    cdb.query_chessdb = lambda fen, timeout=10: {"status": "unknown", "moves": []}

    a.app.run(host="127.0.0.1", port=port, threaded=True)


if __name__ == "__main__":
    main()
