// editor-demo.js — extracted from editor.js (T2-1 incremental split).
// Classic script: shares the global lexical scope with editor.js and is
// loaded BEFORE it in index.html, so its functions may freely reference
// editor.js globals (EDITOR, $, helpers) — they're only called at runtime,
// after every script has loaded. Do NOT convert to an ES module.

// ---------- 演示: replay one PV line on a popup board ----------
function renderDemo() {
  const d = EDITOR.demo;
  if (!d.fens.length) return;
  const lastIccs = d.idx > 0 ? d.lastIccs[d.idx - 1] : null;
  drawBoard($("#demoBoard"), d.fens[d.idx], lastIccs, null);
  const info = $("#demoMoveInfo");
  if (info) {
    info.textContent = d.idx === 0
      ? `起始局面（共 ${d.lastIccs.length} 步）`
      : `第 ${d.idx} / ${d.lastIccs.length} 步：${d.notations[d.idx - 1] || ""}`;
  }
}

function demoStopPlay() {
  const d = EDITOR.demo;
  if (d.timer) { clearInterval(d.timer); d.timer = null; }
  const b = $("#demoPlay");
  if (b) { b.innerHTML = ICON.demo; b.title = "自動播放"; }
}

function demoGo(idx) {
  const d = EDITOR.demo;
  d.idx = Math.max(0, Math.min(idx, d.fens.length - 1));
  renderDemo();
  if (d.idx >= d.fens.length - 1) demoStopPlay();
}

function demoTogglePlay() {
  const d = EDITOR.demo;
  if (d.timer) { demoStopPlay(); return; }
  if (d.idx >= d.fens.length - 1) demoGo(0);   // restart from the top
  const sec = parseFloat($("#demoInterval").value) || 2;
  const b = $("#demoPlay");
  if (b) { b.innerHTML = ICON.pause; b.title = "暫停"; }
  d.timer = setInterval(() => {
    if (d.idx >= d.fens.length - 1) { demoStopPlay(); return; }
    demoGo(d.idx + 1);
  }, Math.max(200, sec * 1000));
}

function openDemo(entry) {
  const moves = entry.pvUci || [];
  if (!moves.length || !entry.fen) { setStatus("此變化例無走子可演示", "err"); return; }
  const fens = [entry.fen];
  for (const u of moves) fens.push(applyIccs(fens[fens.length - 1], u));
  // startFen/startPath persist so 延伸 can append from the leaf and 加入 can merge
  // the WHOLE line (original + every extension) back at the original branch point.
  // notations/lastIccs ARE the running pv/pvUci — they grow in place as we extend,
  // so the demo state itself is always the full {fen,path,pvUci,pv} addPvLine wants.
  EDITOR.demo = {
    fens, notations: (entry.pv || []).slice(), lastIccs: moves.slice(), idx: 0, timer: null,
    startFen: entry.fen, startPath: Array.isArray(entry.path) ? [...entry.path] : [],
    es: null, extending: false,
  };
  $("#demoModal").hidden = false;
  setDemoStatus("");      // fresh dialog: no stale 延伸 feedback
  resetDemoExtendBtn();   // never inherit a stale 計算中… from a prior aborted run
  demoStopPlay();   // ensure the play button shows ▶ (not a stale ⏸)
  renderDemo();
}

function resetDemoExtendBtn() {
  const btn = $("#demoExtendBtn");
  if (btn) { btn.disabled = false; btn.innerHTML = iconLabel("fish", "延伸"); }
}

function closeDemo() {
  demoStopPlay();
  const d = EDITOR.demo;
  if (d.es) { try { d.es.close(); } catch (_) { } d.es = null; }  // abort an in-flight 延伸
  d.extending = false;
  resetDemoExtendBtn();
  setDemoStatus("");
  $("#demoModal").hidden = true;
}

// Persisted 延伸 search DEPTH (plies). Depth beats a time budget here: a fixed
// depth is quantifiable + reproducible (same depth = same search quality), while
// seconds vary with position complexity + machine speed. Mirrors aiDepth() house
// style: read PREFS, clamp 6–40, default 16. Saved on the input's change.
function demoExtendDepth() { const d = parseInt(PREFS.demoExtendDepth, 10); return Number.isFinite(d) && d >= 6 && d <= 40 ? d : 16; }

// ---------- 延伸: extend the demo line with a fresh engine PV from the leaf ----------
// Headless analyze (own EventSource on EDITOR.demo.es so closeDemo can abort it) —
// deliberately NOT startAnalysis (bound to the 引擎分析 tab) nor requestBestMove
// (resolves one move; we want the whole deepest PV). `go depth N` (the backend
// prioritises depth over movetime), so the search stops at a quantifiable depth.
// Resolves {pvUci, pv}.
function requestDemoPv(fen, depth) {
  return new Promise((resolve) => {
    let lastEv = null;   // most recent info event carries the deepest pv/pvUci
    const url = "/api/engine/analyze?fen=" + encodeURIComponent(fen) + "&depth=" + depth;
    const stream = openAnalyzeStream(url, {
      onInfo: (ev) => { if (ev.pvUci || ev.pv) lastEv = ev; },
      onDone: () => {
        if (EDITOR.demo.es === stream.es) EDITOR.demo.es = null;
        resolve({ pvUci: (lastEv && lastEv.pvUci) || [], pv: (lastEv && lastEv.pv) || [] });
      },
      onError: (msg) => {
        if (EDITOR.demo.es === stream.es) EDITOR.demo.es = null;
        resolve({ pvUci: [], pv: [], error: msg });
      },
    });
    EDITOR.demo.es = stream.es;
  });
}

// Extend from the CURRENTLY-shown step (d.idx), not the tail: navigate to the
// step you still trust, hit 延伸, and everything after it is replaced by a fresh
// engine PV. (The demo's last few plies — esp. a chessdb-derived / shallow tail —
// are low-confidence; this lets the master cut the tail and recompute from any
// point.) At the last step it's a no-op truncation, i.e. plain "extend deeper".
async function demoExtend() {
  const d = EDITOR.demo;
  if (d.extending) return;
  if (!EDITOR.engineInfo || !EDITOR.engineInfo.ok) { setDemoStatus("引擎未設定（請在檔案窗格設定引擎）", "err"); return; }
  demoStopPlay();
  const at = d.idx;                        // branch point = the step now on screen
  const leaf = d.fens[at];
  const dropped = d.lastIccs.length - at;  // demo plies after `at` that will be discarded
  const depth = demoExtendDepth();   // persisted; the input's change handler keeps PREFS in sync
  const btn = $("#demoExtendBtn");
  d.extending = true;
  // Busy label MUST stay the same width as the resting "延伸" or the centred
  // .demoActions row drifts as it widens. "計算" is the same 2 CJK glyphs + same
  // icon → identical width, zero drift. The depth detail (redundant with the
  // 「計算 N 層」input beside it) goes to #demoStatus, not onto the button.
  if (btn) { btn.disabled = true; btn.innerHTML = iconLabel("fish", "計算"); }
  setDemoStatus(`計算中(深${depth})…`, "warn");
  const res = await requestDemoPv(leaf, depth);
  d.extending = false;
  resetDemoExtendBtn();
  if ($("#demoModal").hidden) return;      // dialog closed mid-search
  if (res.error) { setDemoStatus("引擎錯誤：" + res.error, "err"); return; }
  if (!res.pvUci.length) { setDemoStatus("引擎無延伸著法（可能已終局）", "err"); return; }
  // Cut the tail beyond `at`, then graft the fresh engine PV from there.
  d.fens.length = at + 1;
  d.lastIccs.length = at;
  d.notations.length = at;
  for (let i = 0; i < res.pvUci.length; i++) {
    d.fens.push(applyIccs(d.fens[d.fens.length - 1], res.pvUci[i]));
    d.lastIccs.push(res.pvUci[i]);
    d.notations.push(res.pv[i] || res.pvUci[i]);
  }
  d.idx = at;   // park at the join so ▶ plays the newly computed line
  renderDemo();
  // Terse, one-line: drop the spaces + the「可再延伸或按加入」hint (the buttons are
  // right above) so it never wraps. 深N matches the busy-button wording.
  const tail = dropped > 0 ? `（捨尾${dropped}）` : "";
  const from = at === 0 ? "自起始" : `自第${at}步`;
  setDemoStatus(`${from}以深${depth}延伸${res.pvUci.length}步${tail}，共${d.lastIccs.length}步`, "ok");
}

// ---------- 加入: merge the demo line UP TO THE CURRENT STEP into the tree ----------
// Only graft the prefix the master has navigated to (d.idx plies), NOT the whole
// line: the tail beyond the shown step "floats" (a shallow engine / chessdb end
// the master hasn't vetted) and isn't worth committing. Navigate to the step you
// trust, then 加入 — it adds lastIccs[0..d.idx). (At the last step d.idx ===
// lastIccs.length, so it still grafts everything; 延伸 recomputes a deeper tail.)
// CLOSE the demo first: it shares .modal z-index:10 with #confirmModal but sits
// LATER in the DOM, so a still-open demo paints OVER addPvLine's confirm dialog
// and blocks the 確定/取消 buttons. Snapshot before closing (closeDemo keeps
// EDITOR.demo's data, but a copy is race-proof) — and after 加入 the board
// navigates to the new branch, so leaving the demo open would only show a stale
// position anyway.
function demoAdd() {
  const d = EDITOR.demo;
  if (d.idx < 1) { setDemoStatus("請先前進到要加入的步數（起始局面無著法可加入）", "warn"); return; }
  const entry = {
    fen: d.startFen, path: d.startPath,
    pvUci: d.lastIccs.slice(0, d.idx), pv: d.notations.slice(0, d.idx),
  };
  closeDemo();
  addPvLine(entry);
}

// ---------- 加入: merge a PV line into the move tree as a branch ----------
async function addPvLine(entry) {
  const moves = entry.pvUci || [];
  if (!moves.length) { setStatus("此變化例無走子可加入", "err"); return; }
  if (!EDITOR.data) { setStatus("尚未載入棋譜", "err"); return; }
  const ok = await showConfirmDialog(
    `將引擎變化例（${moves.length} 步）自此局面加入棋譜分支？\n已存在的著法會沿用，不重複建立。`,
    "加入變化例",
  );
  if (!ok) return;
  const startSide = fenSide(entry.fen) === "w" ? "red" : "black";
  let path = Array.isArray(entry.path) ? [...entry.path] : [];
  let added = 0;
  for (let i = 0; i < moves.length; i++) {
    const iccs = moves[i];
    const notation = (entry.pv && entry.pv[i]) || iccs;
    const side = (i % 2 === 0) ? startSide : (startSide === "red" ? "black" : "red");
    const siblings = path.length === 0
      ? (EDITOR.data.roots || (EDITOR.data.roots = []))
      : (nodeAt(path).children || (nodeAt(path).children = []));
    let idx = siblings.findIndex((n) => n.iccs === iccs);
    if (idx < 0) {
      siblings.push({ iccs, notation, side, ply: path.length + 1, annote: "", children: [] });
      idx = siblings.length - 1;
      added++;
    }
    path = path.concat([idx]);
  }
  clearSelection();
  navigateTo(path);   // jump to the end of the added line
  setStatus(added > 0 ? `已加入 ${added} 步（記得儲存）` : "該變化例已存在於棋譜中", "ok");
}
