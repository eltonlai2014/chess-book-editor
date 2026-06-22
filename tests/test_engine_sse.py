"""Engine SSE contract tests — the safety net the two Pikafish streaming routes
never had (test_routes covers move-info/eval/chessdb; these execs were untested).

Covers the runtime behaviour of:
  GET  /api/engine/analyze        -> text/event-stream: per-depth `info` events
                                     + a final `{done:true, bestmove}`.
  POST /api/engine/analyze-line   -> application/x-ndjson: one record per fen
                                     with {ply,total,cp|mate,best}; depth2 adds cp2.

Needs a REAL Pikafish (it execs the configured binary). SKIPs cleanly when the
engine isn't configured — same CI-safe pattern as tests/test_smoke_ui.py. Bounded
depth keeps each run sub-second. Ephemeral: nothing is persisted.

Run:
    .\.venv\Scripts\python.exe tests\test_engine_sse.py
"""
import json
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cchess import FULL_INIT_FEN  # noqa: E402
from backend import app as app_module  # noqa: E402

app = app_module.app
app.testing = True

START = " ".join(FULL_INIT_FEN.split()[:2])   # `<board> <side>` editor FEN
DEPTH = 10                                     # bounded -> fast, deterministic-ish

_failures = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        _failures.append(name)


def _parse_sse(text):
    """Yield JSON payloads from an SSE body (lines beginning `data: `)."""
    for block in text.split("\n\n"):
        for line in block.splitlines():
            if line.startswith("data:"):
                yield json.loads(line[len("data:"):].strip())


def test_analyze():
    print("[/api/engine/analyze]")
    c = app.test_client()
    fen_q = urllib.parse.quote(START)
    r = c.get(f"/api/engine/analyze?fen={fen_q}&depth={DEPTH}")
    check("content-type event-stream", "text/event-stream" in r.content_type, r.content_type)
    events = list(_parse_sse(r.get_data(as_text=True)))
    infos = [e for e in events if not e.get("done")]
    dones = [e for e in events if e.get("done")]
    check("got >=1 info event", len(infos) >= 1, f"{len(infos)} infos")
    check("info has depth", infos and "depth" in infos[0], infos[:1])
    check("info has score (cp or mate)",
          infos and ("cp" in infos[0] or "mate" in infos[0]), infos[:1])
    check("info has pv list", infos and isinstance(infos[0].get("pv"), list), infos[:1])
    check("exactly one done event", len(dones) == 1, f"{len(dones)} dones")
    check("done has bestmove", dones and "bestmove" in dones[0], dones[:1])

    # Missing fen -> 400 (validated before any engine spawn).
    r = c.get("/api/engine/analyze")
    check("missing fen -> 400", r.status_code == 400, f"got {r.status_code}")


def test_analyze_line():
    print("[/api/engine/analyze-line]")
    c = app.test_client()
    r = c.post("/api/engine/analyze-line",
               json={"fens": [START, START], "depth": DEPTH})
    check("content-type ndjson", "x-ndjson" in r.content_type, r.content_type)
    recs = [json.loads(ln) for ln in r.get_data(as_text=True).splitlines() if ln.strip()]
    check("one record per fen", len(recs) == 2, f"{len(recs)} records")
    check("records carry ply 0..n", [x.get("ply") for x in recs] == [0, 1], recs)
    check("total == 2", all(x.get("total") == 2 for x in recs), recs)
    check("has score (cp or mate)",
          all((x.get("cp") is not None or x.get("mate") is not None) for x in recs), recs)
    check("has best", all("best" in x for x in recs), recs)

    # depth2 -> a second (deeper) eval column cp2/mate2 appears.
    r = c.post("/api/engine/analyze-line",
               json={"fens": [START], "depth": 8, "depth2": DEPTH})
    recs = [json.loads(ln) for ln in r.get_data(as_text=True).splitlines() if ln.strip()]
    check("depth2 adds cp2/mate2 key",
          recs and ("cp2" in recs[0] or "mate2" in recs[0]), recs[:1])


def main():
    engine = app_module._get_pikafish()
    if not (engine.exists() and engine.is_file()):
        print(f"  SKIP  engine SSE tests — no Pikafish at {engine}")
        return 0
    print(f"engine = {engine}")
    test_analyze()
    test_analyze_line()
    print()
    if _failures:
        print(f"FAILED: {len(_failures)} check(s): {', '.join(_failures)}")
        return 1
    print("ALL ENGINE SSE CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
