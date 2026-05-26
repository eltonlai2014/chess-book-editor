"""Dump every annote in every XQF under chess-book/ to stdout.

Goal: let the master eyeball whether annote characters survive the pipeline
intact. Two reads side-by-side:
  (A) cchess.read_from_xqf -> Book   (the raw reader output)
  (B) backend.xqf_service.load_xqf -> JSON.roots (what the browser sees)

If A and B agree byte-for-byte, the editor pipeline preserves whatever the
reader produced. If a particular annote *looks* garbled, the corruption is
upstream (likely in the source XQF file itself, or in cchess decoding).

Usage:
    python tools/dump_annotes.py                      # all files
    python tools/dump_annotes.py 中砲對單提馬.XQF      # one file
"""
import sys
from pathlib import Path

from cchess import Book
from cchess.io_xqf import read_from_xqf

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.xqf_service import load_xqf  # noqa: E402

SRC_ROOT = Path(r"D:\Elton\TestArea\chess-book")


def walk_moves(book):
    """Yield (iccs, annote) for every Move in the tree."""
    if book.first_move is None:
        return
    stack = list(book.first_move.variations_all)
    while stack:
        m = stack.pop()
        yield m.to_iccs(), (m.annote or "")
        if m.next_move is not None:
            stack.extend(m.next_move.variations_all)


def walk_json(node):
    """Yield (iccs, annote) for every node in the JSON tree."""
    yield node["iccs"], (node.get("annote") or "")
    for c in node.get("children", []):
        yield from walk_json(c)


def show_one(path: Path):
    print(f"\n===== {path.relative_to(SRC_ROOT)} =====")
    book = read_from_xqf(str(path), Book)
    if book is None:
        print("  (read failed)")
        return
    raw = sorted({(i, a) for i, a in walk_moves(book) if a})

    data = load_xqf(path)
    via_json = []
    for root in data["roots"]:
        via_json.extend((i, a) for i, a in walk_json(root) if a)
    via_json = sorted(set(via_json))

    print(f"  raw reader: {len(raw)} annotes")
    print(f"  via JSON  : {len(via_json)} annotes")
    print(f"  identical : {raw == via_json}")
    for iccs, annote in raw[:30]:
        # repr() exposes any control bytes / surrogates / mojibake
        print(f"    {iccs}  {annote!r}")
    if len(raw) > 30:
        print(f"    ... ({len(raw) - 30} more)")


def main():
    targets = sys.argv[1:] or [str(p) for p in sorted(SRC_ROOT.rglob("*.XQF"))]
    # Redirect to a UTF-8 file so PowerShell's cp950 doesn't choke on non-CJK
    # bytes that may be embedded in source annotes.
    out = Path(__file__).resolve().parent.parent / "tools" / "annote_dump.txt"
    sys.stdout = open(out, "w", encoding="utf-8")
    for t in targets:
        p = Path(t)
        if not p.is_absolute():
            p = SRC_ROOT / t
        show_one(p)
    sys.stdout.close()
    sys.stdout = sys.__stdout__
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
