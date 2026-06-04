"""One-off: recover NUL-corrupted annotes in 牛頭滾.XQF from a clean GB18030 copy.

The live source D:\\Elton\\TestArea\\chess-book\\牛頭滾.XQF has 327 annotes
containing NUL bytes (characters that were never stored). A smaller historical
copy (chess-book-gb18030/牛頭滾.XQF, 233 plies) preserves the full text for
every one of those positions. We match by pre-move FEN and rewrite the annotes
with PatchedXQFWriter (the variation-preserving writer).

SAFE BY DEFAULT: writes to a temp file and verifies before touching anything.
  - structure check: root-to-leaf move-geometry path set must be IDENTICAL
    (catches the upstream-writer branch-collapse bug)
  - no NUL byte may survive in any annote
  - spot-check that known recoveries landed
Only with --apply does it back up the original and replace it.

  python tools/recover_nul_annotes.py            # dry-run: verify only
  python tools/recover_nul_annotes.py --apply     # backup + replace
"""
import sys
import shutil
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from cchess import Book
from cchess.io_xqf import read_from_xqf
from vendor import PatchedXQFWriter

CUR = Path(r"D:\Elton\TestArea\chess-book\牛頭滾.XQF")
SRC = Path(r"D:\Elton\TestArea\chess-book-gb18030\牛頭滾.XQF")
BACKUP = Path(r"D:\Elton\TestArea\chess-book-ai\output\_recover\牛頭滾_pre_recover.XQF")
RESULT_MAP = {"*": 0, "1-0": 1, "0-1": 2, "1/2-1/2": 3}


def walk_moves(book):
    """Yield every Move in the tree (DFS via variations_all)."""
    if book.first_move is None:
        return
    stack = list(book.first_move.variations_all)
    seen = set()
    while stack:
        m = stack.pop()
        if id(m) in seen:
            continue
        seen.add(id(m))
        yield m
        if m.next_move is not None:
            stack.extend(m.next_move.variations_all)


def fen_of(m):
    return m.board_before.to_fen()


def move_key(m):
    return (tuple(m.pos_from), tuple(m.pos_to))


def geom_paths(book):
    """Set of root-to-leaf paths using move GEOMETRY only (annote-independent).
    Equality across a rewrite proves no variation was dropped or collapsed."""
    def rec(move, prefix):
        here = prefix + (move_key(move),)
        if move.next_move is None:
            yield here
            return
        for child in move.next_move.variations_all:
            yield from rec(child, here)
    if book.first_move is None:
        return set()
    out = set()
    for root in book.first_move.variations_all:
        for p in rec(root, ()):
            out.add(p)
    return out


def main():
    apply = "--apply" in sys.argv

    # 1) recovery map from the clean historical copy (raw annotes by pre-move fen)
    src = read_from_xqf(str(SRC), Book)
    recmap = {}
    for m in walk_moves(src):
        a = m.annote
        if a and "\x00" not in a:
            recmap.setdefault(fen_of(m), a)
    print(f"[recmap] {len(recmap)} clean annotes from {SRC.name}")

    # 2) load current RAW (read_from_xqf decodes GB18030; NO Big5 recovery here —
    #    the file is already GB18030, recovery would mangle it)
    cur = read_from_xqf(str(CUR), Book)
    baseline = geom_paths(cur)  # structure snapshot BEFORE mutation

    fixed_rec = fixed_strip = untouched_nul = 0
    for m in walk_moves(cur):
        a = m.annote or ""
        if "\x00" not in a:
            continue
        f = fen_of(m)
        if f in recmap and "\x00" not in recmap[f]:
            m.annote = recmap[f]
            fixed_rec += 1
        else:
            stripped = a.replace("\x00", "")
            m.annote = stripped
            if len(stripped.strip()) > 2:
                untouched_nul += 1  # in-text loss with no clean source — stripped only
            fixed_strip += 1
    print(f"[fix] recovered-from-copy={fixed_rec}  strip-only={fixed_strip} "
          f"(of which in-text-unrecovered={untouched_nul})")

    # 3) write to temp via the patched (variation-preserving) writer
    with tempfile.NamedTemporaryFile(delete=False, suffix=".XQF") as tf:
        tmp = Path(tf.name)
    w = PatchedXQFWriter(cur)
    w.set_author("cb_editor")  # marks file GB18030-guaranteed → future loads skip Big5 recovery
    w.set_result(RESULT_MAP.get(cur.info.get("result", "*"), 0))
    w.save(str(tmp))

    # 4) verify the temp file
    back = read_from_xqf(str(tmp), Book)
    after = geom_paths(back)
    nul_left = sum(1 for m in walk_moves(back) if (m.annote or "") and "\x00" in m.annote)
    # spot-check: a few recovered fens should now be clean & match the source
    spot_ok = spot_total = 0
    for m in walk_moves(back):
        f = fen_of(m)
        if f in recmap:
            spot_total += 1
            if m.annote == recmap[f]:
                spot_ok += 1

    ok_struct = (baseline == after)
    ok_nul = (nul_left == 0)
    print(f"\n=== VERIFY (temp file) ===")
    print(f"  geometry paths: before={len(baseline)} after={len(after)}  IDENTICAL={ok_struct}")
    print(f"  branchs: {cur.info.get('branchs')} -> {back.info.get('branchs')}")
    print(f"  NUL bytes remaining in annotes: {nul_left}  (must be 0)  PASS={ok_nul}")
    print(f"  recovered-fen spot match: {spot_ok}/{spot_total}")
    print(f"  temp size: {tmp.stat().st_size}  (orig {CUR.stat().st_size})")

    if not (ok_struct and ok_nul):
        print("\n[ABORT] verification FAILED — original left untouched, temp discarded")
        tmp.unlink(missing_ok=True)
        sys.exit(1)

    if not apply:
        print("\n[DRY-RUN] verification PASSED. Re-run with --apply to backup + replace.")
        tmp.unlink(missing_ok=True)
        return

    BACKUP.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(CUR, BACKUP)
    shutil.move(str(tmp), str(CUR))
    print(f"\n[APPLIED] backup -> {BACKUP}")
    print(f"[APPLIED] replaced -> {CUR}")


if __name__ == "__main__":
    main()
