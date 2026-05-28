"""Convert XQF file(s) into a single CCBridge3-compatible CBL library.

  python tools/xqf_to_cbl.py <input> <output.cbl> [--name LIB_NAME]

  <input>   .xqf file (single game) or directory (one CBL game per .xqf, recursive)
  <output>  .cbl file path
  --name    library name (CCBridge property panel); defaults to input dir name
            or input file stem

Uses cchess.io_xqf.read_from_xqf for input and vendor.io_cb_writer for output.
The author field is stamped 'chess-book-editor' and timestamps default to
"now" so CCBridge's properties panel shows the file's provenance.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from cchess import Book  # noqa: E402
from cchess.io_xqf import read_from_xqf  # noqa: E402

from vendor.io_cb_writer import write_cbl_bytes  # noqa: E402


def discover_xqfs(src: Path) -> list[Path]:
    if src.is_file():
        if src.suffix.lower() != ".xqf":
            raise SystemExit(f"not an .xqf file: {src}")
        return [src]
    if src.is_dir():
        return sorted(set(src.rglob("*.xqf")) | set(src.rglob("*.XQF")))
    raise SystemExit(f"not found: {src}")


def load_books(paths: list[Path]) -> tuple[list, list[tuple[Path, str]]]:
    """Load each .xqf into a Book. Returns (books, failures)."""
    books: list = []
    failures: list[tuple[Path, str]] = []
    for p in paths:
        try:
            book = read_from_xqf(str(p), Book)
        except Exception as e:  # pylint: disable=broad-except
            failures.append((p, f"{type(e).__name__}: {e}"))
            continue
        if book is None:
            failures.append((p, "read_from_xqf returned None"))
            continue
        # Use filename stem as fallback title (XQF may have empty title).
        info = book.info or {}
        if not info.get("title"):
            info["title"] = p.stem
        book.info = info
        books.append(book)
    return books, failures


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("input", type=Path)
    ap.add_argument("output", type=Path)
    ap.add_argument("--name", default=None, help="library name (default: derived from input)")
    args = ap.parse_args(argv)

    src: Path = args.input
    out: Path = args.output
    lib_name = args.name or (src.stem if src.is_file() else src.name)

    xqfs = discover_xqfs(src)
    if not xqfs:
        print(f"no .xqf files found under {src}", file=sys.stderr)
        return 1

    print(f"input    : {src}")
    print(f"output   : {out}")
    print(f"lib_name : {lib_name!r}")
    print(f".xqf files: {len(xqfs)}")
    print("=" * 60, flush=True)

    books, failures = load_books(xqfs)
    print(f"loaded   : {len(books)} books  ({len(failures)} failed)")
    for p, msg in failures[:10]:
        print(f"  ERR  {p.name}: {msg}")
    if not books:
        return 1

    now = _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cbl_bytes = write_cbl_bytes(
        lib_name, books,
        creator="chess-book-editor",
        email="",
        created_at=now,
        modified_at=now,
    )

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(cbl_bytes)
    print(f"wrote {len(cbl_bytes):,} bytes  ({len(books)} games)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
