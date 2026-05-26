"""Emit sample XQF files for XQStudio manual verification.

Reads a few representative books from `D:\\Elton\\TestArea\\chess-book\\`,
round-trips them through PatchedXQFWriter, and writes the outputs into
`samples/` at the repo root.

Open each one in XQStudio and verify:
  - All variations show up
  - All annotations display correctly (繁體 chars preserved)
  - Initial position is correct
  - Player names / event / title display correctly
"""
import sys
from pathlib import Path

from cchess import Book
from cchess.io_xqf import read_from_xqf

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))
from vendor import PatchedXQFWriter  # noqa: E402

SRC_ROOT = Path(r"D:\Elton\TestArea\chess-book")
OUT_DIR = REPO_ROOT / "samples"
OUT_DIR.mkdir(exist_ok=True)

PICKS = [
    "中砲對單提馬.XQF",                              # smallest, 6 branches
    r"順包\順包兩頭蛇對雙橫車.XQF",                  # 41 branches, lots of annotes
    r"高車保馬\七路傌攻高車保馬.XQF",                # 261 branches, stress test
    "牛頭滾.XQF",                                    # 225 branches
    r"AI\順包\順包直車3兵對橫車4進5.XQF",            # AI-recovered version
]

for rel in PICKS:
    src = SRC_ROOT / rel
    if not src.exists():
        print(f"!! not found: {rel}")
        continue
    book = read_from_xqf(str(src), Book)
    out = OUT_DIR / src.name
    PatchedXQFWriter(book).save(str(out))
    print(f"{rel}  →  {out.relative_to(REPO_ROOT)}  "
          f"({src.stat().st_size}B → {out.stat().st_size}B, branchs={book.info.get('branchs')})")
