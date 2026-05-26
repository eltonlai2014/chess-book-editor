"""End-to-end annote-edit verification.

Simulates the editor flow:
  1. Load XQF via backend
  2. Mutate an annote (Traditional Chinese with surrogate-prone chars)
  3. Save via backend
  4. Re-load via backend
  5. Confirm the edited annote round-trips byte-identical

Catches: encoding bugs in PatchedXQFWriter, JSON serialisation, Big5 recovery
short-circuiting valid TC strings, etc.
"""
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.xqf_service import load_xqf, save_xqf  # noqa: E402

SRC_ROOT = Path(r"D:\Elton\TestArea\chess-book")

# A varied test annote: traditional CJK + punctuation + ASCII + newline.
# 國 here uses a less common form; 麤 is a rare-ish CJK char; 𠀋 is in
# CJK Extension B (surrogate pair in UTF-16) to stress codec paths.
TEST_ANNOTE = (
    "繁體中文測試：紅方走「砲二平五」中砲開局，黑方馬八進七屏風馬應對。\n"
    "稀字測試 麤 龘 𠀋 ：）\n"
    "Mixed: red plays C2=5, black N8+7, score=+0.3"
)


def main():
    # PowerShell's cp950 chokes on rare CJK / Ext-B chars when we print them.
    # Redirect stdout to a UTF-8 file so test output is readable in any console.
    import io
    log = io.StringIO()
    real_stdout = sys.stdout
    sys.stdout = log
    try:
        rc = _run()
    finally:
        sys.stdout = real_stdout
    Path("tools/annote_edit_result.txt").write_text(log.getvalue(), encoding="utf-8")
    print("wrote tools/annote_edit_result.txt")
    return rc


def _run():
    src = SRC_ROOT / "中砲對單提馬.XQF"
    if not src.exists():
        print(f"missing source: {src}")
        return 1
    tmp_dir = SRC_ROOT / "__annote_test__"
    tmp_dir.mkdir(exist_ok=True)
    tmp = tmp_dir / "edit.XQF"
    try:
        shutil.copy(src, tmp)

        # 1. load
        data = load_xqf(tmp)
        # 2. edit: set annote on root[0] (h2e2 / 砲二平五)
        node = data["roots"][0]
        original_annote = node["annote"]
        node["annote"] = TEST_ANNOTE
        print(f"original annote on h2e2: {original_annote!r}")
        print(f"setting annote      : {TEST_ANNOTE!r}")

        # 3. save
        save_xqf(tmp, data)

        # 4. reload
        data2 = load_xqf(tmp)
        roundtripped = data2["roots"][0]["annote"]
        print(f"after roundtrip     : {roundtripped!r}")

        # 5. compare
        if roundtripped == TEST_ANNOTE:
            print("\nOK — annote survived edit + save + reload byte-identical.")
            return 0
        print("\nFAIL — annote diverged.")
        # show first diff
        for i, (a, b) in enumerate(zip(TEST_ANNOTE, roundtripped)):
            if a != b:
                print(f"  first diff at char {i}: {a!r} vs {b!r}")
                break
        return 1
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
