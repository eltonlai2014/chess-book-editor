"use strict";
/*
 * 中局練習 — 獨立對話框＋自帶互動棋盤（P1 前端）。
 *
 * 刻意與主編輯器/走子樹「完全解耦」：練習盤是 #practiceModal 內的 #practiceBoard，
 * 自己一套狀態（PRACTICE），不碰 EDITOR、不碰主盤、不碰走子樹——所以練習本身就是
 * 一個天然沙盒（「重用沙盒＝不落地」的精神）。只複用無狀態的共享 helper：
 *   board.js：drawBoard / applyIccs / screenX / screenY / parseFen / SVG_NS
 *   editor.js：editorColors / squareIccs / parseSquare（runtime 才呼叫，不怕載入序）
 *   後端：POST /api/xqf/legal-targets、/api/xqf/move-info 驗法；/api/practice/* 取題評分。
 *
 * 評分為「找關鍵首著」：使用者下第一手 → /api/practice/check 對書答或引擎等值判定，
 * 再揭示整條答案＋講解，可一鍵演示重播。多步逐著留待後續迭代（見 CLAUDE.md）。
 */

const PRACTICE = {
  info: null,         // /api/practice/info（gate 入口＋填書目）
  puzzle: null,       // 目前題（/pick 或 /puzzle）
  fen: null,          // 練習盤目前 fen（起＝init_fen，下首著後推進顯示）
  lastIccs: null,     // 盤面高亮的最後一手
  selected: null,     // 已選來源格 iccs
  legal: [],          // 已選子的合法落點
  solved: false,      // 已評分／已揭示（鎖盤，改用「下一題」）
  result: null,       // check 回傳
  startTs: 0,         // 計時（time_ms）
  demo: null,         // 答案重播 {fens, lastIccs[], idx, timer}
  filters: { book: "", difficulty: "" },
};

function $pr(id) { return document.getElementById(id); }

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
  // Esc 關閉（僅當練習開著）
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$pr("practiceModal").hidden) closePracticeModal();
  });
  // 開機探測題庫；有題才顯示入口（同 engine/eval info 的優雅降級）。
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
    PRACTICE.solved = false;
    PRACTICE.result = null;
    PRACTICE.startTs = Date.now();
    renderPracticeMeta();
    renderPracticeResult(null);
    $pr("practiceCommentary").hidden = true;
    setPracticeButtons();
    renderPracticeBoard();
  } catch (e) {
    showPracticeEmpty("載入失敗：" + e.message);
  }
}

function showPracticeEmpty(msg) {
  PRACTICE.puzzle = null;
  $pr("practiceMeta").innerHTML =
    `<div class="practiceEmpty">${escHtml(msg || "題庫為空或無符合條件的題（請先用 CLI 抽題）")}</div>`;
  $pr("practiceResult").innerHTML = "";
  $pr("practiceCommentary").hidden = true;
  drawBoard($pr("practiceBoard"), "9/9/9/9/9/9/9/9/9/9 w", null, null);
}

/* ---------- 盤面渲染（自帶點擊覆蓋層，鏡像 installBoardOverlay 但讀 PRACTICE） ---- */

function renderPracticeBoard() {
  const svg = $pr("practiceBoard");
  drawBoard(svg, PRACTICE.fen, PRACTICE.lastIccs, null);
  if (!PRACTICE.solved) installPracticeOverlay(svg);
}

function installPracticeOverlay(svg) {
  const colors = editorColors();
  const layer = document.createElementNS(SVG_NS, "g");
  layer.setAttribute("class", "clickLayer");

  // 合法落點：敵子上空心環（吃），空格實心點（走）。
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

  // 選中來源格的光暈。
  if (PRACTICE.selected) {
    const { col, row } = parseSquare(PRACTICE.selected);
    const halo = document.createElementNS(SVG_NS, "circle");
    halo.setAttribute("cx", screenX(col)); halo.setAttribute("cy", screenY(row));
    halo.setAttribute("r", 30); halo.setAttribute("fill", "none");
    halo.setAttribute("stroke", colors.target); halo.setAttribute("stroke-width", 3);
    halo.setAttribute("stroke-opacity", 0.9); halo.style.pointerEvents = "none";
    layer.appendChild(halo);
  }

  // 透明點擊矩形（蓋最上，data-iccs）。
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

/* ---------- 點擊／落子／評分 ------------------------------------------------ */

function onPracticeSquareClick(e) {
  if (PRACTICE.solved || !PRACTICE.puzzle) return;
  const target = e.target.closest("[data-iccs]");
  if (!target) return;
  practiceSquareClick(target.getAttribute("data-iccs"));
}

async function practiceSquareClick(sq) {
  // 已選子且點到合法落點 → 落子評分。
  if (PRACTICE.selected && PRACTICE.legal.includes(sq)) {
    await practicePlayMove(PRACTICE.selected + sq);
    return;
  }
  // 否則（重）選來源格，取合法落點。
  PRACTICE.selected = sq;
  PRACTICE.legal = [];
  renderPracticeBoard();
  try {
    const r = await fetch("/api/xqf/legal-targets", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fen: PRACTICE.fen, from: sq }),
    });
    const resp = await r.json();
    if (PRACTICE.selected !== sq) return;           // race guard
    PRACTICE.legal = (resp && resp.targets) || [];
    renderPracticeBoard();
  } catch (_) { /* 留空，點擊落子仍可用 */ }
}

async function practicePlayMove(iccs) {
  PRACTICE.selected = null;
  PRACTICE.legal = [];
  const timeMs = Date.now() - PRACTICE.startTs;
  let res;
  try {
    const r = await fetch("/api/practice/check", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ puzzle_id: PRACTICE.puzzle.id, user_iccs: iccs, time_ms: timeMs }),
    });
    res = await r.json();
  } catch (e) {
    res = { error: e.message };
  }
  if (res.error) { renderPracticeResult({ correct: false, _err: res.error }); return; }
  PRACTICE.solved = true;
  PRACTICE.result = res;
  PRACTICE.fen = applyIccs(PRACTICE.fen, iccs);     // 顯示使用者剛走的手
  PRACTICE.lastIccs = iccs;
  renderPracticeBoard();
  renderPracticeResult(res);
  setPracticeButtons();
  refreshPracticeStats();
}

/* ---------- 揭示答案 / 演示重播 -------------------------------------------- */

async function revealPracticeAnswer() {
  if (!PRACTICE.puzzle) return;
  // 已解出就直接顯示已存的答案；未解出（放棄）則記一次 fail 後揭示。
  if (!PRACTICE.solved) {
    let res;
    try {
      const r = await fetch("/api/practice/check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ puzzle_id: PRACTICE.puzzle.id, user_iccs: "______", time_ms: 0 }),
      });
      res = await r.json();
    } catch (_) { res = null; }
    PRACTICE.solved = true;
    PRACTICE.result = res && !res.error ? res : { correct: false, answer_iccs: PRACTICE.puzzle.answer_iccs, answer_zh: PRACTICE.puzzle.answer_zh, commentary: PRACTICE.puzzle.commentary };
    PRACTICE.result._gaveUp = true;
    renderPracticeBoard();
    renderPracticeResult(PRACTICE.result);
    setPracticeButtons();
    refreshPracticeStats();
  }
  togglePracticeDemo();   // 揭示後直接播一次答案
}

function practiceAnswerData() {
  // 答案來源：result（含答案）優先，否則用題目本身。
  const r = PRACTICE.result || {};
  const iccs = r.answer_iccs || (PRACTICE.puzzle && PRACTICE.puzzle.answer_iccs) || [];
  const zh = r.answer_zh || (PRACTICE.puzzle && PRACTICE.puzzle.answer_zh) || [];
  return { iccs, zh };
}

function togglePracticeDemo() {
  if (PRACTICE.demo && PRACTICE.demo.timer) { stopPracticeDemo(); return; }
  startPracticeDemo();
}

function startPracticeDemo() {
  if (!PRACTICE.puzzle) return;
  const { iccs, zh } = practiceAnswerData();
  if (!iccs.length) return;
  // 由 init_fen 逐手推出每步 fen。
  const fens = [PRACTICE.puzzle.init_fen];
  for (const mv of iccs) fens.push(applyIccs(fens[fens.length - 1], mv));
  PRACTICE.solved = true;                 // 演示期間鎖盤
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
  $pr("practiceResult").querySelector(".practiceDemoStep")?.remove();
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
  const stars = "★".repeat(p.difficulty || 1) + "☆".repeat(5 - (p.difficulty || 1));
  const cat = p.category ? `<span class="practiceCat">${escHtml(p.category)}</span>` : "";
  $pr("practiceMeta").innerHTML =
    `<div class="practiceSide ${p.side === "b" ? "black" : "red"}">輪到 <b>${sideTxt}</b> 走，找出最佳一手</div>` +
    `<div class="practiceTags">${cat}<span class="practiceStars" title="難度">${stars}</span></div>` +
    `<div class="practiceBookline">${escHtml(p.book_title || "")}${p.title ? "　·　" + escHtml(p.title) : ""}</div>`;
}

function renderPracticeResult(res) {
  const box = $pr("practiceResult");
  if (!res) { box.innerHTML = ""; return; }
  if (res._err) { box.innerHTML = `<div class="practiceErr">評分失敗：${escHtml(res._err)}</div>`; return; }
  const { zh } = practiceAnswerData();
  const answerStr = zh.join(" ");
  let head;
  if (res._gaveUp) head = `<div class="practiceVerdict gaveup">已看答案</div>`;
  else if (res.correct) {
    const via = res.via === "engine" ? "（引擎等值）" : "";
    head = `<div class="practiceVerdict ok">✓ 正解${via}</div>`;
  } else {
    head = `<div class="practiceVerdict no">✗ 不是最佳手</div>`;
  }
  const ans = answerStr
    ? `<div class="practiceAnswer">答案：${escHtml(answerStr)}</div>` : "";
  box.innerHTML = head + ans;
  // 講解
  const cm = (res.commentary || (PRACTICE.puzzle && PRACTICE.puzzle.commentary) || "").trim();
  const cmBox = $pr("practiceCommentary");
  if (cm) { cmBox.textContent = cm; cmBox.hidden = false; }
  else cmBox.hidden = true;
}

function setPracticeButtons() {
  const solved = PRACTICE.solved;
  $pr("practiceRevealBtn").disabled = solved;        // 已解出/已揭示就不需要
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

/* ---------- 小工具 ---------------------------------------------------------- */

function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s) { return escHtml(s).replace(/"/g, "&quot;"); }
