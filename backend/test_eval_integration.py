"""End-to-end check: does the editor's tree walk produce FENs that hit
chess-book-ai's positions.db?

Mimics what the browser does on file load:
  1. Load XQF via xqf_service.load_xqf  → JSON tree
  2. BFS the tree from init_fen, applying iccs at each step
  3. Batch-lookup all derived FENs against positions.db
  4. Report hit rate per depth
"""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.xqf_service import load_xqf  # noqa: E402
from backend.eval_service import lookup_batch  # noqa: E402

# Same applyIccs logic as frontend/assets/board.js — port to Python so we can
# reproduce the cross-project FEN check end-to-end without spinning a browser.
def apply_iccs(fen: str, iccs: str) -> str:
    sp = fen.find(" ")
    pos = fen[:sp] if sp >= 0 else fen
    side = fen[sp + 1 :].strip()[:1] if sp >= 0 else "w"
    rows = []
    for row in pos.split("/"):
        arr = []
        for ch in row:
            if ch.isdigit():
                arr.extend(["."] * int(ch))
            else:
                arr.append(ch)
        while len(arr) < 9:
            arr.append(".")
        rows.append(arr)
    ff = ord(iccs[0]) - ord("a")
    fr = int(iccs[1])
    tf = ord(iccs[2]) - ord("a")
    tr = int(iccs[3])
    fromRow, toRow = 9 - fr, 9 - tr
    piece = rows[fromRow][ff]
    rows[toRow][tf] = piece
    rows[fromRow][ff] = "."
    out_rows = []
    for row in rows:
        s, run = "", 0
        for ch in row:
            if ch == ".":
                run += 1
                continue
            if run > 0:
                s += str(run); run = 0
            s += ch
        if run > 0:
            s += str(run)
        out_rows.append(s)
    new_side = "b" if side == "w" else "w"
    return "/".join(out_rows) + " " + new_side


def collect_fens(data: dict) -> list[str]:
    seen = {data["init_fen"]}
    stack = [(data["init_fen"], data.get("roots") or [])]
    while stack:
        fen, children = stack.pop()
        for node in children:
            nxt = apply_iccs(fen, node["iccs"])
            if nxt not in seen:
                seen.add(nxt)
                stack.append((nxt, node.get("children") or []))
    return sorted(seen)


def main():
    lib = Path(r"D:\Elton\TestArea\chess-book")
    db = ROOT.parent / "chess-book-ai" / "output" / "positions.db"
    xqfs = sorted(lib.glob("*.XQF"))
    if not xqfs:
        print(f"no XQF files in {lib}")
        return
    print(f"db = {db}\n")
    print(f"{'file':40s}  {'fens':>5s}  {'d12':>5s}  {'d22':>5s}  {'d28':>5s}  {'d32':>5s}  {'cdb':>5s}")
    print("-" * 90)
    grand = {"fens": 0, "d12": 0, "d22": 0, "d28": 0, "d32": 0, "cdb": 0}
    for xqf in xqfs[:6]:
        try:
            data = load_xqf(xqf)
        except Exception as e:
            print(f"{xqf.name[:38]:40s}  load failed: {e}")
            continue
        fens = collect_fens(data)
        evals = lookup_batch(db, fens)
        hits = {"d12": 0, "d22": 0, "d28": 0, "d32": 0, "cdb": 0}
        for fen, entry in evals.items():
            for k in hits:
                if k in entry:
                    hits[k] += 1
        print(f"{xqf.name[:38]:40s}  {len(fens):5d}  {hits['d12']:5d}  {hits['d22']:5d}  {hits['d28']:5d}  {hits['d32']:5d}  {hits['cdb']:5d}")
        grand["fens"] += len(fens)
        for k in hits:
            grand[k] += hits[k]
    print("-" * 90)
    print(f"{'TOTAL':40s}  {grand['fens']:5d}  {grand['d12']:5d}  {grand['d22']:5d}  {grand['d28']:5d}  {grand['d32']:5d}  {grand['cdb']:5d}")
    if grand["fens"]:
        pct = lambda k: 100 * grand[k] / grand["fens"]
        print(f"{'hit %':40s}  {'':5s}  {pct('d12'):5.1f}  {pct('d22'):5.1f}  {pct('d28'):5.1f}  {pct('d32'):5.1f}  {pct('cdb'):5.1f}")


if __name__ == "__main__":
    main()
