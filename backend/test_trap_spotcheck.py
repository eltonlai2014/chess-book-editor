"""Spot-check: locate the known ground-truth trap (pi=40 d0d1 s=10 d=122)
and confirm the editor's detector flags it with the same loss values.
"""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend.xqf_service import load_xqf  # noqa: E402
from backend.eval_service import lookup_batch, TRAP_THRESHOLDS  # noqa: E402
from backend.test_eval_integration import apply_iccs  # noqa: E402

# Single source (T3-2): same dict the editor fetches via /api/eval/thresholds.
SKIP_OPENING_PLIES = TRAP_THRESHOLDS["skipOpeningPlies"]
TRAP_SHALLOW_MAX = TRAP_THRESHOLDS["trapShallowMax"]
TRAP_DEEP_MIN = TRAP_THRESHOLDS["trapDeepMin"]
TRAP_DEEP_MAX = TRAP_THRESHOLDS["trapDeepMax"]
BRILLIANT_MIN = TRAP_THRESHOLDS["brilliantMin"]
BRILLIANT_MAX = TRAP_THRESHOLDS["brilliantMax"]


def _score_cp(e):
    if not e:
        return None
    if e.get("mate") is not None:
        m = e["mate"]
        return 30000 - abs(m) if m > 0 else -(30000 - abs(m))
    s = e.get("score")
    return s if isinstance(s, int) else None


def _ply_loss(items, i, depth_key, evals):
    if i >= len(items) - 1:
        return None
    a = evals.get(items[i]["fen"])
    b = evals.get(items[i + 1]["fen"])
    if not a or not b:
        return None
    sa = _score_cp(a.get(depth_key))
    sb = _score_cp(b.get(depth_key))
    if sa is None or sb is None:
        return None
    return sa + sb


def editor_detect(data, evals):
    out = {}
    roots = data.get("roots") or []
    for vi, root in enumerate(roots):
        items, fen, node = [], data["init_fen"], root
        ply = 1
        while node is not None:
            items.append({"fen": fen, "node": node, "ply": ply})
            fen = apply_iccs(fen, node["iccs"])
            node = (node.get("children") or [None])[0]
            ply += 1
        for i in range(len(items) - 1):
            if items[i]["ply"] <= SKIP_OPENING_PLIES:
                continue
            s = _ply_loss(items, i, "d12", evals)
            d = _ply_loss(items, i, "d22", evals)
            vd = _ply_loss(items, i, "d28", evals)
            trap_a = s is not None and s < TRAP_SHALLOW_MAX and d is not None and TRAP_DEEP_MIN < d < TRAP_DEEP_MAX
            trap_b = (not trap_a and s is not None and s < TRAP_SHALLOW_MAX
                      and vd is not None and TRAP_DEEP_MIN < vd < TRAP_DEEP_MAX)
            if trap_a or trap_b:
                out[(vi, i)] = ("trap", "d22" if trap_a else "d28", s, d, vd)
                continue
            if d is not None:
                gain = -d
                if BRILLIANT_MIN <= gain <= BRILLIANT_MAX:
                    out[(vi, i)] = ("brilliant", None, s, d, vd)
    return out

DB = ROOT.parent / "chess-book-ai" / "output" / "positions.db"
LIB = Path(r"D:\Elton\TestArea\chess-book")

# Walk every XQF; the editor.detect() will pull traps regardless of filename.
results = []
for xqf in sorted(LIB.glob("*.XQF")):
    try:
        data = load_xqf(xqf)
    except Exception:
        continue
    fens = {data["init_fen"]}
    def walk(fen, children):
        for n in children:
            nxt = apply_iccs(fen, n["iccs"])
            fens.add(nxt)
            walk(nxt, n.get("children") or [])
    walk(data["init_fen"], data.get("roots") or [])
    evals = lookup_batch(DB, list(fens))
    verdicts = editor_detect(data, evals)
    traps = [(k, v) for k, v in verdicts.items() if v[0] == "trap"]
    brilliants = [(k, v) for k, v in verdicts.items() if v[0] == "brilliant"]
    if traps:
        results.append((xqf.name, len(traps), len(brilliants), traps[:3]))

results.sort(key=lambda r: -r[1])
print(f"{'file':46s}  {'traps':>6s}  {'brill':>6s}  first traps")
print("-" * 96)
for name, nt, nb, first in results[:10]:
    samples = "; ".join(
        f"vi={k[0]} pi={k[1]} src={v[1]} s={v[2]} d={v[3]} vd={v[4]}"
        for k, v in first
    )
    print(f"{name[:44]:46s}  {nt:6d}  {nb:6d}  {samples}")
