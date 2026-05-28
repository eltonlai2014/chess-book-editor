"""Smoke test for cchess .cbl / .cbr decoding across a CCBridge install.

Walks a CBL root directory, attempts to decode every .cbl and .cbr file,
and reports:

  * success/fail counts
  * for .cbl: cchess's reported games_count vs raw "CCBridge Record\\0"
    marker count in the file (mismatch = format variant cchess doesn't
    handle)
  * header fields at offsets 16 and 60 (suspected book_count candidates)
  * file size vs expected data-start offset

Run:
  PYTHONIOENCODING=utf-8 .\\.venv\\Scripts\\python.exe tests\\test_cbl_smoke.py
"""

from __future__ import annotations

import os
import struct
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

CBL_ROOT = Path(r"D:\Elton\CCBridge3\CBL")

CBL_MAGIC = b"CCBridgeLibrary\x00"
CBR_MAGIC = b"CCBridge Record\x00"

# Mirrors cchess._CBL_INDEX_OFFSETS
INDEX_OFFSETS = (
    (128, 101952),
    (256, 137280),
    (384, 151080),
    (512, 207936),
)
DEFAULT_OFFSET = 349248


def expected_data_offset(book_count: int) -> int:
    for cap, off in INDEX_OFFSETS:
        if book_count <= cap:
            return off
    return DEFAULT_OFFSET


def count_raw_records(data: bytes, start: int = 0) -> int:
    n, i = 0, start
    while True:
        i = data.find(CBR_MAGIC, i)
        if i < 0:
            return n
        n += 1
        i += len(CBR_MAGIC)


def probe_cbl(path: Path) -> dict:
    """Header-only probe: fast (no full cchess parse).

    Computes raw record marker count and where cchess's offset table
    would place data_start, so we can predict whether cchess will find
    the records without actually running the (slow, per-move-validated)
    parse.
    """
    info: dict = {"path": path, "kind": "cbl", "error": None}
    try:
        with open(path, "rb") as f:
            data = f.read()
        info["size"] = len(data)
        info["magic_ok"] = data[:16] == CBL_MAGIC
        info["off16_i32"] = struct.unpack_from("<i", data, 16)[0]
        info["off60_i32"] = struct.unpack_from("<i", data, 60)[0]
        info["raw_records"] = count_raw_records(data)
        info["data_start_expected"] = expected_data_offset(info["off60_i32"])
        info["records_after_data_start"] = count_raw_records(
            data, info["data_start_expected"]
        )
        # 'visible_to_cchess' = records cchess would step over (4096-aligned
        # from data_start). A record marker at offset O is visible iff
        # (O - data_start) % 4096 == 0.
        ds = info["data_start_expected"]
        visible = 0
        i = 0
        while True:
            i = data.find(CBR_MAGIC, i)
            if i < 0:
                break
            if i >= ds and ((i - ds) % 4096) == 0:
                visible += 1
            i += len(CBR_MAGIC)
        info["visible_to_cchess"] = visible
    except Exception as e:  # pylint: disable=broad-except
        info["error"] = f"open/probe: {type(e).__name__}: {e}"
    return info




def probe_cbr(path: Path) -> dict:
    info: dict = {"path": path, "kind": "cbr", "error": None}
    try:
        with open(path, "rb") as f:
            data = f.read()
        info["size"] = len(data)
        info["magic_ok"] = data[:16] == CBR_MAGIC
        try:
            book = Book.read_from(str(path))
            info["title"] = book.info.get("title", "") if book else ""
            info["parsed"] = book is not None
        except Exception as e:  # pylint: disable=broad-except
            info["error"] = f"{type(e).__name__}: {e}"
    except Exception as e:  # pylint: disable=broad-except
        info["error"] = f"open/parse: {type(e).__name__}: {e}"
    return info


def main() -> int:
    if not CBL_ROOT.exists():
        print(f"CBL_ROOT not found: {CBL_ROOT}", file=sys.stderr)
        return 1

    cbl_files: list[Path] = []
    cbr_files: list[Path] = []
    for root, _dirs, files in os.walk(CBL_ROOT):
        for name in files:
            low = name.lower()
            if low.endswith(".cbl"):
                cbl_files.append(Path(root) / name)
            elif low.endswith(".cbr"):
                cbr_files.append(Path(root) / name)

    print(f"found .cbl: {len(cbl_files)}   .cbr: {len(cbr_files)}", flush=True)
    print(f"scanning under: {CBL_ROOT}", flush=True)
    print("=" * 80, flush=True)

    cbl_results = []
    for i, p in enumerate(cbl_files):
        cbl_results.append(probe_cbl(p))
        if (i + 1) % 300 == 0 or i == len(cbl_files) - 1:
            print(f"  ...cbl probed {i+1}/{len(cbl_files)}", flush=True)
    cbr_results = [probe_cbr(p) for p in cbr_files]

    # --- CBL summary ---
    cbl_ok = [r for r in cbl_results if not r["error"]]
    cbl_err = [r for r in cbl_results if r["error"]]
    # "lossy" = raw markers exist but cchess wouldn't see them all because
    # they're not aligned to its 4096-byte step from expected data_start.
    cbl_lossy = [
        r for r in cbl_ok
        if r.get("raw_records", 0) != r.get("visible_to_cchess", 0)
    ]
    print(f"CBL  total={len(cbl_results)}  ok={len(cbl_ok)}  probe-error={len(cbl_err)}")
    print(f"     cchess-lossy (raw != visible): {len(cbl_lossy)}", flush=True)

    off60_dist = Counter(r["off60_i32"] for r in cbl_ok)
    off16_dist = Counter(r["off16_i32"] for r in cbl_ok)
    print(f"  off60_i32 distribution: {dict(off60_dist.most_common(10))}")
    print(f"  off16_i32 distribution: {dict(off16_dist.most_common(10))}")

    # cross-tab: does off60 correlate with the file's actual data_start?
    print()
    print("--- off60 -> actual first-marker offset (per off60 bucket) ---")
    bucket: dict[int, list[tuple[int, Path]]] = {}
    for r in cbl_ok:
        if r["raw_records"] == 0:
            continue
        with open(r["path"], "rb") as f:
            data = f.read()
        first = data.find(CBR_MAGIC)
        bucket.setdefault(r["off60_i32"], []).append((first, r["path"]))
    for off60 in sorted(bucket):
        entries = bucket[off60]
        firsts = [e[0] for e in entries]
        c = Counter(firsts)
        exp = expected_data_offset(off60)
        marker = "OK" if all(f == exp for f in firsts) else "MISMATCH"
        print(f"  off60={off60:<6d} files={len(firsts):<5d} expected_ds={exp:<8d} "
              f"first-marker offsets={dict(c.most_common(5))}  [{marker}]")

    # --- verify the linear formula matches all 1570 files ---
    print()
    print("--- linear formula check: 66624 + off60*276 vs actual first marker ---")
    from vendor.cbl_index_fix import get_cbl_data_offset  # noqa: E402
    total_with_records = sum(len(v) for v in bucket.values())
    matches = 0
    mismatches: list[tuple[int, int, int, Path]] = []
    for off60, entries in bucket.items():
        predicted = get_cbl_data_offset(off60)
        for first, path in entries:
            if first == predicted:
                matches += 1
            else:
                mismatches.append((off60, predicted, first, path))
    print(f"  files w/records: {total_with_records}")
    print(f"  formula matches: {matches}")
    print(f"  formula misses : {len(mismatches)}")
    for off60, pred, actual, path in mismatches[:10]:
        print(f"    off60={off60} predicted={pred} actual={actual} delta={actual-pred:+d}  "
              f"{path.relative_to(CBL_ROOT)}")

    # --- predicted recovery by the fix ---
    print()
    print("--- impact of fix ---")
    broken_now = 0
    fixed_by_patch = 0
    still_broken = 0
    for off60, entries in bucket.items():
        table_ds = expected_data_offset(off60)
        linear_ds = get_cbl_data_offset(off60)
        for first, path in entries:
            # cchess fails to find ANY record when table_ds > first
            if table_ds > first:
                broken_now += 1
                if linear_ds <= first:
                    fixed_by_patch += 1
                else:
                    still_broken += 1
    print(f"  files where unfixed cchess misses all records (table_ds > first_marker): {broken_now}")
    print(f"  files the linear-formula fix recovers                                  : {fixed_by_patch}")
    print(f"  files still broken after fix                                           : {still_broken}")

    print()
    print("--- CBL probe errors ---")
    for r in cbl_err[:20]:
        print(f"  {r['path'].relative_to(CBL_ROOT)}: {r['error']}")

    # --- verify fix on one known-broken file via subprocess (full parse) ---
    print()
    print("--- before/after demo on a known-broken file ---")
    demo_path = (
        CBL_ROOT / "古谱棋书" / "《马炮争雄》-顺序全录版.CBL"
    )
    if demo_path.exists():
        # Find this file's stats
        demo_info = next((r for r in cbl_ok if r["path"] == demo_path), None)
        if demo_info:
            print(f"  file       : {demo_path.name}")
            print(f"  off60      : {demo_info['off60_i32']}  raw_records: {demo_info['raw_records']}")
            print(f"  table_ds   : {expected_data_offset(demo_info['off60_i32'])}")
            print(f"  linear_ds  : {get_cbl_data_offset(demo_info['off60_i32'])}")
        for label, reader_import in [
            ("UNFIXED", "from cchess import Book; read = Book.read_from_lib"),
            ("FIXED  ", "import sys; sys.path.insert(0, '.'); "
                        "from vendor.cchess_cbl import read_cbl as read"),
        ]:
            code = (
                f"{reader_import};"
                f"lib = read(r'{demo_path}');"
                "print(len(lib['games']))"
            )
            import subprocess
            env = os.environ.copy()
            env["PYTHONIOENCODING"] = "utf-8"
            r = subprocess.run(
                [str(Path(".venv/Scripts/python.exe").resolve()), "-c", code],
                capture_output=True, timeout=60, env=env, text=True,
            )
            print(f"  {label}: games parsed = {r.stdout.strip() or r.stderr.strip()[:120]}")

    # --- CBR summary ---
    print()
    print("=" * 80)
    cbr_ok = [r for r in cbr_results if not r["error"] and r.get("parsed")]
    cbr_err = [r for r in cbr_results if r["error"]]
    cbr_none = [r for r in cbr_results if not r["error"] and not r.get("parsed")]
    print(f"CBR  total={len(cbr_results)}  ok={len(cbr_ok)}  "
          f"returned-None={len(cbr_none)}  error={len(cbr_err)}")
    for r in cbr_err[:10]:
        print(f"  err  {r['path'].relative_to(CBL_ROOT)}: {r['error']}")
    for r in cbr_none[:10]:
        print(f"  none {r['path'].relative_to(CBL_ROOT)}")

    print()
    print("=" * 80)
    print("DONE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
