"""中局練習抽題管線（practice_service）契約測。

兩段：
  1. build_puzzle 濾除/抽取邏輯 — 用合成 JSON，**不需語料/引擎**（CI-safe，恆跑）。
  2. 真語料抽題抽樣 — 抽象棋杀着大全一檔進臨時 practice.db，斷言題數與欄位。
     缺語料則 SKIP（不讓 CI fail）。

不測引擎仲裁（需 Pikafish；端到端已手動驗證）——這裡只鎖抽題正確性。

Run:
    .\.venv\Scripts\python.exe tests\test_practice.py
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from backend.practice_service import (  # noqa: E402
    _difficulty,
    _mate_difficulty,
    _parse_title,
    _verdict,
    build_puzzle,
    connect,
    extract_cbl,
    _STD_BOARD,
)

_SAMPLE_CBL = Path(r"D:\Elton\CCBridge3\CBL\棋研探秘\象棋杀着大全\象棋杀着大全.cbl")


def _ok(msg):
    print(f"  ✓ {msg}")


def _node(iccs, notation="x", side="red", annote="", children=None):
    return {"iccs": iccs, "notation": notation, "side": side,
            "annote": annote, "children": children or []}


def _data(init_fen, roots, title="010 三、单炮类 第01局", init_annote=""):
    return {"info": {"title": title}, "init_fen": init_fen,
            "init_annote": init_annote, "roots": roots}


def test_build_puzzle_filters():
    """濾除：no-fen / no-answer / too-short / opening-start；有效題抽出正確。"""
    # 一條 4-ply 主線（沿第一個 child）。
    line = _node("c8d8", "兵七平六", "red", "好棋", [
        _node("e7d7", "將５平４", "black", "", [
            _node("d8e8", "兵六平五", "red", "", [
                _node("d7e7", "將４平５", "black", "")])])])
    fen = "9/2P6/4k4/9/9/9/9/9/9/5K3 w"

    p, reason = build_puzzle(_data(fen, [line]), "x.cbl", 0, "書", "")
    assert p is not None and reason == "ok", reason
    assert json.loads(p["answer_iccs"]) == ["c8d8", "e7d7", "d8e8", "d7e7"]
    assert json.loads(p["answer_zh"])[0] == "兵七平六"
    assert p["side"] == "w" and p["ply_count"] == 4
    assert p["category"] == "三、单炮类"
    assert p["commentary"].startswith("好棋") or "好棋" in p["commentary"]
    _ok("有效題：答案主線/側/類目/講解 抽取正確")

    # no-fen
    p, reason = build_puzzle(_data("", [line]), "x.cbl", 0, "書", "")
    assert p is None and reason == "no-fen", reason
    # no-answer（roots 空）
    p, reason = build_puzzle(_data(fen, []), "x.cbl", 0, "書", "")
    assert p is None and reason == "no-answer", reason
    # too-short（1 ply < min_ply 2）
    p, reason = build_puzzle(_data(fen, [_node("c8d8")]), "x.cbl", 0, "書", "")
    assert p is None and reason.startswith("too-short"), reason
    # opening-start（標準起手盤面）
    p, reason = build_puzzle(_data(f"{_STD_BOARD} w", [line]), "x.cbl", 0, "書", "")
    assert p is None and reason == "opening-start", reason
    _ok("濾除：no-fen / no-answer / too-short / opening-start 全中")


def test_helpers():
    """難度帶、類目解析、仲裁判定的純函式。"""
    assert _difficulty(1) == 1 and _difficulty(2) == 1   # 1 解題著
    assert _difficulty(3) == 2 and _difficulty(8) == 4
    assert _difficulty(9) == 5 and _difficulty(99) == 5
    assert _mate_difficulty(2) == 2 and _mate_difficulty(9) == 5
    assert _parse_title("301  十八、车马炮类  第30局")[0] == "十八、车马炮类"
    assert _parse_title("608 二十八、对局实例 第02局")[0] == ""  # 非「类」結尾→無類目
    # 仲裁：首著相符→match；不符但解題方見殺→alt；否則 doubt。
    assert _verdict("c8d8", None, 5, "w", "c8d8") == "match"
    assert _verdict("a1a2", None, 3, "w", "c8d8") == "alt"     # 紅見殺、走別著
    assert _verdict("a1a2", None, 3, "b", "c8d8") == "doubt"   # mate>0 是紅勝、但解題方是黑
    assert _verdict("a1a2", 50, None, "w", "c8d8") == "doubt"  # 不夠勝勢
    assert _verdict("a1a2", 400, None, "w", "c8d8") == "alt"   # 紅大優
    _ok("難度帶 / 類目解析 / 仲裁判定 純函式正確")


def test_extract_real_book():
    """真語料抽樣：抽象棋杀着大全進臨時 practice.db，斷言題數與欄位。"""
    if not _SAMPLE_CBL.is_file():
        print(f"  · SKIP（缺語料）：{_SAMPLE_CBL.name}")
        return
    with tempfile.TemporaryDirectory() as td:
        con = connect(Path(td) / "practice.db")
        try:
            st = extract_cbl(con, _SAMPLE_CBL, _SAMPLE_CBL.parent)
            assert st["added"] > 500, f"抽出題數異常少：{st['added']}"
            rows = con.execute(
                "SELECT init_fen, side, answer_iccs, difficulty FROM puzzles"
            ).fetchall()
            assert all(r["init_fen"] and r["side"] in ("w", "b") for r in rows)
            assert all(1 <= r["difficulty"] <= 5 for r in rows)
            assert all(json.loads(r["answer_iccs"]) for r in rows)
            _ok(f"{_SAMPLE_CBL.name}：抽出 {st['added']} 題、欄位健全（濾 {st['skipped']}）")
        finally:
            con.close()


def main():
    print("[1] build_puzzle 濾除/抽取")
    test_build_puzzle_filters()
    print("[2] 純函式（難度/類目/仲裁）")
    test_helpers()
    print("[3] 真語料抽題抽樣")
    test_extract_real_book()
    print("\n全部通過 ✓")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print(f"\n✗ 測試失敗：{e}")
        sys.exit(1)
