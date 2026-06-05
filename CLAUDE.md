# CLAUDE.md

Guidance for Claude Code when working in this repo.

> **先讀 [ARCHITECTURE.md](ARCHITECTURE.md)** — 系統功能、設計原則速查、以及
> 「功能 → 程式碼 `file:line`」對照表。改任何功能前先在那裡定位。本檔聚焦
> 「為什麼」與陷阱；ARCHITECTURE.md 聚焦「在哪裡、做什麼」。

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

- **Editor UI + Flask backend** — browse library, open/edit/save XQF, tree
  ops (add/delete move, promote variation, edit metadata, new file).
- **Live engine analysis (SSE)** — execs Pikafish, streams depth/score/PV;
  ephemeral, nothing persisted. Plus the AI whole-line score-trend chart.
- **Eval + cloud integration** — read-only evals from chess-book-ai's
  `positions.db`, and live chessdb.cn cloud-library lookup (cache-first).
- **Format-conversion CLIs** — XQF ⇄ CBL/CBR (CCBridge3) ⇄ CWP, with the
  vendored reader/writer stack.

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
- **Trap / brilliant thresholds** in `editor.js` (`SKIP_OPENING_PLIES`,
  `TRAP_SHALLOW_MAX`, `TRAP_DEEP_MIN`, `BRILLIANT_MIN`, `BRILLIANT_MAX`)
  **must stay in sync with `chess-book-ai/site_builder/render_site.py`**.
  Same goes for the `_ply_loss` formula. There's a sanity-check script:
  `backend/test_trap_spotcheck.py`.
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
  three guards if you touch it.
- **Cloud queries the BRANCH POINT (前一步), not the post-move position.** The
  cloud list must show "what moves are playable at this decision" (the active
  move + its alternatives), not "how the opponent replies to the move just
  played". So cloud is keyed to `cdbFen()` (= `analysisFen`, one ply back) and
  clicking a cloud move adds it as a *sibling* at the branch point
  (`addCdbMove`→`insertMoveAt(branchPath,…)`), NOT a child of the active move.
  The depth-eval cells in `#evalLine` stay on `currentFen()` (static eval of the
  position as shown) — deliberately a different FEN from the 雲 cell.
- **Return shape mirrors `eval_service`'s `cdb`** (`{status, moves, best,
  source}`) so cached (batch) and live results share `renderEvalLine` /
  `renderCdbTab`. Scores are mover-POV cp; UI flips to red POV for display.
- **Known traps** (NUL byte, FEN trim to `<position> <side>`, http-not-https,
  single-string error states) are handled in `query_chessdb` — see
  `docs/CHESSDB_CLOUD_QUERY.md` for the why.

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
- **Engine + positions.db are NOT bundled.** Pikafish is GPL and microarch-
  specific (avx2 vs plain); the eval DB is the AI repo's data. Users set both
  via the UI pickers; the app runs without either.

## Gotchas

- **Don't `pip install --upgrade cchess` globally.** chess-book-ai uses the
  older cchess (with `read_xqf.py`); upgrading there breaks it. Keep cchess
  versions per-venv.
- **Annote encoding = GB18030.** Master wants Traditional Chinese preserved.
  Upstream uses GBK and silently drops chars. The patch handles this.
- **`Move.variation_next` is unreliable for deep variations.** Walk
  `move.next_move.variations_all` instead. See `vendor/io_xqf_patched.py`
  docstring bug #2.
- **Test source path is hard-coded** to `D:\Elton\TestArea\chess-book\` in
  `tests/test_roundtrip.py`. If the source library moves, update `SRC_ROOT`.

## Master's working style (carried over from chess-book-ai)

- 稱呼「尊敬的主人」
- Traditional Chinese, terse
- Pushes back on sloppy engine-output interpretation
- Wants exploratory questions answered with recommendation + main trade-off
  in 2-3 sentences, not implementation
