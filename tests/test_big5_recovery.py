"""Unit tests for backend/xqf_service.py's Big5-recovery heuristics + marker.

Locks the dual defence against mis-recovering simplified-Chinese GB18030
annotations as Big5 (which produces mojibake like 黑方得势 → 窀源腕岊).

Run:
  PYTHONIOENCODING=utf-8 .\\.venv\\Scripts\\python.exe tests\\test_big5_recovery.py
"""
from __future__ import annotations

import io
import os
import struct
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.stdout.reconfigure(encoding="utf-8")

from backend.xqf_service import (  # noqa: E402
    GB18030_AUTHOR_MARKERS,
    _has_negative_signal,
    _has_simplified_only_char,
    _is_simplified_only,
    _maybe_recover_big5,
    _read_xqf_author,
)


# ---------- _is_simplified_only ---------------------------------------------

def test_simplified_only_detection():
    # 势 (U+52BF) is the simplified form of 勢 (U+52E2). Big5 only has 勢.
    assert _is_simplified_only("势")
    assert not _is_simplified_only("勢")
    # 国 (simplified of 國) — Big5 only has 國
    assert _is_simplified_only("国")
    assert not _is_simplified_only("國")
    # Chars common to both encodings
    assert not _is_simplified_only("黑")
    assert not _is_simplified_only("方")
    # ASCII / latin
    assert not _is_simplified_only("A")
    assert not _is_simplified_only("。")


def test_has_simplified_only_char():
    assert _has_simplified_only_char("黑方得势。")        # 势 triggers
    assert _has_simplified_only_char("现代布局的创新")    # 现 / 创 trigger
    assert not _has_simplified_only_char("黑方")          # all in both
    assert not _has_simplified_only_char("準備兌卒")      # traditional
    assert not _has_simplified_only_char("")
    assert not _has_simplified_only_char("正著")          # both in Big5


# ---------- _maybe_recover_big5 ---------------------------------------------

def test_recover_empty_and_none():
    assert _maybe_recover_big5("") == ""
    assert _maybe_recover_big5(None) is None


def test_recover_keeps_simplified_text():
    """GB18030 simplified text must NOT be mis-recovered as Big5 mojibake."""
    # This is the actual bug: 黑方得势。 written as GB18030 then read as Big5
    # produces 窀源腕岊（. The simplified-only-char check should prevent this.
    s = "黑方得势。"
    assert _maybe_recover_big5(s) == s, (
        "Simplified-Chinese annotation should be preserved verbatim; "
        f"got {_maybe_recover_big5(s)!r}"
    )

    long_s = "20世纪60年代，由于过河车遭到天马行空的有力反击，布子均衡的古典走法。"
    assert _maybe_recover_big5(long_s) == long_s


def test_recover_fixes_genuine_big5_mojibake():
    """Master's primary case: cchess decoded Big5 bytes as GB18030 → mojibake.
    Round-trip through _maybe_recover_big5 must restore the original Big5
    even when the mojibake happens to contain simplified-only-looking chars
    — the PUA gate distinguishes mojibake from real GB18030 text.
    """
    original_big5_text = "準備兌卒活馬"
    big5_bytes = original_big5_text.encode("big5")
    mojibake = big5_bytes.decode("gb18030", errors="ignore")
    # This mojibake demonstrably contains both PUA chars and simplified-only
    # chars (e.g. 称 from 準, 皑 from 馬) — without the PUA gate, the
    # simplified-only positive signal would wrongly suppress recovery.
    recovered = _maybe_recover_big5(mojibake)
    assert recovered == original_big5_text, (
        f"recovery failed: got {recovered!r}, expected {original_big5_text!r}"
    )


def test_recover_rejects_false_positive_with_bopomofo():
    """If recovery produces bopomofo, it's a known false positive — keep original."""
    # Craft a string where GB-encode-then-Big5-decode yields bopomofo.
    # Bopomofo in Big5 occupies bytes A374..A3BA. Working backwards:
    # 'ㄅ' (U+3105) in Big5 = A374. As GB18030 bytes A3 74, decoded as
    # GB18030 = '＃t' (full-width #, then t).
    s = "＃t"  # this should be left alone since recovery would produce bopomofo
    # Verify the test premise
    try:
        rec = s.encode("gb18030").decode("big5")
        assert any("ㄅ" <= c <= "ㄯ" for c in rec), (
            f"test premise broken: {s!r} doesn't recover to bopomofo: {rec!r}"
        )
    except (UnicodeEncodeError, UnicodeDecodeError):
        # If the test premise fails on this platform, skip silently
        return
    assert _maybe_recover_big5(s) == s


# ---------- _read_xqf_author -------------------------------------------------

def _make_header_with_author(author: str) -> bytes:
    """Build a 1024-byte XQF-shaped header with author at offset 0x01E0."""
    buf = bytearray(b"\x00" * 1024)
    buf[0:2] = b"XQ"
    enc = author.encode("gb18030")
    n = min(len(enc), 15)
    buf[0x01E0] = n
    buf[0x01E1 : 0x01E1 + n] = enc[:n]
    return bytes(buf)


def test_read_author_with_marker(tmp_path):
    p = tmp_path / "marked.xqf"
    p.write_bytes(_make_header_with_author("cbl_to_xqf"))
    assert _read_xqf_author(p) == "cbl_to_xqf"


def test_read_author_with_editor_marker(tmp_path):
    # 'cb_editor' rather than 'chess-book-editor' — the XQF author field is
    # only 15 bytes; longer names get silently truncated and break the check.
    p = tmp_path / "marked.xqf"
    p.write_bytes(_make_header_with_author("cb_editor"))
    assert _read_xqf_author(p) == "cb_editor"


def test_markers_fit_in_author_field():
    # Regression guard: any marker longer than 15 GB18030 bytes will be
    # truncated when written by set_author, and load_xqf won't recognise it.
    for m in GB18030_AUTHOR_MARKERS:
        assert len(m.encode("gb18030")) <= 15, (
            f"marker {m!r} is {len(m.encode('gb18030'))} bytes — won't fit in "
            f"XQF's 15-byte author field"
        )


def test_read_author_empty(tmp_path):
    p = tmp_path / "noauthor.xqf"
    p.write_bytes(_make_header_with_author(""))
    assert _read_xqf_author(p) == ""


def test_read_author_short_file(tmp_path):
    p = tmp_path / "tiny.xqf"
    p.write_bytes(b"XQ\x0a\x00")  # nowhere near offset 0x01E0
    assert _read_xqf_author(p) == ""


def test_read_author_missing_file(tmp_path):
    p = tmp_path / "does_not_exist.xqf"
    assert _read_xqf_author(p) == ""


def test_known_markers_are_recognised():
    assert "cbl_to_xqf" in GB18030_AUTHOR_MARKERS
    assert "cb_editor" in GB18030_AUTHOR_MARKERS


# ---------- driver ----------------------------------------------------------

def run_all():
    """Tiny test driver — collect callables named test_* and run them.

    Supplies a `tmp_path` fixture (pathlib.Path) to tests that take it,
    via tempfile.TemporaryDirectory.
    """
    import inspect
    from pathlib import Path

    fns = [v for k, v in globals().items()
           if k.startswith("test_") and callable(v)]
    passed = failed = 0
    for fn in fns:
        sig = inspect.signature(fn)
        try:
            if "tmp_path" in sig.parameters:
                with tempfile.TemporaryDirectory() as td:
                    fn(Path(td))
            else:
                fn()
            print(f"  PASS  {fn.__name__}")
            passed += 1
        except AssertionError as e:
            print(f"  FAIL  {fn.__name__}: {e}")
            failed += 1
        except Exception as e:  # pylint: disable=broad-except
            print(f"  ERR   {fn.__name__}: {type(e).__name__}: {e}")
            failed += 1
    print(f"\nSummary: {passed}/{passed+failed} passed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(run_all())
