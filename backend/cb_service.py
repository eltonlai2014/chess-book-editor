"""象棋橋 CBL / CBR 格式的編輯器整合層（讀→編→寫回）。

XQF 與 CBL/CBR 的每盤棋同為 `cchess.Book`，而 `xqf_service` 的
`book_to_json` / `json_to_book` 是格式無關的——所以本模組只做「格式邊界」的薄
封裝，序列化邏輯完全複用，不重複造輪子：

    讀  vendor.cchess_cbl.read_cbl / read_cbr   -> Book(s)
        -> xqf_service.book_to_json             -> 前端 JSON
    寫  前端 JSON -> xqf_service.json_to_book    -> Book
        -> vendor.io_cb_writer.write_cbr/cbl_bytes

CBR（單盤）與 XQF 同構、零風險。CBL（多盤庫）有兩個額外負擔，本模組負責：

1. **盤序路由**：CBL 內某盤以 rel `子目錄/lib.cbl#3` 定位（`#` 後為 0-based 盤序）。
   `parse_cb_rel` 負責拆解；app.py 先拆 `#N` 再做路徑跳脫驗證。
2. **覆寫整庫的保真**：`read_cbl` 只回 `{name, games}`，會遺失庫層 metadata
   （creator/email/建立時間/capacity）與每盤 GUID。`read_cbl_lib_meta` /
   `read_cbl_guids` 直接讀檔案 raw offset 補回，回填給 `write_cbl_bytes`
   （需其 `guids` 參數），讓未編輯的盤與庫屬性在「讀→改一盤→寫回」後不變。
"""
from __future__ import annotations

import os
import shutil
import struct
import time
from pathlib import Path

from cchess import Book
from cchess.read_cbr import _CBL_RECORD_SIZE, _parse_cbl_header, read_from_cbr_buffer

from backend.xqf_service import book_to_json, json_to_book
from vendor.cbl_index_fix import get_cbl_data_offset  # 線性 data-offset 公式（已修正 cchess bug）
from vendor.cchess_cbl import read_cbl, read_cbr  # import 觸發 apply_cbl_offset_fix
from vendor.io_cb_writer import (
    CBL_INDEX_BASE,
    CBL_INDEX_ENTRY_SIZE,
    CBL_META_CREATED_OFFSET,
    CBL_META_CREATOR_OFFSET,
    CBL_META_EMAIL_OFFSET,
    CBL_META_MODIFIED_OFFSET,
    CBL_META_SLOT_SIZE,
    CBR_ENCODING,
    CBR_MAGIC,
    write_cbl_bytes,
    write_cbr_bytes,
)

# CBR header 內標題欄位（io_cb_writer 寫在 180，128 bytes UTF-16-LE）。
_CBR_TITLE_OFFSET = 180
_CBR_TITLE_SIZE = 128

# CBR header 內其餘顯示欄位（同 io_cb_writer 的寫入 offset）：紅/黑棋手、賽事、
# 賽果。列舉時一併讀出，讓有真棋手的盤能顯示「布局名 — 紅 先勝 黑」。
_CBR_EVENT_OFFSET = 692
_CBR_EVENT_SIZE = 64
_CBR_RED_OFFSET = 1076
_CBR_RED_SIZE = 64
_CBR_BLACK_OFFSET = 1300
_CBR_BLACK_SIZE = 64
_CBR_RESULT_OFFSET = 2076  # 1 byte：0=未知/*, 1=紅勝, 2=黑勝, 3=和

# result byte -> 紅方視角的結果詞（同 XQF 檔名慣例：先勝/先負/先和）。
_RESULT_WORD = {1: "先勝", 2: "先負", 3: "先和"}
# CCBridge 對沒有真棋手的理論譜填的佔位名，視同無棋手。
_PLACEHOLDER_PLAYERS = {"紅方", "黑方", "红方", "无"}


# ---------- rel 解析 --------------------------------------------------------

def parse_cb_rel(rel: str) -> tuple[str, int | None]:
    """把 rel 拆成 (base_rel, game_index)。

    `子目錄/lib.cbl#3` -> (`子目錄/lib.cbl`, 3)；其餘（XQF、CBR、無 `#`）回
    (rel, None)。只有 `#` 左側以 `.cbl` 結尾才視為 CBL 盤參照——避免把檔名本身
    含 `#` 的非 CBL 檔誤判。
    """
    idx = rel.rfind("#")
    if idx == -1:
        return rel, None
    base, suffix = rel[:idx], rel[idx + 1 :]
    if not base.lower().endswith(".cbl"):
        return rel, None
    try:
        return base, int(suffix)
    except ValueError:
        return rel, None


def is_cb_path(base_rel: str) -> bool:
    """base_rel（已拆掉 #N）是否為本模組負責的 CBL/CBR 檔。"""
    low = base_rel.lower()
    return low.endswith(".cbl") or low.endswith(".cbr")


# ---------- CBL 資料區定位（不解析走子樹，給快路徑用） -----------------------
#
# CBL 是固定 4096-byte 記錄、資料區起點 = 66624 + book_count*276（cbl_index_fix
# 的線性公式）。標題就在每筆 CBR header；要拿第 N 盤也只需算位移後解析那一盤——
# 都不必像 read_cbl 那樣把整庫每盤的走子樹全解析。這是「展開庫」「選單局」兩處
# 卡頓的根因修正。

def _cbl_record_starts(contents: bytes) -> list[int]:
    """回傳每筆 CBR 記錄在 contents 內的起始 offset（順序＝盤序）。

    比照 cchess 的固定 4096-byte 走法：從資料區找第一個 'CCBridge Record'，每
    4096 bytes 一筆，遇非記錄（補零）即停。與 read_cbl 的盤序/盤數一致。
    """
    _name, book_count, _valid = _parse_cbl_header(contents)
    buff_start = get_cbl_data_offset(book_count)
    rel_first = contents[buff_start:].find(CBR_MAGIC)
    if rel_first < 0:
        return []
    starts = []
    pos = buff_start + rel_first
    n = len(contents)
    while pos + len(CBR_MAGIC) <= n and contents[pos : pos + len(CBR_MAGIC)] == CBR_MAGIC:
        starts.append(pos)
        pos += _CBL_RECORD_SIZE
    return starts


def _decode_cbr_title(contents: bytes, start: int) -> str:
    return _decode_slot(contents, start + _CBR_TITLE_OFFSET, _CBR_TITLE_SIZE)


def _is_real_player(name: str) -> bool:
    """非空、且非 CCBridge 理論譜的佔位名（紅方/黑方）才算真棋手。"""
    return bool(name) and name not in _PLACEHOLDER_PLAYERS


def _compose_cbl_label(contents: bytes, start: int, title: str) -> str:
    """組左樹顯示文字：有真棋手→「布局名 — 紅 先勝 黑」，否則只回布局名。

    紅/黑/賽果都是 CBR header 固定 offset，bytes 已在記憶體裡，零額外 I/O。
    """
    base = title or "(無標題)"
    red = _decode_slot(contents, start + _CBR_RED_OFFSET, _CBR_RED_SIZE).strip()
    black = _decode_slot(contents, start + _CBR_BLACK_OFFSET, _CBR_BLACK_SIZE).strip()
    if not (_is_real_player(red) and _is_real_player(black)):
        return base
    # 有些盤的 title 本身已寫成「A111 張鴻鈞 先和 黃朝貴」——再 append 會重複。
    # title 已同時含紅黑兩名時，視為自帶棋手資訊，不再加。
    if red in base and black in base:
        return base
    result = contents[start + _CBR_RESULT_OFFSET] if start + _CBR_RESULT_OFFSET < len(contents) else 0
    word = _RESULT_WORD.get(result, "對")
    return f"{base} — {red} {word} {black}"


# ---------- 列舉 CBL 盤目（懶載入用） ----------------------------------------

def list_cbl_games(path: Path) -> list[dict]:
    """枚舉 .cbl 內每盤棋，回 [{index, title, name}]。

    只讀每筆 CBR header 的標題，**不解析走子樹**（避免整庫 N 盤全解析）。
    `name` 供左樹顯示（1-based 序＋標題）；`index` 為 0-based，組進 rel `#N`。
    """
    contents = path.read_bytes()
    starts = _cbl_record_starts(contents)
    out = []
    for i, start in enumerate(starts):
        title = _decode_cbr_title(contents, start).strip()
        out.append({
            "index": i,
            "title": title,
            "name": f"{i + 1}. {_compose_cbl_label(contents, start, title)}",
        })
    return out


# ---------- 載入（CBR 單盤 / CBL 指定盤） -> 前端 JSON ------------------------

def load_cb(path: Path, index: int | None) -> dict:
    """讀 CBR 或 CBL 指定盤，回 `book_to_json` 的 JSON。

    CBL 只解析**指定那一盤**（算 offset → read_from_cbr_buffer），不碰其餘 823 盤。
    不跑 XQF 的 Big5 recovery——CB 格式字串一律 UTF-16-LE，沒有 XQF 的 Big5 舊帳。
    """
    contents = path.read_bytes()
    if index is None:
        book = read_cbr(str(path))
        if book is None:
            raise ValueError(f"failed to read CBR: {path}")
        hdr_start = 0
    else:
        starts = _cbl_record_starts(contents)
        if index < 0 or index >= len(starts):
            raise ValueError(f"game index {index} out of range (0..{len(starts) - 1})")
        hdr_start = starts[index]
        book = read_from_cbr_buffer(contents[hdr_start:], Book)
        if book is None:
            raise ValueError(f"failed to parse CBL game {index} in {path}")
    # cchess 的 cut_bytes_to_str 對位不嚴，標題若以 ASCII 結尾（')'、數字…）會漏掉
    # 最後一字。用對齊解碼（同 list_cbl_games）覆蓋標題，確保顯示與「編輯後存檔」都完整。
    aligned = _decode_cbr_title(contents, hdr_start).strip()
    if aligned:
        book.info["title"] = aligned
    return book_to_json(book)


# ---------- 寫回 ------------------------------------------------------------

def save_cbr(path: Path, data: dict) -> None:
    """前端 JSON -> Book -> CBR bytes -> 原子寫回。

    保留原檔的 record GUID（若原檔可讀），讓 CBR 身分跨編輯不變。
    """
    book = json_to_book(data)
    guid = _read_cbr_guid(path)
    payload = write_cbr_bytes(book, guid_str=guid)
    _atomic_write(path, payload)


def save_cbl_game(path: Path, index: int, data: dict) -> None:
    """覆寫 .cbl 內第 index 盤，寫前備份 .bak。

    **快路徑（位元組級 splice）**：CBL 是固定 4096-byte slot 記錄。只要新盤佔的
    slot 數與原本相同（開局庫幾乎都是 1 slot），就只覆寫該盤所屬的 slot 區、原地
    更新其索引（data_size／標題）與庫層 modified_at——其餘 823 盤、header、index
    其他項全 byte 不動。這比「讀整庫＋全庫重序列化」快上千倍，且更保真。

    新盤 slot 數與原本不同（罕見，盤大幅長大跨 4096）才退回 `_save_cbl_full` 整庫重寫。
    """
    contents = bytearray(path.read_bytes())
    starts = _cbl_record_starts(contents)
    if index < 0 or index >= len(starts):
        raise ValueError(f"game index {index} out of range (0..{len(starts) - 1})")

    entry = CBL_INDEX_BASE + index * CBL_INDEX_ENTRY_SIZE
    old_slot_count = struct.unpack_from("<i", contents, entry + 0x08)[0]
    guid = _decode_slot(contents, entry + 0x14, 76) or None  # 保留原 GUID

    new_cbr = write_cbr_bytes(json_to_book(data), guid_str=guid)
    new_slot_count = (len(new_cbr) + _CBL_RECORD_SIZE - 1) // _CBL_RECORD_SIZE

    if old_slot_count < 1 or new_slot_count != old_slot_count:
        _save_cbl_full(path, index, data)
        return

    span = old_slot_count * _CBL_RECORD_SIZE
    rec_start = starts[index]
    contents[rec_start : rec_start + span] = new_cbr + b"\x00" * (span - len(new_cbr))

    # 索引項：更新 data_size 與標題（slot_count、GUID 不變）。
    struct.pack_into("<i", contents, entry + 0x0C, len(new_cbr))
    title = ((data.get("info") or {}).get("title", "") or "")
    tb = title.encode(CBR_ENCODING, errors="ignore")[:172]
    for j in range(entry + 0x64, entry + CBL_INDEX_ENTRY_SIZE):
        contents[j] = 0
    contents[entry + 0x64 : entry + 0x64 + len(tb)] = tb

    # 庫層 modified_at 蓋成當下。
    _set_meta_slot(contents, CBL_META_MODIFIED_OFFSET, time.strftime("%Y-%m-%d %H:%M:%S"))

    shutil.copy2(path, Path(str(path) + ".bak"))
    _atomic_write(path, bytes(contents))


def _set_meta_slot(buf: bytearray, offset: int, text: str) -> None:
    """清空 64-byte slot 再寫入 UTF-16-LE 字串（絕對 offset，給 splice 用）。"""
    for j in range(offset, offset + CBL_META_SLOT_SIZE):
        buf[j] = 0
    enc = text.encode(CBR_ENCODING, errors="ignore")[: CBL_META_SLOT_SIZE - 2]
    buf[offset : offset + len(enc)] = enc


def _save_cbl_full(path: Path, index: int, data: dict) -> None:
    """整庫重寫退路（盤跨 slot 配置改變時）：讀整庫→換第 index 盤→寫回。

    保留 lib name、庫層 metadata、capacity、每盤原 GUID；只更新 modified_at。
    """
    lib = read_cbl(str(path))
    games = list(lib.get("games") or [])
    if index < 0 or index >= len(games):
        raise ValueError(f"game index {index} out of range (0..{len(games) - 1})")

    games[index] = json_to_book(data)

    meta = read_cbl_lib_meta(path)
    guids = read_cbl_guids(path, len(games))
    # 保真前提是 GUID 數與盤數對得上；對不上就退回讓寫入器重新產生（仍可被
    # CCBridge 正常開啟，只是身分不穩定）。
    if guids is not None and len(guids) != len(games):
        guids = None

    payload = write_cbl_bytes(
        lib.get("name") or path.stem,
        games,
        capacity=meta.get("capacity"),
        creator=meta.get("creator", ""),
        email=meta.get("email", ""),
        created_at=meta.get("created_at", ""),
        modified_at=time.strftime("%Y-%m-%d %H:%M:%S"),
        guids=guids,
    )

    backup = Path(str(path) + ".bak")
    shutil.copy2(path, backup)
    _atomic_write(path, payload)


# ---------- raw-offset 讀取（read_cbl 不回傳的欄位） -------------------------

def _decode_slot(buf: bytes, offset: int, size: int) -> str:
    """讀 UTF-16-LE slot，於 NUL 終止處截斷。"""
    if offset + size > len(buf):
        return ""
    raw = buf[offset : offset + size]
    nul = raw.find(b"\x00\x00")
    if nul != -1 and nul % 2 == 0:
        raw = raw[:nul]
    return raw.decode(CBR_ENCODING, errors="ignore").rstrip("\x00")


def read_cbl_lib_meta(path: Path) -> dict:
    """讀庫層 metadata：creator/email/created_at（modified_at 寫回時重新蓋）與 capacity。

    `read_cbl` 不回傳這些；直接讀 io_cb_writer 寫入時的 raw offset。
    """
    with open(path, "rb") as f:
        head = f.read(CBL_INDEX_BASE)
    meta: dict = {
        "creator": _decode_slot(head, CBL_META_CREATOR_OFFSET, CBL_META_SLOT_SIZE),
        "email": _decode_slot(head, CBL_META_EMAIL_OFFSET, CBL_META_SLOT_SIZE),
        "created_at": _decode_slot(head, CBL_META_CREATED_OFFSET, CBL_META_SLOT_SIZE),
    }
    if len(head) >= 64:
        # offset 60: index slot count（writer 寫入的 capacity）。回填可保 layout 不變。
        cap = struct.unpack_from("<i", head, 60)[0]
        if cap > 0:
            meta["capacity"] = cap
    return meta


def read_cbl_guids(path: Path, count: int) -> list[str] | None:
    """讀前 `count` 盤的索引區 GUID（`66624 + i*276 + 0x14`，76 bytes UTF-16-LE）。

    讀檔失敗回 None（呼叫端會退回讓寫入器重新產生）。
    """
    try:
        with open(path, "rb") as f:
            f.seek(CBL_INDEX_BASE)
            index_area = f.read(count * CBL_INDEX_ENTRY_SIZE)
    except OSError:
        return None
    guids = []
    for i in range(count):
        base = i * CBL_INDEX_ENTRY_SIZE + 0x14
        guids.append(_decode_slot(index_area, base, 76))
    return guids


def _read_cbr_guid(path: Path) -> str | None:
    """讀 CBR header 的 16-byte binary GUID（offset 20）轉回 '{...}' 字串。

    讓 `save_cbr` 保留原身分。讀不到回 None（寫入器自動新生）。
    """
    try:
        with open(path, "rb") as f:
            head = f.read(36)
    except OSError:
        return None
    if len(head) < 36:
        return None
    return _guid_bin_to_str(head[20:36])


def _guid_bin_to_str(raw: bytes) -> str:
    """16-byte Windows binary GUID -> '{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}'。

    inverse of io_cb_writer._guid_str_to_bin（前三組 little-endian，後兩組原序）。
    """
    g = (
        raw[0:4][::-1]
        + raw[4:6][::-1]
        + raw[6:8][::-1]
        + raw[8:10]
        + raw[10:16]
    ).hex().upper()
    return f"{{{g[0:8]}-{g[8:12]}-{g[12:16]}-{g[16:20]}-{g[20:32]}}}"


# ---------- 原子寫入 --------------------------------------------------------

def _atomic_write(path: Path, payload: bytes) -> None:
    """先寫同目錄 .tmp 再 os.replace，避免半寫壞檔。"""
    tmp = Path(str(path) + ".tmp")
    with open(tmp, "wb") as f:
        f.write(payload)
    os.replace(tmp, path)
