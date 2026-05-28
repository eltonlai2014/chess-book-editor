"""Fix cchess's CBL data-offset lookup.

Apply once at import time::

    from vendor.cbl_index_fix import apply_cbl_offset_fix
    apply_cbl_offset_fix()

# The bug

cchess `read_cbr.py` picks the data-area start of a `.cbl` file from a
hard-coded 4-step table::

    (128, 101952), (256, 137280), (384, 151080), (512, 207936)
    # default 349248

This is wrong in two ways:

1. The relationship is **linear**, not a step function:

       data_start = 66624 + book_count * 276

   (verified across 1570 CBL files in the CCBridge3 distribution).
   Each per-book index entry is 276 bytes and the index begins at 66624.

2. The default of 349248 doesn't cover the common 2048-slot capacity:
   ~53 of those files in the wild have their data area at 631872.

When the table returns a value **larger** than the actual data offset
(e.g. off60=149 → table says 137280, real data starts at 107748), cchess
slices `contents[buff_start:]` PAST the only marker and `.find()`
returns -1 → 0 games parsed silently. Confirmed broken on 17 files in
the test corpus.

When the table returns a value **smaller-or-equal** to the real offset
but still 4096-aligned, cchess accidentally recovers because `.find()`
scans forward — these files happen to work despite the table being
wrong. The fix below makes both cases correct.

# Field at offset 60

cchess names it `book_count`, but it's better understood as the
**preallocated index capacity** (always one of 128, 256, 512, 1024,
2048 for fresh files, but can be any integer for files edited in-
place). The actual occupied-record count cannot be derived from the
header alone — walking `CCBridge Record\\x00` markers is the only
reliable way (cchess already does this in the parse loop, so the
miscount in the header is harmless once data_start is right).
"""

from __future__ import annotations


CBL_INDEX_BASE = 66624
CBL_INDEX_ENTRY_SIZE = 276


def get_cbl_data_offset(book_count: int) -> int:
    """Return the byte offset where the game records begin.

    `book_count` is the int32 at file offset 60 (cchess's name).
    """
    return CBL_INDEX_BASE + book_count * CBL_INDEX_ENTRY_SIZE


def apply_cbl_offset_fix() -> None:
    """Monkeypatch cchess.read_cbr._get_cbl_data_offset to use the linear formula."""
    from cchess import read_cbr  # type: ignore[attr-defined]

    if getattr(read_cbr, "_cbl_offset_fix_applied", False):
        return
    read_cbr._get_cbl_data_offset = get_cbl_data_offset  # type: ignore[attr-defined]
    read_cbr._cbl_offset_fix_applied = True  # type: ignore[attr-defined]
