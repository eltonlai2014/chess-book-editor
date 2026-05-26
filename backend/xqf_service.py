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
from cchess.common import append_move_to_book, get_fench_color, iccs2pos, SIDE_BLACK
from cchess.io_xqf import read_from_xqf

from vendor import PatchedXQFWriter


# ---------- Big5 recovery ---------------------------------------------------
# cchess.io_xqf hardcodes GB18030 for ALL annote/header decoding (see line 89
# `read_str(coding="GB18030")`). Master's source XQF library is Big5-encoded
# (traditional Chinese authoring tools), so cchess produces mojibake on load.
#
# Trick: bytes that GB18030 decoded into a mojibake string can be re-encoded
# back to the ORIGINAL bytes via .encode("gb18030"), then re-decoded as Big5
# to recover the true characters. If the string was already correct (e.g. a
# file that genuinely used GB18030), the Big5 decode step will fail on
# unmappable bytes and we keep the original. This is self-detecting.

def _maybe_recover_big5(s):
    """Best-effort Big5 recovery. Returns recovered string or original on failure."""
    if not s:
        return s
    try:
        return s.encode("gb18030").decode("big5")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


def recover_book_strings(book):
    """Mutate Book in place: apply Big5 recovery to all annotes + info string fields."""
    for k, v in list(book.info.items()):
        if isinstance(v, str):
            book.info[k] = _maybe_recover_big5(v)
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
    book = Book(init_board)
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


# ---------- File I/O --------------------------------------------------------

def load_xqf(path: Path):
    book = read_from_xqf(str(path), Book)
    if book is None:
        raise ValueError(f"failed to read XQF: {path}")
    recover_book_strings(book)
    return book_to_json(book)


def save_xqf(path: Path, data: dict):
    """Write JSON tree back to `path` as XQF v0x0A, taking .bak first.

    Backup policy (open question #3 = yes):
      - If `path` exists, copy it to `path + '.bak'` BEFORE writing.
      - Overwrites any previous .bak — we keep ONE generation, not history.
        Master can copy the bak out manually if a deeper history is wanted.
    """
    book = json_to_book(data)
    if path.exists():
        bak = path.with_suffix(path.suffix + ".bak")
        bak.write_bytes(path.read_bytes())
    PatchedXQFWriter(book).save(str(path))
