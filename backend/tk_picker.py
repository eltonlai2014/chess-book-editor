"""One-shot native file/folder picker, driven entirely by environment vars.

Run as a SHORT-LIVED subprocess, never inline: tkinter's mainloop wants the
main thread, so calling it from a Flask worker thread hangs or crashes. Two
callers funnel through here (see backend/app.py `_subprocess_pick`):

  * dev / source run : `python -c "from backend.tk_picker import run_from_env; run_from_env()"`
  * frozen server exe: the exe re-enters its own `--pick` branch (server.py),
    which calls run_from_env() — because `sys.executable -c …` can't run python
    code in a frozen build (sys.executable is the bootloader, not python).

Env contract:
  PICK_MODE     "folder" | "file"
  DIALOG_TITLE  window title
  INITIAL_DIR   starting directory ("" = OS default)
  FILE_TYPES_TK JSON [["Label","*.a *.b"], …] (file mode only)

Prints the chosen path to stdout ("" if cancelled).
"""
from __future__ import annotations


def run_from_env() -> None:
    import json
    import os
    import sys
    import tkinter as tk
    from tkinter import filedialog

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001 — older stdout without reconfigure
        pass

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)

    title = os.environ.get("DIALOG_TITLE", "")
    initial = os.environ.get("INITIAL_DIR", "") or None

    if os.environ.get("PICK_MODE") == "folder":
        path = filedialog.askdirectory(title=title, initialdir=initial, mustexist=True)
    else:
        try:
            ft = json.loads(os.environ.get("FILE_TYPES_TK", "[]"))
        except Exception:  # noqa: BLE001
            ft = []
        ft = ft or [["All files", "*.*"]]
        path = filedialog.askopenfilename(
            title=title, initialdir=initial, filetypes=[tuple(x) for x in ft]
        )

    print(path or "")
