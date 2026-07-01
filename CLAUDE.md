# CLAUDE.md

Guidance for Claude Code when working in this repo.

> **先讀 [ARCHITECTURE.md](ARCHITECTURE.md)** — 系統功能、設計原則速查、以及
> 「功能 → 程式碼 `file:line`」對照表。改任何功能前先在那裡定位。本檔聚焦
> 「為什麼」與陷阱；ARCHITECTURE.md 聚焦「在哪裡、做什麼」。
> **視覺／配色／字型／icon／品牌規範另立 [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md)**
> （單一配色來源：主題 token、Sarasa 等寬、ICON SVG、朱文方印；別在元件寫死顏色）。

## Project

Browser-based XQF editor. Pairs with [chess-book-ai](../chess-book-ai/)
(opening-book analyser + static site) but is intentionally separate:

Both repos analyse — the split is **breadth vs depth**, not "analyse vs edit":

| | chess-book-ai | this repo |
|---|---|---|
| Emphasis | **Breadth** — batch-scan the library, surface problem points | **Depth** — drill into a specific position; input + deep study + annotation |
| Purpose | Analyse XQF en masse, surface engine-vs-book traps | **Edit + deeply analyse** XQF (moves, variations, annotes, targeted engine study) |
| Backend | None (batch Python → static HTML) | Flask for POST /xqf/save + live engine SSE |
| Deploy | GitHub Pages (public) | Local-only tool |
| cchess | old install (read_xqf.py only) | new install + `vendor/io_xqf_patched.py` |

Shared read-only data: `D:\Elton\TestArea\chess-book\` (41 originals + AI/ subset).

## Status

Editor is end-to-end working — see [ARCHITECTURE.md](ARCHITECTURE.md) for the
full feature → `file:line` map. In brief, all of this is built and live:

- **Editor UI + Flask backend** — browse library, open/edit/save XQF **and
  CBL/CBR** (象棋橋), tree ops (add/delete move, promote variation, edit
  metadata, new file). CBL multi-game libraries expand as folders (lazy);
  edits rewrite the whole library in place, preserving every game's GUID +
  library metadata. See "CBL/CBR in the editor UI" below.
- **Live engine analysis (SSE)** — execs Pikafish, streams depth/score/PV;
  ephemeral, nothing persisted. Plus the AI whole-line score-trend chart.
- **Eval + cloud integration** — read-only evals from chess-book-ai's
  `positions.db`, and live chessdb.cn cloud-library lookup (cache-first).
- **Format-conversion CLIs** — XQF ⇄ CBL/CBR (CCBridge3) ⇄ CWP, with the
  vendored reader/writer stack. (The editor UI now also reads/writes CBL/CBR
  directly — the CLIs remain for batch/whole-library conversion.)

Persistence layer (the original foundation, still the correctness anchor):

- `vendor/io_xqf_patched.py` — `PatchedXQFWriter`. Subclasses upstream
  `cchess.io_xqf.XQFWriter`, fixes three bugs (variation collapse, sibling
  pointer mismatch, annote encoding loss). See the module docstring.
- `tests/test_roundtrip.py` — perfect path-level round-trip over the whole
  XQF library (full set of root-to-leaf move+annote paths). Upstream writer
  scores 0 on the same test.
- `samples/` — XQStudio-verified output files (manually opened by the master).

## Commands

```powershell
# Setup (one-time) — builds .venv, installs requirements (cchess from the
# vendored wheel in vendor/wheels/), seeds preferences.json from the example.
.\setup.ps1

# Run the editor (serves the frontend too); open http://127.0.0.1:5174/
.\run-dev.ps1                  # dev: kills stale servers, frees :5174, hot-reload
.\.venv\Scripts\python.exe backend\app.py   # plain run (no reloader; debug OFF)
# Werkzeug debugger is OFF by default; opt in with $env:FLASK_DEBUG=1
# NOTE: debug off = no auto-reload, and SO_REUSEADDR lets a new run bind :5174
# while a STALE server keeps answering old code. run-dev.ps1 clears that first.

# Verify writer (whenever the cchess wheel or PatchedXQFWriter changes)
.\.venv\Scripts\python.exe tests\test_roundtrip.py

# Side-by-side comparison (shows the bug in upstream)
.\.venv\Scripts\python.exe tests\test_roundtrip.py both

# Route-contract tests (Flask test_client; NO network/engine/DB needed —
# chessdb's live query + the eval DB are monkeypatched). Run after touching any
# /api route, FEN serialisation, or the eval/chessdb JSON shape.
.\.venv\Scripts\python.exe tests\test_routes.py

# Browser smoke test (real Chromium drives the UI end-to-end: open→navigate→
# edit annote→save→reload→verify). Isolated sandbox (temp prefs/library/cache,
# stubbed chessdb) — never touches real config, never hits the network. SKIPs
# if Playwright/Chromium/sample absent. Run after frontend or save-path changes.
.\.venv\Scripts\python.exe tests\test_smoke_ui.py

# Engine SSE contract test (execs the REAL Pikafish; bounded depth, sub-second).
# Verifies /api/engine/analyze (SSE: per-depth info + done.bestmove) and
# /api/engine/analyze-line (NDJSON: per-fen cp/best, depth2->cp2). All three
# frontend streams (engine tab, AI auto-play via movetime, demo→延伸 via depth)
# route through these two endpoints. SKIPs if no engine configured (CI-safe).
# Run after touching either SSE route or engine_service.
.\.venv\Scripts\python.exe tests\test_engine_sse.py

# Regenerate XQStudio sanity samples
.\.venv\Scripts\python.exe tools\emit_sample.py
```

## When to break out of this repo

- **Breadth-analysis** — batch sweeps that scan the whole library to *find*
  problem points (trap detection, depth-22 eval sweep over many games,
  traps.html). That machinery + positions.db live in chess-book-ai; don't
  duplicate the batch pipeline here.
- **Depth-analysis is this repo's job, not an exception.** Drilling into the
  *one* position the user is studying — live interactive engine analysis,
  evaluation, annotation — is core to the editor. `GET /api/engine/analyze`
  (SSE) *execs* an existing pikafish binary (no source/build copied here) to
  stream depth/score/PV; strictly **ephemeral**, nothing persisted (contrast
  positions.db). Binary via `preferences.json` `pikafishPath` (default sibling
  `chess-book-ai/engine/Windows/pikafish-avx2.exe`); UI chip in the file pane.
  **Exception — the whole-line sweep IS cached.** `POST /api/engine/analyze-line`
  (the 走勢圖/整局報告 sweep) writes each computed eval to the editor's OWN
  writable `output/editor_eval_cache.db` (`backend/eval_cache.py`), keyed by
  `(去步數fen, depth, depth2, 引擎簽章)` — so a re-scan of the same/overlapping
  line replays from cache and a fully-cached line never spawns Pikafish (lazy
  spawn on first miss). The KEY MUST keep the depth pair + the engine signature
  (`engine_service.engine_signature` = binary+nnue stat): an eval is only valid
  for a fixed depth and engine, so dropping either would serve stale scores.
  `fresh:true` recomputes. positions.db stays read-only; this is the only
  engine-eval store the editor writes (parallels the chessdb editor cache).
  `POST /api/engine/eval-cache` is the **cache-only read** (NEVER spawns the
  engine — keep it that way): the frontend fires it when the AI tab opens or a
  file is switched while it's open (`maybeAutoLoadAiCache`) so a previously-swept
  line shows its chart+report instantly without pressing 掃描.
- **Board rendering code reuse** → currently a TODO. When the UI starts, copy
  `assets/board.js` + `applyIccs` from chess-book-ai's `site_builder/assets/`,
  accept drift. Long-term: extract shared `xiangqi-board-lib`.

## Eval data integration (2026-05-29)

This repo consumes engine evals + chessdb winrates from chess-book-ai's
`output/positions.db` (SQLite). See [../chess-book-ai/SQLITE_EVAL_DB.md](../chess-book-ai/SQLITE_EVAL_DB.md)
for the full design and schema.

- **Strictly read-only.** `backend/eval_service.py` opens the DB with URI mode
  `?mode=ro`. Never INSERT/UPDATE — the AI repo's pipeline owns the file.
- **Default path**: `../chess-book-ai/output/positions.db` (sibling). Override
  via `preferences.json` key `evalDbPath`.
- **Trap / brilliant thresholds — single in-repo source (T3-2):**
  `backend/eval_service.py` `TRAP_THRESHOLDS` (`skipOpeningPlies`,
  `trapShallowMax`, `trapDeepMin`, `trapDeepMax`, `brilliantMin`, `brilliantMax`).
  The editor UI **fetches** them via `GET /api/eval/thresholds` on boot
  (`editor.js` `fetchThresholds`, in boot()'s parallel batch; the consts are now
  fallback mirrors, not authoritative) and `backend/test_trap_spotcheck.py`
  **imports** the dict — so there's exactly one copy here. It **must still match
  `chess-book-ai/site_builder/render_site.py`** (cross-repo: that pipeline can't
  import this one), but only this dict has to track it now. Same for the
  `_ply_loss` formula. Sanity-check script: `backend/test_trap_spotcheck.py`;
  route contract in `tests/test_routes.py`.
- **FEN format compatibility** (must remain `<board> <w|b>`, no move counters):
  `backend/test_eval_integration.py` measures hit rate against the DB and
  will tank to ~0% if either side's FEN serialiser drifts.

## Live cloud-library query (chessdb.cn) (2026-06-04)

The editor lets the user set up arbitrary positions, so `positions.db` (the
read-only AI cache) misses most of them. `backend/chessdb_service.py` fills the
gap with a **cache-first live lookup** of chessdb.cn, exposed as
`GET /api/chessdb?fen=` (`fresh=1` skips caches and re-queries).

- **Three-tier resolution**: read-only positions.db → editor's **own** writable
  cache (`output/editor_chessdb_cache.db`) → live chessdb.cn (written back to
  the editor cache). **Never write positions.db** (read-only, AI repo owns it)
  and **never touch the AI repo's `chessdb_cache.json`** (its pipeline's source).
  The editor cache is the only chessdb store this repo writes.
- **Query per-position, not per-file.** The frontend (`ensureCdbLive`, debounced)
  fires one request for the position you land on — NOT a batch over every FEN in
  the file. That's deliberate: it honours chessdb's ~5 req/s politeness rule
  (see `docs/CHESSDB_CLOUD_QUERY.md` §6). Don't "optimise" this into a bulk sweep.
- **The ONE sanctioned multi-query is 雲庫演繹 (`deriveCdbLine`).** It walks the
  chessdb best move forward up to `cdbLineDepth` plies. It stays within the rule
  by being **button-triggered (never auto on navigation)**, cache-first, and
  sleeping 250ms **only on live misses**. It also self-terminates the moment
  chessdb has no row (out of book), so it rarely runs the full depth. Keep those
  three guards if you touch it. **T2-5**: it shares the fetch+parse helper
  (`fetchCdb`/`parseCdbResponse`) with `fetchCdbLive` and now **back-fills**
  `evalsByFen[fen].cdb` for each derived position (`cacheCdb`) so navigating onto
  one later skips a re-query — but its **own throttled loop is NOT merged** with
  the navigation path (only the response parsing + cache write are shared). It
  still doesn't *read* the cache mid-loop (each step fetches; the loop must stay
  the single deliberate multi-query path).
- **No cloud query once the position is an endgame.** chessdb only covers
  opening+midgame, so a sparse endgame just returns 查無. `isEndgameFen(fen)`
  (editor.js, near `cdbTabFen`) gates BOTH the live lookup (`ensureCdbLive` →
  `EDITOR.cdbLive.endgame`, shown as 「殘局・不查雲庫」/「殘局略」) and the
  derivation loop (`deriveCdbLine` breaks). Rule (whole board, 大子＝車R/馬N/炮C):
  **no rook (`rooks===0`) OR ≤2 大子 (`bigPieces<=2`)** → endgame. FEN letters per
  cchess `FULL_INIT_FEN` (R/N/C). This is a heuristic to skip dead queries, not a
  correctness gate — widen the rule rather than adding a second code path.
- **The whole `#evalLine` judges the position AFTER the active move
  (`currentFen`), not the decision point.** 深N scores, 建議, and 雲 all key to
  `currentFen()`, answering "how does this position stand, and what's the best
  reply" — matching the AI trend chart (which also scores each move's post-move
  position). (Was the 前一步 decision point until 2026-06-18; master flipped it to
  the post-move framing so the eval line agrees with the trend chart.) **The LAST
  ply's terminal (post-move) position is now scored AT SOURCE** (chess-book-ai
  commit `86c4c16`, 2026-06-23): each ply stores its *pre*-move FEN, so the leaf's
  post-move board was once the one position nobody evaluated → the final move
  briefly showed no 深N (that 2026-06-18 trade-off is now OBSOLETE — was
  "deliberately not patched"). `build_data.py` now emits the terminal FEN (→ d12,
  incl. 將死/困斃 `mate=0` shown as #0) and `enrich_decisive.py` adds it to the d22
  candidate set. After positions.db is re-migrated, **d12 covers the leaf
  immediately and d22 fills in via the nightly sweep** — so the final move shows
  深12 right away and 深22 once the sweep reaches that terminal FEN. **Editor needs
  ZERO code change** (read-only DB; `renderEvalLine` just picks up the new rows).
  Depth data comes from the `fetchEvalsForFile` batch (`collectAllFens` already
  includes every node's post-move FEN) — no per-navigation network call.
- **Cloud list defaults to the branch's alternatives; a toggle adds "下一步".**
  The 雲庫 tab has a `當前步`／`下一步` toggle (`EDITOR.cdbScope`, `cdbTabFen()`).
  - `當前步` (DEFAULT, prev): the decision point (`analysisFen`) — lists the
    moves playable at the branch point (active move + its siblings). Clicking
    adds a *sibling* at the branch point (`insertMoveAt(activePath.slice(0,-1),…)`).
    (Since 2026-06-18 this no longer matches the eval line, which moved to
    `currentFen` — see the eval-line bullet above.)
  - `下一步` (next): lists moves at `currentFen` (after the active move) — the
    next ply's options. Clicking adds a *child* of the active move
    (`insertMoveAt(activePath,…)`).
  **Only the tab honours `cdbScope`; the eval line ALWAYS keys to `currentFen()`**
  (the post-move rule above). The navigation live-query is keyed to the eval
  line's `currentFen` (`ensureCdbLive(currentFen())`), so its 雲 cell gets live
  chessdb data when positions.db misses — and it misses a lot for the cloud table:
  positions.db's `chessdb` only covers the AI pipeline's PLY_RANGE 10–25, so
  front/late moves rely on this live fill (depth scores don't — `evals` has no ply
  window). The 雲庫 tab's own position (`cdbTabFen`) is (re)queried when you switch
  to that tab or toggle scope — `cdbLive` is a single slot, so navigation can only
  live-query one position and the常駐 eval line wins. `fetchCdbLive` repaints by
  `fen===currentFen()` (eval line) / `fen===cdbTabFen()` (tab) so a late response
  can't overwrite a newer position. See ARCHITECTURE.md 雲庫 section.
- **Return shape mirrors `eval_service`'s `cdb`** (`{status, moves, best,
  source}`) so cached (batch) and live results share `renderEvalLine` /
  `renderCdbTab`. Scores are mover-POV cp; UI flips to red POV for display.
- **Known traps** (NUL byte, FEN trim to `<position> <side>`, http-not-https,
  single-string error states) are handled in `query_chessdb` — see
  `docs/CHESSDB_CLOUD_QUERY.md` for the why.

## CBL/CBR in the editor UI (2026-06-08)

The editor lists, opens, edits, and writes back 象棋橋 `.cbl`/`.cbr` directly,
not just XQF. The core insight that made this cheap: **CBL/CBR games are the
same `cchess.Book` as XQF**, so `book_to_json`/`json_to_book` (`xqf_service`)
are reused verbatim — the only new code is the format boundary in
`backend/cb_service.py` plus dispatch in `app.py`.

- **CBR ≈ XQF, CBL is the hard part.** `.cbr` (single game) is a leaf in the
  tree like `.xqf`. `.cbl` (multi-game library) is shown as an **expandable
  folder** (📚), and games are loaded **lazily** — `_tree` emits the `.cbl` as
  `{type:dir, cbl:true, children:[]}`; the frontend (`toggleCblDir`) fetches
  `GET /api/xqf/cbl-children` only on first expand. **Don't** make `_tree` read
  every CBL eagerly — the CCBridge corpus is ~1570 files and that tanks
  `/api/xqf/list`.
- **NEVER `read_cbl()` just to list titles or open one game.** `read_cbl`
  (`Book.read_from_lib`) parses EVERY game's move tree — ~26s for the 824-game
  中貴棋譜.cbl. That made both "expand library" and "open one game" crawl. The
  fix exploits CBL being **4096-byte slots** at `66624 + book_count*276`
  (`cbl_index_fix`'s linear offset): `_cbl_record_starts` walks every 4096-byte
  slot to EOF and keeps the ones that **start with** the `CCBridge Record` magic
  (no move parse). **A record can span >1 slot** (a game whose moves/annotes
  exceed 4096 bytes takes 2–4 slots); the continuation slots don't start with the
  magic, so they're **skipped — NOT a stop**. The original parser used the magic
  as the loop *guard* and broke at the first continuation slot, dropping every
  game after the first multi-slot record (1571-file corpus: 315 files
  under-counted, some down to 1 game; 象棋杀着大全 1→624). Counts now equal
  cchess `read_cbl`'s — even on a dirty file whose index is out of sync with the
  physical layout (黄少龙's 象棋实战中局谱: index claims 62, only 61 physical
  records → `_cbl_record_starts`=61=read_cbl, because magic boundaries are the
  ground truth, not the stale index slot_counts). Regression: the multi-slot /
  dirty-file counts are asserted in `tests/test_cb_roundtrip.py`. `list_cbl_games`
  reads each record's title (CBR header +180) **plus red/black/result (fixed
  offsets +1076/+1300/+2076) to build the tree label** — `布局名 — 紅 先勝 黑`
  when both players are real, else just the title (`_compose_cbl_label`;
  theoretical-opening games store placeholder 紅方/黑方 → skipped via
  `_PLACEHOLDER_PLAYERS`; and some titles ALREADY embed the players
  (`A111 張鴻鈞 先和 黃朝貴`) → skip the append when both names are already in
  the title via `_name_in_title`, else it doubles up; `_PLAYER_ALIAS_GROUPS`
  special-cases one person written two ways across title vs player field
  — 中貴棋譜's 詹品三＝詹品川). Still NO move parse — those bytes are already in
  memory, so it stays the fast path. (XQF gets player names from its *filename*;
  the CBL has no filename per game, so the label has to read the in-record
  fields. Both formats store title=布局 + red + black + result.) `load_cb` seeks
  to one record and `read_from_cbr_buffer`s just that game. ~5000×/680× faster,
  output byte-identical to the full parse. Keep new CBL code on this path.
- **Saving a CBL game is a byte-level splice, not a full rewrite.** Because
  records are 4096-byte slots, `save_cbl_game` overwrites only the edited game's
  slot(s) in place (when its slot count is unchanged — true for ~all opening-
  book games), updates that one index entry (data_size/title) + `modified_at`,
  and leaves every other byte untouched. ~700× faster than re-serialising the
  whole library AND more faithful (untouched games stay byte-identical). Only a
  game that grows past its 4096 slot allocation falls back to `_save_cbl_full`
  (the read-all + `write_cbl_bytes` path). Note: this whole stack assumes
  single-slot records (cchess's reader also walks fixed 4096 strides) — true for
  the opening-book corpus; don't assume it for arbitrary huge games.
- **rel of a CBL game = `path/lib.cbl#3`** (`#`+0-based index). `parse_cb_rel`
  splits off `#N` **before** `_safe_resolve` (which must validate a real file
  path — never feed it `#N`). `load`/`save`/`cbl-children` all go through it.
- **Saving edits one game in place; other games keep their identity.** UI only
  edits existing games' moves/annotes — **no add/delete/reorder games** (out of
  scope). `save_cbl_game` backs up to `.cbl.bak` first. The fast path (splice,
  above) keeps untouched games byte-identical for free. Fidelity is still
  load-bearing for the **fallback** `_save_cbl_full` (and the lesson explains why
  the splice path exists at all), because `read_cbl` only returns `{name, games}`
  and a naive read→write loses identity:
  1. **Per-game GUIDs** — `read_cbl` drops them; `read_cbl_guids` reads them from
     the index area (`66624 + i*276 + 0x14`) and threads them into the
     `guids=` param of `write_cbl_bytes`. Without this, EVERY game's GUID changes
     on each save (CCBridge cross-references by GUID). The splice path sidesteps
     this entirely by not touching other entries.
  2. **Library metadata** (creator/email/created_at/capacity) — also dropped by
     `read_cbl`; `read_cbl_lib_meta` reads the raw offsets (832/896/960/1024,
     capacity@60) and re-passes them. Only `modified_at` is restamped.
  3. **`.cbr` GUID** — `save_cbr` reads the original header GUID (`_read_cbr_guid`,
     offset 20, binary) so single-game saves keep identity too.
  Regression for all of this: `tests/test_cb_roundtrip.py` (run it after any
  `cb_service` or `io_cb_writer` change). It asserts unedited games' paths +
  GUIDs + lib metadata survive an edit-one-game save.
- **No Big5 recovery for CB formats.** `load_cb` skips the XQF Big5 heuristic —
  CBL/CBR strings are UTF-16-LE, so that heuristic would only corrupt them.
- **One game's edits at a time — no multi-game pending state.** Editing is
  per-game; `save` writes exactly one game (splice). The frontend tracks an
  `EDITOR.dirty` flag (`markDirty` at every tree/annote/metadata mutation,
  cleared on load + successful save). Switching game/file/root goes through
  `maybeSaveBeforeLeaving`, which forces a 先存檔／放棄變更 decision when dirty
  (save-failure keeps you on the current game). This is deliberate so you can
  never accumulate unsaved edits across several games of one library and then be
  unsure what a save will write. Don't add a path that swaps `EDITOR.data`
  without going through this guard.
- **Atomic writes.** `_atomic_write` does `.tmp`→`os.replace` so a crash mid-save
  can't leave a half-written library.
- **Titles read aligned, not via cchess's `cut_bytes_to_str`.** cchess truncates a
  CBR/CBL title at the first `\x00\x00` WITHOUT 2-byte alignment, so a title ending
  in an ASCII char (`)`, a digit) loses its last character (e.g. `…(棄傌局)` →
  `…(棄傌局`). `list_cbl_games` (display) and `load_cb` (which overrides
  `book.info['title']` with `_decode_cbr_title`) both decode the fixed title field
  aligned (`_decode_slot`), so the editor shows AND saves the full title. Don't
  revert to the raw `read_from_cbr_buffer` title.
  - **`_decode_slot` must scan for the first EVEN-aligned `\x00\x00`, not just
    check whether the *first* `\x00\x00` is even.** A title like `001  一、…類`
    encodes as `…20 00`(space)`00 4E`(一=U+4E00, low byte 0x00)… → the space's
    high `00` + 一's low `00` form a SPURIOUS odd-offset `\x00\x00` at the char
    boundary. The old code saw that odd NUL, gave up on truncation, and returned
    the whole 128-byte field WITH its binary tail as PUA/control-char garbage.
    Any `編號 空格 一/二/三、…` title (very common in the 殺法/中局 books the CBL
    reader fix just surfaced) was affected. All-ASCII fields (GUID/email/dates)
    are unchanged — their chars never have a 0x00 low byte before the real
    terminator. Regression: `test_cbl_title_even_aligned_decode` in
    `tests/test_cb_roundtrip.py`.

## 中局練習題庫 (P0) (2026-06-30)

`backend/practice_service.py` turns the CBL corpus (殺法/戰術/中局 books) into a
middlegame-puzzle bank in the editor's OWN writable `output/practice.db`. A book
game = `cb_service.load_cb`'s `{init_fen, init_annote, roots}`; a puzzle = the
custom set-up position + one answer mainline + commentary. This is the depth
side of the editor's purpose (drill into one position), reusing the CBL stack —
**not** a new analysis pipeline. P0 = the offline extraction CLI; **P1 (the play
UI: 演示/評分/成績 routes + `editor-practice.js`) is not built yet.**

- **Read-only at the source; practice.db is the only thing this writes.** Same
  rule as `eval_cache` / the chessdb editor cache — never write the CBL, never
  touch positions.db. `connect()` builds three tables (`puzzles` keyed UNIQUE on
  `(source_rel, game_index)`, plus `attempts` / `progress` for P1's scoring +
  spaced-repetition). Re-extracting UPSERTs and does NOT clobber the engine
  columns (so a re-extract after a content fix keeps the arbitration).
- **The answer mainline is "first child every ply" (`_mainline`).** CBL puzzle
  trees store the solution as the main line; siblings are variations. Don't walk
  variations into the answer — the puzzle has ONE intended line (alternatives are
  judged at play-time by engine equivalence, not baked into `answer_iccs`).
- **Extraction filters are deliberate — and verified to drop only non-puzzles.**
  `build_puzzle` skips: `no-fen`, `no-answer` (front-matter like 内容提要/作者简介
  → empty roots), `too-short` (< `min_ply`, default 2 → trivial one-movers), and
  `opening-start` (init_fen == the standard start board → a 布局 game from move 1,
  NOT a middlegame set-up). Spot-checked: 弃子.CBL (17 布局譜 from std start) and
  攻防新战术's chapter headers correctly drop to 0; real tactic books (少子百局谱,
  弃子十三刀100例) all pass. So a "0 puzzles" book is genuinely 布局/前言, not a
  filter bug. Filters log per-reason counts — **no silent drops**.
- **Engine arbitration verdict ≠ puzzle quality gate.** `arbitrate` runs ONE
  Pikafish over the whole batch (reuses `engine_service.analyze_line_stream`, so
  the evals also land in the shared `editor_eval_cache.db` — re-arbitration is
  free). `_verdict`: `match` (engine_best == book's first move), `alt` (different
  first move but the mover is clearly winning — engine sees mate, or mover-POV
  cp ≥ 300 → book line is one of several equivalent wins), `doubt` (engine
  doesn't confirm the mover is winning). **`doubt` is a FLAG, not "delete".** At a
  shallow depth (12) deep sacrifice tactics (弃子) legitimately read as `doubt`
  because the material payback resolves deeper — re-run `arbitrate --fresh
  --depth <bigger>` to reduce false doubts. Don't auto-prune `doubt` rows.
- **Difficulty: ply placeholder, refined to mate-distance.** `_difficulty` seeds
  1..5 from the solver's move count (half the mainline plies) so `--no-engine`
  still gives a band; `arbitrate` then OVERRIDES it with the mate distance
  (`_mate_difficulty(|engine_mate|)`) whenever the engine finds a forced mate for
  the mover — mate-in-N is a far better signal than book-line length (which
  includes the opponent's replies + extra mop-up moves). Non-mate (cp) puzzles
  keep the ply placeholder. Glicko-2 is a later upgrade.
- **practice.db is generated data, gitignored (`output/`) — but the puzzle bank
  IS shared via a VERSIONED SEED.** The CBL corpus AND `output/practice.db` are
  both out of git, so another machine can't self-extract. The fix (chosen over
  committing practice.db whole, which would also version-control the user's
  attempts/progress + churn a 4.9MB blob every time you play): export just the
  `puzzles` table to `data/practice_seed.db` (committed; puzzles only, NO
  attempts/progress). On first launch a machine with an empty practice.db has the
  seed auto-loaded by `pooled()` (`_seed_puzzles_if_empty`) → the 🎯 entry lights
  up with zero setup. Attempts + spaced-repetition progress stay per-machine
  (never in the seed, never overwritten). `connect()` (the CLI extract/arbitrate
  path) deliberately does NOT auto-load — it must see the real local content.
  **After re-extracting the bank, run `export-seed` and commit the new seed**
  (`python -m backend.practice_service export-seed`). The frozen build bundles the
  seed via `server.spec` datas (`_MEIPASS/data/`), first-run loads it into the
  exe-adjacent `output/practice.db`. Seed path uses `_resource_base()` (repo root
  in source, `_MEIPASS` when frozen).
- **P1 routes grade the FIRST move against the book answer OR the stored
  `engine_best` — no live engine call.** `check_answer` reads the pre-computed
  `engine_best` (from arbitration) as the "engine-equivalent" acceptance, so an
  already-arbitrated puzzle grades instantly without spawning Pikafish. This is a
  first cut: it accepts exactly two moves (book first move + engine #1). True
  per-move equivalence (re-evaluate the user's actual move, accept if it keeps a
  winning eval) is a later iteration — don't assume the current grader covers
  every winning alternative. Multi-move line-solving is also future work (P1 cut
  grades move 1 only — the key move). Spaced repetition: `update_progress` is a
  3-box Leitner (learning +1d → review +3d → mastered +7d; a fail drops back to
  learning). `pooled()` late-binds `PRACTICE_DB_PATH` (not a signature default)
  so tests redirect it; it's a `db_pool` WAL connection — NEVER `.close()` it
  (route tests close+evict it from `db_pool._cache` only to free the temp dir).
- **The Flask routes only READ/grade; they never populate.** Filling practice.db
  is the offline CLI's job (`extract`). A fresh machine with no practice.db gets
  `pooled()` auto-creating empty tables → `/info` returns `exists:false` → the UI
  gates the practice entry off (same graceful-degradation as engine/eval info).
- **P1 frontend = a SELF-CONTAINED dialog with its OWN interactive board
  (`editor-practice.js`, state in `PRACTICE`).** It deliberately never touches
  `EDITOR`, the main `#board`, or the move tree — so it's a natural sandbox
  ("沙盒＝不落地"). It reuses only stateless shared helpers (`drawBoard`/
  `applyIccs`/coord fns from board.js, `editorColors`/`squareIccs`/`parseSquare`
  from editor.js — called at runtime so load order is fine) + the backend
  `legal-targets`/`move-info` validators and `/api/practice/*`. The clickable
  overlay is a lean copy of `installBoardOverlay` (`installPracticeOverlay`) that
  reads `PRACTICE` instead of `EDITOR` (no carried-piece float). DON'T wire
  practice into the main board to "save" that ~60 lines — the decoupling is the
  point (master picked the self-contained-dialog architecture 2026-06-30). Entry
  is `setupPractice()` (called once from editor.js boot) + a header `#practiceBtn`
  shown only when `/info` says the bank exists.
- **書目主題分頁 (2026-07-01, master-directed).** The CBL corpus is a folder tree
  (`象棋丛书/{作者}/{書}/{章}`, `棋研探秘/{主題}/`) but抽題 kept only the filename
  stem — the flat book dropdown read as「中殘混搭、無序」, and《象棋阶段强化训练手册》
  (~50 章節小檔) drowned the real books. Fix restores two levels **purely from
  `source_rel` folders** (NO schema change, NO re-extract): `_theme_of` classifies
  each book into 殺法/中局/殘局/戰術/其他 (priority-ordered — 殘局 must beat 殺法 for
  「实用残局…看杀局练心算」), and `_collection` collapses the manual's chapters into
  「阶段强化训练手册·<章節>」 (theme from the **section folder**, so 02-基本杀法→殺法,
  03-中局战术→中局). `practice_info` returns `themes:[{theme,count,books:[{book,count}]}]`
  (the dropdown's data源; flat `books` kept for back-compat). This derivation lives
  **only in `practice_service`** — `_resolve_srcs(theme,book)` reverse-maps a
  (主題, 收合後 collection label) pair to a `source_rel` set and `pick_puzzle` filters
  `source_rel IN (...)`; the frontend/SQL never re-derive theme. UI = 主題分頁 tabs
  (`renderPracticeTabs`, built from `/info themes`) atop the 書目 dropdown
  (`rebuildPracticeBooks`: 全部→optgroup by theme, 某主題→flat). **Clicking a tab
  persists `PREFS.practiceTheme`** (比照開局庫 `lastFile`) — restored on dialog open
  (`buildPracticeFilters` in `openPracticeModal`, since `setupPractice` runs before
  boot's `loadPreferences`). `book` param now = collection label (≠ book_title for
  manual sections). Regression: `test_theme_and_collection` / `test_info_themes_and_filter`
  in `tests/test_practice.py`. (成績 tab's `top_books` still groups raw book_title —
  not collapsed; low-priority follow-up.) **Book/難度下拉 onchange 亦即時換題**（與分頁一致，
  非「按下一題才生效」）。**UI 顯示名 2026-07-01 由「中局練習」改「中殘練習」**（題庫本就
  含殺法/戰術/中局/**殘局**，舊名誤導）——只改前端顯示字串＋按鈕/標題/設定標籤；內部識別碼
  （`practiceBtn`/`PRACTICE`/`practice_service`/practice.db/路由）與 doc 段名維持「中局練習」不動。
  **按鈕 icon 用 `ICON.puzzle`（Lucide 線稿，`iconLabel("puzzle","中殘練習")` 於 editor.js 底部
  init 區設定，同 saveBtn/走法/雲庫）——系統早已無彩色 emoji，勿再用 🧩/🎯。** 新 header 按鈕
  一律走 ICON registry + `iconLabel`，別寫死 emoji。
- **Solving flow (2026-06-30 redesign, master-directed):** the user plays their
  side on the practice board. A move matching the book answer at the current ply
  → the system auto-plays the opponent's book reply and the user keeps solving
  (`continueBookLine`); completing the whole line → 完全解出. A NON-answer move
  does NOT reveal/end — it shows a hint + the AI eval & the loss vs best
  (`enterSparring` runs ONE `analyze-line` over `[preFen, postFen]` at
  `PRACTICE.aiDepth`, `fmtEval`/`fmtGap` render it mover-POV), then OPENS
  play-vs-AI from that position: the engine replies at depth `aiDepth`
  (`sparEngineReply`) and the user can spar on. Depth defaults to 20, set via
  `PREFS.practiceAiDepth` (settings field `#practiceDepthInput`).
  - **Stats record the FIRST move only, once** (`recordFirstMove` → `/check`,
    guarded by `PRACTICE.recorded`): finding the key move = pass. The multi-move
    continuation and the spar are for learning, NOT re-graded — don't add per-ply
    `/check` calls (would inflate the attempt count).
  - **Grading is LOCAL** (compare to `answer_iccs[plyIdx]`); `/check`'s server-
    side grade is used only to record the first move. The engine (`analyze-line`,
    cached in `editor_eval_cache.db`) is hit only on a wrong move / during spar —
    NOT on every move. No engine configured → wrong move degrades to reveal-answer
    (`_spar:"noEngine"`), never a hard error.
  - Only own-side pieces are selectable (`practicePieceSide` vs
    `practiceSideToMove`), so the user can't accidentally move the engine's side.
  - Still-open iterations: per-move engine equivalence (a non-book but equally-
    winning move currently counts as "wrong" → enters spar with ~0 loss, which
    reads fine but isn't celebrated), and richer spar UX (live depth ticker).
- **Spar must feed the engine the MOVE HISTORY, not just a FEN — else it
  perpetual-checks (長將).** A single `position fen <fen>` gives Pikafish NO
  repetition context, so from a winning position it keeps picking the same
  checking move forever. Pikafish DOES implement the Chinese repetition rules
  (perpetual check = loss for the checker) but ONLY when handed the history via
  `position fen <start> moves <m1 m2 …>` (confirmed against the official Pikafish
  UCI wiki — there is NO setoption for this; history is the mechanism). So spar
  replies go through `POST /api/practice/engine-move {fen, moves, depth}` →
  `engine_service.bestmove_with_moves` (one-shot, NOT cached — the best move
  depends on history, so an eval-cache keyed by FEN alone would mis-hit). The
  frontend tracks every applied move from `init_fen` in `PRACTICE.moves`
  (`practiceApply`) and sends the full list each spar turn. Flip note: the eval
  is red-POV, but `_engine_fen`'s flip keys off the START fen's side — after an
  ODD number of `moves` the side-to-move has flipped, so `bestmove_with_moves`
  negates the flip for odd-length histories. Belt-and-suspenders: the frontend
  also 3-fold-repetition-guards (`PRACTICE.fenCounts`, `practiceTrackFen`) and
  ends the spar as a draw (`endSparRepetition`) if any position recurs 3×.

## CWP 造字區「車」亂碼 (2026-06-08)

The `以民金儒` CWP corpus (1267 files) was authored in CCBridge, which stuffed 車
into a Big5 user-defined (造字/EUDC) slot `FB 7A` that only its bundled font could
render. Standard Big5/cp950/HKSCS can't map it, so the old `cwp→xqf→cbl` pipeline
turned 車 into `�z` (U+FFFD + the stray ASCII `z`). CCBridge itself now shows it
broken too (font gone). It's the **only** EUDC code in the whole corpus (17 hits,
11 files), always meaning 車.

- **Root cause fixed in `vendor/io_cwp.py`** — a `cwp_eudc` codec error handler maps
  `FB7A`→車 (table `_CWP_EUDC`), boundary-safe (only fires when `0xFB` is a real
  lead byte). Future conversions are correct. To add more recovered EUDC codes,
  extend `_CWP_EUDC` — but verify against the corpus first; there were no others.
- **Already-converted files have the `�z` baked in.** `tools/fix_che_title.py`
  repairs them in place (`�z`→車 in `.cbl` index+CBR title slots and `.xqf`
  titles; backs up `.bak`; `--dry-run` to preview). It does NOT re-parse move
  trees — verified GUIDs + all 824 games byte-stable on 中貴棋譜.cbl. Re-running
  the conversion pipeline would also work but clobbers any manual marks/edits, so
  prefer the in-place tool for files already in use.

## Distribution (zip + setup.ps1, user-configured) (2026-06-04)

The app is a local-only single-user tool; "cloud-hosting for everyone" is a
non-goal (engine exec, file writes, and the shared chessdb politeness budget
are all single-user assumptions). The supported way to share it is: **ship the
source, let each user run it on their own machine with their own engine + data.**

- **cchess is installed from a VENDORED WHEEL** (`vendor/wheels/cchess-*.whl`),
  not from GitHub. A pinned `git+…@commit` still breaks if upstream deletes the
  repo, goes private, or force-pushes (the commit gets GC'd) — and needs live
  network to GitHub on every fresh install. The committed wheel removes all of
  that: zero upstream trust, zero network for cchess, exact bytes. It's
  `py3-none-any` (pure Python) so one file covers every OS + Python 3.
  `requirements.txt` references the wheel by **direct path** (not `cchess==…`)
  so pip can't substitute a same-numbered-but-different PyPI build (PyPI 1.26.2
  ≠ this commit, whose internal `__version__` is 2.27.0).
  **To bump**: rebuild the wheel (`pip wheel "cchess @ git+…@<commit>" -w
  vendor/wheels/ --no-deps`), re-run `tests\test_roundtrip.py` (must stay all-
  green — the writer couples to cchess internals), then swap the wheel + path.
- **cchess is GPLv3.** Bundling the wheel is permitted, but distributing the
  editor with it obligates the editor to stay GPL-compatible and ship source —
  already true (we ship full source, and `import cchess` makes it a combined
  work regardless). Don't relicense the editor as proprietary while it links
  cchess.
- **`FLASK_DEBUG` gates the Werkzeug debugger** (`backend/app.py`, default
  OFF). Never ship a build that boots with debug on — it's an interactive RCE
  console. Opt in locally with `FLASK_DEBUG=1`.
- **`/api/xqf/list` degrades, doesn't 500, when the root is missing** — returns
  `{needsRoot:true}` (200) and the UI shows a 📂 picker. Engine + eval-DB
  absence were already graceful (`engine/info`/`eval/info` `exists:false` gate
  the UI). The XQF root was the one hard-crash on a fresh machine; now fixed.
- **Never package `preferences.json`** — it holds master's absolute paths
  (`xqfRoot`/`evalDbPath`/`lastFile`) and is `.gitignore`d. Ship
  `preferences.example.json` (no machine paths). Use `git archive` for the zip,
  NOT a raw folder copy (which would sweep in the gitignored prefs + venv).
- **Engine / positions.db / library not bundled in the SOURCE/zip flow**
  (Pikafish is GPLv3 + microarch-specific; eval DB is the AI repo's data) — set
  via the UI pickers, app runs fine without any. **But the frozen exe build
  (`package.ps1`) DOES stage them next to the exe** so a fresh machine runs
  zero-config: `engine\Windows\` (Pikafish Windows builds + `pikafish.nnue`),
  `samples\` (library), and `positions.db` (eval cache, opened read-only). The
  frozen `DEFAULT_*` block points at these exe-adjacent copies; any still-absent
  one degrades gracefully (`eval/info`/`engine/info` `exists:false`).
- **PRIMARY frozen build = the SERVER exe (`server.py` + `server.spec`, built by
  `package.ps1`).** Needs NO Python on the user's box: PyInstaller freezes Flask
  into `dist\ChessBookEditor\ChessBookEditor.exe`; it prints `http://127.0.0.1:
  5174/` to the console and the user opens it in **their own browser**. No
  pywebview/pythonnet — that deliberately dodges the `Python.Runtime.dll`
  assembly-load failure + most MOTW breakage an embedded-webview shell hits, and
  keeps the bundle plain-Flask. `package.ps1` stages engine + samples +
  positions.db next to the exe (~93MB total). `_pick_port` walks 5174+ for a free
  port. The
  exe doubles as its own picker via the `--pick` arg (see picker bullet).
  **Frozen path-split is load-bearing**: `_MEIPASS` (read-only `frontend/`) vs
  exe-adjacent dir (writable `preferences.json`/`output/`, AND the staged
  `samples\`/`engine\`) — see `_resource_base`/`_data_base` + the frozen-aware
  `DEFAULT_XQF_ROOT`/`DEFAULT_PIKAFISH` block in `backend/config.py` (since T2-2;
  was `backend/app.py`); never let prefs land in temp `_MEIPASS`. `package.ps1` drops `$ErrorActionPreference` to
  Continue around the PyInstaller call (it logs INFO to stderr → PS would treat
  each line as a terminating NativeCommandError under Stop) and gates on the real
  exit code. Before shipping: code-sign (else SmartScreen/AV may flag the
  unsigned bootloader exe), ship `preferences.example.json` next to the exe.
  (History: a pywebview single-window shell — `desktop.py`/`desktop.spec` — was
  tried first but REMOVED 2026-06-09; pythonnet's `Python.Runtime.dll` failed to
  load from an MOTW'd zone on other machines, so the plain-Flask server replaced
  it. Don't reintroduce an embedded webview without solving that.)
- **Folder/file pickers split by frozen-ness (`backend/picker_service.py`
  `_pick_folder`/`_pick_file` → `_subprocess_pick`; since T2-2, was `app.py`).**
  tkinter's mainloop needs the main thread,
  so a picker always runs in a SHORT-LIVED subprocess, never inline. The catch:
  `[sys.executable, "-c", …]` only runs python in a SOURCE run. In the frozen exe
  `sys.executable` is the bootloader — `-c …` would re-launch the whole app. So
  frozen re-enters its OWN `--pick` branch (`server.py`), which runs the SAME
  tkinter body (`backend/tk_picker.run_from_env`, driven by env vars). tkinter is
  bundled via `server.spec` hiddenimports. Any NEW picker must go through
  `_pick_folder`/`_pick_file`, never call `sys.executable -c` directly. File
  filters use a `"Label (*.a;*.b)"` spec; `_web_types_to_tk` converts it for
  tkinter.
- **MOTW (Mark-of-the-Web) on OTHER machines.** Copied via zip/network, every
  file gets a Zone.Identifier. **The server exe has no .NET assembly, so it just
  RUNS** — but MOTW / AV can still quarantine the bootloader exe, or SmartScreen
  may warn once on an unsigned exe from an untrusted zone. (The since-removed
  pywebview POC failed HARD here instead: .NET refused to load pythonnet's
  managed assembly from an untrusted zone — `Failed to resolve
  Python.Runtime.Loader.Initialize` — and the window never opened. That class of
  failure is gone with the embedded webview.) Mitigate on the target box:
  `Get-ChildItem -Recurse | Unblock-File`; or ship via an installer (Inno Setup —
  installed files carry no MOTW); or code-sign. A SELF-signed cert does NOT help
  other machines (their trust store doesn't have it) unless you also import its
  public key into their Trusted Root — about as much friction as Unblock-File.

## Gotchas

- **Don't `pip install --upgrade cchess` globally.** chess-book-ai uses the
  older cchess (with `read_xqf.py`); upgrading there breaks it. Keep cchess
  versions per-venv.
- **Annote encoding = GB18030.** Master wants Traditional Chinese preserved.
  Upstream uses GBK and silently drops chars. The patch handles this.
- **`Move.variation_next` is unreliable for deep variations.** Walk
  `move.next_move.variations_all` instead. See `vendor/io_xqf_patched.py`
  docstring bug #2.
- **Loading a big variation tree is dominated by cchess's per-move 將軍/將死.**
  `board.move()` calls `is_checking()` (recomputes the 10×9 attack matrix) +
  `is_checkmate()` on EVERY move just to set `move.is_check`/`.is_checkmate` —
  flags `book_to_json`/中文著法 never read. On a 22589-move file that's ~9s of
  pure overhead. `fast_parse_book()` (xqf_service) short-circuits
  `is_checking`→False for the parse window only: **byte-identical output**
  (verified against the full parse) and ~3x faster (9s→3s). `load_xqf` AND
  `cb_service.load_cb` both wrap their cchess read in it. **T3-4**: it's gated on
  a **thread-local flag** (`_suppress_check`), not a global class-method swap —
  `ChessBoard.is_checking` is wrapped once and returns False only when the
  CURRENT thread is inside `fast_parse_book()`. So a ~3s parse on one Flask
  thread no longer disables check detection on another thread doing move
  validation/auto-play/engine (the old global swap did, `threaded=True`).
  Reentrant-safe (restores prior flag); no lock needed. Still **never widen its
  scope to the editing path** (the flag must only be set around the cchess read).
- **Test source path is hard-coded** to `D:\Elton\TestArea\chess-book\` in
  `tests/test_roundtrip.py`. If the source library moves, update `SRC_ROOT`.
- **AI 自動走棋靠 `go movetime`，不是新後端。** `/api/engine/analyze` 早就吃
  `movetime`＋回 `{done,bestmove}`，自動走子只是前端 `requestBestMove` 帶
  `movetime=步時×1000`、拿 `done.bestmove`（步時到＝當前最高分著）。`bestmove
  (none)`＝終局即停。**別為此加後端端點。** **自動走棋一律沙盒**（`ap.recording`
  釘死 false，UI 開關已移除）：走子在 `EDITOR.autoPlay.sandboxLine`，**不碰走子樹**，
  停止即 `navigateTo(startPath)` 還原；要落地按 🤖AI走棋 分頁歷程**最新一步**的「加入」
  （`addPvLine`）。換檔/換目錄走 `stopAutoPlay(null,false)` 只清狀態不還原。**盤面渲染**分流的開關是
  `boardFen()`（沙盒回末筆 fen，否則 `currentFen()`）；**輸入驗證**另有 `inputFen()`——平時＝`boardFen()`，
  唯獨 `reviseMove`（紅方待走時點黑子改黑的上一步）回**決策點** `analysisFen`，好讓盤面不動而輸入吃走子前局面。
  新增會吃盤面 fen 的渲染碼用 `boardFen()`、吃輸入 fen 的（合法著點/著法驗證）用 `inputFen()`，別寫死 `currentFen()`。
  人機輪替（只勾一方）靠 `tryAddMove` 末的 `maybeResumeAutoPlay`。

## Master's working style (carried over from chess-book-ai)

- 稱呼「尊敬的主人」
- Traditional Chinese, terse
- Pushes back on sloppy engine-output interpretation
- Wants exploratory questions answered with recommendation + main trade-off
  in 2-3 sentences, not implementation
