"""Pikafish subprocess management + UCI parsing for the two streaming analysis
routes (T2-2 split out of app.py).

The app.py routes stay thin: parse/validate the request, resolve the engine
path (config._get_pikafish), then wrap one of these generators in a streaming
Flask Response. The shared subprocess plumbing (``_spawn``/``_shutdown``) and the
editor-FEN→6-field conversion (``_engine_fen``) live here so the two streams
don't each reimplement them — that's the "兩支 SSE 合一" of the backlog.

The single-position live stream (``analyze_stream``) is EPHEMERAL by design: it
kills its engine in ``finally`` (client disconnect raises GeneratorExit on the
next yield) and persists nothing (contrast positions.db). The whole-line sweep
(``analyze_line_stream``) is ALSO ephemeral in its streaming, but OPTIONALLY
consults + fills an editor-owned eval cache (``eval_cache``) when handed a
``cache_path`` — so a re-scan of the same / overlapping line skips Pikafish. The
engine itself is still spawned/killed per request (and deferred to the first
cache miss). Scores are red POV (cp/mate), matching #evalLine and the eval DB
convention.
"""
from __future__ import annotations

import json
import subprocess
import threading
import time

from backend.xqf_service import pv_to_chinese

# Per-request stall guard (T3-5). A wedged engine that emits NOTHING for this
# long is killed so it can't pin a Flask worker thread on a blocking readline
# forever. This is a STALL timeout, not a duration cap: a productive search —
# including `go infinite` for the live tab — streams `info` lines continuously,
# bumping the progress clock, so it never trips. Only true silence does.
_STALL_TIMEOUT = 30.0


def _safe_int(v, default: int = 0) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _engine_fen(fen: str) -> tuple[str, int]:
    """Editor FEN (``<board> <side>``) -> (6-field FEN Pikafish wants, red-POV
    flip). ``flip`` converts the engine's side-to-move score to red POV; -1 when
    black is to move. Missing side defaults to red. Single source for the
    backend's FEN-side parsing (both streams used to inline this)."""
    parts = fen.split()
    board_part = parts[0]
    side = parts[1] if len(parts) > 1 else "w"
    full_fen = f"{board_part} {side} - - 0 1"
    flip = -1 if side == "b" else 1
    return full_fen, flip


def _spawn(engine_path):
    """Start an engine process with cwd=binary dir (so it finds its sibling
    ``*.nnue``). Returns (proc, send) where ``send`` writes one UCI command."""
    proc = subprocess.Popen(
        [str(engine_path)],
        cwd=str(engine_path.parent),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )

    def send(cmd: str) -> None:
        proc.stdin.write(cmd + "\n")
        proc.stdin.flush()

    return proc, send


def _shutdown(proc, send) -> None:
    """Best-effort engine teardown (quit then kill); safe to call mid-stream on
    client disconnect. Swallows errors — the process may already be gone."""
    try:
        send("quit")
    except Exception:
        pass
    try:
        proc.kill()
    except Exception:
        pass


def _start_stall_watchdog(proc):
    """Kill ``proc`` if it produces no output for ``_STALL_TIMEOUT`` seconds.

    Returns a one-element list ``last`` holding the monotonic time of the last
    output — the reader loop must set ``last[0] = time.monotonic()`` on every
    line so a live/long-but-productive search never trips. The daemon thread
    exits on its own once the process dies (normal completion kills it via
    ``_shutdown``). Killing the engine makes the reader's blocking
    ``for line in proc.stdout`` hit EOF, so the generator unwinds cleanly."""
    last = [time.monotonic()]

    def watch():
        while proc.poll() is None:
            if time.monotonic() - last[0] > _STALL_TIMEOUT:
                try:
                    proc.kill()
                except Exception:
                    pass
                return
            time.sleep(1.0)

    threading.Thread(target=watch, daemon=True).start()
    return last


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
    info["pv"] = pv_to_chinese(fen, pv, limit=64)
    # Keep UCI aligned 1:1 with the Chinese list (pv_to_chinese stops at the
    # first illegal move) so demo/add-to-tree never desync.
    info["pvUci"] = pv[:len(info["pv"])]
    info["bestUci"] = pv[0] if pv else None
    return info


def _parse_score(line: str, flip: int):
    """Pull just the red-POV score out of one UCI ``info`` line — cheap, no PV
    conversion. Used by the per-position line sweep where only the number
    matters. Returns ``{"cp": n}`` or ``{"mate": n}`` (the latest wins), or None."""
    toks = line.split()
    for i in range(len(toks) - 2):
        if toks[i] == "score":
            kind, val = toks[i + 1], _safe_int(toks[i + 2])
            return {"mate": val * flip} if kind == "mate" else {"cp": val * flip}
    return None


def pikafish_info(p) -> dict:
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


def engine_signature(engine_path) -> str:
    """A cheap identity for the engine binary + its sibling NNUE net(s), used as
    part of the eval-cache key so swapping or rebuilding either MISSES (recomputes)
    instead of serving a stale score. Stat-based (name+size+mtime) — no UCI
    handshake needed, so it's free to compute per sweep. Changes whenever the user
    points at a different binary, the binary is rebuilt, or the net file changes.
    Falls back to bare names if a stat fails (still stable within one install)."""
    parts = []
    try:
        st = engine_path.stat()
        parts.append(f"{engine_path.name}:{st.st_size}:{st.st_mtime_ns}")
    except OSError:
        parts.append(engine_path.name)
    try:
        for nnue in sorted(engine_path.parent.glob("*.nnue")):
            st = nnue.stat()
            parts.append(f"{nnue.name}:{st.st_size}:{st.st_mtime_ns}")
    except OSError:
        pass
    return "|".join(parts)


def analyze_line_stream(engine_path, fens: list[str], depth: int, depth2: int,
                        cache_path=None, fresh: bool = False):
    """Generator: analyse a whole line of positions at a fixed depth, yielding one
    NDJSON record per position. One engine process reused for the whole sweep.
    Each record: ``{ply, total, cp|null, mate|null, best|null}``; when ``depth2``
    is given (>0), a single ``go depth max(depth, depth2)`` search also reports the
    second (usually deeper) eval as ``cp2|null, mate2|null`` — the client diffs
    the two to flag positions where shallow and deep search disagree.

    When ``cache_path`` is given, each position is looked up in the editor eval
    cache first (key = fen + the depth pair + this engine's signature): a hit is
    replayed verbatim with NO engine work, and a miss is computed then written
    back. The engine is spawned LAZILY on the first miss, so a fully-cached
    re-scan never starts Pikafish at all. ``fresh=True`` ignores cached rows
    (still writes back) — the force-recompute escape hatch."""
    go_depth = max(depth, depth2) if depth2 else depth
    total = len(fens)
    # Editor eval cache (optional). Resolve the pooled connection + this run's
    # engine signature up front; any failure disables caching but never breaks
    # the sweep (the engine path still works).
    cache = sig = None
    if cache_path is not None:
        try:
            from backend import eval_cache as _eval_cache
            cache = _eval_cache.ensure(cache_path)
            sig = engine_signature(engine_path)
        except Exception:
            cache = None
    proc = send = last = None   # spawned lazily on the first cache miss
    try:
        for idx, fen in enumerate(fens):
            # Cache hit → replay the stored record (engine untouched).
            if cache is not None and not fresh:
                hit = _eval_cache.read(cache, fen, depth, depth2, sig)
                if hit is not None:
                    yield json.dumps({"ply": idx, "total": total, **hit},
                                     ensure_ascii=False) + "\n"
                    continue
            # Miss → make sure the engine is up (spawn + handshake once), then
            # search this position.
            if proc is None:
                proc, send = _spawn(engine_path)
                last = _start_stall_watchdog(proc)
                send("uci")
                send("setoption name Threads value 4")
                send("setoption name Hash value 128")
                send("isready")
            if proc.poll() is not None:
                break   # watchdog killed a wedged engine — stop cleanly
            full_fen, flip = _engine_fen(fen)
            send(f"position fen {full_fen}")
            send(f"go depth {go_depth}")
            # Capture the resolved score at each completed iteration depth, so
            # one deep search yields BOTH the shallow (depth) and deep (depth2)
            # evals — iterative deepening passes through `depth` on its way up.
            cap = {}   # iteration-depth -> {"cp": x} | {"mate": x}
            best = None
            completed = False   # True only once `bestmove` confirms the search finished
            for line in proc.stdout:
                last[0] = time.monotonic()
                line = line.strip()
                if line.startswith("bestmove"):
                    bits = line.split()
                    best = bits[1] if len(bits) > 1 and bits[1] != "(none)" else None
                    completed = True
                    break
                if line.startswith("info ") and " score " in line and " depth " in line:
                    sc = _parse_score(line, flip)
                    if sc is not None:
                        toks = line.split()
                        d = None
                        for k, t in enumerate(toks):
                            if t == "depth" and k + 1 < len(toks):
                                d = _safe_int(toks[k + 1], None)
                                break
                        if d is not None:
                            cap[d] = sc   # latest line at this depth wins

            def _pick(d):
                if not d:
                    return None
                if d in cap:
                    return cap[d]
                lower = [k for k in cap if k <= d]
                return cap[max(lower)] if lower else None

            sc1 = _pick(depth)
            rec = {
                "ply": idx, "total": total,
                "cp": sc1.get("cp") if sc1 else None,
                "mate": sc1.get("mate") if sc1 else None,
                "best": best,
            }
            if depth2:
                sc2 = _pick(depth2)
                rec["cp2"] = sc2.get("cp") if sc2 else None
                rec["mate2"] = sc2.get("mate") if sc2 else None
            # Persist this freshly-computed record (ply/total are per-request, so
            # store only the eval fields) — but ONLY when the search actually
            # finished (`bestmove` seen). A position whose engine was stall-killed
            # mid-search holds a shallower-than-requested (or empty) score; caching
            # that would serve a wrong-depth eval forever. It's still streamed for
            # live display, just not written. Cache failure never breaks the stream.
            if cache is not None and completed:
                try:
                    _eval_cache.write(cache, fen, depth, depth2, sig,
                                      {k: rec[k] for k in
                                       ("cp", "mate", "best", "cp2", "mate2") if k in rec})
                except Exception:
                    pass
            yield json.dumps(rec, ensure_ascii=False) + "\n"
    finally:
        if proc is not None:
            _shutdown(proc, send)


def analyze_stream(engine_path, fen: str, depth: int, movetime: int):
    """Generator: live SSE analysis of ONE position. Streams per-depth depth/
    score/pv events (plus a 150ms heartbeat so nps/time tick on long single-depth
    searches), then a final ``{done:true, bestmove}``. ``depth>0`` -> ``go depth``;
    else ``movetime>0`` -> ``go movetime`` (auto-play uses this); else
    ``go infinite``. Killed when the client closes (GeneratorExit) or bestmove
    arrives."""
    full_fen, flip = _engine_fen(fen)
    proc, send = _spawn(engine_path)
    last = _start_stall_watchdog(proc)
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
            last[0] = time.monotonic()
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
        _shutdown(proc, send)


def bestmove_with_moves(engine_path, fen: str, moves: list[str], depth: int) -> dict:
    """一次取最佳著＋分數，**帶走子歷史**（`position fen <fen> moves <m1 m2 …>`）。

    給「中局練習走錯後與 AI 對弈」用。關鍵：只送單一 FEN 時引擎沒有歷史、偵測不到
    重複局面，於勝勢局面會一直挑同一將軍著 → **長將循環**。送出自起始盤以來的完整
    走子串後，Pikafish 依陸規（長將判負、三次重複判和）就會避開長將、有殺則收殺。
    一次性、不快取（局面隨歷史而異，以 FEN 為鍵的 eval cache 會誤命中）。

    回 `{best, cp, mate}`，cp/mate 為**紅方 POV**（同 analyze_line_stream 慣例）。
    `_engine_fen` 的 flip 是依 `fen` 的走子方；套用 `moves` 後走子方會翻 len(moves)
    次，故奇數步要再反號，分數才正確歸到紅方 POV。
    """
    full_fen, flip = _engine_fen(fen)
    if moves and len(moves) % 2 == 1:
        flip = -flip
    mv = (" moves " + " ".join(moves)) if moves else ""
    proc, send = _spawn(engine_path)
    last = _start_stall_watchdog(proc)
    try:
        send("uci")
        send("setoption name Threads value 4")
        send("setoption name Hash value 128")
        send("isready")
        send(f"position fen {full_fen}{mv}")
        send(f"go depth {depth}")
        best = None
        cp = mate = None
        for line in proc.stdout:
            last[0] = time.monotonic()
            line = line.strip()
            if line.startswith("bestmove"):
                bits = line.split()
                best = bits[1] if len(bits) > 1 and bits[1] != "(none)" else None
                break
            if line.startswith("info ") and " score " in line and " depth " in line:
                sc = _parse_score(line, flip)
                if sc is not None:
                    cp = sc.get("cp")    # 最新一條 info 勝出（深度最深）
                    mate = sc.get("mate")
        return {"best": best, "cp": cp, "mate": mate}
    finally:
        _shutdown(proc, send)
