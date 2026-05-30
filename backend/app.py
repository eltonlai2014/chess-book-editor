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
    GET  /api/eval/info                -> {path, exists, evals_by_depth?, chessdb_rows?}
    POST /api/eval/pick-db             -> {ok, path?} via native file picker
    POST /api/eval/db    body {path}   -> persist new eval DB path to prefs
    POST /api/eval/batch body {fens:[...]} -> {fen:{d12?,d22?,d28?,d32?,cdb?}}
    GET  /api/engine/info              -> {path, exists, ok?, name?} (UCI handshake)
    POST /api/engine/pick              -> {ok, path?} via native file picker
    POST /api/engine/path body {path}  -> persist Pikafish path to prefs
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
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

# Make `vendor` importable when running this file directly.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from flask import Flask, jsonify, request, send_from_directory, Response, stream_with_context  # noqa: E402

from backend.xqf_service import (  # noqa: E402
    compute_legal_targets,
    compute_move_info,
    create_xqf,
    load_xqf,
    sanitise_filename,
    save_xqf,
)
from backend.eval_service import db_info as eval_db_info, lookup_batch as eval_lookup_batch  # noqa: E402
from backend.xqf_service import pv_to_chinese  # noqa: E402


# Fallback when preferences.json has no xqfRoot — matches master's primary
# machine. On other machines, user sets the actual root via UI (POST /api/xqf/root)
# and it persists to preferences.json.
DEFAULT_XQF_ROOT = Path(r"D:\Elton\TestArea\chess-book")
# Default eval database path: sibling chess-book-ai repo's migrated SQLite.
# Overridden via preferences key ``evalDbPath`` (set from UI later if needed).
DEFAULT_EVAL_DB = (
    Path(__file__).resolve().parent.parent.parent
    / "chess-book-ai" / "output" / "positions.db"
)
# Default Pikafish engine: sibling chess-book-ai repo ships several microarch
# builds — avx2 is the broadest-compatible modern default. Overridden via
# preferences key ``pikafishPath`` (user picks the build matching their CPU).
# We only ever *run* this binary live; the engine source/build stays in the AI
# repo (see CLAUDE.md), and analysis is ephemeral (never persisted).
DEFAULT_PIKAFISH = (
    Path(__file__).resolve().parent.parent.parent
    / "chess-book-ai" / "engine" / "Windows" / "pikafish-avx2.exe"
)
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


def _get_eval_db() -> Path:
    """Resolve current eval DB path. Pref override > default sibling repo."""
    prefs = _read_prefs()
    custom = prefs.get("evalDbPath")
    if custom:
        try:
            p = Path(custom).expanduser().resolve()
            return p
        except Exception:
            pass
    return DEFAULT_EVAL_DB.resolve()


@app.get("/api/eval/info")
def eval_info():
    """Report whether the eval DB is wired up and what's in it.

    Used by the UI on boot to decide whether to show eval columns at all
    (graceful degradation when the AI repo's positions.db is missing).
    """
    return jsonify(eval_db_info(_get_eval_db()))


@app.post("/api/eval/pick-db")
def pick_eval_db_dialog():
    """Native open-file dialog for selecting a SQLite eval database.

    Same subprocess + tkinter pattern as `/api/xqf/pick-root`, but uses
    askopenfilename and filters to .db / .sqlite. Returns
    {ok: true, path} on selection; {ok: false} on cancel.
    """
    code = (
        "import os, sys, tkinter as tk\n"
        "from tkinter import filedialog\n"
        "sys.stdout.reconfigure(encoding='utf-8')\n"
        "r = tk.Tk(); r.withdraw(); r.attributes('-topmost', True)\n"
        "p = filedialog.askopenfilename("
        "title=os.environ.get('DIALOG_TITLE',''),"
        "initialdir=os.environ.get('INITIAL_DIR','') or None,"
        "filetypes=(("
        "'SQLite databases','*.db *.sqlite *.sqlite3'"
        "),('All files','*.*')))\n"
        "print(p or '')\n"
    )
    cur = _get_eval_db()
    env = {
        **os.environ,
        "DIALOG_TITLE": "選擇引擎評估資料庫 (positions.db)",
        "INITIAL_DIR": str(cur.parent if cur.exists() else cur.parent.parent),
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


@app.post("/api/eval/db")
def set_eval_db():
    """Persist a new eval DB path to preferences.json.

    Validates the file exists, is a file (not dir), and looks like a SQLite
    DB (we try opening it read-only and reading evals table info — if either
    fails, refuse). Doesn't enforce any depth-set so future schema additions
    don't break this endpoint.
    """
    body = request.get_json(silent=True) or {}
    raw = (body.get("path") or "").strip().strip('"').strip("'")
    if not raw:
        return jsonify({"error": "path is required"}), 400
    try:
        p = Path(raw).expanduser().resolve()
    except Exception as e:
        return jsonify({"error": f"invalid path: {e}"}), 400
    if not p.exists():
        return jsonify({"error": f"檔案不存在：{p}"}), 400
    if not p.is_file():
        return jsonify({"error": f"不是檔案：{p}"}), 400
    info = eval_db_info(p)
    if info.get("error"):
        return jsonify({"error": f"無法開啟 SQLite：{info['error']}"}), 400
    if "evals_by_depth" not in info:
        return jsonify({"error": "該檔案沒有 evals 表（不是相容的評估資料庫）"}), 400
    prefs = _read_prefs()
    prefs["evalDbPath"] = str(p)
    _write_prefs(prefs)
    return jsonify({"ok": True, "path": str(p), "info": info})


# ---------- Pikafish engine config -------------------------------------------
# Just the config slot here (path chip + picker + persistence), mirroring the
# eval DB. Live UCI streaming/analysis is a separate, later increment.

def _get_pikafish() -> Path:
    """Resolve current Pikafish path. Pref override > default sibling build."""
    prefs = _read_prefs()
    custom = prefs.get("pikafishPath")
    if custom:
        try:
            return Path(custom).expanduser().resolve()
        except Exception:
            pass
    return DEFAULT_PIKAFISH.resolve()


def _pikafish_info(p: Path) -> dict:
    """Report whether the engine is wired up. When present, do a short UCI
    handshake (``uci``/``quit``) to surface the engine's ``id name`` so the
    chip confirms it's a real, runnable Pikafish rather than just any file.
    Runs with cwd=binary dir so the engine finds its sibling ``*.nnue``."""
    info = {"path": str(p), "exists": p.exists() and p.is_file()}
    if not info["exists"]:
        return info
    try:
        proc = subprocess.run(
            [str(p)],
            input="uci\nquit\n",
            capture_output=True,
            text=True,
            timeout=8,
            cwd=str(p.parent),
        )
        out = proc.stdout or ""
        info["ok"] = "uciok" in out
        for line in out.splitlines():
            if line.startswith("id name"):
                info["name"] = line[len("id name"):].strip()
                break
    except Exception as e:
        info["ok"] = False
        info["error"] = str(e)
    return info


@app.get("/api/engine/info")
def engine_info():
    """Report whether the Pikafish engine is configured + a quick handshake."""
    return jsonify(_pikafish_info(_get_pikafish()))


@app.post("/api/engine/pick")
def pick_engine_dialog():
    """Native open-file dialog for selecting the Pikafish executable.

    Same subprocess + tkinter pattern as `/api/eval/pick-db`, filtered to .exe.
    Returns {ok: true, path} on selection; {ok: false} on cancel.
    """
    code = (
        "import os, sys, tkinter as tk\n"
        "from tkinter import filedialog\n"
        "sys.stdout.reconfigure(encoding='utf-8')\n"
        "r = tk.Tk(); r.withdraw(); r.attributes('-topmost', True)\n"
        "p = filedialog.askopenfilename("
        "title=os.environ.get('DIALOG_TITLE',''),"
        "initialdir=os.environ.get('INITIAL_DIR','') or None,"
        "filetypes=(("
        "'Pikafish 執行檔','pikafish*.exe'"
        "),('執行檔','*.exe'),('All files','*.*')))\n"
        "print(p or '')\n"
    )
    cur = _get_pikafish()
    env = {
        **os.environ,
        "DIALOG_TITLE": "選擇皮卡魚引擎執行檔 (pikafish*.exe)",
        "INITIAL_DIR": str(cur.parent if cur.parent.exists() else cur.parent.parent),
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


@app.post("/api/engine/path")
def set_engine_path():
    """Persist a new Pikafish path to preferences.json after validating it
    exists, is a file, and survives a UCI handshake (refuse non-engines)."""
    body = request.get_json(silent=True) or {}
    raw = (body.get("path") or "").strip().strip('"').strip("'")
    if not raw:
        return jsonify({"error": "path is required"}), 400
    try:
        p = Path(raw).expanduser().resolve()
    except Exception as e:
        return jsonify({"error": f"invalid path: {e}"}), 400
    if not p.exists():
        return jsonify({"error": f"檔案不存在：{p}"}), 400
    if not p.is_file():
        return jsonify({"error": f"不是檔案：{p}"}), 400
    info = _pikafish_info(p)
    if not info.get("ok"):
        detail = info.get("error") or "未回應 uciok"
        return jsonify({"error": f"不是可用的 UCI 引擎：{detail}"}), 400
    prefs = _read_prefs()
    prefs["pikafishPath"] = str(p)
    _write_prefs(prefs)
    return jsonify({"ok": True, "path": str(p), "info": info})


def _safe_int(v, default: int = 0) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _parse_info_line(line: str, flip: int, fen: str) -> dict | None:
    """Parse one UCI ``info ... pv ...`` line into a display event. ``flip``
    converts the engine's side-to-move score into red POV (matches the eval
    DB / #evalLine convention). ``fen`` is the editor FEN used to render the
    PV in Chinese."""
    toks = line.split()
    info: dict = {}
    pv: list = []
    i = 0
    while i < len(toks):
        t = toks[i]
        if t == "depth" and i + 1 < len(toks):
            info["depth"] = _safe_int(toks[i + 1]); i += 2
        elif t == "seldepth" and i + 1 < len(toks):
            info["seldepth"] = _safe_int(toks[i + 1]); i += 2
        elif t == "nps" and i + 1 < len(toks):
            info["nps"] = _safe_int(toks[i + 1]); i += 2
        elif t == "time" and i + 1 < len(toks):
            info["time_ms"] = _safe_int(toks[i + 1]); i += 2
        elif t == "score" and i + 2 < len(toks):
            kind, val = toks[i + 1], _safe_int(toks[i + 2])
            if kind == "mate":
                info["mate"] = val * flip
            else:
                info["cp"] = val * flip
            i += 3
        elif t == "wdl" and i + 3 < len(toks):
            w, d2, l = _safe_int(toks[i + 1]), _safe_int(toks[i + 2]), _safe_int(toks[i + 3])
            # wdl is side-to-move POV (per-mille). For red-POV display, swap
            # win/loss when black is to move (flip < 0).
            if flip < 0:
                w, l = l, w
            info["wdl"] = [w, d2, l]
            i += 4
        elif t == "pv":
            pv = toks[i + 1:]
            break
        else:
            i += 1
    if "depth" not in info:
        return None
    info["pv"] = pv_to_chinese(fen, pv, limit=16)
    info["bestUci"] = pv[0] if pv else None
    return info


@app.get("/api/engine/analyze")
def engine_analyze():
    """SSE stream of live Pikafish analysis for one position.

    Ephemeral by design: spawns an engine, streams per-depth depth/score/pv
    events, and is killed when the client closes the EventSource (GeneratorExit
    on the next yield) or ``bestmove`` arrives. Nothing is persisted.

    Query: fen (required), depth (0=infinite), movetime ms (0=infinite).
    """
    fen = (request.args.get("fen") or "").strip()
    if not fen:
        return jsonify({"error": "fen is required"}), 400
    depth = _safe_int(request.args.get("depth"), 0)
    movetime = _safe_int(request.args.get("movetime"), 0)
    engine = _get_pikafish()
    if not (engine.exists() and engine.is_file()):
        return jsonify({"error": "皮卡魚引擎未設定（請先在檔案窗格選擇）"}), 400

    parts = fen.split()
    board_part = parts[0]
    side = parts[1] if len(parts) > 1 else "w"
    full_fen = f"{board_part} {side} - - 0 1"   # Pikafish wants a 6-field FEN
    flip = -1 if side == "b" else 1

    def gen():
        proc = subprocess.Popen(
            [str(engine)],
            cwd=str(engine.parent),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )

        def send(cmd: str) -> None:
            proc.stdin.write(cmd + "\n")
            proc.stdin.flush()

        try:
            send("uci")
            send("setoption name Threads value 4")
            send("setoption name Hash value 128")
            send("setoption name UCI_ShowWDL value true")
            send("isready")
            send(f"position fen {full_fen}")
            if depth > 0:
                send(f"go depth {depth}")
            elif movetime > 0:
                send(f"go movetime {movetime}")
            else:
                send("go infinite")
            last_emit = 0.0
            last_depth = -1
            for line in proc.stdout:
                line = line.strip()
                if line.startswith("bestmove"):
                    bits = line.split()
                    bm = bits[1] if len(bits) > 1 else ""
                    yield "data: " + json.dumps({"done": True, "bestmove": bm}, ensure_ascii=False) + "\n\n"
                    break
                if not (line.startswith("info ") and " pv " in line and " depth " in line):
                    continue
                ev = _parse_info_line(line, flip, fen)
                if ev is None:
                    continue
                now = time.monotonic()
                # One event per completed depth, plus a 150ms heartbeat so nps/
                # time still tick on long single-depth searches. Avoids flooding.
                if ev["depth"] != last_depth or (now - last_emit) >= 0.15:
                    last_depth = ev["depth"]
                    last_emit = now
                    yield "data: " + json.dumps(ev, ensure_ascii=False) + "\n\n"
        finally:
            try:
                send("quit")
            except Exception:
                pass
            try:
                proc.kill()
            except Exception:
                pass

    return Response(
        stream_with_context(gen()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/eval/batch")
def eval_batch():
    """Batch-lookup evals for a list of FENs.

    Body: {fens: [str, ...]}
    Returns: {db_path, evals: {fen: {d12?, d22?, d28?, d32?, cdb?}}}

    Missing FENs map to ``{}``. Missing depths are absent from the per-fen
    dict (so the frontend can use ``'d22' in entry`` as a presence check).
    """
    body = request.get_json(silent=True) or {}
    fens = body.get("fens") or []
    if not isinstance(fens, list):
        return jsonify({"error": "fens must be an array"}), 400
    # Reject obviously-bogus input early; SQLite would handle it fine but
    # rejecting here gives a clearer error.
    fens = [f for f in fens if isinstance(f, str) and f]
    db = _get_eval_db()
    try:
        evals = eval_lookup_batch(db, fens)
    except sqlite3.DatabaseError as e:
        return jsonify({"error": f"eval db read failed: {e}"}), 500
    return jsonify({"db_path": str(db), "evals": evals})


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
    # threaded=True so a long-lived SSE analysis stream doesn't block other
    # requests (page, move-info, a second analyze after navigation).
    app.run(host="127.0.0.1", port=5174, debug=True, threaded=True)
