"""Standalone launcher for the frozen .exe — the PRIMARY distribution path.

Starts the existing Flask backend, prints the URL to the console, and lets the
user open it in THEIR OWN browser (Chrome/Edge/whatever). No pywebview, no
pythonnet, no embedded WebView2:

    [console: prints http://127.0.0.1:<port>/] --> [user's own browser] --HTTP--> [Flask]

Why browser+console over an embedded webview shell: keeping the bundle to plain
Flask dodges the whole pythonnet/.NET stack — which on other machines tripped
the `Python.Runtime.dll` assembly-load failure and most of the Mark-of-the-Web
breakage — and the user gets their familiar browser (zoom, DevTools, bookmarks)
instead of an embedded webview whose chrome we'd have to re-implement.

Modes:
    ChessBookEditor.exe            start the server, print the URL
    ChessBookEditor.exe --pick     internal: run one native file/folder dialog
                                    (the in-app pickers re-enter the exe here;
                                    see backend/tk_picker.py)

Dev run (no freeze needed):  .\.venv\Scripts\python.exe server.py
"""
from __future__ import annotations

import socket
import sys
from pathlib import Path

# Make `backend` / `vendor` importable when run from the repo root or frozen.
sys.path.insert(0, str(Path(__file__).resolve().parent))


def _pick_port(preferred: int = 5174) -> int:
    """Bind the first free port at/after `preferred` so the URL is stable across
    runs (and a stale server on 5174 doesn't wedge startup)."""
    for port in range(preferred, preferred + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return preferred


def _serve() -> None:
    from backend.app import app

    port = _pick_port()
    url = f"http://127.0.0.1:{port}/"
    bar = "=" * 52
    # ASCII-only banner: a Windows console is cp950 by default and would mangle
    # CJK even with utf-8 stdout. The URL — the one thing the user must copy — is
    # ASCII, so this stays clean everywhere.
    print(
        f"\n{bar}\n"
        f"  Chess Book Editor is running.\n"
        f"  Open this in your browser:  {url}\n"
        f"  Keep this window open; close it to stop the server.\n"
        f"{bar}\n",
        flush=True,
    )
    # No reloader (would fork a second process), no debugger (interactive RCE).
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)


def main() -> None:
    if "--pick" in sys.argv[1:]:
        from backend.tk_picker import run_from_env

        run_from_env()
        return
    _serve()


if __name__ == "__main__":
    main()
