# CLAUDE.md

Guidance for Claude Code when working in this repo.

## Project

Browser-based XQF editor. Pairs with [chess-book-ai](../chess-book-ai/)
(opening-book analyser + static site) but is intentionally separate:

| | chess-book-ai | this repo |
|---|---|---|
| Purpose | Analyse XQF, surface engine-vs-book traps | **Edit** XQF (moves, variations, annotes) |
| Backend | None (batch Python → static HTML) | Flask/FastAPI for POST /xqf/save |
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

- **Analysis features** (depth-22 engine eval, trap detection, traps.html) →
  chess-book-ai. Don't pull pikafish/engine code into this repo.
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
