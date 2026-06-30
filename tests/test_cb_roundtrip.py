"""CBL / CBR 往返測 — 驗證編輯器的「讀→序列化→重建→寫回」對 CB 格式保真。

涵蓋三件事：
  1. CBR 單盤：read → book_to_json → json_to_book → write_cbr_bytes → 重讀，
     每盤 root-to-leaf 的「步法＋註解」路徑全等。
  2. CBL 覆寫整庫（save_cbl_game）：只改第 0 盤的註解，重讀後——
       - 第 0 盤確實改到、其餘盤路徑全等（內容保真）；
       - 未編輯盤的 GUID 不變、庫層 metadata（creator/email/created_at/capacity）
         不變（身分＋屬性保真）；
       - 產生 .bak 備份。

複用 tests/test_roundtrip.py 的路徑列舉，與 backend/xqf_service 的序列化。

Run:
    .\.venv\Scripts\python.exe tests\test_cb_roundtrip.py
"""
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from backend.cb_service import (  # noqa: E402
    list_cbl_games,
    load_cb,
    read_cbl_guids,
    read_cbl_lib_meta,
    save_cbl_game,
    save_cbr,
)
from backend.xqf_service import book_to_json, json_to_book  # noqa: E402
from tests.test_roundtrip import collect_paths  # noqa: E402
from vendor.cchess_cbl import read_cbl, read_cbr  # noqa: E402
from vendor.io_cb_writer import write_cbr_bytes  # noqa: E402

# 任一含多盤的 CBL；若搬移請改這裡。
SRC_CBL = Path(r"D:\Elton\CCBridge3\CBL\中貴棋譜.cbl")

# 盤數回歸（_cbl_record_starts 漏數修正，2026-06-30）。舊版把 CBR_MAGIC 當迴圈
# 守衛，一撞到 multi-slot 記錄的續接 slot 就 break → 後面全漏（全庫 1571 檔有 315
# 檔受害）。新版掃到檔尾、跳過續接 slot，盤數須與 cchess read_cbl 一致。
# 路徑較深、可能搬移：缺檔則 SKIP 個別案例（CI-safe），不讓整測 fail。
_RECORD_COUNT_CASES = [
    # (檔路徑, 期望盤數, 是否與 read_cbl 交叉比對, 說明)
    (SRC_CBL, 824, False, "全 1-slot：向後相容（修正前後都應 824）"),
    (Path(r"D:\Elton\CCBridge3\CBL\棋研探秘\象棋杀着大全\象棋杀着大全.cbl"),
     624, False, "含 2-slot：舊 parser 只讀到 1"),
    (Path(r"D:\Elton\CCBridge3\CBL\象棋丛书\黄少龙著\象棋实战中局谱\象棋实战中局谱--黄少龙.CBL"),
     61, True, "index(62)與實體(61)不同步的髒檔：以 magic 邊界為準，須同 read_cbl"),
]


def _ok(msg):
    print(f"  ✓ {msg}")


def test_cbl_record_count_multislot():
    """多-slot／髒檔的盤數須對，且每個起點都是可解析的真記錄。"""
    ran = 0
    for path, expect, xcheck, note in _RECORD_COUNT_CASES:
        if not path.is_file():
            print(f"  · SKIP（缺檔）：{path.name} — {note}")
            continue
        ran += 1
        games = list_cbl_games(path)  # 只讀 header、不解析走子樹（快）
        assert len(games) == expect, \
            f"{path.name} 盤數 {len(games)} != 期望 {expect}（{note}）"
        # 髒檔才付 read_cbl 全解析的代價，交叉確認與權威 reader 一致。
        if xcheck:
            n_read = len(read_cbl(str(path))["games"])
            assert n_read == expect, f"{path.name} read_cbl 讀到 {n_read} != {expect}"
        # 頭/中/尾抽樣：每個起點都是真記錄、可被 load_cb 解析（單盤解析，快）。
        for idx in sorted({0, len(games) // 2, len(games) - 1}):
            data = load_cb(path, idx)
            assert data.get("roots") is not None, f"{path.name} 第 {idx} 盤載入無 roots"
        tag = " ＝read_cbl" if xcheck else ""
        _ok(f"{path.name}：{len(games)} 盤{tag}（{note}）")
    assert ran > 0, "所有回歸檔都缺：請確認 D:\\Elton\\CCBridge3\\CBL 仍在"


def test_cbr_single_roundtrip(book):
    """單盤 Book -> json -> book -> CBR -> 重讀，路徑全等。"""
    data = book_to_json(book)
    rebuilt = json_to_book(data)
    payload = write_cbr_bytes(rebuilt)
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "one.cbr"
        p.write_bytes(payload)
        reread = read_cbr(str(p))
    assert reread is not None, "CBR 重讀失敗"
    a, b = collect_paths(book), collect_paths(reread)
    assert a == b, f"CBR 路徑不符：原 {len(a)} 條 vs 回 {len(b)} 條"
    _ok(f"CBR 單盤往返：{len(a)} 條路徑全等")


def test_cbl_fidelity_overwrite():
    """save_cbl_game 改第 0 盤，驗證內容＋身分＋屬性保真。"""
    orig = read_cbl(str(SRC_CBL))
    games = orig["games"]
    assert len(games) >= 2, f"需要多盤 CBL 測保真，{SRC_CBL.name} 只有 {len(games)} 盤"

    orig_paths = [collect_paths(g) for g in games]
    orig_meta = read_cbl_lib_meta(SRC_CBL)
    orig_guids = read_cbl_guids(SRC_CBL, len(games))

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / SRC_CBL.name
        shutil.copy2(SRC_CBL, tmp)

        # 模擬編輯：在第 0 盤首步註解後加標記。
        data = load_cb(tmp, 0)
        marker = "【往返測】"
        if data["roots"]:
            data["roots"][0]["annote"] = (data["roots"][0].get("annote") or "") + marker

        save_cbl_game(tmp, 0, data)

        assert Path(str(tmp) + ".bak").exists(), "未產生 .bak 備份"
        _ok("已產生 .bak 備份")

        re = read_cbl(str(tmp))
        re_games = re["games"]
        assert len(re_games) == len(games), \
            f"盤數變了：{len(games)} -> {len(re_games)}"

        # 內容保真：未編輯的盤路徑全等。
        for i in range(1, len(games)):
            assert collect_paths(re_games[i]) == orig_paths[i], \
                f"第 {i} 盤（未編輯）路徑被改動"
        _ok(f"未編輯的 {len(games) - 1} 盤路徑全等")

        # 第 0 盤：標記確實寫入（透過 load_cb 取回的 JSON 比對）。
        edited = load_cb(tmp, 0)
        assert edited["roots"] and edited["roots"][0].get("annote", "").endswith(marker), \
            "第 0 盤的編輯未寫入"
        _ok("第 0 盤編輯已寫入並讀回")

        # 身分保真：GUID 不變。
        re_guids = read_cbl_guids(tmp, len(re_games))
        assert re_guids == orig_guids, "GUID 在覆寫後改變了（身分未保真）"
        _ok(f"全部 {len(re_guids)} 盤 GUID 不變")

        # 屬性保真：庫層 metadata 不變（modified_at 會被更新，不比對）。
        re_meta = read_cbl_lib_meta(tmp)
        for k in ("creator", "email", "created_at", "capacity"):
            assert re_meta.get(k) == orig_meta.get(k), \
                f"庫層 metadata「{k}」改變：{orig_meta.get(k)!r} -> {re_meta.get(k)!r}"
        _ok("庫層 metadata（creator/email/created_at/capacity）不變")


def main():
    assert SRC_CBL.is_file(), f"找不到測試用 CBL：{SRC_CBL}"
    lib = read_cbl(str(SRC_CBL))
    games = lib["games"]
    print(f"來源：{SRC_CBL.name}（{len(games)} 盤）")

    print("[1] CBR 單盤往返")
    test_cbr_single_roundtrip(games[0])

    print("[2] CBL 覆寫整庫保真")
    test_cbl_fidelity_overwrite()

    print("[3] CBL 盤數（multi-slot／髒檔回歸）")
    test_cbl_record_count_multislot()

    print("\n全部通過 ✓")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print(f"\n✗ 測試失敗：{e}")
        sys.exit(1)
