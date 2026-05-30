"""XQF <-> JSON conversion + load/save plumbing.

Bridges the cchess `Book` object model and the editor's JSON wire format.

JSON shape:
    {
      "info":       {...book.info pairs...},
      "init_fen":   "...",            # init_board.to_fen()
      "roots":      [node, ...]       # = book.first_move.variations_all
    }

Each `node`:
    {"iccs": "h2e2", "annote": "...", "children": [node, ...]}

`children[0]` is the main continuation (i.e. would become `next_move`);
`children[1:]` are siblings (variations at that ply). This mirrors how
`_read_steps` walks XQF: recurse into has_next, then into has_var.
"""
import re
from pathlib import Path

from cchess import Book, FULL_INIT_FEN
from cchess.board import ChessBoard
from cchess.common import append_move_to_book, get_fench_color, iccs2pos, pos2iccs, SIDE_BLACK
from cchess.io_xqf import read_from_xqf

from vendor import PatchedXQFWriter


# XQF header fields the writer __init__ KeyErrors on if absent. Use this set
# whenever building a Book from scratch (create_xqf) to avoid surprise.
_XQF_HEADER_KEYS = (
    "title", "event", "date", "location",
    "red_player", "black_player", "commentator",
)

_FILENAME_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WIN_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def sanitise_filename(name: str, max_len: int = 80) -> str:
    """Same rules as tools/cbl_to_xqf.py — duplicated to avoid backend ↔ tools cross-import."""
    cleaned = _FILENAME_BAD.sub("_", name).strip(" .")
    if not cleaned:
        return "untitled"
    if cleaned.upper() in _WIN_RESERVED:
        cleaned = f"_{cleaned}"
    if len(cleaned) > max_len:
        cleaned = cleaned[:max_len].rstrip(" .")
    return cleaned or "untitled"


# XQF header result byte (offset 0x40, see cchess.io_xqf.XQFWriter.set_result).
# cchess's writer __init__ defaults to 0 (unknown); save_xqf must call
# set_result explicitly to round-trip the result field.
_RESULT_STR_TO_INT = {"*": 0, "1-0": 1, "0-1": 2, "1/2-1/2": 3}


# ---------- Big5 recovery ---------------------------------------------------
# cchess.io_xqf hardcodes GB18030 for ALL annote/header decoding (see line 89
# `read_str(coding="GB18030")`). Master's source XQF library is Big5-encoded
# (traditional Chinese authoring tools), so cchess produces mojibake on load.
#
# Trick: bytes that GB18030 decoded into a mojibake string can be re-encoded
# back to the ORIGINAL bytes via .encode("gb18030"), then re-decoded as Big5
# to recover the true characters. If the string was already correct (e.g. a
# file that genuinely used GB18030 like tools/cbl_to_xqf.py output), the Big5
# decode step is *partially* self-detecting:
#
#   * Sometimes the GB18030 bytes don't form valid Big5 → decode errors →
#     try/except keeps the original. ✓
#   * Often the bytes DO form valid Big5 (the byte ranges overlap heavily) →
#     decode succeeds with mojibake. Telltale: the result contains code
#     points that essentially never appear in real Chinese chess text but
#     are common landing zones for GB-as-Big5 misinterpretation, notably
#     Bopomofo (ㄅㄆㄇㄈ...) and CJK Compatibility Ideographs.
#
# So we run the recovery, then sanity-check: if it introduced any of those
# negative-signal characters, treat the recovery as a false positive and
# return the original.

_NEG_RANGES = (
    ("ㄅ", "ㄯ"),  # Bopomofo
    ("ㆠ", "ㆿ"),  # Bopomofo Extended
    ("豈", "﫿"),  # CJK Compatibility Ideographs
    ("⺀", "⻿"),  # CJK Radicals Supplement
)


def _has_negative_signal(s: str) -> bool:
    for c in s:
        for lo, hi in _NEG_RANGES:
            if lo <= c <= hi:
                return True
    return False


# Cache the simplified-only check — round-tripping every char through two
# codecs adds up across thousands of annotations.
_simplified_only_cache: dict = {}


def _is_simplified_only(c: str) -> bool:
    """True iff `c` is encodable in GB18030 but NOT in Big5.

    Such characters (e.g. 势, 实, 国, 这, 们, 个, 红, 兴) exist only in
    simplified-Chinese codepages — if a string contains any, it was
    decoded from GB18030 correctly and is NOT mojibake.
    """
    cached = _simplified_only_cache.get(c)
    if cached is not None:
        return cached
    try:
        c.encode("big5")
        result = False
    except UnicodeEncodeError:
        try:
            c.encode("gb18030")
            result = True
        except UnicodeEncodeError:
            result = False
    _simplified_only_cache[c] = result
    return result


def _has_simplified_only_char(s: str) -> bool:
    return any(_is_simplified_only(c) for c in s if "一" <= c <= "鿿")


def _has_pua(s: str) -> bool:
    """True if `s` contains Private Use Area characters (U+E000–U+F8FF).

    Real Chinese chess annotations don't use PUA. When GB18030 fails to map
    incoming bytes (typical for Big5 byte streams misread as GB18030), the
    fallback often lands in PUA — so PUA presence is a strong mojibake signal.
    """
    return any("" <= c <= "" for c in s)


# Top-216 chars covering ~100% of usage in clean chess-commentary annotations.
# Same set chess-book-ai uses in site_builder/build_data.py — acts as a "looks
# like real chess commentary" vocabulary score, used to disambiguate when both
# GB18030 and Big5 produce valid-but-different Chinese.
_CHESS_VOCAB = set(
    "法的方馬路走紅抗勢有優中後兌對較黑利手車無充分用性壓著子六加厚攻軟件局衡招要下棄可動此面"
    "最計畫化出主翼多棋之勝奪大易機求線謀底佳準備右得但先行好錯很容現力卒相取以再爭定簡位不交"
    "換符合人類思維會直接貫徹長距離進變與比頭兵矛盾頑強砲包只能和推薦退解反應具觀死急吃陣型弱"
    "點虧左一保留均搶支援呆滯回益等伺而帥其他都為集擊殘必雙制占過河略佔逼實質上並明顯收送被視"
    "臥槽傌穩空門巧消拆飛認威脅抽趨緩足宜輕健跳避免七開放未戰術成功平妙叫將確立雖置欠"
)


def _vocab_score(s: str) -> int:
    """Count chars matching the in-domain chess-commentary vocabulary."""
    return sum(1 for c in s if c in _CHESS_VOCAB)


def _maybe_recover_big5(s):
    """Best-effort Big5 recovery. Returns recovered string or original.

    The hard problem: byte sequences can be valid in BOTH GB18030 and Big5,
    producing two different but plausible-looking Chinese strings. The
    GB18030 reading is what cchess already gave us; we attempt the Big5
    reading and pick whichever scores higher against in-domain chess
    vocabulary (`_CHESS_VOCAB`). Ties keep the original GB18030 — same
    default as chess-book-ai's `_recover_annote`, and the only safe call
    for files like the master's AI-annotated XQF where annotes are
    genuinely Traditional Chinese in GB18030 (e.g., 正著, 紅方殘局優勢).

    Hard gates:
      - PUA in the original → always definite mojibake, prefer recovered
        (no real chess text uses Private Use Area chars).
      - Bopomofo / CJK Compat in the recovered version (and not in original)
        → recovery worsened things, stick with original.
    """
    if not s:
        return s
    pua = _has_pua(s)
    try:
        recovered = s.encode("gb18030").decode("big5")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s
    if pua and not _has_pua(recovered):
        return recovered
    if _has_negative_signal(recovered) and not _has_negative_signal(s):
        return s
    s_score = _vocab_score(s)
    r_score = _vocab_score(recovered)
    if r_score > s_score:
        return recovered
    return s


# Files our own tools generate are guaranteed-GB18030; the loader skips Big5
# recovery entirely when it sees one of these author markers. Keep this list
# in sync with PatchedXQFWriter callers in tools/cbl_to_xqf.py and save_xqf().
# NB: XQF's author field is capped at 15 GB18030 bytes — pick short names
# that fit (e.g. "chess-book-editor" would be silently truncated to
# "chess-book-edit", breaking the marker check).
GB18030_AUTHOR_MARKERS = frozenset({
    "cbl_to_xqf",
    "cb_editor",
})

# XQF header layout (from cchess.io_xqf.XQFWriter.HEADER_FIELDS):
# at offset 0x01E0, 1 length byte + up to 15 string bytes (GB18030).
_XQF_AUTHOR_OFFSET = 0x01E0
_XQF_AUTHOR_MAX = 15


def _read_xqf_author(path) -> str:
    """Peek the author field directly from the XQF header.

    cchess's reader doesn't populate `book.info['author']` (it only reads a
    subset of the header), so we can't use the parsed Book for this check.
    """
    try:
        with open(path, "rb") as f:
            f.seek(_XQF_AUTHOR_OFFSET)
            raw = f.read(1 + _XQF_AUTHOR_MAX)
    except OSError:
        return ""
    if len(raw) < 1:
        return ""
    n = min(raw[0], _XQF_AUTHOR_MAX)
    if n == 0:
        return ""
    return raw[1 : 1 + n].decode("gb18030", errors="ignore").strip("\x00").strip()


def recover_book_strings(book):
    """Mutate Book in place: apply Big5 recovery to info + book-level + per-move annotes."""
    for k, v in list(book.info.items()):
        if isinstance(v, str):
            book.info[k] = _maybe_recover_big5(v)
    if getattr(book, "annote", None):
        book.annote = _maybe_recover_big5(book.annote)
    if book.first_move is None:
        return book
    stack = list(book.first_move.variations_all)
    seen = set()
    while stack:
        m = stack.pop()
        if id(m) in seen:
            continue
        seen.add(id(m))
        if m.annote:
            m.annote = _maybe_recover_big5(m.annote)
        if m.next_move is not None:
            stack.extend(m.next_move.variations_all)
    return book


# ---------- Book -> JSON ----------------------------------------------------

# cchess's traditional notation uses one glyph set for both sides
# (馬/士/象/車/將, and 砲 for cannons). Master's RED convention maps the piece
# names to red forms — 馬→傌, 士→仕, 象→相, 車→俥, 將→帥 — matching the board
# glyphs; only the cannon stays 砲 (not 炮). BLACK only swaps 砲→包.
_RED_GLYPHS = str.maketrans({"馬": "傌", "士": "仕", "象": "相", "車": "俥", "將": "帥"})


def _apply_side_glyphs(notation: str, is_red: bool) -> str:
    if is_red:
        return notation.translate(_RED_GLYPHS)
    return notation.replace("砲", "包")


def _node_to_json(move):
    """Recurse: serialise one Move and its subtree.

    Children of `move` live in `move.next_move.variations_all` (see writer
    docstring bug #2). `move.next_move` is the first entry of that list.

    `notation` is the traditional Chinese form (e.g. "砲二平五"); it depends
    on `move.board_before` being populated, which is true for moves coming
    from cchess's reader.
    """
    children = []
    if move.next_move is not None:
        for child in move.next_move.variations_all:
            children.append(_node_to_json(child))
    try:
        notation = move.to_text(fmt="chinese", traditional=True)
    except Exception:
        notation = move.to_iccs()
    # cchess maps both red and black cannon to 砲 in traditional mode (see
    # common.py:91-92). Master's convention: red = 砲, black = 包. Apply on
    # black moves only.
    side = "black" if move.move_side == SIDE_BLACK else "red"
    notation = _apply_side_glyphs(notation, side == "red")
    return {
        "iccs": move.to_iccs(),
        "notation": notation,
        "side": side,
        "annote": move.annote or "",
        "ply": move.step_index + 1,  # 1-based for display
        "children": children,
    }


def book_to_json(book):
    roots = []
    if book.first_move is not None:
        for root_move in book.first_move.variations_all:
            roots.append(_node_to_json(root_move))
    info = {k: v for k, v in book.info.items()}
    return {
        "info": info,
        "init_fen": book.init_board.to_fen(),
        "init_annote": (getattr(book, "annote", "") or ""),
        "roots": roots,
    }


# ---------- JSON -> Book ----------------------------------------------------

def _apply_node(book, node, parent_move, board):
    """Replay one JSON node on `board`, attach Move under `parent_move`, recurse.

    Mirrors `_read_steps` in cchess.io_xqf: for each child, snapshot the board
    so siblings replay from the same pre-state.
    """
    iccs = node["iccs"]
    annote = node.get("annote") or ""
    # Mirror `_read_steps`: derive move side from the piece on from-square, not
    # from strict turn alternation. Endgame puzzles rely on this — they may
    # encode side-to-move differently from standard chess flow.
    move_from, move_to = iccs2pos(iccs)
    fench = board.get_fench(move_from)
    if fench == "." or fench is None:
        raise ValueError(f"no piece at {iccs[:2]} for move {iccs!r}")
    board.set_move_side(get_fench_color(fench))
    if not board.is_valid_move(move_from, move_to):
        raise ValueError(f"illegal move {iccs!r} from fen {board.to_fen()!r}")
    curr_move = board.move(move_from, move_to)
    curr_move.annote = annote
    append_move_to_book(book, curr_move, parent_move)

    children = node.get("children") or []
    if not children:
        return
    # First child: main continuation - shares the board we just moved on.
    # Subsequent children: variations - each needs its own pre-state snapshot
    # (the state BEFORE curr_move was played).
    # But by the time we get here, board already has curr_move applied, so its
    # state IS the pre-state for curr_move's children. Snapshot it for siblings.
    main_child = children[0]
    pre_state_for_children = board.copy()
    _apply_node(book, main_child, curr_move, board)
    for sibling in children[1:]:
        _apply_node(book, sibling, curr_move, pre_state_for_children.copy())


def json_to_book(data):
    init_fen = data.get("init_fen") or None
    init_board = ChessBoard(init_fen) if init_fen else ChessBoard()
    init_annote = data.get("init_annote") or ""
    book = Book(init_board, init_annote) if init_annote else Book(init_board)
    info = data.get("info") or {}
    for k, v in info.items():
        # branchs is recomputed below; everything else passes through
        if k == "branchs":
            continue
        book.info[k] = v

    roots = data.get("roots") or []
    if not roots:
        return book

    # Root alternatives all start from init_board. Each needs its own snapshot.
    branchs = 0
    for root_node in roots:
        board_for_root = init_board.copy()
        _apply_node(book, root_node, None, board_for_root)
        branchs += 1
    # branchs in cchess counts every variation (root + nested has_var).
    # For now, leave it as len(roots) at root level; writer doesn't depend on it.
    book.info["branchs"] = max(branchs, 1)
    return book


# ---------- Move validation (UI: click-to-add-move) -------------------------
# Editor's board clicks send {fen, iccs} here; we use cchess's authoritative
# legality check and notation generator (same code path that load_xqf goes
# through), so what the UI shows mid-edit matches what'll be persisted on save.

def compute_move_info(fen: str, iccs: str) -> dict:
    """Validate `iccs` against `fen` and return its Chinese notation + side.

    Mirrors `_apply_node`: derives move-side from the piece on the from-square
    so endgame puzzles (non-standard turn parity) work too. Same 砲→包 rule
    for black-side cannons as `_node_to_json`.
    """
    if not fen or not iccs or len(iccs) < 4:
        raise ValueError("fen and iccs are required")
    board = ChessBoard(fen)
    move_from, move_to = iccs2pos(iccs)
    fench = board.get_fench(move_from)
    if fench == "." or fench is None:
        raise ValueError(f"起點無棋子：{iccs[:2]}")
    board.set_move_side(get_fench_color(fench))
    if not board.is_valid_move(move_from, move_to):
        raise ValueError(f"非法走法：{iccs}")
    move = board.move(move_from, move_to)
    try:
        notation = move.to_text(fmt="chinese", traditional=True)
    except Exception:
        notation = move.to_iccs()
    side = "black" if move.move_side == SIDE_BLACK else "red"
    notation = _apply_side_glyphs(notation, side == "red")
    return {"notation": notation, "side": side}


def pv_to_chinese(fen: str, uci_moves, limit: int = 64) -> list:
    """Replay a UCI principal variation on `fen`, return each move's
    traditional-Chinese notation. Pikafish move coords are identical to our
    iccs (files a-i, ranks 0-9), so each token feeds straight into the same
    replay path as `compute_move_info`. Stops at the first illegal/unparseable
    move (engine PVs are legal; guard anyway). Used only for live display."""
    out = []
    if not fen or not uci_moves:
        return out
    try:
        board = ChessBoard(fen)
    except Exception:
        return out
    for uci in uci_moves[:limit]:
        if not uci or len(uci) < 4:
            break
        try:
            move_from, move_to = iccs2pos(uci[:4])
            fench = board.get_fench(move_from)
            if fench == "." or fench is None:
                break
            board.set_move_side(get_fench_color(fench))
            if not board.is_valid_move(move_from, move_to):
                break
            move = board.move(move_from, move_to)
            try:
                notation = move.to_text(fmt="chinese", traditional=True)
            except Exception:
                notation = move.to_iccs()
            notation = _apply_side_glyphs(notation, move.move_side != SIDE_BLACK)
            out.append(notation)
        except Exception:
            break
    return out


def compute_legal_targets(fen: str, from_sq: str) -> list:
    """Return a list of legal destination square iccs (e.g. ['e2','e3',...])
    for the piece on `from_sq` under `fen`. Empty list if no piece or no
    legal moves. Used to render destination markers in the editor."""
    if not fen or not from_sq or len(from_sq) < 2:
        return []
    board = ChessBoard(fen)
    move_from = iccs2pos(from_sq + "a0")[0]  # iccs2pos needs a 4-char str; we only use the from-pos
    fench = board.get_fench(move_from)
    if fench == "." or fench is None:
        return []
    board.set_move_side(get_fench_color(fench))
    targets = []
    for _, to_pos in board.create_piece_moves(move_from):
        targets.append(pos2iccs(to_pos, to_pos)[:2])
    return targets


# ---------- File I/O --------------------------------------------------------

def load_xqf(path: Path):
    book = read_from_xqf(str(path), Book)
    if book is None:
        raise ValueError(f"failed to read XQF: {path}")
    # Author marker is peeked from the raw header — cchess's reader doesn't
    # populate book.info['author']. If it's one of our generators, the file
    # is guaranteed GB18030 and Big5 recovery is harmful (it produces
    # mojibake on legit simplified-Chinese annotations).
    author = _read_xqf_author(path)
    if author not in GB18030_AUTHOR_MARKERS:
        recover_book_strings(book)
    # Expose the marker to the frontend / debuggers.
    if author:
        book.info["author"] = author
    return book_to_json(book)


def save_xqf(path: Path, data: dict):
    """Write JSON tree back to `path` as XQF v0x0A.

    Author field is stamped with 'cb_editor' (short — XQF author field is
    only 15 bytes) so `load_xqf` knows the file is guaranteed-GB18030 and
    skips the Big5 recovery heuristic on next read.
    """
    book = json_to_book(data)
    writer = PatchedXQFWriter(book)
    writer.set_author("cb_editor")
    writer.set_result(_RESULT_STR_TO_INT.get(book.info.get("result", "*"), 0))
    writer.save(str(path))


def create_xqf(path: Path, title: str) -> None:
    """Write a fresh XQF at `path` with the standard initial position and
    the supplied title. No moves, no annote — caller (editor) edits from there.

    Header fields other than title default to empty strings; PatchedXQFWriter's
    parent __init__ KeyErrors if any of _XQF_HEADER_KEYS is missing, so we
    populate them all up-front.
    """
    # ChessBoard() with no FEN is an EMPTY board — use FULL_INIT_FEN to get
    # the standard initial position.
    book = Book(ChessBoard(FULL_INIT_FEN))
    for k in _XQF_HEADER_KEYS:
        book.info[k] = ""
    book.info["title"] = title
    book.info["result"] = "*"
    writer = PatchedXQFWriter(book)
    writer.set_author("cb_editor")
    writer.set_result(0)
    writer.save(str(path))
