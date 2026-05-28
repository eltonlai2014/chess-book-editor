"""Convert CWP (CCBridge plain-text) files to XQF using PatchedXQFWriter.

Skips:
  - Files with non-standard starting position (endgame puzzles like 適情雅趣)
  - Files under directories matching SKIP_DIRS

Strategy:
  1. Parse CWP via vendor.io_cwp
  2. Build a fresh ChessBoard from FULL_INIT_FEN
  3. Replay each CWP move (ICCS string) into a Book
  4. Set header fields from CWP metadata (event/title/players/date/result)
  5. Save via PatchedXQFWriter

Output preserves source folder structure under <OUT_ROOT>.
"""
from __future__ import annotations
import sys
import os
import glob
import traceback
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from cchess import Book, ChessBoard, FULL_INIT_FEN
from vendor.io_cwp import parse_cwp_file
from vendor import PatchedXQFWriter


SRC_ROOT = Path(r"D:\以民金儒")
OUT_ROOT = Path(r"D:\Elton\TestArea\chess-book\以民金儒-xqf")

SKIP_DIRS = ("26. 適情雅趣 360",)  # endgame puzzles, layout decoding pending


def build_book(cwp_game) -> Book:
    board = ChessBoard(FULL_INIT_FEN)
    book = Book(board, annote=cwp_game.source or "")
    parent_move = None
    for i, m in enumerate(cwp_game.moves):
        iccs = m.iccs
        chess_move = board.move_iccs(iccs, check=False)
        if chess_move is None:
            raise ValueError(f"move {i+1} {iccs} rejected by board (illegal?)")
        if m.annote or m.comment:
            chess_move.annote = (m.annote + (" " if m.annote and m.comment else "") + m.comment).strip()
        if parent_move is None:
            book.append_first_move(chess_move)
        else:
            book.append_next_move(chess_move)
        parent_move = chess_move
    return book


def populate_headers(writer: PatchedXQFWriter, g) -> None:
    if g.event:        writer.set_event(g.event)
    if g.title:        writer.set_title(g.title)
    if g.red_player:   writer.set_red_player(g.red_player)
    if g.black_player: writer.set_black_player(g.black_player)
    if g.result:
        # XQF result is a byte: 0=unknown, 1=red win, 2=black win, 3=draw
        r = g.result
        if "紅" in r and ("勝" in r or "胜" in r): writer.set_result(1)
        elif "黑" in r and ("勝" in r or "胜" in r): writer.set_result(2)
        elif "和" in r: writer.set_result(3)
    # Date: combine year/month/day if available
    parts = [p for p in (g.year, g.month, g.day) if p and p.strip()]
    if parts:
        writer.set_date("-".join(parts))


def convert_one(cwp_path: Path, xqf_path: Path) -> tuple[bool, str]:
    try:
        g = parse_cwp_file(str(cwp_path))
    except Exception as e:
        return False, f"parse error: {e}"
    if g.init_position != "0":
        return False, "non-standard init_position (skipped)"
    if not g.moves:
        return False, "no moves"
    try:
        book = build_book(g)
    except Exception as e:
        return False, f"build_book: {e}"
    try:
        writer = PatchedXQFWriter(book)
        populate_headers(writer, g)
        xqf_path.parent.mkdir(parents=True, exist_ok=True)
        writer.save(str(xqf_path))
    except Exception as e:
        return False, f"save: {e}"
    return True, "ok"


def is_skipped(cwp_path: Path) -> bool:
    rel = cwp_path.relative_to(SRC_ROOT)
    return any(part in SKIP_DIRS for part in rel.parts)


def main():
    cwp_files = sorted(SRC_ROOT.rglob("*.cwp"))
    print(f"found {len(cwp_files)} .cwp files under {SRC_ROOT}")

    skipped_dir = 0
    skipped_nonstd = 0
    ok = 0
    failed = []

    for i, src in enumerate(cwp_files, 1):
        if is_skipped(src):
            skipped_dir += 1
            continue
        rel = src.relative_to(SRC_ROOT)
        out = OUT_ROOT / rel.with_suffix(".xqf")
        success, msg = convert_one(src, out)
        if success:
            ok += 1
        else:
            if "non-standard" in msg:
                skipped_nonstd += 1
            else:
                failed.append((src, msg))
        if i % 100 == 0 or i == len(cwp_files):
            print(f"  [{i:>4}/{len(cwp_files)}] ok={ok} skipped_dir={skipped_dir} "
                  f"skipped_nonstd={skipped_nonstd} failed={len(failed)}")

    print(f"\n=== summary ===")
    print(f"  total cwp files:                {len(cwp_files)}")
    print(f"  skipped (in {SKIP_DIRS}): {skipped_dir}")
    print(f"  skipped (non-standard start):   {skipped_nonstd}")
    print(f"  converted ok:                   {ok}")
    print(f"  failed:                         {len(failed)}")
    if failed:
        print(f"\nfirst 10 failures:")
        for p, msg in failed[:10]:
            print(f"  {p.name}: {msg}")
    print(f"\noutput: {OUT_ROOT}")


if __name__ == "__main__":
    main()
