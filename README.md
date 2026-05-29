# chess-book-editor

Browser-based XQF (Chinese chess opening-book file) editor — open `.XQF` files,
edit moves / variations / annotations, save back as `.XQF`.

Sibling project of [chess-book-ai](../chess-book-ai/) (engine analysis +
static-site builder). This repo focuses on the **authoring** side. The XQF
library path is configurable from the UI (see *Choose your library* below).

## Status

MVP editor working end-to-end: browse library → open XQF → navigate moves /
variations → edit annotations (including the init / 譜首引言 annote) → save
(with `.bak` backup). Tree-editing operations (add/delete move, promote
variation, edit metadata) not built yet. See [docs/HANDOFF.md](docs/HANDOFF.md)
for full context.

Persistence + format work that is already verified:

- `vendor/io_xqf_patched.py` — patched `cchess.io_xqf.XQFWriter`. 46/46
  round-trip on the XQF library, samples in `samples/xqf/` verified in
  XQStudio. Preserves variations, init annote, and Traditional Chinese
  (GB18030).
- `vendor/cchess_cbl.py` + `vendor/cbl_index_fix.py` — CCBridge3 `.cbl`
  reader; transparently fixes a cchess offset bug that left 18/1570 of the
  master's CBL files unreadable.
- `vendor/io_cb_writer.py` — `.cbr` / `.cbl` writer, opens cleanly in
  CCBridge3 (binary-GUID linkage, init-annote gate flag, and library
  metadata slots all handled).
- Big5 mojibake recovery for legacy XQF files in [backend/xqf_service.py](backend/xqf_service.py).

## Layout

```
backend/      # Flask app — /api/xqf/{list,load,save,root,pick-root}, /preferences
frontend/     # board.js + editor.js + editor.css (single-page)
tools/        # CLI: cbl_to_xqf.py, xqf_to_cbl.py, cwp_to_xqf.py, emit_sample.py, dump_annotes.py
vendor/       # io_xqf_patched + cchess_cbl + io_cb_writer + io_cwp + cbl_index_fix
tests/        # round-trip, integration, Big5 recovery, CBL smoke, CWP reader
samples/      # xqf/ (XQStudio-verified) + cbl/ (CCBridge3-verified)
docs/         # HANDOFF.md (session-to-session context)
```

## Setup

### Prerequisites

- **Python 3.10+** (this venv was built on 3.10.10 — anything ≥ 3.10 should
  work; older versions won't because the code uses `match`-free PEP-604
  unions / `from __future__ import annotations` patterns expected by 3.10).
  Install via the [python.org Windows installer](https://www.python.org/downloads/windows/)
  — tick "Add python.exe to PATH" and keep the default "tcl/tk and IDLE"
  component (the native folder picker uses **tkinter**, which ships with
  the python.org installer but is omitted by some minimal builds).
- **Git** for Windows — `pip install` pulls cchess straight from GitHub.
- **Browser** — Chrome/Edge tested. Any modern evergreen will do.

Sanity-check on a fresh machine:

```powershell
python --version              # 3.10.x or newer
git --version                 # any recent
python -c "import tkinter; print(tkinter.TkVersion)"   # should print a number, not error
```

### Create venv + install deps

```powershell
# In the repo root
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install "git+https://github.com/walker8088/cchess.git@master"
.\.venv\Scripts\python.exe -m pip install flask
```

Direct dependencies are intentionally short — `cchess` and `flask`. There
is no `requirements.txt`; pin versions yourself if you need reproducible
builds.

### First-run check

```powershell
# Round-trip test against the bundled samples — no external corpora needed
.\.venv\Scripts\python.exe tests\test_roundtrip.py
```

You should see `46/46 perfect round-trip` (or similar — depends on what's
under `SRC_ROOT`; see *Test corpora paths* below).

### Test corpora paths (hard-coded)

Several tests reference real-world corpora the master keeps on `D:\`:

| Test | Path | Notes |
|---|---|---|
| `tests/test_roundtrip.py` | `D:\Elton\TestArea\chess-book\` (`SRC_ROOT`) | 46 XQF files |
| `tests/test_cbl_smoke.py` | `D:\Elton\CCBridge3\CBL\` | ~1570 CBLs |
| `tests/test_cb_xqf_integration.py` | `D:\Elton\CCBridge3\CBL\…` (3 specific files) | round-trip fixtures |
| `tests/test_big5_recovery.py` | `D:\Elton\TestArea\chess-book\` | mojibake corpus |

If those paths don't exist on the new machine, either:
1. Copy the corpora over, or
2. Edit the path constants at the top of each test file to point somewhere
   you have data, or
3. Skip those tests — `samples/xqf/` and `samples/cbl/` in this repo are
   enough for a smoke check.

## Run the editor

```powershell
# If PowerShell blocks Activate.ps1 the first time:
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
.\.venv\Scripts\Activate.ps1

# Start the Flask backend (serves the frontend too)
.\.venv\Scripts\python.exe backend\app.py
```

Then open <http://127.0.0.1:5174/> in a browser.

## Choose your library

The XQF library root is **set from the UI**, not hard-coded. On the file
panel header, click the **📁** button next to the path display — a native
Windows folder picker opens. Pick the directory containing your `.XQF`
files; the file tree refreshes immediately.

The chosen path is saved to `preferences.json` at the repo root, alongside
splitter sizes, board theme, and the last-opened file. If no root has been
set yet, the backend falls back to `D:\Elton\TestArea\chess-book\` — change
`DEFAULT_XQF_ROOT` in [backend/app.py](backend/app.py) if you want a
different starting default.

## Format conversion

CLI drivers for converting between XQF, CBL/CBR (CCBridge3 libraries), and
CWP (CCBridge single-game plain text). Round-trip-verified end-to-end
against real CCBridge corpora (see [tests/test_cb_xqf_integration.py](tests/test_cb_xqf_integration.py)).

### CBL → XQF (explode a library into per-game files)

```powershell
# Single library
.\.venv\Scripts\python.exe tools\cbl_to_xqf.py path\to\lib.cbl out_dir

# Or a directory tree — one sub-folder per .cbl
.\.venv\Scripts\python.exe tools\cbl_to_xqf.py D:\Elton\CCBridge3\CBL out_dir
```

Output layout: `<out_dir>/<cbl_stem>/<NNN>-<sanitised_title>.xqf`. Annotation
encoding is converted from CBR's UTF-16-LE to XQF's GB18030 (rare non-GB
chars drop silently).

### XQF → CBL (bundle files into a CCBridge3-compatible library)

```powershell
# Single .xqf or directory of .xqf files → one .cbl
.\.venv\Scripts\python.exe tools\xqf_to_cbl.py input_dir out.cbl --name "library name"
```

`--name` controls the library name shown in CCBridge3's property panel
(defaults to the input directory/file stem). The writer stamps `creator =
chess-book-editor` and `created_at`/`modified_at` to now, and handles the
CCBridge format gotchas (binary GUID linkage, init-annote gate flag,
metadata slots) automatically.

### CWP → XQF

```powershell
.\.venv\Scripts\python.exe tools\cwp_to_xqf.py
```

Paths are hard-coded at the top of the script (`SRC_ROOT`, `OUT_ROOT`,
`SKIP_DIRS`) — edit them before running. Endgame puzzles with non-standard
starting positions are skipped (full FEN replay not implemented).

## Verify round-trip

```powershell
# XQF library: all 46 files round-trip without losing variations or annotations
.\.venv\Scripts\python.exe tests\test_roundtrip.py

# Side-by-side with upstream XQFWriter (shows why we patch)
.\.venv\Scripts\python.exe tests\test_roundtrip.py both

# Full XQF <-> CBL pipeline: 3 real CCBridge3 corpora, 376 games
.\.venv\Scripts\python.exe tests\test_cb_xqf_integration.py

# Big5 mojibake recovery: 870-file legacy corpus
.\.venv\Scripts\python.exe tests\test_big5_recovery.py

# CBL offset-fix smoke: linear formula vs. cchess's broken table across 1570 files
.\.venv\Scripts\python.exe tests\test_cbl_smoke.py

# Regenerate XQStudio sanity-check samples
.\.venv\Scripts\python.exe tools\emit_sample.py
```

## Why a patched writer / vendored CBL stack

`cchess.io_xqf.XQFWriter.save()` collapses multi-branch trees to the main line
because its linear move-list emission does not match the reader's recursive
DFS expectation; it also drops Traditional Chinese chars (GBK vs. GB18030)
and the book-level init annote. See [vendor/io_xqf_patched.py](vendor/io_xqf_patched.py)
docstring for the full breakdown — suitable for upstream PR.

The CBL/CBR side was reverse-engineered against the master's CCBridge3
corpus (no public spec). cchess ships a CBL reader with a broken
4-bucket `_get_cbl_data_offset` lookup; the actual formula is linear
(`66624 + N*276`), which `vendor/cbl_index_fix.py` monkeypatches in.
`vendor/io_cb_writer.py` is the first open writer that produces files
CCBridge3 opens cleanly (binary-GUID linkage at CBR +19..35, init-annote
gate flag 0/1/4/5, library metadata slots at 832/896/960/1024).
