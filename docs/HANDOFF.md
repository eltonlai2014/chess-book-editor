# Handoff — chess-book-editor session 1 → session 2

Written 2026-05-26 at the moment master switches Claude Code's working
directory from `D:\Elton\TestArea\chess-book-ai\` to this repo.

Read this first, then [CLAUDE.md](../CLAUDE.md) for steady-state guidance.

## What just happened (session 1 summary)

Session 1 lived in `chess-book-ai/`. The goal was to evaluate whether the
master could build a browser-based XQF editor that reads/writes XQF files
losslessly. Outcome: **yes, feasible — persistence layer is verified**.

Investigation steps that led here:
1. Found `walker8088/cchess` has an `XQFWriter` (newer version not yet
   installed globally on master's machine).
2. Spike at `chess-book-ai/spike/xqf_writer/` (now deleted) round-tripped
   46 XQF files through the upstream writer — **0/46 perfect**. Every file
   collapsed multi-branch trees to the main line (branchs N → 1).
3. Diagnosed three bugs (see `vendor/io_xqf_patched.py` module docstring).
4. Wrote `PatchedXQFWriter` subclass with all three fixes. **46/46 perfect**.
5. Generated 5 sample XQFs in `samples/`. Master manually opened each in
   XQStudio — all variations, annotations, headers display correctly.
6. Master approved direction. Repo was init'd, spike artifacts moved here,
   first commit made (`c68ce43`).

Master then chose to proceed with building the editor (path A from the
options offered), skipped upstreaming the patch to cchess (B), and authorised
deletion of the chess-book-ai spike (C — done).

## Current state (verified)

| Component | Status | Notes |
|---|---|---|
| `vendor/io_xqf_patched.py` | ✅ verified | 46/46 round-trip, XQStudio opens output cleanly |
| `tests/test_roundtrip.py` | ✅ passing | Re-run after any cchess upgrade |
| `samples/` | ✅ XQStudio-verified | Don't regenerate without re-verifying |
| `frontend/assets/board.js` | 📋 copied raw | From chess-book-ai/site_builder/assets/, not adapted yet |
| `frontend/assets/style.css` | 📋 copied raw | Same |
| `backend/` | empty | Flask/FastAPI shell pending |
| Editor UI | not started | |

## Critical context the next session needs

### 1. cchess Move tree semantics (subtle)

There are TWO sibling pointers in `cchess.move.Move`:
- `move.variation_next` — linked-list pointer, **only** populated for top-level
  variations (via `Book.append_first_move` → `add_variation`).
- `move.variations_all` — Python list of all siblings, **always** maintained.

`Move.append_next_move()` (called by reader for deep variations) only updates
`variations_all`, **not** `variation_next`. So:

> **Always walk `move.next_move.variations_all` to find children at any depth.
> Walking `variation_next` works only at the root and silently misses deep
> branches. This was bug #2 of the writer fix; it would silently come back
> if anyone refactors tree-traversal code.**

### 2. Annotation encoding = GB18030 (not GBK)

Upstream cchess writer encodes annotes as GBK. Master uses Traditional Chinese.
GBK doesn't cover many traditional chars → upstream silently drops them via
`errors="ignore"`. Reader decodes as GB18030. The patch encodes as GB18030.

> **Any new code that touches XQF annotation bytes should use GB18030 in both
> directions. Don't reintroduce GBK.**

### 3. Writer version = 0x0A (low version, unencrypted)

We don't reproduce the v18 XOR encryption. Writing as v0x0A is XQStudio-compatible,
much simpler, and skips the encryption headache. Output files are ~50% larger
than v18 input — that's expected.

### 4. Two cchess installs side-by-side

| Repo | cchess source | Why |
|---|---|---|
| `chess-book-ai` | Old pip install (only `read_xqf.py`, has `Game`) | Pinned by existing site_builder code |
| **`chess-book-editor`** | GitHub master (has `io_xqf.py`, `Book`) | Required for writer |

> **Do NOT `pip install --upgrade cchess` globally.** Use `.venv` here, leave
> the chess-book-ai install alone. They serve different code paths.

### 5. board.js / style.css are dragged-in, not adapted

I copied them verbatim from `chess-book-ai/site_builder/assets/`. They were
written for a **read-only analyzer view** — they include:
- Score chart (`drawChart`, lines 780-858) — irrelevant for editor
- Engine PV demo (`stopDemo`, `setDemoMode`, etc.) — irrelevant
- Trap/brilliant highlighting in `annotateTable` (line 1084) — irrelevant
- 本步可選 panel (`VAR_PICKER`, line 867) — **reusable / adapt for editor**
- `applyIccs(fen, iccs)` line 70 — **critical reusable**
- `drawBoard(svg, fen, bookMove, engineMove)` line 448 — **reusable**
- `parseFen()` line 44 — **critical reusable**
- 3 themes + multiple board styles (lines 272-446) — bonus, keep

> **Strategy: don't strip board.js yet. Build the editor UI alongside it,
> use what's useful, leave the rest dormant. Strip later when the editor
> shape is stable.**

## What the next session should build (path A)

The first vertical slice (no editing yet — just open/display/save round-trip
through the browser):

1. **Flask backend** at `backend/app.py`:
   - `GET /api/xqf/list` → directory tree of `D:\Elton\TestArea\chess-book\`
   - `GET /api/xqf/load?path=...` → JSON: `{init_fen, move_tree, info}` —
     derive from a `cchess.Book` via `read_from_xqf`
   - `POST /api/xqf/save` body `{path, init_fen, move_tree, info}` → use
     `PatchedXQFWriter` to write back
   - Hard-code `XQF_ROOT = r"D:\Elton\TestArea\chess-book"`, refuse paths
     outside it

2. **JSON shape for move_tree** — sketch:
   ```json
   {
     "iccs": "h2e2",
     "annote": "中砲",
     "children": [
       { "iccs": "h7e7", "annote": "", "children": [...] },
       { "iccs": "b9c7", "annote": "屏風馬", "children": [...] }
     ]
   }
   ```
   Convert to/from `cchess.Book` via straightforward DFS. The first child of
   the children array is the "main continuation" (next_move); the rest are
   the variation siblings.

3. **Minimal frontend** at `frontend/index.html`:
   - Left panel: file tree (clicking a file calls `/api/xqf/load`)
   - Center: board (reuse `drawBoard()` from board.js)
   - Right: move tree display (start with simple nested `<ul>`; clicking a
     node updates board state via `applyIccs()`)
   - "Save" button calls `/api/xqf/save` with the unchanged tree → quickest
     way to verify the full pipe round-trips through the browser

4. **End-to-end round-trip test**: open `中砲對單提馬.XQF`, save without
   changes, diff path-set against original via `tests/test_roundtrip.py`
   logic. If green → persistence is wired correctly.

Only after the round-trip-through-browser works should editing operations
(add child move, edit annote, delete subtree, reorder siblings) be added.

## Things deliberately NOT done in session 1

- **No upstream PR to walker8088/cchess.** Master said skip for now (path B).
  The patch stays vendored. Could revisit later.
- **No shared `xiangqi-board-lib`.** Initially the master accepts board.js
  drift between chess-book-ai and this repo. Extract a shared lib only after
  both projects stabilize and the divergence becomes painful.
- **No public deployment.** This is a local-only tool. Don't add GitHub Pages
  setup, don't mirror to a `docs/` directory.

## Master's working preferences (carried over)

From `chess-book-ai/`'s memory:
- 稱呼「尊敬的主人」, Traditional Chinese, terse responses
- Pushes back on sloppy interpretation of engine/library output
- For exploratory questions: 2–3 sentences with recommendation + main
  tradeoff, *don't* implement until master agrees
- Wants 繁體中文 throughout (UI labels, annotations, etc.)
- Default Pikafish to `Threads=4` if engine work happens here (it shouldn't —
  that's chess-book-ai's domain)

## Files to read first in session 2

1. `vendor/io_xqf_patched.py` — module docstring explains the writer fix
2. `tests/test_roundtrip.py` — see how path-set comparison works (will
   reuse the same logic for the browser-round-trip test)
3. `frontend/assets/board.js` lines 44–110 — `parseFen`, `iccsToCoord`,
   `applyIccs`. These are the reusable core.
4. `CLAUDE.md` — steady-state guidance

## Open questions for master in session 2

1. Backend framework: Flask or FastAPI? (Recommend Flask for simplicity; the
   API is 3 endpoints, no async needed.)
2. File-tree refresh: live (watch filesystem) or on-demand (refresh button)?
   Recommend on-demand for first cut.
3. Backup/versioning: should `POST /api/xqf/save` write to a `.bak` first?
   Strong recommend yes — first edits will surface bugs we haven't found yet.
4. Whether to also display chess-book-ai's analysis data (engine scores,
   trap annotations) as read-only overlays. Probably no for v1 — keep editor
   clean.
