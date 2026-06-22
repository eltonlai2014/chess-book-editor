// editor-autoplay.js — extracted from editor.js (T2-1 incremental split).
// Classic script: shares the global lexical scope with editor.js and is
// loaded BEFORE it in index.html, so its functions may freely reference
// editor.js globals (EDITOR, $, helpers) — they're only called at runtime,
// after every script has loaded. Do NOT convert to an ES module.

// ---------- AI 自動走棋 (auto-play) ----------
// pikafish drives one or both sides. Each side gets a think-time budget (步時,
// seconds); the engine searches `go movetime` and plays its bestmove the moment
// time runs out (= the highest-scored move so far). Backend is unchanged — the
// /api/engine/analyze SSE endpoint already honours `movetime` and reports
// `{done, bestmove}`. Two modes (snapshotted at start into autoPlay.recording):
//   record  — every move is inserted into the tree (insertMoveAt); persists.
//   sandbox — moves live on an ephemeral line (autoPlay.sandboxLine); the tree
//             is untouched and the board is restored to startPath on stop.

// Preference accessors (mirror aiDepth()/cdbLineDepth() house style).
function autoAiRed() { return PREFS.autoAiRed === true || PREFS.autoAiRed === "true"; }
function autoAiBlack() { return PREFS.autoAiBlack === true || PREFS.autoAiBlack === "true"; }
function autoRedSecs() { const s = parseInt(PREFS.autoRedSecs, 10); return Number.isFinite(s) && s >= 1 && s <= 120 ? s : 3; }
function autoBlackSecs() { const s = parseInt(PREFS.autoBlackSecs, 10); return Number.isFinite(s) && s >= 1 && s <= 120 ? s : 3; }
function autoMaxPlies() { const n = parseInt(PREFS.autoMaxPlies, 10); return Number.isFinite(n) && n >= 2 && n <= 600 ? n : 200; }

// Redraw the board for the *input* path: during a sandbox session the board
// shows the ephemeral line, otherwise the normal tree-driven full refresh.
function redrawBoardView() {
  const ap = EDITOR.autoPlay;
  if (ap.running && !ap.recording) renderSandbox();
  else refreshActive();
}

// Draw the sandbox line's current tip on the main board (no tree side-effects).
// Mirrors the board portion of refreshActive() but keyed off boardFen(); leaves
// the move list / eval line alone (those describe the tree, which is unchanged).
function renderSandbox() {
  const ap = EDITOR.autoPlay;
  const last = ap.sandboxLine.length ? ap.sandboxLine[ap.sandboxLine.length - 1] : null;
  const fen = last ? last.fen : ap.sandboxBaseFen;
  const lastIccs = last ? last.iccs : null;
  drawBoard($("#board"), fen, lastIccs, null, EDITOR.selectedSquare);
  installBoardOverlay($("#board"));   // halo + legal dots + carried piece read selection + boardFen()
}

// Append one move to the sandbox line and redraw. Selection is consumed.
function sandboxPush(iccs, notation, side) {
  const ap = EDITOR.autoPlay;
  const tip = ap.sandboxLine.length ? ap.sandboxLine[ap.sandboxLine.length - 1].fen : ap.sandboxBaseFen;
  clearSelection();
  ap.sandboxLine.push({ iccs, notation, side, fen: applyIccs(tip, iccs) });   // applyIccs from board.js
  renderSandbox();
}

// Ask the engine for the best move at `fen`, thinking for `movetimeMs`. Resolves
// {bestUci, notation} — bestUci null means terminal (bestmove "(none)") or error.
// Headless: its own EventSource (stored on autoPlay.es so stopAutoPlay can abort)
// — deliberately NOT startAnalysis(), which is bound to the 引擎分析 tab UI.
function requestBestMove(fen, movetimeMs) {
  return new Promise((resolve) => {
    let lastEv = null;   // most recent info event (carries pv/pvUci for notation)
    const url = "/api/engine/analyze?fen=" + encodeURIComponent(fen) + "&movetime=" + movetimeMs + "&depth=0";
    const stream = openAnalyzeStream(url, {
      onInfo: (ev) => { if (ev.pvUci || ev.pv) lastEv = ev; },
      onError: (msg) => {
        if (EDITOR.autoPlay.es === stream.es) EDITOR.autoPlay.es = null;
        resolve({ bestUci: null, error: msg });
      },
      onDone: async (ev) => {
        if (EDITOR.autoPlay.es === stream.es) EDITOR.autoPlay.es = null;
        const bm = ev.bestmove;
        const cp = lastEv ? (lastEv.cp ?? null) : null;   // red-POV, for the history score
        const mate = lastEv ? (lastEv.mate ?? null) : null;
        if (!bm || bm === "(none)" || bm.length < 4) { resolve({ bestUci: null }); return; }
        // Notation: free if the last PV started with this move; else one move-info.
        let notation = null;
        if (lastEv && lastEv.pvUci && lastEv.pvUci[0] === bm && lastEv.pv) notation = lastEv.pv[0];
        if (!notation) {
          try {
            const r = await fetch("/api/xqf/move-info", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ fen, iccs: bm }),
            });
            const resp = await r.json();
            notation = resp.error ? bm : resp.notation;
          } catch (_) { notation = bm; }
        }
        resolve({ bestUci: bm, notation, cp, mate });
      },
    });
    EDITOR.autoPlay.es = stream.es;
  });
}

// Apply one AI move. Returns true if the board advanced (loop should continue).
async function autoApplyMove(iccs, notation, sideName) {
  if (EDITOR.autoPlay.recording) {
    const outcome = await insertMoveAt(EDITOR.activePath, {
      iccs, notation: notation || iccs, side: sideName || "",
      ply: EDITOR.activePath.length + 1, annote: "", children: [],
    });
    return outcome === "added" || outcome === "existing";   // "cancelled" → halt
  }
  sandboxPush(iccs, notation || iccs, sideName || "");
  return true;
}

function autoPlayActiveSides() { return autoAiRed() || autoAiBlack(); }

function startAutoPlay() {
  if (!EDITOR.data) { setStatus("尚未載入棋譜", "err"); return; }
  if (!EDITOR.engineInfo || !EDITOR.engineInfo.ok) { setStatus("引擎未設定（請在檔案窗格設定引擎）", "err"); return; }
  if (!autoPlayActiveSides()) { setStatus("請先在 ⚙ 設定勾選 AI 紅方或 AI 黑方", "err"); openSettingsModal(); return; }
  const ap = EDITOR.autoPlay;
  ap.running = true;
  // Auto-play always runs in the ephemeral sandbox (never auto-writes the tree);
  // to keep a line, use 加入 on the latest history step. The recording field is
  // kept (the sandbox/tree split keys off it) but pinned false now the UI toggle
  // is gone.
  ap.recording = false;
  ap.waitingHuman = false;
  ap.startPath = [...EDITOR.activePath];
  ap.sandboxBaseFen = currentFen();
  ap.sandboxLine = [];
  ap.history = [];                     // fresh session log
  renderAutoHistory();
  switchRpTab("auto");                 // surface the live move log
  updateAutoPlayBtn();
  autoPlayStep();
}

async function autoPlayStep() {
  const ap = EDITOR.autoPlay;
  if (!ap.running) return;
  const fen = boardFen();
  if (!fen) { stopAutoPlay("無局面"); return; }
  const side = parseFen(fen).side;   // "w" red / "b" black (board.js)
  const aiThis = side === "w" ? autoAiRed() : autoAiBlack();
  if (!aiThis) {                     // 人機輪替: idle until the human moves
    ap.waitingHuman = true;
    setAutoState(`等待${side === "w" ? "紅" : "黑"}方（對手）落子…`);
    return;
  }
  if (!ap.recording && ap.sandboxLine.length >= autoMaxPlies()) { stopAutoPlay("達沙盒步數上限"); return; }
  const secs = side === "w" ? autoRedSecs() : autoBlackSecs();
  setAutoState(`AI 思考中（${side === "w" ? "紅" : "黑"}方 ${secs}s）…`);
  const res = await requestBestMove(fen, secs * 1000);
  if (!ap.running) return;           // stopped during the search
  if (res.error) { stopAutoPlay("引擎錯誤：" + res.error); return; }
  if (!res.bestUci) { stopAutoPlay("終局（無合法著）"); return; }
  const sideName = side === "w" ? "red" : "black";
  const advanced = await autoApplyMove(res.bestUci, res.notation, sideName);
  if (!ap.running) return;
  if (!advanced) { stopAutoPlay("已取消新增分支"); return; }
  // Log the played move (chronological; rendered newest-on-top). cp/mate are
  // red-POV from requestBestMove.
  ap.history.push({ side: sideName, iccs: res.bestUci, notation: res.notation, cp: res.cp, mate: res.mate });
  renderAutoHistory();
  setAutoState(`已走 ${ap.history.length} 步…`);
  autoPlayStep();                    // next ply
}

// Called after a human move lands: resume the loop if it was idling and the
// next side is AI.
function maybeResumeAutoPlay() {
  const ap = EDITOR.autoPlay;
  if (!ap.running || !ap.waitingHuman) return;
  const fen = boardFen();
  if (!fen) return;
  const side = parseFen(fen).side;
  const aiNext = side === "w" ? autoAiRed() : autoAiBlack();
  if (aiNext) { ap.waitingHuman = false; autoPlayStep(); }
}

// `restore` = false when the caller is about to swap EDITOR.data (file/dir
// switch): don't navigate the old startPath into the new tree, just drop state.
function stopAutoPlay(msg, restore = true) {
  const ap = EDITOR.autoPlay;
  const wasSandbox = ap.running && !ap.recording && ap.sandboxLine.length;
  ap.running = false;
  ap.waitingHuman = false;
  if (ap.es) { try { ap.es.close(); } catch (_) { } ap.es = null; }
  ap.sandboxLine = [];
  // history + startPath/sandboxBaseFen persist so 演示/加入 still work after stop.
  updateAutoPlayBtn();
  if (msg != null) setAutoState(msg);
  if (wasSandbox && restore && ap.startPath && EDITOR.data) navigateTo(ap.startPath);   // discard sandbox, show the real board
}

function toggleAutoPlay() {
  if (EDITOR.autoPlay.running) stopAutoPlay("已停止自動走棋");
  else startAutoPlay();
}

function updateAutoPlayBtn() {
  const btn = $("#autoStartBtn");
  if (!btn) return;
  // Start/stop lives inside the 🤖AI走棋 tab control bar (not the tab strip).
  btn.innerHTML = EDITOR.autoPlay.running ? iconLabel("stop", "停止") : iconLabel("play", "開始");
  btn.title = EDITOR.autoPlay.running ? "停止 AI 自動走棋" : "開始 AI 自動走棋（步時/紅黑由 ⚙ 設定）";
}

function setAutoState(text) {
  const el = $("#autoState");
  if (el) el.textContent = text;
}

// Build a {fen, path, pvUci, pv} entry for the line from the session start up to
// (and including) history step `idx` — fed to openDemo / addPvLine. The start
// position + tree path persist on autoPlay across stop, so this works mid-run
// and after. Same shape as cdbLineEntry().
function autoEntryUpTo(idx) {
  const ap = EDITOR.autoPlay;
  const slice = ap.history.slice(0, idx + 1);
  return {
    fen: ap.sandboxBaseFen,
    path: Array.isArray(ap.startPath) ? [...ap.startPath] : [],
    pvUci: slice.map((s) => s.iccs),
    pv: slice.map((s) => s.notation),
  };
}

// Move log for the auto-play session. Newest on top (matches 引擎分析). Each row
// = 第N步 著法 紅分 + 演示/加入 (replay / merge the line up to that step). Records
// regardless of mode; 加入 is most useful in sandbox (record mode is already in
// the tree). Reuses fmtEngineScore for the red-POV cp/mate.
function renderAutoHistory() {
  const box = $("#autoHistory");
  if (!box) return;
  const h = EDITOR.autoPlay.history;
  if (!h.length) { box.innerHTML = `<div class="varEmpty">尚未自動走棋</div>`; return; }
  const last = h.length - 1;
  box.innerHTML = h.map((e, i) => {
    const sideTxt = e.side === "red" ? "紅" : "黑";
    const cls = e.side === "red" ? "moveRed" : "moveBlk";
    // Only the latest step carries 演示/加入 — the line up to "now" is the only
    // one worth replaying or merging; older rows would just be prefixes of it.
    const actions = (i === last)
      ? `<span class="engActions">`
        + `<button class="autoDemo" title="在彈出棋盤上演示自起點到這一步的走子">${iconLabel("demo", "演示")}</button>`
        + `<button class="autoAdd" title="把自起點到這一步的走子加入棋譜分支">${iconLabel("branch", "加入")}</button>`
        + `</span>`
      : "";
    return `<div class="engEntry" data-seq="${i}">`
      + `<div class="engMeta">`
      + `<span>第 <b class="engBig">${i + 1}</b> 步</span>`
      + `<span class="${cls}">${sideTxt} <b class="engBig">${e.notation || e.iccs}</b></span>`
      + `<span>紅分 <b class="engBig">${fmtEngineScore(e)}</b></span>`
      + actions
      + `</div>`
      + `</div>`;
  }).reverse().join("");   // newest on top
}

function clearAutoHistory() {
  EDITOR.autoPlay.history = [];
  renderAutoHistory();
  setAutoState("尚未開始");
}
