"""Sanity test for vendor/io_cwp.py.

Walks every .cwp under D:/以民金儒/ and verifies:
  * magic ok, parse doesn't raise
  * all move indices in [0, 89]
  * declared move count vs parsed move count
  * a handful of known-game spot checks
"""
from __future__ import annotations
import sys
import glob
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.stdout.reconfigure(encoding="utf-8")

from vendor.io_cwp import parse_cwp_file, index_to_iccs

CWP_ROOT = r"D:/以民金儒"


def spot_check():
    """Verify the first known-game file decodes its opening moves correctly."""
    path = os.path.join(CWP_ROOT, r"1.  先手順炮局 11/1.  順炮直車對橫車(先手棄傌局).cwp")
    g = parse_cwp_file(path)
    assert g.title.startswith("第1局"), f"title={g.title!r}"
    assert g.source == "本局摘自「橘中秘」", f"source={g.source!r}"
    assert g.result == "紅先勝", f"result={g.result!r}"
    assert g.declared_move_count == 37, f"count={g.declared_move_count}"
    # First 6 moves of 順炮直車對橫車
    expected_iccs = ["h2e2", "h7e7", "h0g2", "h9g7", "i0h0", "i9i8"]
    for i, exp in enumerate(expected_iccs):
        got = g.moves[i].iccs
        assert got == exp, f"move {i+1}: expected {exp}, got {got}"
    print(f"spot check OK  ({len(g.moves)} moves parsed, {g.declared_move_count} declared)")


def full_sweep():
    files = sorted(glob.glob(os.path.join(CWP_ROOT, "**/*.cwp"), recursive=True))
    print(f"\nfound {len(files)} .cwp files")

    ok = 0
    bad = []
    count_mismatch = []
    bad_index = []
    with_comments = 0
    with_annotes = 0
    nonstandard_start = 0
    total_moves = 0

    for p in files:
        try:
            g = parse_cwp_file(p)
        except Exception as e:
            bad.append((p, f"{type(e).__name__}: {e}"))
            continue
        ok += 1
        total_moves += len(g.moves)
        if len(g.moves) != g.declared_move_count:
            count_mismatch.append((p, g.declared_move_count, len(g.moves)))
        for m in g.moves:
            if not (0 <= m.src <= 89 and 0 <= m.dst <= 89):
                bad_index.append((p, m))
                break
            if m.comment:
                with_comments += 1
            if m.annote:
                with_annotes += 1
        if g.init_position != "0":
            nonstandard_start += 1

    print(f"  parsed ok:               {ok}/{len(files)}")
    print(f"  raised exception:        {len(bad)}")
    print(f"  count mismatch:          {len(count_mismatch)}")
    print(f"  bad-index moves:         {len(bad_index)}")
    print(f"  nonstandard start pos:   {nonstandard_start}")
    print(f"  total moves parsed:      {total_moves}")
    print(f"  moves with comments:     {with_comments}")
    print(f"  moves with annote(!/?):  {with_annotes}")

    if bad:
        print("\nfirst 5 exceptions:")
        for p, err in bad[:5]:
            print(f"  {os.path.basename(p)}: {err}")
    if count_mismatch:
        print(f"\nfirst 5 count mismatches (declared vs parsed):")
        for p, d, pp in count_mismatch[:5]:
            print(f"  {os.path.basename(p)}: declared={d} parsed={pp}")
    if bad_index:
        print("\nfirst 5 bad-index samples:")
        for p, m in bad_index[:5]:
            print(f"  {os.path.basename(p)}: src={m.src} dst={m.dst}")

    return ok, len(files)


def demo_one():
    """Print one parsed game in full as a visual smoke test."""
    path = os.path.join(
        CWP_ROOT,
        r"8.  先手起傌局 93/2.  先手起傌局2--19/燕青 先勝 東風190206.cwp",
    )
    if not os.path.exists(path):
        return
    g = parse_cwp_file(path)
    print(f"\n=== demo: {os.path.basename(path)} ===")
    print(f"event={g.event!r}  title={g.title!r}")
    print(f"date={g.year}-{g.month}-{g.day}")
    print(f"red={g.red_player!r}  black={g.black_player!r}")
    print(f"result={g.result!r}  declared={g.declared_move_count}")
    for i, m in enumerate(g.moves[:10], 1):
        suffix = f"  // {m.comment}" if m.comment else ""
        prefix = f"{m.annote} " if m.annote else "  "
        print(f"  {i:2d}. {prefix}{m.iccs}{suffix}")
    if len(g.moves) > 10:
        print(f"  ... ({len(g.moves)-10} more)")


if __name__ == "__main__":
    spot_check()
    ok, total = full_sweep()
    demo_one()
    sys.exit(0 if ok == total else 1)
