"""Round-trip via JSON: XQF -> Book -> JSON -> Book -> XQF -> Book.

Verifies the editor's wire format preserves every path/annote. Reuses the
path-set comparison logic from test_roundtrip.py.
"""
import sys
import tempfile
import traceback
from pathlib import Path

from cchess import Book
from cchess.io_xqf import read_from_xqf

sys.path.insert(0, str(Path(__file__).parent.parent))
from backend.xqf_service import book_to_json, json_to_book, save_xqf, recover_book_strings  # noqa: E402
from tests.test_roundtrip import collect_paths  # noqa: E402

SRC_ROOT = Path(r"D:\Elton\TestArea\chess-book")


def check_one(xqf_path: Path):
    rel = str(xqf_path.relative_to(SRC_ROOT))
    book_a = read_from_xqf(str(xqf_path), Book)
    if book_a is None:
        return {"file": rel, "ok": False, "error": "read returned None"}
    # Apply Big5 recovery so paths_a uses the same (corrected) annote strings
    # that the editor flow produces. Without this, source mojibake won't match
    # the recovered TC that book_to_json emits and round-trip "fails" spuriously.
    recover_book_strings(book_a)
    paths_a = collect_paths(book_a)

    # JSON round-trip in memory
    data = book_to_json(book_a)
    book_b = json_to_book(data)
    paths_b = collect_paths(book_b)
    if paths_a != paths_b:
        return {"file": rel, "ok": False, "error": f"json roundtrip paths {len(paths_a)} -> {len(paths_b)}"}

    # JSON -> file -> reread (the actual save_xqf path)
    with tempfile.NamedTemporaryFile(delete=False, suffix=".xqf") as tf:
        tmp = Path(tf.name)
    try:
        data["path"] = "ignored"
        save_xqf(tmp, data)
        book_c = read_from_xqf(str(tmp), Book)
        paths_c = collect_paths(book_c)
    finally:
        if tmp.exists():
            tmp.unlink()
    if paths_a != paths_c:
        return {"file": rel, "ok": False, "error": f"file roundtrip paths {len(paths_a)} -> {len(paths_c)}"}
    return {"file": rel, "ok": True, "paths": len(paths_a)}


def main():
    xqfs = sorted(SRC_ROOT.rglob("*.XQF"))
    print(f"Found {len(xqfs)} XQF files")
    rows = []
    for i, p in enumerate(xqfs, 1):
        try:
            r = check_one(p)
        except Exception:
            r = {"file": str(p.relative_to(SRC_ROOT)), "ok": False,
                 "error": traceback.format_exc().splitlines()[-1][:100]}
        rows.append(r)
        flag = "OK " if r["ok"] else "ERR"
        extra = f" paths={r.get('paths')}" if r["ok"] else f" {r.get('error')}"
        print(f"[{i:>2}/{len(xqfs)}] {flag} {r['file']}{extra}")
    ok = sum(1 for r in rows if r["ok"])
    print(f"\nSummary: {ok}/{len(rows)} perfect")
    return 0 if ok == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
