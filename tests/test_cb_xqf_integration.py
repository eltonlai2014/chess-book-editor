"""Full XQF ↔ CBL round-trip integration test.

Exercises the entire pipeline for each test corpus:

  source.cbl
    → read via vendor.cchess_cbl.read_cbl       (applies CBL offset fix)
    → write each game as .xqf via PatchedXQFWriter
    → read each .xqf back via cchess.io_xqf.read_from_xqf
    → bundle Books into a new .cbl via vendor.io_cb_writer.write_cbl_bytes
    → read final .cbl via vendor.cchess_cbl.read_cbl

For each game, asserts source ↔ final equality across:
  * title, event, red, black, result
  * book.annote (init annote — chapter intro / 譜首引言)
  * DFS-walked move tree: (iccs, annote) tuple per move

Catches regressions in:
  * CBL offset fix (vendor/cbl_index_fix.py)
  * CBR writer (vendor/io_cb_writer.py)
  * PatchedXQFWriter init-annote serialization (vendor/io_xqf_patched.py)
  * Big5 recovery skip on author-marked files (backend/xqf_service.py)
  * Encoding round-trips (CBR UTF-16-LE ↔ XQF GB18030)

Run:
  PYTHONIOENCODING=utf-8 .\\.venv\\Scripts\\python.exe tests\\test_cb_xqf_integration.py
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.stdout.reconfigure(encoding="utf-8")

from cchess import Book  # noqa: E402
from cchess.io_xqf import read_from_xqf  # noqa: E402

from vendor.cchess_cbl import read_cbl  # noqa: E402
from vendor.io_cb_writer import write_cbl_bytes  # noqa: E402
from vendor.io_xqf_patched import PatchedXQFWriter  # noqa: E402

# Reuse the CBR-info → XQF-info adapter from the production tool so this test
# exercises the same path callers use.
sys.path.insert(0, str(ROOT / "tools"))
from cbl_to_xqf import normalise_info_for_xqf, set_result  # noqa: E402


# Corpus: small + medium + edge-case-heavy
CORPUS = [
    # path, description, capacity-for-rewrite
    (r"D:\Elton\CCBridge3\CBL\象棋丛书\王嘉良著\顺炮全集.CBL",
     "5 games, has init annotes on games 3+4", 128),
    (r"D:\Elton\CCBridge3\CBL\古谱棋书\《马炮争雄》-顺序全录版.CBL",
     "149 games (off60=149, exercises CBL offset fix)", 149),
    (r"D:\Elton\CCBridge3\CBL\象棋丛书\王嘉良著\《中国象棋中级教程》.cbl",
     "222 games, many empty-board chapter intros (first_move=None)", 256),
]


def walk_moves(book):
    """Return list of (iccs, annote) tuples in deterministic DFS order."""
    out = []
    seen = set()

    def go(m):
        if m is None or id(m) in seen:
            return
        seen.add(id(m))
        out.append((m.to_iccs(), m.annote or ""))
        if m.next_move is not None:
            for child in m.next_move.variations_all:
                go(child)

    if book.first_move is None:
        return out
    for root in book.first_move.variations_all:
        go(root)
    return out


def summarise_book(book):
    """A dict of all the things we care about preserving."""
    info = book.info or {}
    return {
        "title": info.get("title", "") or "",
        "event": info.get("event", "") or "",
        "red": info.get("red") or info.get("red_player") or "",
        "black": info.get("black") or info.get("black_player") or "",
        "result": info.get("result", "") or "",
        "init_annote": getattr(book, "annote", "") or "",
        "moves": walk_moves(book),
    }


# XQF header string fields have hard byte limits (cchess.io_xqf.HEADER_FIELDS):
# title=63, event=63, red_player=15, black_player=15, etc. CBR fields are
# much larger (title=128 bytes UTF-16-LE). Long source strings are unavoidably
# truncated when going CBR → XQF → CBR. Treat truncation as OK as long as the
# truncated value is a clean prefix of the source.
_XQF_BYTE_LIMITS = {
    "title": 63, "event": 63,
    "red": 15, "black": 15,
}


def _is_acceptable_truncation(field: str, src_val: str, final_val: str) -> bool:
    limit = _XQF_BYTE_LIMITS.get(field)
    if limit is None or not src_val:
        return False
    if not src_val.startswith(final_val):
        return False
    return len(src_val.encode("gb18030", errors="ignore")) > limit - 1


def diff_summary(label_a, a, label_b, b) -> list[str]:
    diffs = []
    for k in ("title", "event", "red", "black", "result", "init_annote"):
        if a[k] != b[k]:
            if _is_acceptable_truncation(k, a[k], b[k]):
                continue
            diffs.append(f"{k}: {label_a}={a[k]!r}  {label_b}={b[k]!r}")
    if len(a["moves"]) != len(b["moves"]):
        diffs.append(f"move count: {label_a}={len(a['moves'])} {label_b}={len(b['moves'])}")
        return diffs
    for i, (am, bm) in enumerate(zip(a["moves"], b["moves"])):
        if am != bm:
            diffs.append(f"move[{i}]: {label_a}={am!r}  {label_b}={bm!r}")
            if len(diffs) >= 5:
                diffs.append(f"... (more diffs suppressed)")
                break
    return diffs


def test_one_corpus(src_path: Path, description: str, capacity: int) -> tuple[int, int]:
    """Run full pipeline on one CBL source. Returns (games_total, games_failed)."""
    src_lib = read_cbl(str(src_path))
    src_games = src_lib["games"]
    src_summaries = [summarise_book(b) for b in src_games]

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)

        # Step 1: CBL → many .xqf  (mirrors tools/cbl_to_xqf.py exactly)
        xqf_paths: list[Path] = []
        for i, book in enumerate(src_games):
            xqf_path = td / f"{i:04d}.xqf"
            cbr_info = book.info or {}
            book.info = normalise_info_for_xqf(cbr_info)  # adapt CBR keys → XQF keys
            writer = PatchedXQFWriter(book)
            writer.set_author("cbl_to_xqf")
            set_result(writer, cbr_info.get("result", "*"))
            writer.save(str(xqf_path))
            xqf_paths.append(xqf_path)
            # Put the CBR info back for the comparison phase below.
            book.info = cbr_info

        # Step 2: each .xqf → Book
        rebuilt_books = []
        for p in xqf_paths:
            b = read_from_xqf(str(p), Book)
            assert b is not None, f"failed to read back {p}"
            rebuilt_books.append(b)

        # Step 3: Books → new CBL
        out_cbl = td / "rebuilt.cbl"
        cbl_bytes = write_cbl_bytes(
            src_lib["name"],
            rebuilt_books,
            capacity=capacity,
            creator="chess-book-editor",
            email="",
            created_at="2026-01-01 00:00:00",
            modified_at="2026-01-01 00:00:00",
        )
        out_cbl.write_bytes(cbl_bytes)

        # Step 4: read final CBL
        final_lib = read_cbl(str(out_cbl))
        final_games = final_lib["games"]
        final_summaries = [summarise_book(b) for b in final_games]

    # Compare
    total = len(src_summaries)
    failed = 0
    if len(src_summaries) != len(final_summaries):
        print(f"    GAME COUNT DIFF: src={len(src_summaries)} final={len(final_summaries)}")
        return total, max(total - len(final_summaries), 1)

    for i, (s, f) in enumerate(zip(src_summaries, final_summaries)):
        diffs = diff_summary("src", s, "final", f)
        if diffs:
            failed += 1
            print(f"    [{i}] {s['title']!r}: {len(diffs)} diff(s)")
            for d in diffs[:3]:
                print(f"      {d}")

    return total, failed


def main() -> int:
    print(f"Integration test: XQF ↔ CBL round-trip across {len(CORPUS)} corpora")
    print("=" * 70, flush=True)

    grand_total = 0
    grand_failed = 0
    skipped: list[tuple[str, str]] = []

    for src_path, desc, capacity in CORPUS:
        p = Path(src_path)
        print(f"\n>>> {p.name}")
        print(f"    {desc}")
        if not p.exists():
            print(f"    SKIP — file not found: {p}")
            skipped.append((p.name, "not found"))
            continue
        try:
            total, failed = test_one_corpus(p, desc, capacity)
        except Exception as e:  # pylint: disable=broad-except
            import traceback
            traceback.print_exc()
            print(f"    ERR — {type(e).__name__}: {e}")
            skipped.append((p.name, str(e)))
            continue
        grand_total += total
        grand_failed += failed
        if failed == 0:
            print(f"    PASS — {total} games round-tripped")
        else:
            print(f"    FAIL — {failed}/{total} games differ")

    print()
    print("=" * 70)
    print(f"TOTAL: {grand_total - grand_failed}/{grand_total} games passed; "
          f"{len(skipped)} corpora skipped")
    if skipped:
        for name, reason in skipped:
            print(f"  skip  {name}: {reason}")

    return 0 if grand_failed == 0 and not skipped else 1


if __name__ == "__main__":
    sys.exit(main())
