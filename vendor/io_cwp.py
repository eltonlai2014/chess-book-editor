"""CCBridge .cwp reader.

CCBridge is a Taiwan-developed Xiangqi program. Despite the binary-looking
extension, its native `.cwp` files are **plain-text Big5-encoded** with
CRLF line delimiters.

File layout:
    Line  0       'CCWP' magic
    Lines 1-20    Fixed-position metadata (see HEADER_FIELDS below)
    Line  21      Initial board state ('0' = standard start, else a
                  ~184-char layout string for endgame puzzles)
    Line  22      Move count as decimal string
    Lines 23..    One move per line, plus optional inline comment

Move line layout (header = 9 fixed-width chars; optional comment follows):
    cols 0-4   annote prefix (e.g. '', '!', '?', '!?'), right-padded with spaces
    cols 5-8   4 decimal digits 'SSDD'
                 SS = src index, DD = dst index, index = row*9 + col
                 row 0 = black back rank, row 9 = red back rank
                 col 0 = our left = red's left (= ICCS file 'a')
    cols 9..   optional Big5 comment text

Verified on 1267 files under D:/以民金儒/ (classical books + tournament
records + online games, 1992-2019).
"""

import codecs
from dataclasses import dataclass, field
from typing import List, Tuple

MAGIC = "CCWP"


# CCBridge stored a handful of glyphs in the Big5 user-defined (造字/EUDC,
# 0xFA40–0xFEFE) area that only render with its bundled font — standard Big5
# (and cp950/HKSCS) can't decode them, so they came through as '�'+stray
# ASCII (e.g. 車 → '�'+'z'). Even CCBridge itself now shows them broken
# once that font is gone. Reverse-engineered across the whole 以民金儒 corpus
# (1267 files): the ONLY such code is FB 7A = 車 (17 hits in 11 files, always
# in titles like "中炮直橫車…"). Map it back on decode.
_CWP_EUDC = {b"\xfb\x7a": "車"}


def _cwp_eudc_error_handler(err: UnicodeDecodeError):
    """Big5 decode error handler: recover known CCBridge EUDC codes.

    Boundary-safe: the codec only calls this when the bad lead byte sits at a
    real character boundary, so a legit Big5 char ending in 0xFB followed by
    ASCII 'z' (0x7A) never triggers it (that char is consumed whole first).
    Unknown bad bytes fall back to the standard 'replace' behaviour.
    """
    two = err.object[err.start:err.start + 2]
    if two in _CWP_EUDC:
        return _CWP_EUDC[two], err.start + 2
    return "�", err.end


codecs.register_error("cwp_eudc", _cwp_eudc_error_handler)


@dataclass
class CWPMove:
    src: int           # 0..89, = row*9 + col
    dst: int
    annote: str = ""   # '', '!', '?', '!?', '?!', ...
    comment: str = ""

    @property
    def src_rc(self) -> Tuple[int, int]:
        return divmod(self.src, 9)

    @property
    def dst_rc(self) -> Tuple[int, int]:
        return divmod(self.dst, 9)

    @property
    def iccs(self) -> str:
        sr, sc = self.src_rc
        dr, dc = self.dst_rc
        return f"{chr(ord('a')+sc)}{9-sr}{chr(ord('a')+dc)}{9-dr}"


def decode_layout(init_position: str):
    """Decode a CWP init_position string into a 10x9 grid of raw 2-char codes.

    Framing (verified empirically against 適情雅趣 #002 二龍繞室):
        2-char header  +  10 rows × 9 cells × 2 chars  +  2-char trailer
        cell at (cwp_row, col) = s[2 + cwp_row*18 + col*2 : ... + 2]

    Returns:
        None if the layout is the standard start (init_position == '0'),
        otherwise a list[list[str]] of length 10 × 9 holding the raw codes.

    NOTE: the cell occupancy (which squares hold a piece) is reliable, but
    the 2-char code → piece-type mapping is NOT yet fully reverse-engineered.
    The same code can appear for different piece types at different cells
    (e.g. '20' is both 黑士 and 紅傌 in puzzle #002). Until that's resolved,
    callers should treat the codes as opaque identifiers.
    """
    if init_position == "0":
        return None
    s = init_position
    if len(s) < 184:
        return None
    # length-274 layouts are length-184 + 90 full-width spaces (no extra info)
    body = s[2:2 + 180]
    grid = [["00"] * 9 for _ in range(10)]
    for r in range(10):
        for c in range(9):
            p = r * 18 + c * 2
            grid[r][c] = body[p:p + 2]
    return grid


@dataclass
class CWPGame:
    event: str = ""          # line 1   賽事 / 書名
    title: str = ""          # line 2   局名 / 章節
    year: str = ""           # line 3
    month: str = ""          # line 4
    day: str = ""            # line 5
    red_player: str = ""     # line 7
    red_extra: str = ""      # line 8   (隊伍 / 段位)
    black_player: str = ""   # line 9
    black_extra: str = ""    # line 10
    source: str = ""         # line 15  出處 / 註
    result: str = ""         # line 16  紅先勝 / 黑勝 / 和 ...
    headers: List[str] = field(default_factory=list)   # raw lines 1-20
    init_position: str = "0"
    declared_move_count: int = 0
    moves: List[CWPMove] = field(default_factory=list)
    trailing: List[str] = field(default_factory=list)  # lines after moves we didn't parse


def parse_cwp_bytes(raw: bytes, encoding: str = "big5") -> CWPGame:
    # errors="cwp_eudc": recover CCBridge 造字區 codes (e.g. FB7A=車) instead of
    # dropping them to '�'; unknown bad bytes still degrade to '�' like "replace".
    text = raw.decode(encoding, errors="cwp_eudc")
    lines = text.split("\r\n")

    if not lines or lines[0] != MAGIC:
        head = lines[0] if lines else ""
        raise ValueError(f"not a CWP file (missing CCWP magic, got {head!r})")
    if len(lines) < 23:
        raise ValueError(f"CWP truncated: only {len(lines)} lines")

    headers = lines[1:21]
    init_position = lines[21]
    try:
        declared = int(lines[22].strip())
    except ValueError:
        declared = 0

    def at(i: int) -> str:
        return headers[i].strip() if i < len(headers) else ""

    game = CWPGame(
        event=at(0),
        title=at(1),
        year=at(2),
        month=at(3),
        day=at(4),
        red_player=at(6),
        red_extra=at(7),
        black_player=at(8),
        black_extra=at(9),
        source=at(14),
        result=at(15),
        headers=headers,
        init_position=init_position,
        declared_move_count=declared,
    )

    for ln in lines[23:]:
        if not ln.strip():
            continue
        if len(ln) < 9 or not ln[5:9].isdigit():
            game.trailing.append(ln)
            continue
        annote = ln[:5].strip()
        src = int(ln[5:7])
        dst = int(ln[7:9])
        if src > 89 or dst > 89:
            game.trailing.append(ln)
            continue
        comment = ln[9:].rstrip()
        game.moves.append(CWPMove(src=src, dst=dst, annote=annote, comment=comment))

    return game


def parse_cwp_file(path: str, encoding: str = "big5") -> CWPGame:
    with open(path, "rb") as f:
        return parse_cwp_bytes(f.read(), encoding)


def index_to_iccs(idx: int) -> str:
    """Convert a CWP index (row*9+col, row 0 = black back) to ICCS notation."""
    row, col = divmod(idx, 9)
    return f"{chr(ord('a')+col)}{9-row}"
