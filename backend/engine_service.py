"""Pikafish subprocess management + UCI parsing for the two streaming analysis
routes (T2-2 split out of app.py).

The app.py routes stay thin: parse/validate the request, resolve the engine
path (config._get_pikafish), then wrap one of these generators in a streaming
Flask Response. The shared subprocess plumbing (``_spawn``/``_shutdown``) and the
editor-FEN→6-field conversion (``_engine_fen``) live here so the two streams
don't each reimplement them — that's the "兩支 SSE 合一" of the backlog.

Both streams are EPHEMERAL by design: each generator kills its engine in
``finally`` (client disconnect raises GeneratorExit on the next yield), and
nothing is persisted (contrast positions.db). Scores are red POV (cp/mate),
matching #evalLine and the eval DB convention.
"""
from __future__ import annotations

import json
import subprocess
import time

from backend.xqf_service import pv_to_chinese


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


def analyze_line_stream(engine_path, fens: list[str], depth: int, depth2: int):
    """Generator: analyse a whole line of positions at a fixed depth, yielding one
    NDJSON record per position. One engine process reused for the whole sweep.
    Each record: ``{ply, total, cp|null, mate|null, best|null}``; when ``depth2``
    is given (>0), a single ``go depth max(depth, depth2)`` search also reports the
    second (usually deeper) eval as ``cp2|null, mate2|null`` — the client diffs
    the two to flag positions where shallow and deep search disagree."""
    go_depth = max(depth, depth2) if depth2 else depth
    proc, send = _spawn(engine_path)
    try:
        send("uci")
        send("setoption name Threads value 4")
        send("setoption name Hash value 128")
        send("isready")
        total = len(fens)
        for idx, fen in enumerate(fens):
            full_fen, flip = _engine_fen(fen)
            send(f"position fen {full_fen}")
            send(f"go depth {go_depth}")
            # Capture the resolved score at each completed iteration depth, so
            # one deep search yields BOTH the shallow (depth) and deep (depth2)
            # evals — iterative deepening passes through `depth` on its way up.
            cap = {}   # iteration-depth -> {"cp": x} | {"mate": x}
            best = None
            for line in proc.stdout:
                line = line.strip()
                if line.startswith("bestmove"):
                    bits = line.split()
                    best = bits[1] if len(bits) > 1 and bits[1] != "(none)" else None
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
            yield json.dumps(rec, ensure_ascii=False) + "\n"
    finally:
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
        _shutdown(proc, send)
