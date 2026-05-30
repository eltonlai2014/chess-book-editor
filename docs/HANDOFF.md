# Handoff — chess-book-editor

Updated 2026-05-26 end of session 2.

Read this first for full context. For steady-state guidance see
[CLAUDE.md](../CLAUDE.md).

## Where we are

Working end-to-end MVP. Master can:

1. Browse the XQF library from a file-tree pane
2. Open any XQF, see the board + linearised move list + annote + variations
3. Navigate with buttons (`|◀ ◀ ⎇分支 ▶ ▶|`) or keyboard (←/→/↑/↓/Home/End/B/Ctrl-S)
4. Switch board themes (傳統手繪 / 雅石回紋 / 鎏金歲月)
5. Edit annote text on any move
6. Save → original is backed up as `*.XQF.bak`, new file written via PatchedXQFWriter
7. Drag splitters to resize panels; sizes + theme + last-opened-file persist server-side

Nothing in the **tree-editing layer** is built (add/delete moves, promote
variations, metadata edit). Persistence and rendering layers are stable and
all 46/46 round-trip tests still pass.

## Session 1 (recap, see commit `c68ce43`)

Built and verified the **persistence layer only**:

- `vendor/io_xqf_patched.py` — `PatchedXQFWriter` (recursive DFS, GB18030, no
  v18 encryption). 46/46 perfect round-trip on the XQF library.
- `tests/test_roundtrip.py` — path-set comparison test, used as ground truth
- `samples/` — XQStudio-verified outputs (manually opened by master)

## Session 2 — what got built

### Backend (`backend/`)

- `app.py` — Flask app, binds 127.0.0.1:5174:
  - `GET  /api/xqf/list` → directory tree under `XQF_ROOT`
  - `GET  /api/xqf/load?path=<rel>` → `{info, init_fen, roots, path}`
  - `POST /api/xqf/save` body `{path, info, init_fen, roots}` → writes
    `<file>.XQF.bak` then `<file>.XQF`
  - `GET  /api/preferences`, `POST /api/preferences` → `preferences.json`
    at repo root (shallow-merge POST)
  - `/` and `/assets/<file>` serve the frontend statically
  - `XQF_ROOT = D:\Elton\TestArea\chess-book` (hard-coded, rejects paths
    outside it)
- `xqf_service.py` — Book ↔ JSON converter + Big5 annote recovery:
  - `book_to_json` walks `next_move.variations_all` (see CLAUDE.md
    gotcha #3), adds `notation` (Chinese, traditional) + `ply` + `side`
    per node. Black-side cannon `砲` is mapped to `包`.
  - `json_to_book` mirrors `_read_steps` from `cchess.io_xqf`: for each
    move it sets the move-side based on the piece's colour (so endgame
    puzzles with non-standard turn parity still rebuild).
  - `recover_book_strings(book)` — mutates Book in place to recover Big5
    annotes: `s.encode("gb18030").decode("big5")` succeeds on mojibake
    and fails on already-correct strings, so it's self-detecting. Called
    inside `load_xqf` only.
- `save_xqf(path, data)` — writes `.bak` first, then uses
  `PatchedXQFWriter` (still GB18030 on the wire).

### Frontend (`frontend/`)

Layout: 3-pane flex (`#filePane | #boardPane | #rightPane`) with three
draggable splitters. Right pane subdivides: `棋譜` (full height left)
and `注解 / 本步可選` (stacked right column).

- `index.html` — single page; loads `board.js` then `editor.js` as
  classic (non-module) scripts so they share the global lexical scope.
- `assets/board.js` — **modified copy** of chess-book-ai's renderer.
  Only minimal surgery applied so `drawBoard()` works standalone:
    - `isRedPerspective()` defaults to `true` when `REDP_BOX` isn't set
    - `drawMeanderFrame()` had a vertical-band geometry bug (lx/rx
      formula was off by 9px so half the meander drew off-board). Fixed
      to `lx = (B + 9) / 2`, `rx = W - (B + 9) / 2`.
  Otherwise we DON'T call its bootstrap `initGamePage` — just lift the
  pure renderer + `parseFen`/`applyIccs`/`iccsToCoord` helpers.
- `assets/editor.js` — main app:
  - `EDITOR.activePath` is a list of child indices from the root; `[]`
    = initial position. Used everywhere for navigation.
  - `currentLine()` linearises the path through the active variation
    plus the main continuation from there (matches XQStudio's display).
  - `navToNearestBranch()` walks back along activePath to find the
    deepest ply with `siblingsAt(...).length > 1` and navigates to its
    **parent** — so the next-move button takes you to the branch ply
    where 本步可選 shows the alternatives.
  - Splitters mutate `target.style.flexBasis` (NOT width/height —
    inside a flex container, flex-basis wins). State persisted via
    `savePreference(key, size)` on mouseup.
  - Annote textarea writes back into `EDITOR.data` on every input;
    `commitAnnoteEdit()` flushes pending changes before navigate/save.
- `assets/editor.css` — warm-dark palette with gold accent (`--accent:
  #d4a043`). XQStudio-inspired panel layout. LXGW WenKai TC font
  (loaded by board.js's `ensurePieceFontLoaded` from Google Fonts).

### Tests + tools

- `tests/test_json_roundtrip.py` — XQF → JSON → Book → XQF → reread,
  with Big5 recovery applied to both sides for a fair compare. 46/46.
- `tests/test_annote_edit.py` — opens a file, mutates an annote with
  Traditional Chinese + Ext-B `𠀋` + ASCII + newline, saves, reloads,
  compares byte-identical. Pass.
- `tools/dump_annotes.py` — UTF-8-safe dump of every annote in every
  XQF (raw reader vs JSON service, side-by-side). Useful to spot any
  remaining mojibake. Writes to `tools/annote_dump.txt` so PowerShell's
  cp950 doesn't choke.

### User preferences (`preferences.json` at repo root, gitignored)

- `splitFileW`, `splitMovesW`, `splitAnnoteH` — splitter sizes (px)
- `boardTheme` — `traditional` | `stone` | `gilded`
- `lastFile` — relative path of the last successfully opened file;
  auto-reopened on next boot (expands parent dirs, highlights, loads)

## Critical context (still load-bearing — don't break)

### 1. Big5 source / GB18030 wire / Unicode in memory

The 41 XQF source files use **Big5** encoded annotes. cchess's reader
hardcodes GB18030 → reads them as mojibake. `recover_book_strings`
recovers proper Traditional Chinese strings on load. The editor
operates on those strings. **Save still writes GB18030** (every modern
XQF reader handles GB18030 — including XQStudio — and GB18030 covers
all Unicode CJK). Saved files are therefore NOT byte-identical to the
source (different encoding), but reread cleanly across tools.

If you encounter a file that wasn't Big5 (e.g. AI-generated), the
recovery's Big5 decode step will fail on bytes Big5 can't represent,
and the string is left as-is. Self-detecting.

### 2. `move.next_move.variations_all`, never `variation_next`

cchess's `Move.append_next_move` (used for deep variations) only
updates `variations_all`, not `variation_next`. The writer fix and our
DFS walk both depend on this. **If anyone refactors tree-traversal
code to walk `variation_next`, deep variations silently disappear.**

### 3. `STATE` was a name collision with board.js

board.js declares `const STATE = ...` at module-script top level.
editor.js's analogous state object is named `EDITOR` to avoid this.
**Don't reintroduce `STATE` in editor.js** — it'll throw
`Identifier 'STATE' has already been declared` and break the page.

### 4. cchess's `move_iccs` vs reader

`board.move_iccs(s)` validates strict turn alternation. The XQF reader
does NOT — it sets the move-side based on the piece colour at the
source square before each move. Endgame puzzles depend on this. Our
`_apply_node` in `xqf_service.py` mirrors the reader's behaviour;
**don't switch to `move_iccs` "for simplicity"** — two source files
in the library (`牛頭滾`, similar endgames) will fail to rebuild.

### 5. Black cannon = 包, not 砲

cchess's `to_text(traditional=True)` maps both sides' cannon to 砲.
Master's convention: red 砲, black 包. `_node_to_json` post-processes:
when `move.move_side == SIDE_BLACK`, replace 砲 with 包 in the
notation string. Don't undo this.

## What's NOT built (session 3 targets)

In rough priority order:

### Must-have for editor to be usable

1. **Edit metadata** — title / red player / black player / event / date.
   Touches `book.info` only; no tree changes. Smallest scope. Add a UI
   panel above 棋譜 or behind a `⚙ 賽事資訊` button.
2. **Add a move** — extend the active line. Need board-click input OR
   ICCS textbox. Backend: `_apply_node` already handles tree-grow.
3. **Add a variation** — sibling of active move. UI: "在此分支" button
   that takes a new ICCS and inserts it into the parent's children.
4. **Delete subtree** — drop active node + descendants. Requires
   updating the parent's children list and `Move.variations_all`. Confirm
   dialog mandatory.
5. **Promote / demote variation** — swap variation with main line (very
   common in book editing). Probably needs an arrow-up/down button next
   to each variation in 本步可選.

### Nice-to-have

6. **Click pieces on board to move** — drag-and-drop, much more
   intuitive than reading ICCS. board.js doesn't have piece interaction
   wired; need new code.
7. **Undo / Redo** — once tree-edit operations exist, an undo stack on
   the JSON tree (with `EDITOR.data` snapshots) is straightforward.
8. **Board flip** — `data-board-flipped` attribute + `CURRENT_REDP`
   wiring is already in board.js, just needs a UI toggle.
9. **File-tree filter / search** — 41 files isn't bad, but a quick
   filter would help.

### Deferred

- **Upstream PR to walker8088/cchess** — `PatchedXQFWriter` is
  PR-ready. Master deferred (path B in session 1).
- **Shared `xiangqi-board-lib`** — until chess-book-ai and the editor
  diverge painfully, keep the copy.

## Files to read first in session 3

1. `backend/xqf_service.py` — Book ↔ JSON; pay attention to
   `_apply_node` (how to grow the tree when implementing add-move).
2. `frontend/assets/editor.js` `currentLine()` / `nodeAt()` /
   `siblingsAt()` — how the path-based addressing works.
3. `vendor/io_xqf_patched.py` — writer docstring still explains why
   the patch exists.
4. `CLAUDE.md` — steady-state guidance (still accurate).

## Editor.css layout notes (session 4 follow-up)

This repo's editor layout is now much more sensitive to **container
ownership** (who owns scroll / padding / sticky) than to any single
header rule. If future UI work touches header alignment, scrollbars, or
panel chrome, start here first.

### 1. Main layout ownership

- `main` is a 3-column flex layout: `#filePane` / `#boardPane` /
  `#rightPane`
- Splitter drag resizes by mutating `flex-basis`, not width/height
- `#filePane` owns its own scrolling
- `#boardPane` is mostly fixed-width presentation; it is not the place
  to add nested scroll containers lightly
- `#rightPane` is only the wrapper; its child sections own actual scroll
  behaviour

### 2. Right column scroll rule (important)

- `#rpMoves` is the **single scroll container** for the move list area
- `#moveList` should stay flow content, not become a second scrollable
  box again
- This is load-bearing for:
  - sticky `棋譜` header
  - scrollbar alignment with the card edge
  - avoiding header/scrollbar width drift

If a future change re-adds `overflow:auto` to `#moveList`, expect the
old alignment problems to come back.

### 3. Header systems

There are currently **two related but not identical** header patterns:

- `h2.panelHead`
  - used by `檔案`, `棋譜`, `注解`, `本步的所有走法`
  - visual rule = section chrome header with gold bottom line
- `#fileTitle`
  - centre-board file title
  - visually brought closer to the panel-header system, but still its
    own selector because it is centred and belongs to `#boardPane`

Do not assume that changing `h2.panelHead` automatically fixes
`#fileTitle`; inspect them separately.

### 4. Layout tokens worth checking first

When alignment looks "off", inspect these before patching literal px:

- `--rp-pad-x` — right-panel horizontal padding
- `--rp-pad-y` — right-panel vertical padding
- `--board-pad-x` — board-pane horizontal padding
- `--header-pad-x` — header text inset
- `--scrollbar-w` — scrollbar width assumption

If one of these changes, header lines / sticky behaviour / content-box
alignment can all shift together.

### 5. Button system

Buttons are now grouped by intent rather than per-section styling:

- `primary` — filled gold action
- `outline` — standard header / modal secondary button
- `ghost` — light glass button (nav, icon buttons, pickers, promote)
- `danger` — red destructive hover treatment layered on icon buttons

Prefer extending this system over adding a new one-off button style.

### 6. Right-side sections (`注解` / `本步的所有走法`)

These two sections are particularly sensitive because:

- their header line should visually align with the card interior
- their content boxes (`#annoteBox`, `#varPicker`) have their own inner
  margins / widths
- small width hacks (`calc(...)`) tend to create horizontal overflow or
  fake alignment fixes

If they drift again, first inspect:

- section padding
- `box-sizing`
- who owns overflow-x / overflow-y
- whether the width fix is trying to compensate for the wrong parent

### 7. Practical debugging order for future UI tweaks

If the issue is visual alignment:

1. Check **who owns scroll**
2. Check **which container owns padding**
3. Check **box-sizing / width / max-width**
4. Only then patch the child component

This repo has already proven that patching a header in isolation often
creates a second bug somewhere else.

## Master's working preferences (running notes)

From sessions 1 + 2:

- 稱呼「尊敬的主人」
- Traditional Chinese, **terse** responses; one-paragraph diagnosis
  followed by minimal fix; no trailing summaries unless asked
- Exploratory questions: 2-3 sentences with recommendation + main
  tradeoff, don't implement until master agrees
- **Doesn't over-engineer** — when master said "靠左對齊即可" after I
  had built a 3-column grid + spacer for centred buttons, that was a
  correction to over-design. Default to the simplest layout first.
- Sees through bugs fast — points out concrete failure modes (e.g.
  "垂直紋路的位置不正確") and expects diagnosis + fix, not handwaving
- Iterates on UI a lot. Expect 2-3 rounds of polish on every visual
  change. Don't argue past round 2; just do what master asks.
- Wants 繁體中文 throughout (UI labels, annotations, etc.)
- Pikafish runs `Threads=4` if engine work happens (it shouldn't —
  engine analysis is chess-book-ai's domain)
