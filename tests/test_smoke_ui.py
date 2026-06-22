"""Browser smoke test — drives the real editor UI end-to-end in Chromium.

The first automated check of the FRONTEND state machine (route tests live in
tests/test_routes.py). It boots the real Flask app in an ISOLATED sandbox (temp
prefs + a temp library holding ONE copied sample XQF + stubbed chessdb), then
walks the core editing loop:

    boot -> open file -> board renders -> navigate -> edit annote -> save
    -> reload -> annote persisted

Isolation (see tests/_smoke_server.py): never touches the user's real
preferences.json / library / chessdb cache / eval DB, never hits the network.

Portable by design: if Playwright, its Chromium, or the sample is unavailable
the test SKIPs (exit 0) with a clear message instead of failing — so CI without
browsers stays green. On a dev box with Chromium installed it runs in full.

Run:
    .\.venv\Scripts\python.exe tests\test_smoke_ui.py
"""
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LAUNCHER = ROOT / "tests" / "_smoke_server.py"
SAMPLE = ROOT / "samples" / "xqf" / "牛頭滾.XQF"
MARK = "SMOKE-TEST-ANNOTE-牛頭滾"

_failures = []


def check(name, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + name + ("" if cond else f"  {detail}"))
    if not cond:
        _failures.append(name)


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _wait_server(base: str, proc: subprocess.Popen, timeout: float = 25) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"server exited early (code {proc.returncode})")
        try:
            with urllib.request.urlopen(base + "/api/preferences", timeout=1) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(0.25)
    raise RuntimeError("server did not come up in time")


def _serve(lib, prefs, cache):
    """Start a fresh sandbox server on a free port and wait for it. Returns
    (proc, base). The reload-verify phase uses a SECOND fresh server rather than
    re-hitting the first: the werkzeug dev server intermittently wedges on a 2nd
    full page-load against the same instance after the edit session's keep-alive
    burst (handlers complete but responses stall). A fresh server mirrors a real
    app restart and still verifies disk persistence + auto-open render."""
    port = _free_port()
    base = f"http://127.0.0.1:{port}"
    proc = subprocess.Popen(
        [sys.executable, str(LAUNCHER), str(port), str(lib), str(prefs), str(cache), str(ROOT)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
    )
    _wait_server(base, proc)
    return proc, base


def _open_sample(page, base, rel):
    """(Re)open the sample file and wait until the board has rendered pieces."""
    page.wait_for_selector("#fileTree", timeout=15000)
    page.click(f'li.file[data-rel="{rel}"]', timeout=15000)
    page.wait_for_function(
        "document.querySelectorAll('#board text').length > 10", timeout=15000)


def main() -> int:
    # --- availability gates -> SKIP (keep portable / CI-safe) ----------------
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        print(f"SKIP: playwright unavailable ({e})")
        return 0
    if not SAMPLE.exists():
        print(f"SKIP: sample missing ({SAMPLE})")
        return 0

    # --- temp sandbox --------------------------------------------------------
    work = Path(tempfile.mkdtemp(prefix="cbe_smoke_"))
    lib = work / "lib"
    lib.mkdir()
    shutil.copy2(SAMPLE, lib / SAMPLE.name)
    prefs = work / "preferences.json"
    prefs.write_text("{}", encoding="utf-8")
    cache = work / "cache.db"
    rel = SAMPLE.name

    proc, base = _serve(lib, prefs, cache)
    browser = None
    try:
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as e:
                print(f"SKIP: chromium launch failed ({e}); run `python -m playwright install chromium`")
                return 0
            page = browser.new_page(viewport={"width": 1600, "height": 1000})
            page_errors = []
            page.on("pageerror", lambda e: page_errors.append(str(e)))

            # --- boot ---
            # wait_until="load" (not "networkidle"): the app loads several
            # classic scripts + lazy fonts + a second wave of API calls on
            # auto-open, so the network rarely goes 500ms-idle within the
            # timeout (Playwright discourages networkidle for exactly this).
            # "load" + the explicit element waits below are the robust check.
            page.goto(base, wait_until="load", timeout=20000)
            page.wait_for_selector("#fileTree", timeout=15000)
            check("boot: no uncaught page errors", not page_errors, str(page_errors[:3]))

            # --- open the sample ---
            _open_sample(page, base, rel)
            piece_count = page.eval_on_selector_all("#board text", "els => els.length")
            check("open: board renders pieces", piece_count > 10, f"got {piece_count}")
            check("open: file title set", bool((page.text_content("#fileTitle") or "").strip()),
                  repr(page.text_content("#fileTitle")))
            move_rows = page.eval_on_selector_all("#moveList *", "els => els.length")
            check("open: move list populated", move_rows > 0, f"got {move_rows}")

            # --- navigate to the first move ---
            page.click("#navNext")
            page.wait_for_timeout(300)
            annote_disabled = page.get_attribute("#annoteBox", "disabled")
            check("navigate: annote editable at a move", annote_disabled is None,
                  "annoteBox disabled after navNext")

            if annote_disabled is None:
                # --- edit annote + save ---
                page.fill("#annoteBox", MARK)
                page.wait_for_timeout(150)   # let the input handler (commitAnnoteEdit) run
                check("edit: save button actionable", page.get_attribute("#saveBtn", "disabled") is None,
                      "saveBtn disabled")
                page.click("#saveBtn")
                page.wait_for_function(
                    "() => { const s = document.querySelector('#status');"
                    " return s && s.textContent.includes('已儲存'); }", timeout=15000)
                check("save: status shows 已儲存", True)

                # --- reload (fresh server) + verify persistence to disk ---
                # Fresh server avoids the same-instance reload wedge (see _serve);
                # reopening reads the just-saved file from disk, so finding MARK
                # confirms it persisted.
                page.close()
                proc.terminate()
                proc, base = _serve(lib, prefs, cache)
                page = browser.new_page(viewport={"width": 1600, "height": 1000})
                page.goto(base, wait_until="load", timeout=20000)
                _open_sample(page, base, rel)
                # The fresh server ALSO auto-opens lastFile (the edit session
                # persisted it to prefs), so _open_sample's explicit re-open races
                # the boot auto-open: a late auto-open re-render can reset
                # activePath right after a single navNext click, leaving us on the
                # init position (empty annote) — a TEST-ONLY flake, not a save bug
                # (the edited node is on disk; reopened EDITOR.data.roots[0].annote
                # already holds MARK). Poll-click navNext until the first move
                # actually activates, defeating the race deterministically.
                page.wait_for_function(
                    "() => { if (JSON.stringify(EDITOR.activePath) === '[0]') return true;"
                    "  const b = document.querySelector('#navNext'); if (b) b.click();"
                    "  return false; }", timeout=8000)
                annote_val = page.input_value("#annoteBox")
                check("reload: annote persisted to file", MARK in (annote_val or ""),
                      f"got {annote_val!r}")

            browser.close()
            browser = None
    except Exception as e:
        # Surface server output to debug a launch/boot failure.
        out = ""
        try:
            proc.terminate()
            out = (proc.stdout.read() or "")[:2000] if proc.stdout else ""
        except Exception:
            pass
        print(f"  FAIL  harness error: {e}")
        if out:
            print("  --- server output ---\n" + out)
        _failures.append("harness error")
    finally:
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        shutil.rmtree(work, ignore_errors=True)

    print()
    if _failures:
        print(f"FAILED: {len(_failures)} check(s): {', '.join(_failures)}")
        return 1
    print("ALL SMOKE CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
