"""CBR / CBL writers — inverse of cchess.read_cbr.

Two entry points:

  * `write_cbr_bytes(book)` — serialise a single `cchess.Book` to CBR bytes.
  * `write_cbl_bytes(lib_name, books)` — bundle multiple Books into a CBL
    container, ready to write to disk as a `.cbl` file.

Layout reverse-engineered from real CCBridge3 files (see ai/cbl_format.md
analysis upstream; in short):

  CBR record (variable length):
    +0      16 bytes   magic 'CCBridge Record\\x00'
    +180   128 bytes   title (UTF-16-LE, null-pad)
    +692    64 bytes   event
    +1076   64 bytes   red
    +1300   64 bytes   black
    +2076    1 byte    game_result (0=*, 1=red, 2=black, 3=draw)
    +2116    2 bytes   move_side (uint16; 1=red, 2=black)
    +2120   90 bytes   board (9x10 piece codes; see _FENCH_TO_CBR)
    (all other header bytes: zero)
    +2214   ...        init annote: <i32 gate> [+<i32 len> + utf16le]
    +...    ...        DFS move stream

  CBL container:
    +0      16 bytes   magic 'CCBridgeLibrary\\x00'
    +60      4 bytes   book_count / capacity (i32; 128/256/512/1024/2048)
    +64    512 bytes   lib_name (UTF-16-LE)
    +576   65 KB       library metadata area (mostly zero; optional)
    +66624 N*276 bytes index entries (one per slot)
    +66624+N*276 ...   data area: 4096-byte slots, CBR records sequentially

  Index entry (276 bytes):
    +0x00 i32        =7 (constant — record type marker)
    +0x04 i32        record index (0..N-1)
    +0x08 i32        slot_count (number of 4096-byte slots this CBR occupies)
    +0x0C i32        data_size (actual CBR byte length)
    +0x10 i32        0
    +0x14 76 bytes   GUID string '{XXXXXXXX-XXXX-...}' (UTF-16-LE)
    +0x60 i32        0
    +0x64 ~176 bytes title (UTF-16-LE)

Records that exceed 4096 bytes span multiple consecutive slots. cchess's
reader walks 4096-byte slots and skips ones with bad magic, so the layout
remains compatible with their parser.
"""
from __future__ import annotations

import struct
import uuid
from io import BytesIO


# ---------- Piece code map (cchess fench → CBR byte) ------------------------

_FENCH_TO_CBR = {
    # Red
    "R": 0x11, "N": 0x12, "B": 0x13, "A": 0x14, "K": 0x15, "C": 0x16, "P": 0x17,
    # Black
    "r": 0x21, "n": 0x22, "b": 0x23, "a": 0x24, "k": 0x25, "c": 0x26, "p": 0x27,
}

_RESULT_STR_TO_INT = {
    "*": 0,
    "1-0": 1,
    "0-1": 2,
    "1/2-1/2": 3,
}

CBR_MAGIC = b"CCBridge Record\x00"
CBR_HEADER_SIZE = 2214
CBR_ENCODING = "utf-16-le"

CBL_MAGIC = b"CCBridgeLibrary\x00"
CBL_HEADER_SIZE = 576
CBL_INDEX_BASE = 66624
CBL_INDEX_ENTRY_SIZE = 276
CBL_SLOT_SIZE = 4096

# Library-level metadata fields live in 64-byte UTF-16-LE slots starting at
# offset 832 in the CBL. Reverse-engineered from 顺炮全集.CBL.
CBL_META_CREATOR_OFFSET = 832
CBL_META_EMAIL_OFFSET = 896
CBL_META_CREATED_OFFSET = 960
CBL_META_MODIFIED_OFFSET = 1024
CBL_META_SLOT_SIZE = 64

_CBL_STANDARD_CAPACITIES = (128, 256, 512, 1024, 2048)


# ---------- helpers ---------------------------------------------------------

def _enc_str_field(text: str, max_bytes: int) -> bytes:
    """UTF-16-LE encode, truncate to max_bytes-2 (leave null terminator), zero-pad."""
    if not text:
        return b"\x00" * max_bytes
    encoded = text.encode(CBR_ENCODING, errors="ignore")[: max_bytes - 2]
    return encoded + b"\x00" * (max_bytes - len(encoded))


def _cbr_pos(x: int, y: int) -> int:
    """Inverse of cchess.read_cbr._cbr_decode_pos."""
    return (9 - y) * 9 + x


def _encode_board(board) -> bytes:
    out = bytearray(90)
    for x in range(9):
        for y in range(10):
            fench = board.get_fench((x, 9 - y))
            if fench and fench in _FENCH_TO_CBR:
                out[y * 9 + x] = _FENCH_TO_CBR[fench]
    return bytes(out)


def _generate_guid_str() -> str:
    return "{" + str(uuid.uuid4()).upper() + "}"


def _guid_str_to_bin(guid_str: str) -> bytes:
    """Convert '{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}' to 16-byte Windows binary form.

    First 3 groups are little-endian (per Windows GUID convention); last 2 are
    big-endian (just byte-for-byte).
    """
    hexstr = guid_str.strip("{}").replace("-", "")
    raw = bytes.fromhex(hexstr)
    return (
        raw[0:4][::-1]   # int32 LE
        + raw[4:6][::-1] # int16 LE
        + raw[6:8][::-1] # int16 LE
        + raw[8:16]      # 8 bytes as-is
    )


def _round_up_capacity(n: int) -> int:
    """CCBridge fresh-file capacity buckets."""
    for cap in _CBL_STANDARD_CAPACITIES:
        if n <= cap:
            return cap
    return ((n + 255) // 256) * 256


# ---------- CBR move stream encoding ----------------------------------------

def _write_cbr_siblings(buf: BytesIO, siblings) -> None:
    """Recursively write a sibling list in the order cchess's `_cbr_read_steps`
    expects: for each move M, write M's record, then M's main continuation
    subtree, then advance to the next sibling.
    """
    n = len(siblings)
    for i, move in enumerate(siblings):
        has_more_siblings = i < n - 1
        has_next = move.next_move is not None
        annote = move.annote or ""

        step_mark = 0
        if not has_next:
            step_mark |= 0x01
        if has_more_siblings:
            step_mark |= 0x02
        if annote:
            step_mark |= 0x04

        from_pos = _cbr_pos(*move.pos_from)
        to_pos = _cbr_pos(*move.pos_to)
        buf.write(bytes([step_mark, 0, from_pos, to_pos]))

        if annote:
            ann_bytes = annote.encode(CBR_ENCODING, errors="ignore")
            buf.write(struct.pack("<i", len(ann_bytes)))
            buf.write(ann_bytes)

        if has_next:
            children = list(move.next_move.variations_all)
            _write_cbr_siblings(buf, children)


# ---------- public: write CBR -----------------------------------------------

def write_cbr_bytes(book, guid_str: str | None = None) -> bytes:
    """Serialise a single Book to CBR bytes.

    `guid_str` (format '{XXXXXXXX-...}') is embedded in the CBR header as a
    16-byte binary GUID at offset 19..35. CCBridge cross-validates this
    against the index entry's GUID — mismatched records are treated as
    invalid (titles disappear from the list, opening errors out). The CBL
    writer passes a single GUID per record for both header and index entry.
    Auto-generates one if not provided.

    Tolerates both CBR-style info keys (red, black) and XQF-style
    (red_player, black_player).
    """
    if guid_str is None:
        guid_str = _generate_guid_str()
    guid_bin = _guid_str_to_bin(guid_str)

    header = bytearray(CBR_HEADER_SIZE)
    header[0:16] = CBR_MAGIC
    # CBR-header GUID block: 4-byte prefix (00 00 00 02) + 16-byte binary GUID
    header[16:20] = b"\x00\x00\x00\x02"
    header[20:36] = guid_bin

    # Two structured int16 fields observed stable across all original records.
    # Purpose unknown (possibly game_type / record_subtype), but writing the
    # observed constants makes CCBridge happier than leaving zeros.
    struct.pack_into("<H", header, 58, 0x0107)
    struct.pack_into("<H", header, 64, 0x0103)

    info = book.info or {}
    title = info.get("title", "") or ""
    event = info.get("event", "") or ""
    red = info.get("red") or info.get("red_player") or ""
    black = info.get("black") or info.get("black_player") or ""

    header[180 : 180 + 128] = _enc_str_field(title, 128)
    header[692 : 692 + 64] = _enc_str_field(event, 64)
    header[1076 : 1076 + 64] = _enc_str_field(red, 64)
    header[1300 : 1300 + 64] = _enc_str_field(black, 64)

    header[2076] = _RESULT_STR_TO_INT.get(info.get("result", "*"), 0)

    side_val = book.init_board.move_side()
    move_side = 1 if side_val == 1 else 2
    struct.pack_into("<H", header, 2116, move_side)

    header[2120 : 2120 + 90] = _encode_board(book.init_board)

    buf = BytesIO()
    buf.write(bytes(header))

    init_annote = getattr(book, "annote", "") or ""
    if init_annote:
        ann_bytes = init_annote.encode(CBR_ENCODING, errors="ignore")
        # Gate is a category flag, NOT the length. Observed values in
        # CCBridge3 corpus: 0=no annote, 1=empty annote, 4=plain text,
        # 5=BBCode-formatted (e.g. '[color=red][big]...'). cchess only
        # checks gate != 0, but CCBridge gets confused by other values
        # (game won't load). 4 is the safe plain-text default.
        gate = 5 if ("[" in init_annote and "]" in init_annote) else 4
        buf.write(struct.pack("<i", gate))
        buf.write(struct.pack("<i", len(ann_bytes)))
        buf.write(ann_bytes)
    else:
        buf.write(b"\x00\x00\x00\x00")

    if book.first_move is not None:
        roots = list(book.first_move.variations_all)
        _write_cbr_siblings(buf, roots)

    return buf.getvalue()


# ---------- public: write CBL -----------------------------------------------

def _write_meta_slot(buf: bytearray, offset: int, text: str) -> None:
    """Write a UTF-16-LE string into a 64-byte slot in the CBL metadata area."""
    if not text:
        return
    encoded = text.encode(CBR_ENCODING, errors="ignore")[: CBL_META_SLOT_SIZE - 2]
    buf[offset : offset + len(encoded)] = encoded


def write_cbl_bytes(
    lib_name: str,
    books,
    capacity: int | None = None,
    creator: str = "",
    email: str = "",
    created_at: str = "",
    modified_at: str = "",
) -> bytes:
    """Bundle a list of Books into a CBL container.

    `capacity` overrides the auto-chosen index size (one of 128/256/512/...).
    Useful for matching an original file's layout when round-tripping.

    `creator` / `email` / `created_at` / `modified_at` populate the
    library-level metadata fields shown in CCBridge's properties panel.
    `created_at` and `modified_at` are free-form strings; CCBridge shows
    them as written, e.g. '2026-05-28 14:30:00'. Default empty string fills
    the corresponding slot with zeros (CCBridge displays an empty field).
    """
    # Generate one GUID per book upfront; reuse for both the CBR header
    # (binary form at +20) and the index entry (UTF-16-LE string at +0x14).
    # CCBridge cross-validates the two — mismatches mark the record invalid.
    guids = [_generate_guid_str() for _ in books]
    cbr_records = [write_cbr_bytes(b, guid_str=g) for b, g in zip(books, guids)]

    if capacity is None:
        capacity = _round_up_capacity(len(books))
    if capacity < len(books):
        raise ValueError(
            f"capacity {capacity} too small for {len(books)} games"
        )

    # ----- 576-byte CBL header
    header = bytearray(CBL_HEADER_SIZE)
    header[0:16] = CBL_MAGIC
    struct.pack_into("<i", header, 60, capacity)
    name_bytes = lib_name.encode(CBR_ENCODING, errors="ignore")[:510]
    header[64 : 64 + len(name_bytes)] = name_bytes

    # ----- Index area (capacity slots; first len(books) populated)
    index_area = bytearray(capacity * CBL_INDEX_ENTRY_SIZE)
    for i, (book, cbr) in enumerate(zip(books, cbr_records)):
        base = i * CBL_INDEX_ENTRY_SIZE
        data_size = len(cbr)
        slot_count = (data_size + CBL_SLOT_SIZE - 1) // CBL_SLOT_SIZE

        struct.pack_into("<i", index_area, base + 0x00, 7)
        struct.pack_into("<i", index_area, base + 0x04, i)
        struct.pack_into("<i", index_area, base + 0x08, slot_count)
        struct.pack_into("<i", index_area, base + 0x0C, data_size)
        # +0x10 reserved (0)

        guid_bytes = guids[i].encode(CBR_ENCODING)[:76]
        index_area[base + 0x14 : base + 0x14 + len(guid_bytes)] = guid_bytes
        # +0x60 reserved (0)
        title_bytes = ((book.info or {}).get("title", "") or "").encode(
            CBR_ENCODING, errors="ignore"
        )[:172]  # leaves room for null terminator within the ~176-byte slot
        index_area[base + 0x64 : base + 0x64 + len(title_bytes)] = title_bytes

    # ----- Data area: each CBR padded out to its slot_count * 4096
    data_area = BytesIO()
    for cbr in cbr_records:
        slot_count = (len(cbr) + CBL_SLOT_SIZE - 1) // CBL_SLOT_SIZE
        data_area.write(cbr)
        data_area.write(b"\x00" * (slot_count * CBL_SLOT_SIZE - len(cbr)))

    # ----- Metadata area (576..66624): library properties + zero pad
    metadata = bytearray(CBL_INDEX_BASE - CBL_HEADER_SIZE)  # 66048 bytes
    # All slot offsets are relative to file start; convert to relative to
    # the start of the metadata area.
    _write_meta_slot(metadata, CBL_META_CREATOR_OFFSET - CBL_HEADER_SIZE, creator)
    _write_meta_slot(metadata, CBL_META_EMAIL_OFFSET - CBL_HEADER_SIZE, email)
    _write_meta_slot(metadata, CBL_META_CREATED_OFFSET - CBL_HEADER_SIZE, created_at)
    _write_meta_slot(metadata, CBL_META_MODIFIED_OFFSET - CBL_HEADER_SIZE, modified_at)

    # ----- Assemble: header + metadata + index + data
    return (
        bytes(header)
        + bytes(metadata)
        + bytes(index_area)
        + data_area.getvalue()
    )
