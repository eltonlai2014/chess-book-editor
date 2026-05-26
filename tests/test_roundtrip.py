"""Round-trip test — verifies PatchedXQFWriter preserves every variation.

Compares two Books by enumerating ALL root-to-leaf paths through the move tree
(each path = list of (move_key, annote) tuples). Two trees are equivalent iff
their PATH SETS are equal.

Also accepts a `writer_cls` argument so we can compare upstream vs patched.

Run:
    python tests/test_roundtrip.py          # patched writer only
    python tests/test_roundtrip.py both     # both, side by side
"""
import sys
import tempfile
import traceback
from pathlib import Path

from cchess import Book
from cchess.io_xqf import read_from_xqf, XQFWriter

sys.path.insert(0, str(Path(__file__).parent.parent))
from vendor import PatchedXQFWriter  # noqa: E402

SRC_ROOT = Path(r"D:\Elton\TestArea\chess-book")


def move_key(m):
    """Stable identifier for a move's geometry — (from, to)."""
    return (tuple(m.pos_from), tuple(m.pos_to))


def enumerate_paths(move, prefix=()):
    """Yield all root-to-leaf paths starting at this move.

    Tree model (verified against cchess.move.Move):
      - `move.next_move` = the FIRST child (continuation) — may be None
      - `move.next_move.variations_all` = ALL children of `move` (a list that
         includes `move.next_move` itself plus deeper-level siblings)
      - `move.variation_next` is only reliably populated by top-level
         `book.append_first_move`/`add_variation`; deeper variations don't always
         set it because `append_next_move` only updates `variations_all`. So we
         walk siblings via `variations_all`, not via `variation_next`.
    """
    here = prefix + ((move_key(move), move.annote or ""),)
    if move.next_move is None:
        yield here
        return
    children = list(move.next_move.variations_all)
    for child in children:
        yield from enumerate_paths(child, here)


def collect_paths(book):
    """Return the set of all root-to-leaf paths for a Book."""
    if book.first_move is None:
        return set()
    # Root-level alternatives live in first_move.variations_all
    roots = list(book.first_move.variations_all)
    paths = set()
    for root in roots:
        for p in enumerate_paths(root):
            paths.add(p)
    return paths


def check_one(xqf_path: Path, writer_cls):
    rel = str(xqf_path.relative_to(SRC_ROOT))
    out = {
        "file": rel, "ok": False, "error": None,
        "src_size": xqf_path.stat().st_size, "out_size": None,
        "branchs_a": None, "branchs_b": None,
        "paths_a": 0, "paths_b": 0, "paths_common": 0,
        "version_src": None,
    }
    try:
        book_a = read_from_xqf(str(xqf_path), Book)
        if book_a is None:
            out["error"] = "read returned None"
            return out
        out["version_src"] = book_a.info.get("version")
        out["branchs_a"] = book_a.info.get("branchs", 0)
        paths_a = collect_paths(book_a)
        out["paths_a"] = len(paths_a)

        with tempfile.NamedTemporaryFile(delete=False, suffix=".xqf") as tf:
            tmp = Path(tf.name)
        try:
            writer_cls(book_a).save(str(tmp))
            out["out_size"] = tmp.stat().st_size
            book_b = read_from_xqf(str(tmp), Book)
        finally:
            if tmp.exists():
                tmp.unlink()

        if book_b is None:
            out["error"] = "reread returned None"
            return out
        out["branchs_b"] = book_b.info.get("branchs", 0)
        paths_b = collect_paths(book_b)
        out["paths_b"] = len(paths_b)
        out["paths_common"] = len(paths_a & paths_b)
        out["ok"] = paths_a == paths_b and out["branchs_a"] == out["branchs_b"]
    except Exception:
        out["error"] = traceback.format_exc().splitlines()[-1][:80]
    return out


def run(writer_cls, label):
    xqfs = sorted(SRC_ROOT.rglob("*.XQF"))
    print(f"\n=== {label} ({writer_cls.__name__}) ===")
    print(f"Found {len(xqfs)} XQF files")
    rows = []
    for i, p in enumerate(xqfs, 1):
        r = check_one(p, writer_cls)
        rows.append(r)
        flag = "✓" if r["ok"] else ("ERR" if r["error"] else "✗")
        print(f"[{i:>2}/{len(xqfs)}] {flag}  branchs {r['branchs_a']}→{r['branchs_b']}  "
              f"paths {r['paths_a']}→{r['paths_b']} (∩{r['paths_common']})  "
              f"{r['file']}{' ! '+r['error'] if r['error'] else ''}")
    perfect = sum(1 for r in rows if r["ok"])
    branch_ok = sum(1 for r in rows if r["branchs_a"] == r["branchs_b"] and not r["error"])
    paths_ok = sum(1 for r in rows if r["paths_a"] == r["paths_b"] and not r["error"])
    print(f"\nSummary: {perfect}/{len(rows)} perfect  "
          f"| branchs OK {branch_ok}/{len(rows)}  "
          f"| path count OK {paths_ok}/{len(rows)}")
    return rows


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "fixed":
        run(PatchedXQFWriter, "PATCHED writer (recursive DFS + GB18030)")
    elif len(sys.argv) > 1 and sys.argv[1] == "both":
        run(XQFWriter, "UPSTREAM writer (broken baseline)")
        run(PatchedXQFWriter, "PATCHED writer (recursive DFS + GB18030)")
    else:
        run(PatchedXQFWriter, "PATCHED writer (recursive DFS + GB18030)")


if __name__ == "__main__":
    main()
