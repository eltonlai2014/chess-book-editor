"""Flask backend for the XQF editor.

Local-only by design (binds 127.0.0.1), no auth:

    GET  /api/xqf/list                 -> directory tree under current root
    GET  /api/xqf/load?path=<rel>      -> {info, init_fen, roots}
    POST /api/xqf/new   body {title, filename?, subdir?} -> {ok, path}
    POST /api/xqf/save  body {path, info, init_fen, roots}
    POST /api/xqf/move-info body {fen, iccs} -> {ok, notation, side}
    POST /api/xqf/legal-targets body {fen, from} -> {ok, targets:[iccs,...]}
    GET  /api/xqf/root                 -> {root}
    POST /api/xqf/root  body {path}    -> persist new library root to prefs
    POST /api/xqf/pick-root            -> {ok, path?} via native folder picker
    GET  /api/preferences              -> prefs dict
    POST /api/preferences body {...}   -> shallow-merge into prefs

All XQF paths are RELATIVE to the current root and validated against it
(rejects absolute paths, .. traversal, symlinks pointing outside).

Run:
    .\.venv\Scripts\python.exe backend\app.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

# Make `vendor` importable when running this file directly.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from flask import Flask, jsonify, request, send_from_directory  # noqa: E402

from backend.xqf_service import (  # noqa: E402
    compute_legal_targets,
    compute_move_info,
    create_xqf,
    load_xqf,
    sanitise_filename,
    save_xqf,
)


# Fallback when preferences.json has no xqfRoot — matches master's primary
# machine. On other machines, user sets the actual root via UI (POST /api/xqf/root)
# and it persists to preferences.json.
DEFAULT_XQF_ROOT = Path(r"D:\Elton\TestArea\chess-book")
FRONTEND_ROOT = Path(__file__).resolve().parent.parent / "frontend"
PREFS_PATH = Path(__file__).resolve().parent.parent / "preferences.json"

app = Flask(__name__)


def get_xqf_root() -> Path:
    """Resolve current XQF library root. Reads preferences each call so a
    change via POST /api/xqf/root takes effect without a restart."""
    prefs = _read_prefs()
    custom = prefs.get("xqfRoot")
    if custom:
        try:
            p = Path(custom).expanduser().resolve()
            if p.is_dir():
                return p
        except Exception:
            pass
    return DEFAULT_XQF_ROOT.resolve()


# ---------- static frontend (local dev only — Flask serves the SPA) --------

@app.get("/")
def index():
    return send_from_directory(FRONTEND_ROOT, "index.html")


@app.get("/assets/<path:fname>")
def assets(fname):
    return send_from_directory(FRONTEND_ROOT / "assets", fname)


# ---------- user preferences --------------------------------------------------
# Lightweight key/value store kept as preferences.json at repo root. Persists
# UI state across sessions: splitter sizes, board theme, anything we add later.
# Local-only tool, so no auth — anyone reaching this server can read/write it.

def _read_prefs() -> dict:
    if not PREFS_PATH.exists():
        return {}
    try:
        return json.loads(PREFS_PATH.read_text("utf-8"))
    except Exception:
        return {}


def _write_prefs(data: dict) -> None:
    PREFS_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


@app.get("/api/preferences")
def get_preferences():
    return jsonify(_read_prefs())


@app.post("/api/preferences")
def set_preferences():
    """Merge POSTed JSON object into stored preferences (shallow merge)."""
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return jsonify({"error": "preferences must be an object"}), 400
    current = _read_prefs()
    current.update(body)
    _write_prefs(current)
    return jsonify({"ok": True})


def _safe_resolve(rel: str) -> Path:
    """Resolve `rel` against the current XQF root, refuse anything that escapes it.

    Accepts only relative paths. Resolves symlinks via .resolve() and checks
    the result is inside the root.
    """
    if not rel:
        raise ValueError("path is required")
    p = Path(rel)
    if p.is_absolute():
        raise ValueError("path must be relative to XQF root")
    root = get_xqf_root()
    target = (root / p).resolve()
    try:
        target.relative_to(root)
    except ValueError as e:
        raise ValueError("path escapes XQF root") from e
    return target


def _tree(node: Path, root: Path) -> dict:
    """Recursive directory listing. .XQF files are leaves; dirs recurse."""
    entry = {"name": node.name, "rel": str(node.relative_to(root)).replace("\\", "/")}
    if node.is_dir():
        children = []
        for child in sorted(node.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
            if child.name.startswith(".") or child.name.startswith("__"):
                continue  # skip .git, .claude, __tmp_test__, etc.
            if child.is_dir():
                children.append(_tree(child, root))
            elif child.suffix.lower() == ".xqf":
                children.append({
                    "name": child.name,
                    "rel": str(child.relative_to(root)).replace("\\", "/"),
                    "type": "file",
                    "size": child.stat().st_size,
                })
        entry["type"] = "dir"
        entry["children"] = children
    else:
        entry["type"] = "file"
        entry["size"] = node.stat().st_size
    return entry


@app.get("/api/xqf/list")
def list_xqf():
    root = get_xqf_root()
    if not root.exists():
        return jsonify({"error": f"XQF root missing: {root}", "root": str(root)}), 500
    root_view = _tree(root, root)
    root_view["rel"] = ""
    root_view["root"] = str(root)
    return jsonify(root_view)


@app.get("/api/xqf/root")
def get_root():
    return jsonify({"root": str(get_xqf_root())})


@app.post("/api/xqf/pick-root")
def pick_root_dialog():
    """Pop a native folder-picker via a one-shot subprocess.

    tkinter's mainloop needs to run on the main thread; in a Flask dev server
    (worker threads, debug-mode reloader) calling it inline either hangs or
    crashes. A short-lived subprocess sidesteps that — and tkinter is in
    stdlib so no new dependency.

    Returns {ok: true, path} on selection, {ok: false} if user cancelled.
    """
    code = (
        "import os, sys, tkinter as tk\n"
        "from tkinter import filedialog\n"
        "sys.stdout.reconfigure(encoding='utf-8')\n"
        "r = tk.Tk(); r.withdraw(); r.attributes('-topmost', True)\n"
        "p = filedialog.askdirectory("
        "title=os.environ.get('DIALOG_TITLE',''),"
        "initialdir=os.environ.get('INITIAL_DIR','') or None,"
        "mustexist=True)\n"
        "print(p or '')\n"
    )
    env = {
        **os.environ,
        "DIALOG_TITLE": "選擇棋譜根目錄",
        "INITIAL_DIR": str(get_xqf_root()),
        "PYTHONIOENCODING": "utf-8",
    }
    try:
        proc = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            timeout=300,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return jsonify({"error": "選擇對話框逾時"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    chosen = proc.stdout.decode("utf-8", errors="replace").strip()
    if not chosen:
        return jsonify({"ok": False})
    return jsonify({"ok": True, "path": chosen})


@app.post("/api/xqf/root")
def set_root():
    """Update the XQF library root. Validates the path exists and is a directory,
    then persists it to preferences.json. Clears lastFile since its rel path
    almost certainly no longer applies under the new root."""
    body = request.get_json(silent=True) or {}
    raw = (body.get("path") or "").strip().strip('"').strip("'")
    if not raw:
        return jsonify({"error": "path is required"}), 400
    try:
        p = Path(raw).expanduser().resolve()
    except Exception as e:
        return jsonify({"error": f"invalid path: {e}"}), 400
    if not p.exists():
        return jsonify({"error": f"路徑不存在：{p}"}), 400
    if not p.is_dir():
        return jsonify({"error": f"不是目錄：{p}"}), 400
    prefs = _read_prefs()
    prefs["xqfRoot"] = str(p)
    prefs.pop("lastFile", None)
    _write_prefs(prefs)
    return jsonify({"ok": True, "root": str(p)})


@app.get("/api/xqf/load")
def load():
    rel = request.args.get("path", "")
    try:
        target = _safe_resolve(rel)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if not target.is_file():
        return jsonify({"error": f"not a file: {rel}"}), 404
    try:
        data = load_xqf(target)
    except Exception as e:
        return jsonify({"error": f"load failed: {e}"}), 500
    data["path"] = rel
    return jsonify(data)


@app.post("/api/xqf/legal-targets")
def legal_targets():
    """Return legal destination squares for the piece on `from` under `fen`.

    Body: {fen: str, from: str (e.g. "h2")}
    Returns: {ok: true, targets: ["h3","h4",...]} (possibly empty)
    """
    body = request.get_json(silent=True) or {}
    fen = body.get("fen")
    from_sq = body.get("from")
    try:
        targets = compute_legal_targets(fen, from_sq)
    except Exception as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, "targets": targets})


@app.post("/api/xqf/move-info")
def move_info():
    """Validate a click-to-add move against `fen` and return its notation+side.

    Body: {fen: str, iccs: str}
    On success: {ok: true, notation, side}
    On failure: {error: <human-readable>} with HTTP 400
    """
    body = request.get_json(silent=True) or {}
    fen = body.get("fen")
    iccs = body.get("iccs")
    try:
        info = compute_move_info(fen, iccs)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"驗證失敗：{e}"}), 400
    return jsonify({"ok": True, **info})


@app.post("/api/xqf/new")
def new_xqf():
    """Create a fresh .XQF with the given title at <root>[/subdir]/<filename>.

    Body: {title: str, filename?: str, subdir?: str}
      - title:    required, non-empty (becomes book.info['title'])
      - filename: optional; defaults to sanitise_filename(title). ".XQF" is
                  appended if not already present.
      - subdir:   optional; relative directory under the library root
                  (forward or backward slashes both fine, validated by
                  _safe_resolve like every other path-taking endpoint).

    Refuses to overwrite an existing file (409). Creates the parent
    directory tree if missing.
    """
    body = request.get_json(silent=True) or {}
    title = (body.get("title") or "").strip()
    if not title:
        return jsonify({"error": "標題不可為空"}), 400
    filename = (body.get("filename") or "").strip() or sanitise_filename(title)
    if not filename.lower().endswith(".xqf"):
        filename += ".XQF"
    subdir = (body.get("subdir") or "").strip().replace("\\", "/").strip("/")
    rel = f"{subdir}/{filename}" if subdir else filename
    try:
        target = _safe_resolve(rel)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if target.suffix.lower() != ".xqf":
        return jsonify({"error": "filename must end in .XQF"}), 400
    if target.exists():
        return jsonify({"error": f"檔案已存在：{rel}"}), 409
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        create_xqf(target, title)
    except Exception as e:
        return jsonify({"error": f"建立失敗：{e}"}), 500
    return jsonify({"ok": True, "path": rel})


@app.post("/api/xqf/save")
def save():
    body = request.get_json(silent=True) or {}
    rel = body.get("path", "")
    try:
        target = _safe_resolve(rel)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if target.suffix.lower() != ".xqf":
        return jsonify({"error": "path must end in .XQF"}), 400
    try:
        save_xqf(target, body)
    except Exception as e:
        return jsonify({"error": f"save failed: {e}"}), 500
    return jsonify({"ok": True, "path": rel})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5174, debug=True)
