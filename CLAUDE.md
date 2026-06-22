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
  the post-move framing so the eval line agrees with the trend chart.) **Trade-off
  (master's call): the LAST ply's post-leaf position isn't in positions.db, so the
  final move shows no 深N — deliberately NOT patched** (the live engine / trend
  chart already carries that number if needed). Depth data comes from the
  `fetchEvalsForFile` batch (`collectAllFens` already includes every node's
  post-move FEN) — no per-navigation network call.
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
  fix exploits CBL being **fixed 4096-byte records** at `66624 + book_count*276`
  (`cbl_index_fix`'s linear offset): `_cbl_record_starts` finds each record by
  the `CCBridge Record` magic + 4096 stride (no move parse). `list_cbl_games`
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
  aligned, so the editor shows AND saves the full title. Don't revert to the raw
  `read_from_cbr_buffer` title.

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
  （`addPvLine`）。換檔/換目錄走 `stopAutoPlay(null,false)` 只清狀態不還原。輸入/盤面分流的唯一開關是
  `boardFen()`（沙盒回末筆 fen，否則 `currentFen()`）——新增會吃盤面 fen 的程式碼要用它而非
  `currentFen()`。人機輪替（只勾一方）靠 `tryAddMove` 末的 `maybeResumeAutoPlay`。

## Master's working style (carried over from chess-book-ai)

- 稱呼「尊敬的主人」
- Traditional Chinese, terse
- Pushes back on sloppy engine-output interpretation
- Wants exploratory questions answered with recommendation + main trade-off
  in 2-3 sentences, not implementation
