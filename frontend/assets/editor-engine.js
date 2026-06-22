// editor-engine.js — extracted from editor.js (T2-1 incremental split).
// Classic script: shares the global lexical scope with editor.js and is
// loaded BEFORE it in index.html, so its functions may freely reference
// editor.js globals (EDITOR, $, helpers) — they're only called at runtime,
// after every script has loaded. Do NOT convert to an ES module.

function fmtEngineScore(ev) {
  if (ev.mate != null) {
    const m = Number(ev.mate);
    return (m > 0 ? "#+" : "#-") + Math.abs(m);
  }
  if (ev.cp == null) return "—";
  return (ev.cp > 0 ? "+" : "") + ev.cp;
}

// WDL is per-mille (win/draw/loss summing to 1000), already red POV.
function fmtWdl(wdl) {
  if (!wdl || wdl.length < 3) return "";
  const pct = (x) => (x / 10).toFixed(1);
  return `勝 ${pct(wdl[0])}%　和 ${pct(wdl[1])}%　負 ${pct(wdl[2])}%`;
}

// Same numbers as fmtWdl but as colour-coded spans for the inline meta row.
function fmtWdlHtml(wdl) {
  if (!wdl || wdl.length < 3) return "";
  const pct = (x) => (x / 10).toFixed(1);
  return `<span class="wdlW">勝 ${pct(wdl[0])}%</span>`
    + `<span class="wdlD">和 ${pct(wdl[1])}%</span>`
    + `<span class="wdlL">負 ${pct(wdl[2])}%</span>`;
}

// Record one streamed event into the history (newest depth on top, Pikafish
// style). Same-depth heartbeats update the top row in place; a new depth
// prepends a fresh row. Values are already red-POV + Chinese from the backend.
function recordEngineEvent(ev) {
  if (ev.done) return;
  const h = EDITOR.engineAnalysis.history;
  const a0 = EDITOR.engineAnalysis;
  const entry = {
    depth: ev.depth, cp: ev.cp, mate: ev.mate, wdl: ev.wdl,
    time_ms: ev.time_ms, pv: ev.pv || [], pvUci: ev.pvUci || [],
    fen: a0.fen, path: a0.startPath,   // start position + tree path for demo / 加入
  };
  if (h.length && h[0].depth === entry.depth) h[0] = entry;
  else h.unshift(entry);
  renderEngineHistory();
  updateBoardArrows();   // refresh the blue best-move arrow as depth climbs
}

// "red"|"black" of the side to move at a two/six-field FEN. Used by the 雲庫演繹
// per-row side tint. (The 引擎分析 PV is intentionally left uncoloured — tinting
// its moves, even just the lead one, read as too busy.)
function fenSideName(fen) {
  return fenSide(fen) === "w" ? "red" : "black";
}

function renderEngineHistory() {
  const box = $("#engineHistory");
  if (!box) return;
  const h = EDITOR.engineAnalysis.history;
  if (!h.length) { box.innerHTML = `<div class="varEmpty">尚無分析結果</div>`; return; }
  box.innerHTML = h.map((e) => {
    const t = e.time_ms ? (e.time_ms / 1000).toFixed(1) + "s" : "—";
    const pv = (e.pv || []).join("　");   // single colour — tinting plies was too busy
    const canPlay = (e.pvUci || []).length > 0;
    return `<div class="engEntry" data-depth="${e.depth}">`
      + `<div class="engMeta">`
      + `<span>深度 <b class="engBig">${e.depth}</b></span>`
      + `<span>紅分 <b class="engBig">${fmtEngineScore(e)}</b></span>`
      + `<span>耗時 ${t}</span>`
      + fmtWdlHtml(e.wdl)
      + (canPlay ? `<span class="engActions">`
        + `<button class="engDemo" title="在彈出棋盤上演示這條變化例">${iconLabel("demo", "演示")}</button>`
        + `<button class="engAdd" title="把這條變化例加入棋譜分支">${iconLabel("branch", "加入")}</button>`
        + `</span>` : "")
      + `</div>`
      + (pv ? `<div class="engPv">${pv}</div>` : "")
      + `</div>`;
  }).join("");
}

function clearAnalysisHistory() {
  EDITOR.engineAnalysis.history = [];
  renderEngineHistory();
}

// Export the full history as plain text via the clipboard — the natural feed
// into the 注解 box or notes. Header carries the analysed position's FEN.
function exportAnalysisHistory() {
  const h = EDITOR.engineAnalysis.history;
  if (!h.length) { setStatus("無分析歷程可導出", "err"); return; }
  const fen = EDITOR.engineAnalysis.fen || currentFen() || "";
  const body = h.map((e) => {
    const t = e.time_ms ? (e.time_ms / 1000).toFixed(1) + "s" : "—";
    const wdl = fmtWdl(e.wdl);
    let head = `深度 ${e.depth}　紅分 ${fmtEngineScore(e)}　耗時 ${t}`;
    if (wdl) head += `　${wdl}`;
    const pv = (e.pv || []).join(" ");
    return pv ? head + "\n" + pv : head;
  }).join("\n");
  const text = `局面 FEN: ${fen}\n\n${body}\n`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => setStatus("已複製分析歷程到剪貼簿", "ok"),
      () => setStatus("複製失敗", "err"),
    );
  } else {
    setStatus("瀏覽器不支援剪貼簿", "err");
  }
}

// The engine should evaluate the position the *active move was chosen from*
// (i.e. one ply back), so its best-move/eval judges that move. At the initial
// position (no parent) we analyse the initial position itself.
function analysisFen() {
  const path = EDITOR.activePath;
  if (!path || path.length === 0) return currentFen();
  return fenAndLastIccsFor(path.slice(0, -1)).fen;
}

function stopAnalysis(stateText) {
  const a = EDITOR.engineAnalysis;
  if (a.es) { try { a.es.close(); } catch (_) { } }
  a.es = null;
  a.running = false;
  a.fen = null;
  a.mode = null;
  updateEngineToggleBtns();   // clear the 前一步/本步 active highlight
  const st = $("#engineState");
  if (st && stateText != null) st.textContent = stateText;
  updateBoardArrows();   // drop the blue best-move arrow now analysis is idle
}

// Reflect which analysis mode is running on the segmented 前一步/本步 toggle.
function updateEngineToggleBtns() {
  const a = EDITOR.engineAnalysis;
  const prev = $("#engineToggleBtn"), cur = $("#engineCurBtn");
  if (prev) prev.classList.toggle("active", a.running && a.mode === "prev");
  if (cur) cur.classList.toggle("active", a.running && a.mode === "cur");
}

// Segmented-toggle click: re-clicking the running mode stops; otherwise (re)start
// analysis on that mode's position. Mirrors the 當前步/下一步 mode-switch feel.
function engineModeClick(mode) {
  const a = EDITOR.engineAnalysis;
  if (a.running && a.mode === mode) { stopAnalysis("已停止"); return; }
  startAnalysis(mode === "cur" ? currentFen() : analysisFen(), mode);
}

// ---------- shared SSE helper for /api/engine/analyze ----------
// All three engine streams (startAnalysis live UI, requestBestMove, requestDemoPv)
// shared the same boilerplate: open an EventSource, JSON-parse each line, and
// dispatch error / done / info. Centralised here so a fix (parse guard, close
// timing, error wording) lands once instead of in three places. Dispatch:
//   onInfo(ev)        — any non-terminal event (depth/score/pv/pvUci…)
//   onDone(ev)        — the terminal {done:true, bestmove?} event (auto-closed first)
//   onError(msg, ev?) — ev.error from the backend (ev present), OR a connection
//                       drop ("連線中斷", ev undefined)
// Returns {es, close}; close() is idempotent. Callers that store es for external
// abort (autoPlay.es / demo.es) keep doing so via the returned handle.
function openAnalyzeStream(url, { onInfo, onDone, onError } = {}) {
  const es = new EventSource(url);
  let closed = false;
  const close = () => { if (closed) return; closed = true; try { es.close(); } catch (_) { } };
  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch (_) { return; }
    if (ev.error) { close(); if (onError) onError(ev.error, ev); return; }
    if (ev.done) { close(); if (onDone) onDone(ev); return; }
    if (onInfo) onInfo(ev);
  };
  es.onerror = () => { close(); if (onError) onError("連線中斷"); };
  return { es, close };
}

// mode: "prev" = the position the active move was chosen from (judge the move);
//       "cur"  = the position after the active move.
function startAnalysis(fen, mode) {
  switchRpTab("engine");
  if (!EDITOR.engineInfo || !EDITOR.engineInfo.ok) {
    $("#engineState").textContent = "引擎未設定（請在檔案窗格設定引擎）";
    return;
  }
  if (!fen) { $("#engineState").textContent = "尚未載入棋譜"; return; }
  stopAnalysis(null);
  const a = EDITOR.engineAnalysis;
  a.fen = fen;
  a.mode = mode;
  // Tree path the PV branches from: the active node (cur) or its parent (prev).
  a.startPath = mode === "cur" ? [...EDITOR.activePath] : EDITOR.activePath.slice(0, -1);
  a.running = true;
  a.history = [];
  renderEngineHistory();
  $("#engineState").textContent = mode === "cur" ? "分析中（本步）…" : "分析中（前一步）…";
  updateEngineToggleBtns();   // highlight the running mode on the segmented toggle
  a.es = openAnalyzeStream("/api/engine/analyze?fen=" + encodeURIComponent(fen), {
    onInfo: (ev) => recordEngineEvent(ev),
    onDone: (ev) => { recordEngineEvent(ev); stopAnalysis("完成"); },
    onError: (msg, ev) => stopAnalysis(ev ? "錯誤：" + msg : msg),
  }).es;
}
