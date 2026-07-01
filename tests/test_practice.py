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
    _collection,
    _difficulty,
    _mate_difficulty,
    _parse_title,
    _resolve_srcs,
    _seed_puzzles_if_empty,
    _theme_of,
    _verdict,
    build_puzzle,
    connect,
    export_seed,
    extract_cbl,
    pick_puzzle,
    practice_info,
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


_MANUAL = "象棋丛书/《棋社出版》/《象棋阶段强化训练手册》"


def test_theme_and_collection():
    """主題分類優先序 + 訓練手冊章節收合（純函式，無 db）。"""
    # 主題：先命中先贏；殘局要贏過殺法（残局练心算含「杀」）。
    assert _theme_of("象棋中局精华") == "中局"
    assert _theme_of("中国象棋实用残局增订本-八、看杀局练心算") == "殘局"
    assert _theme_of("象棋杀着大全") == "殺法"
    assert _theme_of("象棋战术精粹") == "戰術"
    assert _theme_of("与主題無關的名字") == "其他"
    # 收合：手冊章節 → 一條「阶段强化训练手册·<章節>」，主題取章節資料夾
    assert _collection(f"{_MANUAL}/02-基本杀法/19卧槽马杀法.cbl", "19卧槽马杀法") \
        == ("殺法", "阶段强化训练手册·基本杀法")
    assert _collection(f"{_MANUAL}/03-中局战术/05谋子战术.cbl", "05谋子战术") \
        == ("中局", "阶段强化训练手册·中局战术")
    # 非手冊：collection = 書名 stem、主題照全路徑判
    assert _collection("棋研探秘/象棋杀着大全/象棋杀着大全.cbl", "象棋杀着大全") \
        == ("殺法", "象棋杀着大全")
    _ok("主題優先序 / 手冊收合 / 一般書 collection 正確")


def _ins(con, src, bt, gi=0, diff=1):
    con.execute(
        "INSERT INTO puzzles(source_rel,game_index,init_fen,side,answer_iccs,"
        "answer_zh,book_title,ply_count,difficulty) VALUES(?,?,?,?,?,?,?,?,?)",
        (src, gi, "9/9/9/9/9/9/9/9/9/4K4 w", "w", '["e0e1"]', '["帥五進一"]', bt, 1, diff))


def test_info_themes_and_filter():
    """practice_info 主題分群 + 收合計數；_resolve_srcs 反解 (主題,書)；pick 依主題篩。"""
    with tempfile.TemporaryDirectory() as td:
        con = connect(Path(td) / "p.db")
        try:
            # 殺法大書(2) + 中局書(1) + 殘局書(1) + 手冊殺法2章各1 + 手冊中局1章1
            _ins(con, "棋研探秘/象棋杀着大全/象棋杀着大全.cbl", "象棋杀着大全", 0)
            _ins(con, "棋研探秘/象棋杀着大全/象棋杀着大全.cbl", "象棋杀着大全", 1)
            _ins(con, "象棋丛书/象棋中局精华/象棋中局精华.cbl", "象棋中局精华", 0)
            _ins(con, "象棋丛书/实用残局/看杀局练心算.cbl", "看杀局练心算", 0)
            _ins(con, f"{_MANUAL}/02-基本杀法/19卧槽马杀法.cbl", "19卧槽马杀法", 0)
            _ins(con, f"{_MANUAL}/02-基本杀法/17铁门栓杀法.cbl", "17铁门栓杀法", 0)
            _ins(con, f"{_MANUAL}/03-中局战术/05谋子战术.cbl", "05谋子战术", 0)
            con.commit()

            info = practice_info(con)
            assert info["total"] == 7, info["total"]
            themes = {t["theme"]: t for t in info["themes"]}
            assert set(themes) == {"殺法", "中局", "殘局"}, list(themes)
            # 殺法：大書(2) + 收合手冊·基本杀法(2 章合 1 條) = 2 條、共 4 題
            sha = {b["book"]: b["count"] for b in themes["殺法"]["books"]}
            assert sha == {"象棋杀着大全": 2, "阶段强化训练手册·基本杀法": 2}, sha
            # 中局：中局精华(1) + 手冊·中局战术(1)
            zhong = {b["book"]: b["count"] for b in themes["中局"]["books"]}
            assert zhong == {"象棋中局精华": 1, "阶段强化训练手册·中局战术": 1}, zhong
            # 主題順序照 THEME_ORDER（殺法先於中局先於殘局）
            assert [t["theme"] for t in info["themes"]] == ["殺法", "中局", "殘局"]
            # 扁平 books 相容（含 count）
            assert info["books"] and "count" in info["books"][0]
            _ok("info themes：分群/收合/計數/順序正確")

            # 反解：手冊收合書 → 2 個原始檔
            srcs = _resolve_srcs(con, "殺法", "阶段强化训练手册·基本杀法")
            assert len(srcs) == 2 and all("基本杀法" in s for s in srcs), srcs
            # 只給主題 → 該主題所有檔
            assert len(_resolve_srcs(con, "殺法", None)) == 3      # 大書1 + 2章
            assert _resolve_srcs(con, None, None) is None          # 不篩
            _ok("_resolve_srcs：收合書反解多檔 / 主題全取 / 空回 None")

            # pick 依主題：殘局只會抽到殘局那題
            pz = pick_puzzle(con, theme="殘局", exclude_doubt=False)
            assert pz and "实用残局" in pz["source_rel"], pz and pz.get("source_rel")
            # 無相符主題 → None（非報錯）
            assert pick_puzzle(con, theme="布局", exclude_doubt=False) is None
            _ok("pick_puzzle：主題篩中殘 / 無相符回 None")
        finally:
            con.close()


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


def _insert_puzzle(con, gi, fen="9/9/9/9/9/9/9/9/9/4K4 w"):
    con.execute(
        "INSERT INTO puzzles(source_rel,game_index,init_fen,side,answer_iccs,"
        "answer_zh,ply_count,difficulty) VALUES(?,?,?,?,?,?,?,?)",
        ("x.cbl", gi, fen, "w", '["e0e1"]', '["帥五進一"]', 1, 1))


def test_seed_roundtrip():
    """題庫 seed：export 只帶 puzzles（不含作答/進度）；空 db 自動灌入、且冪等。"""
    with tempfile.TemporaryDirectory() as td:
        src = connect(Path(td) / "src.db")
        seed = Path(td) / "practice_seed.db"
        try:
            _insert_puzzle(src, 0)
            _insert_puzzle(src, 1)
            # 作答/進度：export 不應帶進 seed（各機獨立）。
            src.execute("INSERT INTO attempts(puzzle_id,ts,result) VALUES(1,'t','pass')")
            src.execute("INSERT INTO progress(puzzle_id,state) VALUES(1,'learning')")
            src.commit()

            n = export_seed(src, seed)
            assert n == 2, n
            chk = connect(seed)
            try:
                assert chk.execute("SELECT COUNT(*) FROM puzzles").fetchone()[0] == 2
                assert chk.execute("SELECT COUNT(*) FROM attempts").fetchone()[0] == 0
                assert chk.execute("SELECT COUNT(*) FROM progress").fetchone()[0] == 0
            finally:
                chk.close()
            _ok("export-seed：只帶 2 題、不含 attempts/progress")

            # 全新空 db → 自動從 seed 灌入；再灌一次冪等（已有題）。
            fresh = connect(Path(td) / "fresh.db")
            try:
                assert _seed_puzzles_if_empty(fresh, seed) == 2
                assert fresh.execute("SELECT COUNT(*) FROM puzzles").fetchone()[0] == 2
                assert _seed_puzzles_if_empty(fresh, seed) == 0   # 冪等：已有題不重灌
                # id 保留（跨機一致）。
                ids = [r[0] for r in fresh.execute("SELECT id FROM puzzles ORDER BY id")]
                assert ids == [1, 2], ids
            finally:
                fresh.close()
            _ok("空 practice.db：自動灌 seed、冪等、id 保留")

            # seed 不存在 → 不灌、回 0（其他主機沒 seed 也不炸）。
            empty = connect(Path(td) / "empty.db")
            try:
                assert _seed_puzzles_if_empty(empty, Path(td) / "nope.db") == 0
                assert empty.execute("SELECT COUNT(*) FROM puzzles").fetchone()[0] == 0
            finally:
                empty.close()
            _ok("缺 seed：不灌、不報錯")
        finally:
            src.close()


def main():
    print("[1] build_puzzle 濾除/抽取")
    test_build_puzzle_filters()
    print("[2] 純函式（難度/類目/仲裁）")
    test_helpers()
    print("[3] 主題分類 + 手冊收合（純函式）")
    test_theme_and_collection()
    print("[4] info 主題分群 + 反解 + 主題篩")
    test_info_themes_and_filter()
    print("[5] 題庫 seed round-trip")
    test_seed_roundtrip()
    print("[6] 真語料抽題抽樣")
    test_extract_real_book()
    print("\n全部通過 ✓")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print(f"\n✗ 測試失敗：{e}")
        sys.exit(1)
