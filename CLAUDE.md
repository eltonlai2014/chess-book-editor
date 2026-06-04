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
| Backend | None (batch Python → static HTML) | Flask/FastAPI for POST /xqf/save + live engine SSE |
| Deploy | GitHub Pages (public) | Local-only tool |
| cchess | old install (read_xqf.py only) | new install + `vendor/io_xqf_patched.py` |

Shared read-only data: `D:\Elton\TestArea\chess-book\` (41 originals + AI/ subset).

## Status (as of repo init)

Only the **persistence layer** is built and verified:

- `vendor/io_xqf_patched.py` — `PatchedXQFWriter`. Subclasses upstream
  `cchess.io_xqf.XQFWriter`, fixes three bugs (variation collapse, sibling
  pointer mismatch, annote encoding loss). See the module docstring for the
  precise reasoning.
- `tests/test_roundtrip.py` — 46/46 perfect round-trip on the XQF library
  (compares the FULL set of root-to-leaf move+annote paths). Upstream writer
  scores 0/46 on the same test.
- `samples/` — XQStudio-verified output files (manually opened by the master).

Nothing else is built yet: no editor UI, no backend, no shared board library.

## Commands

```powershell
# Setup (one-time)
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install "git+https://github.com/walker8088/cchess.git@master"

# Verify writer (whenever cchess updates or PatchedXQFWriter changes)
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
