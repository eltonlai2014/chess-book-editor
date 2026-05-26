"""Flask backend for the XQF editor.

Three endpoints, no auth, local-only by design (binds 127.0.0.1):

    GET  /api/xqf/list                 -> directory tree under XQF_ROOT
    GET  /api/xqf/load?path=<rel>      -> {info, init_fen, roots}
    POST /api/xqf/save  body {path, info, init_fen, roots}

All paths are RELATIVE to XQF_ROOT and validated against it (rejects
absolute paths, .. traversal, symlinks pointing outside).

Run:
    .\.venv\Scripts\python.exe backend\app.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# Make `vendor` importable when running this file directly.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from flask import Flask, jsonify, request, send_from_directory  # noqa: E402

from backend.xqf_service import load_xqf, save_xqf  # noqa: E402


XQF_ROOT = Path(r"D:\Elton\TestArea\chess-book").resolve()
FRONTEND_ROOT = Path(__file__).resolve().parent.parent / "frontend"
PREFS_PATH = Path(__file__).resolve().parent.parent / "preferences.json"

app = Flask(__name__)


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
    """Resolve `rel` against XQF_ROOT, refuse anything that escapes it.

    Accepts only relative paths. Resolves symlinks via .resolve() and checks
    the result is inside XQF_ROOT.
    """
    if not rel:
        raise ValueError("path is required")
    p = Path(rel)
    if p.is_absolute():
        raise ValueError("path must be relative to XQF_ROOT")
    target = (XQF_ROOT / p).resolve()
    try:
        target.relative_to(XQF_ROOT)
    except ValueError as e:
        raise ValueError("path escapes XQF_ROOT") from e
    return target


def _tree(node: Path) -> dict:
    """Recursive directory listing. .XQF files are leaves; dirs recurse."""
    entry = {"name": node.name, "rel": str(node.relative_to(XQF_ROOT)).replace("\\", "/")}
    if node.is_dir():
        children = []
        for child in sorted(node.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
            if child.name.startswith(".") or child.name.startswith("__"):
                continue  # skip .git, .claude, __tmp_test__, etc.
            if child.is_dir():
                children.append(_tree(child))
            elif child.suffix.lower() == ".xqf":
                children.append({
                    "name": child.name,
                    "rel": str(child.relative_to(XQF_ROOT)).replace("\\", "/"),
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
    if not XQF_ROOT.exists():
        return jsonify({"error": f"XQF_ROOT missing: {XQF_ROOT}"}), 500
    root_view = _tree(XQF_ROOT)
    root_view["rel"] = ""
    return jsonify(root_view)


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
    return jsonify({"ok": True, "path": rel, "bak": rel + ".bak"})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5174, debug=True)
