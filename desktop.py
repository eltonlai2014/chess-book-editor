"""pywebview desktop shell — POC.

Wraps the EXISTING Flask backend in a native desktop window, replacing the
"run a server in a terminal + open a browser" flow. Nothing about the backend
or frontend changes; only the presentation layer:

    [native OS webview window] --HTTP--> [Flask on 127.0.0.1:<port>]
                                          (same Python process, daemon thread)

Why pywebview instead of Electron: the backend is Python. pywebview drives the
OS's own webview (WebView2 / Edge on Windows 11 — already installed, no
Chromium shipped) and stays in one language. See the Electron trade-off notes.

Run the POC (after `pip install pywebview` into the venv):
    .\.venv\Scripts\python.exe desktop.py

Headless smoke check (starts Flask, verifies it answers, then exits — does NOT
open a window; for CI / verifying on a box with no display):
    .\.venv\Scripts\python.exe desktop.py --check
"""
from __future__ import annotations

import socket
import sys
import threading
import time
import urllib.request
from pathlib import Path

# Make `backend` / `vendor` importable when run from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from backend.app import app  # noqa: E402


def _free_port() -> int:
    """Grab an OS-assigned free port. The frontend uses same-origin relative
    URLs, so the port is irrelevant to it — picking a free one avoids clashing
    with a dev server already holding :5174."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _serve(port: int) -> None:
    # No reloader (it would fork a second process), no debugger (interactive
    # RCE console — never in a shipped build).
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)


def _wait_until_up(port: int, timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1) as r:
                if r.status == 200:
                    return
        except Exception as e:  # noqa: BLE001 — server not up yet
            last_err = e
        time.sleep(0.1)
    raise RuntimeError(f"Flask did not answer on :{port} within {timeout}s ({last_err})")


def main(check_only: bool = False) -> None:
    port = _free_port()
    threading.Thread(target=_serve, args=(port,), daemon=True).start()
    _wait_until_up(port)

    if check_only:
        print(f"OK - Flask is serving on http://127.0.0.1:{port}/ (window skipped)")
        return

    import webview  # imported lazily so --check works without the GUI dep

    webview.create_window(
        "象棋打譜機 · XQF Editor",
        f"http://127.0.0.1:{port}/",
        width=1280,
        height=860,
        min_size=(960, 640),
    )
    # Blocks until the window is closed; the daemon Flask thread dies with us.
    webview.start()


if __name__ == "__main__":
    main(check_only="--check" in sys.argv[1:])
