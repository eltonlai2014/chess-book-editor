# chess-book-editor

Browser-based XQF (Chinese chess opening-book file) editor — open `.XQF` files,
edit moves / variations / annotations, save back as `.XQF`.

Sibling project of [chess-book-ai](../chess-book-ai/) (engine analysis +
static-site builder). This repo focuses on the **authoring** side. Shared XQF
library at `D:\Elton\TestArea\chess-book\`.

## Status

🚧 Early — only the **persistence layer is verified** so far:

- `vendor/io_xqf_patched.py` — patched `cchess.io_xqf.XQFWriter` that fixes the
  upstream variation-collapse bug, encodes annotations as GB18030 (Traditional
  Chinese safe), and survives a 46/46 round-trip on the existing XQF library.
- Sample outputs in `samples/` verified to open correctly in XQStudio.

UI, backend, and the editor itself are not built yet.

## Layout

```
backend/      # (planned) Flask/FastAPI — GET /xqf/list, POST /xqf/save
frontend/     # (planned) board.js + editor UI (copy from chess-book-ai initially)
tools/        # CLI utilities — emit_sample.py, future xqf_diff.py, etc.
vendor/       # cchess.io_xqf patch — exports PatchedXQFWriter
tests/        # test_roundtrip.py + future editor logic tests
samples/      # XQStudio-verified sample outputs
```

## Setup

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install "git+https://github.com/walker8088/cchess.git@master"
```

## Verify round-trip

```powershell
# All 46 XQF files round-trip without losing variations or annotations
.\.venv\Scripts\python.exe tests\test_roundtrip.py

# Side-by-side with upstream (shows why we patch)
.\.venv\Scripts\python.exe tests\test_roundtrip.py both

# Regenerate XQStudio sanity-check samples
.\.venv\Scripts\python.exe tools\emit_sample.py
```

## Why a patched writer

`cchess.io_xqf.XQFWriter.save()` collapses multi-branch trees to the main line
because its linear move-list emission does not match the reader's recursive
DFS expectation. See `vendor/io_xqf_patched.py` module docstring for the full
breakdown (three bugs, three fixes). Suitable for upstream PR.
