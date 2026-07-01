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
    GET  /api/chessdb?fen=<fen>        -> live cloud-library lookup (cache-first)
    GET  /api/engine/info              -> {path, exists, ok?, name?} (UCI handshake)
    POST /api/engine/pick              -> {ok, path?} via native file picker
    POST /api/engine/path body {path}  -> persist Pikafish path to prefs
    GET  /api/engine/analyze?fen=      -> SSE live analysis of one position
    POST /api/engine/analyze-line      -> NDJSON score-trend sweep over a line
    GET  /api/practice/info            -> {exists, total, by_difficulty, books}
    GET  /api/practice/pick?book=&difficulty= -> one puzzle (due>new>any)
    GET  /api/practice/puzzle/<id>     -> one puzzle incl. answer (demo/reveal)
    POST /api/practice/check body {puzzle_id, user_iccs} -> grade + record
    POST /api/practice/engine-move body {fen, moves, depth} -> {best,cp,mate} (spar)
    GET  /api/practice/stats           -> {attempts, passed, states, due}
    GET  /api/preferences              -> prefs dict
    POST /api/preferences body {...}   -> shallow-merge into prefs

All XQF paths are RELATIVE to the current root and validated against it
(rejects absolute paths, .. traversal, symlinks pointing outside).

This module is intentionally THIN (T2-2): routes do request parsing + path
validation + response shaping only. The substance lives in sibling modules —
``config`` (paths/prefs/frozen-vs-source), ``picker_service`` (native dialogs),
``engine_service`` (Pikafish subprocess + the two streaming generators), and the
``xqf_service``/``cb_service``/``eval_service``/``chessdb_service`` data layers.

Run:
    .\.venv\Scripts\python.exe backend\app.py
"""
from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path

# Make `vendor` importable when running this file directly.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from flask import Flask, jsonify, request, send_from_directory, Response, stream_with_context  # noqa: E402

from backend.xqf_service import (  # noqa: E402
    compute_legal_targets,
    compute_move_info,
    compute_move_infos_batch,
    create_xqf,
    load_xqf,
    sanitise_filename,
    save_xqf,
)
from backend.cb_service import (  # noqa: E402
    is_cb_path,
    list_cbl_games,
    load_cb,
    parse_cb_rel,
    save_cbl_game,
    save_cbr,
)
from backend.eval_service import (  # noqa: E402
    TRAP_THRESHOLDS,
    db_info as eval_db_info,
    lookup_batch as eval_lookup_batch,
)
from backend.chessdb_service import lookup as chessdb_lookup  # noqa: E402
from backend.config import (  # noqa: E402
    CHESSDB_CACHE_PATH,
    EVAL_CACHE_PATH,
    FRONTEND_ROOT,
    _get_eval_db,
    _get_pikafish,
    _read_prefs,
    _write_prefs,
    get_xqf_root,
)
from backend.picker_service import _pick_file, _pick_folder  # noqa: E402
from backend import eval_cache  # noqa: E402
from backend import practice_service  # noqa: E402
from backend.engine_service import (  # noqa: E402
    _safe_int,
    analyze_line_stream,
    analyze_stream,
    bestmove_with_moves,
    engine_signature,
    pikafish_info,
)

app = Flask(__name__)


# ---------- static frontend (local dev only — Flask serves the SPA) --------
# Local-only dev tool: serve the frontend with no-store so edits to
# index.html / editor.css / *.js show up on a plain reload. Flask's default
# ETag/Last-Modified revalidation isn't honoured by some embedded webviews
# (VSCode Simple Browser), which left stale CSS sticking around after edits.

def _no_store(resp: Response) -> Response:
    resp.headers["Cache-Control"] = "no-store, must-revalidate"
    return resp


@app.get("/")
def index():
    return _no_store(send_from_directory(FRONTEND_ROOT, "index.html"))


@app.get("/assets/<path:fname>")
def assets(fname):
    return _no_store(send_from_directory(FRONTEND_ROOT / "assets", fname))


# ---------- user preferences --------------------------------------------------
# Storage + path resolution live in backend/config.py; these routes are the HTTP
# surface over them. Local-only tool, so no auth.

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


def _tree(node: Path, root: Path) -> dict | None:
    """Recursive directory listing. .XQF files are leaves; dirs recurse.

    A directory whose subtree contains **no** .XQF file is pruned (returns
    ``None``) so image-only / asset folders like ``png/`` don't clutter the
    library tree. The pruning is recursive: a dir holding only such empty dirs
    is itself empty and dropped."""
    entry = {"name": node.name, "rel": str(node.relative_to(root)).replace("\\", "/")}
    if node.is_dir():
        children = []
        for child in sorted(node.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
            if child.name.startswith(".") or child.name.startswith("__"):
                continue  # skip .git, .claude, __tmp_test__, etc.
            if child.is_dir():
                sub = _tree(child, root)
                if sub is not None:   # drop subdirs with no .XQF anywhere inside
                    children.append(sub)
            elif child.suffix.lower() in (".xqf", ".cbr"):
                # .cbr (象棋橋單盤) 與 .xqf 同構：直接當可開啟的葉節點。
                children.append({
                    "name": child.name,
                    "rel": str(child.relative_to(root)).replace("\\", "/"),
                    "type": "file",
                    "size": child.stat().st_size,
                })
            elif child.suffix.lower() == ".cbl":
                # .cbl (象棋橋多盤庫) 當可展開資料夾，但 children 留空：盤目
                # 懶載入——前端首次展開才打 /api/xqf/cbl-children 讀。避免大語料
                # 庫每次列樹全讀變慢。`cbl:true` 供前端辨識要走懶載入。
                children.append({
                    "name": child.name,
                    "rel": str(child.relative_to(root)).replace("\\", "/"),
                    "type": "dir",
                    "cbl": True,
                    "children": [],
                })
        if not children:
            return None   # no .XQF/.CBR/.CBL in this whole subtree -> hide the directory
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
        # First run on a fresh machine: the default root is master's path and
        # won't exist. Don't 500 — that paints a broken error screen. Return a
        # 200 with needsRoot so the UI can invite the user to pick a root via
        # the native folder picker. (A real 500 stays reserved for unexpected
        # failures.)
        return jsonify({
            "needsRoot": True,
            "root": str(root),
            "error": "尚未設定棋譜根目錄，請點「📂 選擇目錄」挑選存放 .XQF 的資料夾。",
        })
    root_view = _tree(root, root)
    if root_view is None:
        # Root exists but holds no .XQF anywhere — show an empty library tree
        # rather than crashing on the None.
        root_view = {"name": root.name, "type": "dir", "children": []}
    root_view["rel"] = ""
    root_view["root"] = str(root)
    return jsonify(root_view)


@app.get("/api/xqf/root")
def get_root():
    return jsonify({"root": str(get_xqf_root())})


@app.post("/api/xqf/pick-root")
def pick_root_dialog():
    """Pop a native folder-picker (see backend/picker_service.py).

    Returns {ok: true, path} on selection, {ok: false} if user cancelled.
    """
    chosen = _pick_folder("選擇棋譜根目錄", str(get_xqf_root()))
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


@app.get("/api/xqf/cbl-children")
def cbl_children():
    """懶載入：列出某 .cbl 內的每盤棋（左樹展開時呼叫）。

    回 [{rel:"<cbl-rel>#i", name, type:"file"}]，rel 直接餵 selectFile。
    """
    rel = request.args.get("path", "")
    try:
        target = _safe_resolve(rel)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if not target.is_file() or target.suffix.lower() != ".cbl":
        return jsonify({"error": f"not a .cbl file: {rel}"}), 404
    try:
        games = list_cbl_games(target)
    except Exception as e:
        return jsonify({"error": f"list failed: {e}"}), 500
    children = [
        {"rel": f"{rel}#{g['index']}", "name": g["name"], "type": "file"}
        for g in games
    ]
    return jsonify({"children": children})


@app.get("/api/xqf/load")
def load():
    rel = request.args.get("path", "")
    # CBL 盤 rel 形如 `lib.cbl#3`：先拆掉 #N，只用真實檔案路徑做跳脫驗證。
    base_rel, game_index = parse_cb_rel(rel)
    try:
        target = _safe_resolve(base_rel)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if not target.is_file():
        return jsonify({"error": f"not a file: {base_rel}"}), 404
    try:
        if game_index is not None or is_cb_path(base_rel):
            data = load_cb(target, game_index)
        else:
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


@app.post("/api/xqf/move-info-batch")
def move_info_batch():
    """Batch Chinese-notation lookup for many candidate moves from ONE fen.

    Body: ``{fen, iccs: [iccs, ...]}`` -> ``{ok, notations: {iccs: notation}}``.
    Collapses the per-cloud-move ``/move-info`` burst (one request per candidate
    move in the chessdb list) into a single request. Illegal/unparseable moves
    are absent from ``notations`` (caller shows the raw iccs).
    """
    body = request.get_json(silent=True) or {}
    fen = body.get("fen")
    iccs_list = body.get("iccs") or []
    if not isinstance(iccs_list, list):
        return jsonify({"error": "iccs must be an array"}), 400
    try:
        notations = compute_move_infos_batch(fen, iccs_list)
    except Exception as e:
        return jsonify({"error": f"驗證失敗：{e}"}), 400
    return jsonify({"ok": True, "notations": notations})


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


# ---------- eval DB config + lookup ------------------------------------------
# Path resolution lives in backend/config.py (_get_eval_db); the read layer is
# backend/eval_service.py. These routes are the HTTP surface.

@app.get("/api/eval/thresholds")
def eval_thresholds():
    """Trap / brilliant detection thresholds — the single source the editor UI
    fetches on boot instead of hardcoding (T3-2). See eval_service.TRAP_THRESHOLDS.
    """
    return jsonify(TRAP_THRESHOLDS)


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

    Filtered to .db / .sqlite (see backend/picker_service.py). Returns
    {ok: true, path} on selection; {ok: false} on cancel.
    """
    cur = _get_eval_db()
    initdir = str(cur.parent if cur.exists() else cur.parent.parent)
    chosen = _pick_file(
        "選擇引擎評估資料庫 (positions.db)",
        initdir,
        ("SQLite databases (*.db;*.sqlite;*.sqlite3)", "All files (*.*)"),
    )
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


# ---------- Pikafish engine config + live analysis ---------------------------
# Path resolution lives in backend/config.py (_get_pikafish); the subprocess +
# UCI parsing + the two streaming generators live in backend/engine_service.py.

@app.get("/api/engine/info")
def engine_info():
    """Report whether the Pikafish engine is configured + a quick handshake."""
    return jsonify(pikafish_info(_get_pikafish()))


@app.post("/api/engine/pick")
def pick_engine_dialog():
    """Native open-file dialog for selecting the Pikafish executable.

    Filtered to .exe (see backend/picker_service.py). Returns {ok: true, path}
    on selection; {ok: false} on cancel.
    """
    cur = _get_pikafish()
    initdir = str(cur.parent if cur.parent.exists() else cur.parent.parent)
    chosen = _pick_file(
        "選擇皮卡魚引擎執行檔 (pikafish*.exe)",
        initdir,
        ("Pikafish 執行檔 (pikafish*.exe)", "執行檔 (*.exe)", "All files (*.*)"),
    )
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
    info = pikafish_info(p)
    if not info.get("ok"):
        detail = info.get("error") or "未回應 uciok"
        return jsonify({"error": f"不是可用的 UCI 引擎：{detail}"}), 400
    prefs = _read_prefs()
    prefs["pikafishPath"] = str(p)
    _write_prefs(prefs)
    return jsonify({"ok": True, "path": str(p), "info": info})


@app.post("/api/engine/analyze-line")
def analyze_line():
    """Analyse a whole line of positions at a fixed depth, streaming one NDJSON
    record per position so the client can build a score trend live.

    Body: ``{fens: [editor-FEN, ...], depth (default 12), depth2?, fresh?}``.
    Scores are red POV; see engine_service.analyze_line_stream for the per-record
    shape and the depth/depth2 semantics. Results are cached per (fen, depth pair,
    engine) in EVAL_CACHE_PATH so a re-scan of the same/overlapping line skips the
    engine; ``fresh:true`` ignores the cache and recomputes (still writes back).
    """
    body = request.get_json(silent=True) or {}
    fens = [f for f in (body.get("fens") or []) if isinstance(f, str) and f]
    depth = max(1, min(30, _safe_int(body.get("depth"), 12)))
    depth2 = body.get("depth2")
    depth2 = max(1, min(30, _safe_int(depth2, 0))) if depth2 is not None else 0
    fresh = bool(body.get("fresh"))
    engine = _get_pikafish()
    if not (engine.exists() and engine.is_file()):
        return jsonify({"error": "皮卡魚引擎未設定（請先在檔案窗格選擇）"}), 400
    return Response(
        stream_with_context(analyze_line_stream(
            engine, fens, depth, depth2, cache_path=EVAL_CACHE_PATH, fresh=fresh)),
        mimetype="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/engine/eval-cache")
def engine_eval_cache():
    """Cache-only read of the AI sweep results for a line — NEVER spawns the
    engine. Lets the AI tab show prior analysis the instant it's opened (or a file
    is switched while it's open) without pressing 掃描.

    Body: ``{fens: [editor-FEN, ...], depth (default 12), depth2?}``. Returns
    ``{depth, depth2, hits, total, records:[{cp,mate,best,cp2?,mate2?}|null, ...]}``
    — one slot per fen, null on a cache miss. When the engine is unconfigured
    there's no signature to key by, so every slot is null (hits 0); the client
    only renders when hits>0.
    """
    body = request.get_json(silent=True) or {}
    fens = [f for f in (body.get("fens") or []) if isinstance(f, str) and f]
    depth = max(1, min(30, _safe_int(body.get("depth"), 12)))
    depth2 = body.get("depth2")
    depth2 = max(1, min(30, _safe_int(depth2, 0))) if depth2 is not None else 0
    records = [None] * len(fens)
    engine = _get_pikafish()
    if engine.exists() and engine.is_file():
        sig = engine_signature(engine)
        con = eval_cache.ensure(EVAL_CACHE_PATH)
        records = eval_cache.read_line(con, fens, depth, depth2, sig)
    hits = sum(1 for r in records if r is not None)
    return jsonify({"depth": depth, "depth2": depth2,
                    "hits": hits, "total": len(fens), "records": records})


@app.get("/api/engine/analyze")
def engine_analyze():
    """SSE stream of live Pikafish analysis for one position.

    Ephemeral by design (see engine_service.analyze_stream): spawns an engine,
    streams per-depth depth/score/pv events, and is killed when the client closes
    the EventSource or ``bestmove`` arrives. Nothing is persisted.

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
    return Response(
        stream_with_context(analyze_stream(engine, fen, depth, movetime)),
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


@app.get("/api/chessdb")
def chessdb_query():
    """Cache-first chessdb.cn cloud-library lookup for one position.

    Query: ``fen`` (required, ``<position> <side>``); ``fresh=1`` skips both
    caches and forces a live re-query. Resolution: read-only positions.db →
    editor's own cache → live chessdb.cn (written back to the cache). Returns
    the same ``cdb`` shape as /api/eval/batch's ``cdb`` field plus a ``source``
    flag, so the frontend renders it identically.

    Live network failures degrade to ``{status:'error', moves:[]}`` (HTTP 200)
    rather than a hard error — a missing cloud row shouldn't break navigation.
    """
    fen = (request.args.get("fen") or "").strip()
    if not fen:
        return jsonify({"error": "fen is required"}), 400
    fresh = request.args.get("fresh") in ("1", "true", "yes")
    try:
        result = chessdb_lookup(_get_eval_db(), CHESSDB_CACHE_PATH, fen, fresh=fresh)
    except Exception as e:
        # Network glitch / timeout / unparseable response: don't 500, just
        # report no data so the UI shows "雲庫無資料" and navigation continues.
        return jsonify({"status": "error", "moves": [], "best": None,
                        "source": "live", "error": str(e)})
    return jsonify(result)


# ---------- 中局練習題庫（practice.db；P1 路由） -----------------------------
# 題庫由 backend/practice_service.py 的離線 CLI 預先填充；這些路由只讀題/評分/記成績。
# practice.db 是編輯器自有可寫庫（pooled，WAL），不存在時 pooled() 自動建空表 →
# /info 回 exists:false，前端據此 gate 練習入口（同 engine/info、eval/info）。

@app.get("/api/practice/info")
def practice_info_route():
    """題庫總覽（gate 練習入口）：題數/已仲裁/難度分布/書目。空庫回 exists:false。"""
    con = practice_service.pooled()
    return jsonify(practice_service.practice_info(con))


@app.get("/api/practice/pick")
def practice_pick_route():
    """抽一題（到期複習優先→新題→任一）。query：theme / book / difficulty / include_doubt。"""
    theme = (request.args.get("theme") or "").strip() or None
    book = (request.args.get("book") or "").strip() or None
    difficulty = request.args.get("difficulty")
    difficulty = _safe_int(difficulty, 0) or None if difficulty else None
    exclude_doubt = request.args.get("include_doubt") not in ("1", "true", "yes")
    con = practice_service.pooled()
    puzzle = practice_service.pick_puzzle(con, book=book, difficulty=difficulty,
                                          exclude_doubt=exclude_doubt, theme=theme)
    if puzzle is None:
        return jsonify({"error": "題庫為空或無符合條件的題（先用 CLI 抽題）"}), 404
    return jsonify(puzzle)


@app.get("/api/practice/puzzle/<int:pid>")
def practice_puzzle_route(pid: int):
    """取單題完整內容（含答案）——演示/解答揭示用。"""
    con = practice_service.pooled()
    puzzle = practice_service.get_puzzle(con, pid)
    if puzzle is None:
        return jsonify({"error": f"查無題目 id={pid}"}), 404
    return jsonify(puzzle)


@app.post("/api/practice/check")
def practice_check_route():
    """評使用者首著（對書答或已存 engine_best＝引擎等值），記 attempt＋更新間隔重練。

    Body：``{puzzle_id, user_iccs(單著或list), time_ms?}``。回 ``{correct, via,
    expected_iccs, answer_iccs, answer_zh, commentary, ...}``。
    """
    body = request.get_json(silent=True) or {}
    pid = _safe_int(body.get("puzzle_id"), 0)
    user_iccs = body.get("user_iccs")
    if not pid or not user_iccs:
        return jsonify({"error": "puzzle_id 與 user_iccs 為必填"}), 400
    con = practice_service.pooled()
    result = practice_service.check_answer(con, pid, user_iccs,
                                           time_ms=_safe_int(body.get("time_ms"), 0))
    if result is None:
        return jsonify({"error": f"查無題目 id={pid}"}), 404
    return jsonify(result)


@app.get("/api/practice/stats")
def practice_stats_route():
    """個人成績總覽（成績分頁）：作答數/答對數/狀態分布/到期數。"""
    con = practice_service.pooled()
    return jsonify(practice_service.practice_progress_stats(con))


@app.post("/api/practice/engine-move")
def practice_engine_move_route():
    """練習走錯後與 AI 對弈的「帶歷史一次取著」。Body：``{fen, moves:[uci…], depth?}``
    → ``{best, cp, mate}``（紅 POV）。

    **必須帶 moves**：只送 FEN 無走子歷史，引擎偵測不到重複局面 → 勝勢時一直挑同一
    將軍著（長將循環）。送出自起始盤的完整走子後，Pikafish 依陸規避開長將。一次性、
    不快取（局面隨歷史而異）。
    """
    body = request.get_json(silent=True) or {}
    fen = (body.get("fen") or "").strip()
    moves = [m for m in (body.get("moves") or []) if isinstance(m, str) and m]
    depth = max(1, min(30, _safe_int(body.get("depth"), 20)))
    if not fen:
        return jsonify({"error": "fen is required"}), 400
    engine = _get_pikafish()
    if not (engine.exists() and engine.is_file()):
        return jsonify({"error": "皮卡魚引擎未設定"}), 400
    try:
        return jsonify(bestmove_with_moves(engine, fen, moves, depth))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/xqf/save")
def save():
    body = request.get_json(silent=True) or {}
    rel = body.get("path", "")
    # 依副檔名分派：.cbl#N -> 覆寫整庫指定盤、.cbr -> 單盤、.xqf -> XQF。
    base_rel, game_index = parse_cb_rel(rel)
    try:
        target = _safe_resolve(base_rel)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    suffix = target.suffix.lower()
    try:
        if suffix == ".cbl":
            if game_index is None:
                return jsonify({"error": "CBL 存檔需指定盤序（lib.cbl#N）"}), 400
            save_cbl_game(target, game_index, body)
        elif suffix == ".cbr":
            save_cbr(target, body)
        elif suffix == ".xqf":
            save_xqf(target, body)
        else:
            return jsonify({"error": "path must end in .XQF / .CBR / .CBL"}), 400
    except Exception as e:
        return jsonify({"error": f"save failed: {e}"}), 500
    return jsonify({"ok": True, "path": rel})


if __name__ == "__main__":
    # threaded=True so a long-lived SSE analysis stream doesn't block other
    # requests (page, move-info, a second analyze after navigation).
    #
    # debug defaults OFF: the Werkzeug debugger is an interactive-RCE console,
    # not something to ship to other users. It binds 127.0.0.1 so the blast
    # radius is local, but a distributed build must not boot with it on. Opt in
    # for your own dev with FLASK_DEBUG=1.
    debug = os.environ.get("FLASK_DEBUG", "").strip().lower() in ("1", "true", "yes", "on")
    app.run(host="127.0.0.1", port=5174, debug=debug, threaded=True)
