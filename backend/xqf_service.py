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
from pathlib import Path

from cchess import Book
from cchess.board import ChessBoard
from cchess.common import append_move_to_book, get_fench_color, iccs2pos, pos2iccs, SIDE_BLACK
from cchess.io_xqf import read_from_xqf

from vendor import PatchedXQFWriter


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


def _maybe_recover_big5(s):
    """Best-effort Big5 recovery. Returns recovered string or original on failure.

    Defence layers against false positives (recovery turning correct GB18030
    text into mojibake, which can happen because the byte ranges overlap):

      1. **Positive signal** — `s` contains a simplified-only character
         (in GB18030 but not Big5) AND no PUA → keep `s`. (PUA gate matters
         because Big5 mojibake can coincidentally include simplified-only
         CJK chars; pairing with PUA distinguishes real GB from mojibake.)
      2. **Negative signal** — recovery introduces Bopomofo / CJK Compat
         Ideographs (rare in real notes, common mojibake landing zones) →
         keep `s`.

    Ambiguous cases (no signals either way) still default to the recovered
    form — backward-compatible with the master's primarily-Big5 corpus.
    For known-GB18030 generators, prefer the per-file `author` marker check
    in `load_xqf` to override this default unambiguously.
    """
    if not s:
        return s
    if _has_simplified_only_char(s) and not _has_pua(s):
        return s
    try:
        recovered = s.encode("gb18030").decode("big5")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s
    if _has_negative_signal(recovered) and not _has_negative_signal(s):
        return s
    return recovered


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
    if side == "black":
        notation = notation.replace("砲", "包")
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
    if side == "black":
        notation = notation.replace("砲", "包")
    return {"notation": notation, "side": side}


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
    """Write JSON tree back to `path` as XQF v0x0A, taking .bak first.

    Backup policy (open question #3 = yes):
      - If `path` exists, copy it to `path + '.bak'` BEFORE writing.
      - Overwrites any previous .bak — we keep ONE generation, not history.
        Master can copy the bak out manually if a deeper history is wanted.

    Author field is stamped with 'cb_editor' (short — XQF author field is
    only 15 bytes) so `load_xqf` knows the file is guaranteed-GB18030 and
    skips the Big5 recovery heuristic on next read.
    """
    book = json_to_book(data)
    if path.exists():
        bak = path.with_suffix(path.suffix + ".bak")
        bak.write_bytes(path.read_bytes())
    writer = PatchedXQFWriter(book)
    writer.set_author("cb_editor")
    writer.set_result(_RESULT_STR_TO_INT.get(book.info.get("result", "*"), 0))
    writer.save(str(path))
