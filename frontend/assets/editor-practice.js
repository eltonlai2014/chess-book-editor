"use strict";
/*
 * 中局練習 — 獨立對話框＋自帶互動棋盤（P1 前端）。
 *
 * 刻意與主編輯器/走子樹「完全解耦」：練習盤是 #practiceModal 內的 #practiceBoard，
 * 自己一套狀態（PRACTICE），不碰 EDITOR、不碰主盤、不碰走子樹——練習本身即天然沙盒。
 * 只複用無狀態共享 helper：board.js 的 drawBoard/applyIccs/screenX/screenY/parseFen/
 * SVG_NS、editor.js 的 editorColors/squareIccs/parseSquare（runtime 才呼叫，不怕載入序）；
 * 後端 POST /api/xqf/legal-targets 驗合法落點、/api/engine/analyze-line 取評分＋AI 著、
 * /api/practice/* 取題記成績。
 *
 * 解題流程（2026-06-30 改版）：
 *   · 多步逐著：走對書中該手 → 系統回對手書著 → 續解到底（全對＝完全解出）。
 *   · 走非正解：不揭答、不結束 → 提示「非正解」＋顯示 AI 評分與落差（虧多少）→
 *     接著開放在該局面與 AI 對弈（深度 PREFS.practiceAiDepth，預設 20，設定可改）。
 *   · 成績只記「首著對不對」一次（/check）；多步續解/對弈為學習，不重複記。
 */

const PRACTICE = {
  info: null,
  puzzle: null,
  fen: null,
  lastIccs: null,
  selected: null,
  legal: [],
  plyIdx: 0,          // 答案線目前 ply（解題方走偶數 index、系統走奇數）
  mode: "solve",      // "solve"(循書) | "spar"(人機對弈) | "done"(鎖盤)
  recorded: false,    // 首著已記一次成績
  busy: false,        // 等引擎中（鎖盤）
  startTs: 0,
  demo: null,
  aiDepth: 20,
  filters: { book: "", difficulty: "" },
};

function $pr(id) { return document.getElementById(id); }

function practiceAiDepthPref() {
  const d = parseInt((typeof PREFS === "object" && PREFS) ? PREFS.practiceAiDepth : 20, 10);
  return Number.isFinite(d) && d >= 1 && d <= 30 ? d : 20;
}

function setupPractice() {
  const btn = $pr("practiceBtn");
  if (!btn) return;
  btn.onclick = openPracticeModal;
  $pr("practiceClose").onclick = closePracticeModal;
  $pr("practiceNextBtn").onclick = () => loadPracticePuzzle();
  $pr("practiceRevealBtn").onclick = revealPracticeAnswer;
  $pr("practiceDemoBtn").onclick = togglePracticeDemo;
  $pr("practiceBoard").addEventListener("click", onPracticeSquareClick);
  $pr("practiceBook").onchange = (e) => { PRACTICE.filters.book = e.target.value; };
  $pr("practiceDiff").onchange = (e) => { PRACTICE.filters.difficulty = e.target.value; };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$pr("practiceModal").hidden) closePracticeModal();
  });
  fetchPracticeInfo();
}

async function fetchPracticeInfo() {
  try {
    const r = await fetch("/api/practice/info");
    const info = await r.json();
    PRACTICE.info = info;
    if (info && info.exists) {
      $pr("practiceBtn").hidden = false;
      populatePracticeBooks(info);
    }
  } catch (_) { /* 後端未起或無題庫：入口保持隱藏 */ }
}

function populatePracticeBooks(info) {
  const sel = $pr("practiceBook");
  if (!sel) return;
  const opts = ['<option value="">全部書目</option>'];
  for (const b of (info.books || [])) {
    opts.push(`<option value="${escAttr(b.book)}">${escHtml(b.book)}（${b.count}）</option>`);
  }
  sel.innerHTML = opts.join("");
}

async function openPracticeModal() {
  stopPracticeDemo();
  PRACTICE.aiDepth = practiceAiDepthPref();
  $pr("practiceModal").hidden = false;
  await refreshPracticeStats();
  await loadPracticePuzzle();
}

function closePracticeModal() {
  stopPracticeDemo();
  $pr("practiceModal").hidden = true;
}

async function loadPracticePuzzle() {
  stopPracticeDemo();
  const qs = new URLSearchParams();
  if (PRACTICE.filters.book) qs.set("book", PRACTICE.filters.book);
  if (PRACTICE.filters.difficulty) qs.set("difficulty", PRACTICE.filters.difficulty);
  try {
    const r = await fetch("/api/practice/pick?" + qs.toString());
    if (r.status === 404) { showPracticeEmpty(); return; }
    const pz = await r.json();
    if (pz.error) { showPracticeEmpty(pz.error); return; }
    PRACTICE.puzzle = pz;
    PRACTICE.fen = pz.init_fen;
    PRACTICE.lastIccs = null;
    PRACTICE.selected = null;
    PRACTICE.legal = [];
    PRACTICE.plyIdx = 0;
    PRACTICE.mode = "solve";
    PRACTICE.recorded = false;
    PRACTICE.busy = false;
    PRACTICE.aiDepth = practiceAiDepthPref();
    PRACTICE.startTs = Date.now();
    renderPracticeMeta();
    renderPracticeResult({ _hint: "輪到你走，找出最佳一手" });
    $pr("practiceCommentary").hidden = true;
    setPracticeButtons();
    renderPracticeBoard();
  } catch (e) {
    showPracticeEmpty("載入失敗：" + e.message);
  }
}

function showPracticeEmpty(msg) {
  PRACTICE.puzzle = null;
  PRACTICE.mode = "done";
  $pr("practiceMeta").innerHTML =
    `<div class="practiceEmpty">${escHtml(msg || "題庫為空或無符合條件的題（請先用 CLI 抽題）")}</div>`;
  $pr("practiceResult").innerHTML = "";
  $pr("practiceCommentary").hidden = true;
  drawBoard($pr("practiceBoard"), "9/9/9/9/9/9/9/9/9/9 w", null, null);
}

/* ---------- 盤面渲染（自帶點擊覆蓋層，鏡像 installBoardOverlay 但讀 PRACTICE） ---- */

function practiceInteractive() {
  return PRACTICE.puzzle && PRACTICE.mode !== "done" && !PRACTICE.busy && !PRACTICE.demo;
}

function renderPracticeBoard() {
  const svg = $pr("practiceBoard");
  drawBoard(svg, PRACTICE.fen, PRACTICE.lastIccs, null);
  if (practiceInteractive()) installPracticeOverlay(svg);
}

function installPracticeOverlay(svg) {
  const colors = editorColors();
  const layer = document.createElementNS(SVG_NS, "g");
  layer.setAttribute("class", "clickLayer");

  const occupied = new Set();
  if (PRACTICE.fen) {
    const { rows } = parseFen(PRACTICE.fen);
    for (let r = 0; r <= 9; r++)
      for (let c = 0; c <= 8; c++)
        if (rows[r][c]) occupied.add(squareIccs(c, r));
  }
  for (const sq of PRACTICE.legal) {
    const { col, row } = parseSquare(sq);
    const cx = screenX(col), cy = screenY(row);
    const mark = document.createElementNS(SVG_NS, "circle");
    mark.setAttribute("cx", cx); mark.setAttribute("cy", cy);
    if (occupied.has(sq)) {
      mark.setAttribute("r", 29); mark.setAttribute("fill", "none");
      mark.setAttribute("stroke", colors.target);
      mark.setAttribute("stroke-width", 2.5); mark.setAttribute("stroke-opacity", 0.85);
    } else {
      mark.setAttribute("r", 7); mark.setAttribute("fill", colors.target);
      mark.setAttribute("fill-opacity", 0.65);
    }
    mark.style.pointerEvents = "none";
    layer.appendChild(mark);
  }

  if (PRACTICE.selected) {
    const { col, row } = parseSquare(PRACTICE.selected);
    const halo = document.createElementNS(SVG_NS, "circle");
    halo.setAttribute("cx", screenX(col)); halo.setAttribute("cy", screenY(row));
    halo.setAttribute("r", 30); halo.setAttribute("fill", "none");
    halo.setAttribute("stroke", colors.target); halo.setAttribute("stroke-width", 3);
    halo.setAttribute("stroke-opacity", 0.9); halo.style.pointerEvents = "none";
    layer.appendChild(halo);
  }

  for (let r = 0; r <= 9; r++) {
    for (let c = 0; c <= 8; c++) {
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", screenX(c) - 30); rect.setAttribute("y", screenY(r) - 30);
      rect.setAttribute("width", 60); rect.setAttribute("height", 60);
      rect.setAttribute("fill", "transparent");
      rect.setAttribute("data-iccs", squareIccs(c, r));
      rect.style.cursor = "pointer";
      layer.appendChild(rect);
    }
  }
  svg.appendChild(layer);
}

/* ---------- 點擊／選子（只選輪到走的一方） ---------------------------------- */

function practiceSideToMove() {
  return (PRACTICE.fen && PRACTICE.fen.split(" ")[1] === "b") ? "b" : "w";
}

function practicePieceSide(sq) {
  const { rows } = parseFen(PRACTICE.fen);
  const { col, row } = parseSquare(sq);
  const p = rows[row] && rows[row][col];
  if (!p) return null;
  return p === p.toUpperCase() ? "w" : "b";   // 紅=大寫=w，黑=小寫=b
}

function onPracticeSquareClick(e) {
  if (!practiceInteractive()) return;
  const target = e.target.closest("[data-iccs]");
  if (!target) return;
  practiceSquareClick(target.getAttribute("data-iccs"));
}

async function practiceSquareClick(sq) {
  if (PRACTICE.selected && PRACTICE.legal.includes(sq)) {
    await practicePlayMove(PRACTICE.selected + sq);
    return;
  }
  const ps = practicePieceSide(sq);
  if (!ps) { PRACTICE.selected = null; PRACTICE.legal = []; renderPracticeBoard(); return; }
  if (ps !== practiceSideToMove()) return;      // 只選輪到走的一方
  PRACTICE.selected = sq;
  PRACTICE.legal = [];
  renderPracticeBoard();
  try {
    const r = await fetch("/api/xqf/legal-targets", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fen: PRACTICE.fen, from: sq }),
    });
    const resp = await r.json();
    if (PRACTICE.selected !== sq) return;        // race guard
    PRACTICE.legal = (resp && resp.targets) || [];
    renderPracticeBoard();
  } catch (_) { /* 留空，點擊落子仍可用 */ }
}

/* ---------- 落子：多步逐著 / 非正解→對弈 ----------------------------------- */

async function practicePlayMove(iccs) {
  if (PRACTICE.busy || PRACTICE.mode === "done") return;
  const preFen = PRACTICE.fen;
  PRACTICE.selected = null;
  PRACTICE.legal = [];
  PRACTICE.fen = applyIccs(preFen, iccs);
  PRACTICE.lastIccs = iccs;
  renderPracticeBoard();

  if (PRACTICE.mode === "spar") { await sparEngineReply(); return; }

  // solve 模式：對書中該手？
  const answer = PRACTICE.puzzle.answer_iccs || [];
  const expected = answer[PRACTICE.plyIdx];
  const isBook = iccs === expected;

  if (!PRACTICE.recorded) {                       // 首著記一次成績（/check）
    PRACTICE.recorded = true;
    recordFirstMove(iccs);
  }

  if (isBook) { await continueBookLine(); return; }
  await enterSparring(preFen);
}

async function continueBookLine() {
  const answer = PRACTICE.puzzle.answer_iccs || [];
  const zh = PRACTICE.puzzle.answer_zh || [];
  PRACTICE.plyIdx += 1;
  if (PRACTICE.plyIdx >= answer.length) { practiceFullySolved(); return; }
  // 系統回對手書著（稍候，讓使用者看清）。
  PRACTICE.busy = true;
  renderPracticeBoard();
  await practiceSleep(450);
  const reply = answer[PRACTICE.plyIdx];
  const replyZh = zh[PRACTICE.plyIdx] || "";
  PRACTICE.fen = applyIccs(PRACTICE.fen, reply);
  PRACTICE.lastIccs = reply;
  PRACTICE.plyIdx += 1;
  PRACTICE.busy = false;
  renderPracticeBoard();
  if (PRACTICE.plyIdx >= answer.length) { practiceFullySolved(); return; }
  const left = Math.ceil((answer.length - PRACTICE.plyIdx) / 2);
  renderPracticeResult({ _solveStep: true, replyZh, left });
}

function practiceFullySolved() {
  PRACTICE.mode = "done";
  renderPracticeBoard();
  renderPracticeResult({ _full: true });
  showCommentary();
  setPracticeButtons();
}

/* 非正解 → 顯示 AI 評分＋落差 → 開放與 AI 對弈（深度 practiceAiDepth）。 */
async function enterSparring(preFen) {
  PRACTICE.mode = "spar";
  PRACTICE.busy = true;
  renderPracticeBoard();
  renderPracticeResult({ _spar: "calc" });
  const postFen = PRACTICE.fen;
  const side = PRACTICE.puzzle.side;
  const recs = await practiceAnalyze([preFen, postFen], PRACTICE.aiDepth);
  PRACTICE.busy = false;
  if (!recs) {                                    // 無引擎：退化成只揭答
    PRACTICE.mode = "done";
    renderPracticeBoard();
    renderPracticeResult({ _spar: "noEngine" });
    showCommentary();
    setPracticeButtons();
    return;
  }
  renderPracticeResult({ _spar: "gap", pre: recs[0], post: recs[1], side });
  setPracticeButtons();
  const aiReply = recs[1] ? recs[1].best : null;
  if (aiReply && aiReply !== "(none)") await playEngineMove(aiReply);
  else { renderPracticeResult({ _spar: "over", side, pre: recs[0], post: recs[1] }); PRACTICE.mode = "done"; }
  renderPracticeBoard();
}

async function sparEngineReply() {
  PRACTICE.busy = true;
  renderPracticeBoard();
  const recs = await practiceAnalyze([PRACTICE.fen], PRACTICE.aiDepth);
  PRACTICE.busy = false;
  const rec = recs ? recs[0] : null;
  const best = rec ? rec.best : null;
  if (best && best !== "(none)") {
    await playEngineMove(best);
    renderPracticeResult({ _sparRunning: true, rec, side: PRACTICE.puzzle.side });
  } else {
    PRACTICE.mode = "done";
    renderPracticeResult({ _spar: "over", side: PRACTICE.puzzle.side, post: rec });
  }
  renderPracticeBoard();
}

async function playEngineMove(iccs) {
  await practiceSleep(350);
  PRACTICE.fen = applyIccs(PRACTICE.fen, iccs);
  PRACTICE.lastIccs = iccs;
  renderPracticeBoard();
}

/* 一次 analyze-line 取多個 fen 的 {cp,mate,best}（紅 POV）；無引擎/失敗回 null。 */
async function practiceAnalyze(fens, depth) {
  try {
    const r = await fetch("/api/engine/analyze-line", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fens, depth }),
    });
    if (!r.ok) return null;                        // 400＝引擎未設定
    const text = await r.text();
    const out = new Array(fens.length).fill(null);
    for (const line of text.trim().split("\n")) {
      if (!line) continue;
      const rec = JSON.parse(line);
      if (typeof rec.ply === "number") out[rec.ply] = rec;
    }
    return out;
  } catch (_) { return null; }
}

/* ---------- 揭答 / 演示 ------------------------------------------------------ */

async function revealPracticeAnswer() {
  if (!PRACTICE.puzzle || PRACTICE.mode === "done") { togglePracticeDemo(); return; }
  if (!PRACTICE.recorded) {                        // 放棄＝記一次 fail
    PRACTICE.recorded = true;
    try {
      await fetch("/api/practice/check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ puzzle_id: PRACTICE.puzzle.id, user_iccs: "______", time_ms: 0 }),
      });
    } catch (_) {}
    refreshPracticeStats();
  }
  PRACTICE.mode = "done";
  PRACTICE.fen = PRACTICE.puzzle.init_fen;
  PRACTICE.lastIccs = null;
  PRACTICE.plyIdx = 0;
  renderPracticeBoard();
  renderPracticeResult({ _gaveUp: true });
  showCommentary();
  setPracticeButtons();
  togglePracticeDemo();                            // 直接播一次答案
}

function togglePracticeDemo() {
  if (PRACTICE.demo && PRACTICE.demo.timer) { stopPracticeDemo(); return; }
  startPracticeDemo();
}

function startPracticeDemo() {
  if (!PRACTICE.puzzle) return;
  const iccs = PRACTICE.puzzle.answer_iccs || [];
  const zh = PRACTICE.puzzle.answer_zh || [];
  if (!iccs.length) return;
  const fens = [PRACTICE.puzzle.init_fen];
  for (const mv of iccs) fens.push(applyIccs(fens[fens.length - 1], mv));
  PRACTICE.mode = "done";
  PRACTICE.demo = { fens, iccs, zh, idx: 0, timer: null };
  renderDemoStep();
  PRACTICE.demo.timer = setInterval(() => {
    const d = PRACTICE.demo;
    if (!d) return;
    if (d.idx >= d.iccs.length) { stopPracticeDemo(); return; }
    d.idx += 1;
    renderDemoStep();
  }, 1100);
  $pr("practiceDemoBtn").textContent = "⏸ 停止";
}

function renderDemoStep() {
  const d = PRACTICE.demo;
  if (!d) return;
  PRACTICE.fen = d.fens[d.idx];
  PRACTICE.lastIccs = d.idx > 0 ? d.iccs[d.idx - 1] : null;
  renderPracticeBoard();
  const moved = d.idx > 0 ? `${d.idx}. ${d.zh[d.idx - 1] || ""}` : "起始局面";
  const more = d.idx < d.iccs.length ? "" : "（演示完）";
  const old = $pr("practiceResult").querySelector(".practiceDemoStep");
  if (old) old.remove();
  const tag = document.createElement("div");
  tag.className = "practiceDemoStep";
  tag.textContent = `演示：${moved} ${more}`;
  $pr("practiceResult").appendChild(tag);
}

function stopPracticeDemo() {
  if (PRACTICE.demo && PRACTICE.demo.timer) clearInterval(PRACTICE.demo.timer);
  PRACTICE.demo = null;
  const btn = $pr("practiceDemoBtn");
  if (btn) btn.textContent = "▶ 演示答案";
}

/* ---------- 文字面板 -------------------------------------------------------- */

function renderPracticeMeta() {
  const p = PRACTICE.puzzle;
  if (!p) return;
  const sideTxt = p.side === "b" ? "黑方" : "紅方";
  const d = p.difficulty || 1;
  const stars = "★".repeat(d) + "☆".repeat(5 - d);
  const cat = p.category ? `<span class="practiceCat">${escHtml(p.category)}</span>` : "";
  $pr("practiceMeta").innerHTML =
    `<div class="practiceSideLine ${p.side === "b" ? "black" : "red"}">輪到 <b>${sideTxt}</b> 走，找出最佳一手</div>` +
    `<div class="practiceTags">${cat}<span class="practiceStars" title="難度">${stars}</span></div>` +
    `<div class="practiceBookline">${escHtml(p.book_title || "")}${p.title ? "　·　" + escHtml(p.title) : ""}</div>`;
}

function renderPracticeResult(st) {
  const box = $pr("practiceResult");
  if (!st) { box.innerHTML = ""; return; }
  const side = (PRACTICE.puzzle && PRACTICE.puzzle.side) || "w";
  let html = "";
  if (st._hint) {
    html = `<div class="practiceHint">${escHtml(st._hint)}</div>`;
  } else if (st._solveStep) {
    html = `<div class="practiceVerdict ok">✓ 正解，續走！</div>` +
           `<div class="practiceAnswer">對手應：${escHtml(st.replyZh)}　（還剩約 ${st.left} 手）</div>`;
  } else if (st._full) {
    html = `<div class="practiceVerdict ok">✓ 完全解出！</div>` +
           `<div class="practiceAnswer">答案：${escHtml((PRACTICE.puzzle.answer_zh || []).join(" "))}</div>`;
  } else if (st._gaveUp) {
    html = `<div class="practiceVerdict gaveup">已看答案</div>` +
           `<div class="practiceAnswer">答案：${escHtml((PRACTICE.puzzle.answer_zh || []).join(" "))}</div>`;
  } else if (st._spar === "calc") {
    html = `<div class="practiceVerdict no">✗ 非正解</div><div class="practiceAnswer">引擎評分中…</div>`;
  } else if (st._spar === "noEngine") {
    html = `<div class="practiceVerdict no">✗ 非正解</div>` +
           `<div class="practiceAnswer">（未設定引擎，無法對弈）答案：${escHtml((PRACTICE.puzzle.answer_zh || []).join(" "))}</div>`;
  } else if (st._spar === "gap") {
    const best = fmtEval(st.pre, side), now = fmtEval(st.post, side);
    const gap = fmtGap(st.pre, st.post, side);
    html = `<div class="practiceVerdict no">✗ 非正解</div>` +
           `<div class="practiceAnswer">AI 評分：最佳 <b>${best}</b>　你這手後 <b>${now}</b> ${gap}</div>` +
           `<div class="practiceSparNote">⚔ 已在此局面開放與 AI 對弈（深度 ${PRACTICE.aiDepth}）——繼續落子試試。</div>`;
  } else if (st._sparRunning) {
    html = `<div class="practiceSparNote">⚔ 對弈中（深度 ${PRACTICE.aiDepth}）　目前評分：<b>${fmtEval(st.rec, side)}</b></div>`;
  } else if (st._spar === "over") {
    html = `<div class="practiceVerdict gaveup">對弈結束（終局）</div>`;
  }
  box.innerHTML = html;
}

function showCommentary() {
  const cm = ((PRACTICE.puzzle && PRACTICE.puzzle.commentary) || "").trim();
  const cmBox = $pr("practiceCommentary");
  if (cm) { cmBox.textContent = cm; cmBox.hidden = false; }
  else cmBox.hidden = true;
}

/* 評分顯示（解題方視角；mate 友善化）。 */
function fmtEval(rec, side) {
  if (!rec) return "—";
  const sign = side === "w" ? 1 : -1;
  if (rec.mate != null) {
    const m = rec.mate * sign;
    if (m === 0) return "被將死";
    return m > 0 ? `${m} 步殺` : `對方 ${-m} 步殺`;
  }
  if (rec.cp != null) {
    const v = rec.cp * sign;
    return (v > 0 ? "+" : "") + v;
  }
  return "—";
}

function evalScalar(rec, side) {
  if (!rec) return null;
  const sign = side === "w" ? 1 : -1;
  if (rec.mate != null) {
    const m = rec.mate * sign;
    return m >= 0 ? 30000 - m * 50 : -30000 - m * 50;
  }
  if (rec.cp != null) return rec.cp * sign;
  return null;
}

function fmtGap(pre, post, side) {
  const a = evalScalar(pre, side), b = evalScalar(post, side);
  if (a == null || b == null) return "";
  const loss = a - b;
  if (loss <= 20) return "（與最佳手相當）";
  if (loss >= 25000) return "（錯失殺著）";
  return `（虧 ${loss} 分）`;
}

function setPracticeButtons() {
  $pr("practiceRevealBtn").disabled = (PRACTICE.mode === "done");
  $pr("practiceDemoBtn").disabled = !PRACTICE.puzzle;
}

async function refreshPracticeStats() {
  try {
    const r = await fetch("/api/practice/stats");
    const s = await r.json();
    const acc = s.attempts ? Math.round((s.passed / s.attempts) * 100) : 0;
    $pr("practiceProgress").textContent =
      `作答 ${s.attempts}　正確 ${s.passed}（${acc}%）　待複習 ${s.due}`;
  } catch (_) {}
}

function recordFirstMove(iccs) {
  // /check 評首著（對書答或 engine_best＝引擎等值）並記 attempt＋進度。本地另行
  // 逐手判定，這裡只為「記一次成績」；回傳不需要。
  fetch("/api/practice/check", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ puzzle_id: PRACTICE.puzzle.id, user_iccs: iccs, time_ms: Date.now() - PRACTICE.startTs }),
  }).then(() => refreshPracticeStats()).catch(() => {});
}

/* ---------- 小工具 ---------------------------------------------------------- */

function practiceSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s) { return escHtml(s).replace(/"/g, "&quot;"); }
