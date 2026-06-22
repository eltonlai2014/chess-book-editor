"""Native OS folder/file pickers via a short-lived subprocess (T2-2 split out of
app.py).

tkinter's mainloop needs the main thread, so a picker can NEVER run inline in a
Flask worker thread — it always goes through a one-shot subprocess:
  * Browser / dev (run-dev.ps1): ``sys.executable`` is a REAL python -> run the
    tkinter body via ``python -c``.
  * Frozen server exe (server.py -> ChessBookEditor.exe): ``sys.executable`` is
    the bootloader, so ``[sys.executable, "-c", …]`` would re-launch the app.
    Instead re-enter the exe's OWN ``--pick`` branch, which runs the SAME tkinter
    body (backend/tk_picker.run_from_env). tkinter IS bundled (server.spec).

Both paths run backend/tk_picker.run_from_env, driven entirely by env vars set
here. Any NEW picker must go through _pick_folder / _pick_file — never call
``sys.executable -c`` directly.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys


def _web_types_to_tk(file_types):
    """Convert a ``'Label (*.a;*.b)'`` filter spec to tkinter filetypes
    ``[('Label', '*.a *.b')]``."""
    out = []
    for s in file_types:
        m = re.match(r"^(.*?)\s*\(([^)]*)\)\s*$", s)
        if m:
            label = m.group(1).strip() or "Files"
            pats = m.group(2).replace(";", " ").strip() or "*.*"
        else:
            label, pats = s, "*.*"
        out.append([label, pats])
    return out or [["All files", "*.*"]]


# Dev route runs the picker via `python -c`; the import works because the dev
# subprocess inherits cwd=repo-root (run-dev.ps1), so `backend.tk_picker` resolves.
_PICK_DEV_CMD = "from backend.tk_picker import run_from_env; run_from_env()"


def _subprocess_pick(mode: str, title: str, initialdir: str, file_types) -> str:
    """One-shot native dialog via a short-lived subprocess. dev -> ``python -c``;
    frozen -> the exe's ``--pick`` branch. Both run backend/tk_picker.run_from_env,
    driven entirely by the env vars set here."""
    env = {
        **os.environ,
        "PICK_MODE": mode,
        "DIALOG_TITLE": title,
        "INITIAL_DIR": initialdir or "",
        "PYTHONIOENCODING": "utf-8",
    }
    if file_types:
        env["FILE_TYPES_TK"] = json.dumps(_web_types_to_tk(file_types))
    if getattr(sys, "frozen", False):
        cmd = [sys.executable, "--pick"]
    else:
        cmd = [sys.executable, "-c", _PICK_DEV_CMD]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=300, env=env)
    except Exception as e:  # noqa: BLE001 — timeout / spawn failure == "no pick"
        print(f"[pick] subprocess dialog failed: {e}", file=sys.stderr)
        return ""
    return proc.stdout.decode("utf-8", errors="replace").strip()


def _pick_folder(title: str, initialdir: str) -> str:
    return _subprocess_pick("folder", title, initialdir, None)


def _pick_file(title: str, initialdir: str, file_types) -> str:
    return _subprocess_pick("file", title, initialdir, file_types)
