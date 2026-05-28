"""Convert .cbl libraries (CCBridge3) to individual .xqf files.

  python tools/cbl_to_xqf.py <input> <out_dir>

  <input>   .cbl file, or directory to recurse for .cbl files
  <out_dir> output root; one subdirectory per .cbl

Layout:
  <out_dir>/<cbl_stem>/<NNN>-<sanitised_title>.xqf

Uses vendor.cchess_cbl (which auto-applies the CBL offset fix) for
reading and vendor.io_xqf_patched.PatchedXQFWriter for writing.

Annotation encoding: CBR stores notes as UTF-16-LE (full Unicode),
XQF stores them as GB18030. Characters outside GB18030 (rare in
Chinese-chess notes) get dropped silently by the writer's
errors='ignore' path.
"""
from __future__ import annotations

import sys
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from vendor.cchess_cbl import read_cbl
from vendor.io_xqf_patched import PatchedXQFWriter


RESULT_STR_TO_INT = {
    "*": 0,
    "1-0": 1,
    "0-1": 2,
    "1/2-1/2": 3,
}

_FILENAME_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WIN_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def sanitise_filename(name: str, max_len: int = 80) -> str:
    cleaned = _FILENAME_BAD.sub("_", name).strip(" .")
    if not cleaned:
        return "untitled"
    if cleaned.upper() in _WIN_RESERVED:
        cleaned = f"_{cleaned}"
    if len(cleaned) > max_len:
        cleaned = cleaned[:max_len].rstrip(" .")
    return cleaned or "untitled"


def normalise_info_for_xqf(cbr_info: dict) -> dict:
    """Map CBR-reader info keys to the keys XQFWriter.__init__ requires.

    CBR populates: title, event, red, black, result, source, index.
    XQFWriter reads: title, event, date, location, red_player, black_player,
    commentator. Missing keys default to empty string.
    """
    return {
        "title": cbr_info.get("title", ""),
        "event": cbr_info.get("event", ""),
        "date": cbr_info.get("date", ""),
        "location": cbr_info.get("location", ""),
        "red_player": cbr_info.get("red", ""),
        "black_player": cbr_info.get("black", ""),
        "commentator": cbr_info.get("commentator", ""),
    }


def set_result(writer: PatchedXQFWriter, result_str: str) -> None:
    writer.set_result(RESULT_STR_TO_INT.get(result_str, 0))


def convert_one_cbl(cbl_path: Path, out_dir: Path) -> tuple[int, int, list[str]]:
    """Returns (ok_count, fail_count, error_messages)."""
    try:
        lib = read_cbl(cbl_path)
    except Exception as e:  # pylint: disable=broad-except
        return 0, 0, [f"{cbl_path.name}: read_cbl failed: {type(e).__name__}: {e}"]

    games = lib.get("games", [])
    if not games:
        return 0, 0, []

    out_dir.mkdir(parents=True, exist_ok=True)
    ok = 0
    failed: list[str] = []

    for idx, book in enumerate(games):
        title = (book.info or {}).get("title", "") or f"game_{idx:03d}"
        stem = f"{idx:03d}-{sanitise_filename(title)}"
        xqf_path = out_dir / f"{stem}.xqf"
        try:
            cbr_info = book.info or {}
            book.info = normalise_info_for_xqf(cbr_info)
            writer = PatchedXQFWriter(book)
            # Stamp author so backend.xqf_service.load_xqf knows to skip Big5
            # recovery (annotations here are guaranteed GB18030 from CBR
            # source). Keep in sync with GB18030_AUTHOR_MARKERS.
            writer.set_author("cbl_to_xqf")
            set_result(writer, cbr_info.get("result", "*"))
            writer.save(str(xqf_path))
            ok += 1
        except Exception as e:  # pylint: disable=broad-except
            failed.append(f"{cbl_path.name}[{idx}] {title}: {type(e).__name__}: {e}")

    return ok, len(failed), failed


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__)
        return 2

    src = Path(argv[1])
    out_root = Path(argv[2])

    if src.is_file():
        cbl_files = [src]
    elif src.is_dir():
        cbl_files = sorted(src.rglob("*.cbl")) + sorted(src.rglob("*.CBL"))
        # rglob is case-insensitive on Windows so this dedupes naturally,
        # but be explicit:
        cbl_files = sorted(set(cbl_files))
    else:
        print(f"not found: {src}", file=sys.stderr)
        return 1

    print(f"input        : {src}")
    print(f"out_root     : {out_root}")
    print(f".cbl files   : {len(cbl_files)}")
    print("=" * 60, flush=True)

    total_ok = 0
    total_fail = 0
    total_empty = 0
    all_errors: list[str] = []

    for i, cbl in enumerate(cbl_files, 1):
        if src.is_file():
            sub = out_root / cbl.stem
        else:
            rel = cbl.relative_to(src).with_suffix("")
            sub = out_root / rel
        ok, fail, errs = convert_one_cbl(cbl, sub)
        if ok == 0 and fail == 0:
            total_empty += 1
        total_ok += ok
        total_fail += fail
        all_errors.extend(errs)
        if i % 50 == 0 or i == len(cbl_files):
            print(f"  [{i:>4}/{len(cbl_files)}] games_ok={total_ok} "
                  f"games_fail={total_fail} empty_cbls={total_empty}", flush=True)

    print()
    print("=" * 60)
    print(f"converted   : {total_ok} games")
    print(f"failed      : {total_fail} games")
    print(f"empty cbls  : {total_empty}")
    if all_errors:
        print()
        print(f"first 10 errors:")
        for e in all_errors[:10]:
            print(f"  {e}")
    return 0 if total_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
