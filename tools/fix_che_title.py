"""一次性修復：把已轉好的 .cbl/.xqf 標題裡燒進去的「車」亂碼還原。

# 背景
原始 CWP 把「車」存進 Big5 造字區私用碼 `FB 7A`（見 vendor/io_cwp.py）。早期
cwp→xqf→cbl 轉檔時，Big5 解不出該碼 → 變成 U+FFFD+'z'（顯示為「�z」）。根因已在
io_cwp.py 修好（之後重轉會正確），但**已經轉好的檔**裡亂碼是燒進去的，需原地修。

# 做法
標題裡的亂碼一律是字串 "�z"（U+FFFD 後接 'z'），固定代表「車」。

- .cbl：固定長度 UTF-16-LE 標題欄有兩處（每盤的 CBR header @180/128B、index entry
  @0x64/172B）。逐欄解碼→replace("�z","車")→重編碼補零回原長度。不解析走子樹、
  其餘 byte 不動。
- .xqf：用 cchess 讀出 book、修 book.info['title']、PatchedXQFWriter 寫回。

修改前一律備份成 <file>.bak。

# 用法
    python tools/fix_che_title.py <root_dir> [--dry-run]
    python tools/fix_che_title.py                      # 用 preferences.json 的 xqfRoot
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from cchess import Book  # noqa: E402
from cchess.io_xqf import read_from_xqf  # noqa: E402

from vendor import PatchedXQFWriter  # noqa: E402
from vendor.cchess_cbl import read_cbl  # noqa: E402  (import 觸發 cbl offset fix)
from backend.cb_service import _cbl_record_starts  # noqa: E402

_RESULT_STR_TO_INT = {"*": 0, "1-0": 1, "0-1": 2, "1/2-1/2": 3}

BAD = "�z"      # 亂碼形態（U+FFFD + 'z'）
GOOD = "車"
ENC = "utf-16-le"

# CBR header 標題欄、CBL index entry 標題欄（鏡像 vendor/io_cb_writer.py）。
CBR_TITLE_OFF, CBR_TITLE_SIZE = 180, 128
CBL_INDEX_BASE, CBL_INDEX_ENTRY_SIZE = 66624, 276
IDX_TITLE_REL, IDX_TITLE_SIZE = 0x64, CBL_INDEX_ENTRY_SIZE - 0x64  # 172


def _read_field_title(buf: bytes, off: int, size: int) -> str:
    field = bytes(buf[off:off + size])
    nul = field.find(b"\x00\x00")
    if nul == -1:
        nul = size
    elif nul % 2:
        nul -= 1            # 對齊到偶數邊界
    return field[:nul].decode(ENC, errors="replace")


def _fix_field(buf: bytearray, off: int, size: int, dry_run: bool) -> str | None:
    """若該欄標題含亂碼則回傳修好的標題（非 dry-run 時順便寫回 buf），否則 None。"""
    title = _read_field_title(buf, off, size)
    if BAD not in title:
        return None
    fixed = title.replace(BAD, GOOD)
    if not dry_run:
        enc = fixed.encode(ENC)[: size - 2]
        buf[off:off + size] = enc + b"\x00" * (size - len(enc))
    return fixed


def fix_cbl(path: Path, dry_run: bool) -> int:
    contents = bytearray(path.read_bytes())
    starts = _cbl_record_starts(contents)
    fixes = 0
    for i, rec in enumerate(starts):
        # 兩處標題欄都修（CBR header + index entry）以保持一致。
        a = _fix_field(contents, rec + CBR_TITLE_OFF, CBR_TITLE_SIZE, dry_run)
        idx_off = CBL_INDEX_BASE + i * CBL_INDEX_ENTRY_SIZE + IDX_TITLE_REL
        b = _fix_field(contents, idx_off, IDX_TITLE_SIZE, dry_run)
        if a or b:
            fixes += 1
            print(f"    #{i}: {(a or b)!r}")
    if fixes and not dry_run:
        shutil.copy2(path, Path(str(path) + ".bak"))
        path.write_bytes(bytes(contents))
    return fixes


def fix_xqf(path: Path, dry_run: bool) -> int:
    book = read_from_xqf(str(path), Book)
    if book is None:
        return 0
    title = book.info.get("title", "") or ""
    if BAD not in title:
        return 0
    fixed = title.replace(BAD, GOOD)
    print(f"    {title!r} -> {fixed!r}")
    if not dry_run:
        book.info["title"] = fixed
        shutil.copy2(path, Path(str(path) + ".bak"))
        # 比照 backend.xqf_service.save_xqf：標作者（之後讀檔跳過 Big5 還原）＋保留結果欄。
        writer = PatchedXQFWriter(book)
        writer.set_author("cb_editor")
        writer.set_result(_RESULT_STR_TO_INT.get(book.info.get("result", "*"), 0))
        writer.save(str(path))
    return 1


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry_run = "--dry-run" in sys.argv
    if args:
        target = Path(args[0])
    else:
        prefs = json.loads((ROOT / "preferences.json").read_text(encoding="utf-8"))
        target = Path(prefs["xqfRoot"])

    # 接受單一檔（.cbl/.xqf）或整個目錄。
    if target.is_file():
        files = [target]
        label = str(target)
    elif target.is_dir():
        files = sorted(target.rglob("*"))
        label = str(target)
    else:
        print(f"找不到檔案或目錄：{target}")
        sys.exit(1)

    print(f"掃描 {label}{'（dry-run，不寫檔）' if dry_run else ''}")
    total_files = total_games = 0
    for p in files:
        suf = p.suffix.lower()
        if suf == ".cbl":
            n = fix_cbl(p, dry_run)
        elif suf == ".xqf":
            n = fix_xqf(p, dry_run)
        else:
            continue
        if n:
            print(f"  {p.name}：修 {n} 個標題")
            total_files += 1
            total_games += n
    print(f"\n完成：{total_files} 檔、{total_games} 個標題"
          + ("（dry-run 未寫）" if dry_run else "（原檔已備份 .bak）"))


if __name__ == "__main__":
    main()
