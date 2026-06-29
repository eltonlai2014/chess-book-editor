// editor-aichart.js — extracted from editor.js (T2-1 incremental split).
// Classic script: shares the global lexical scope with editor.js and is
// loaded BEFORE it in index.html, so its functions may freely reference
// editor.js globals (EDITOR, $, helpers) — they're only called at runtime,
// after every script has loaded. Do NOT convert to an ES module.

// ---------- AI 分析: depth-limited sweep of the whole current line ----------
// Walks the current branch (active path, then the main line down to the leaf),
// runs Pikafish at a fixed user-set depth (preferences.aiAnalysisDepth, default
// 12) on every position, and plots a red-POV score trend. The backend streams
// NDJSON so the chart + list fill in live. Ephemeral — nothing persisted.
function aiDepth() {
  const d = parseInt(PREFS.aiAnalysisDepth, 10);
  return Number.isFinite(d) && d >= 1 && d <= 30 ? d : 12;
}

// Second (usually deeper) depth + the dual-depth comparison toggle/threshold.
// When enabled, each position is also evaluated at aiDepth2 and the deep-vs-
// shallow gap is flagged on the chart + readout where |Δ| ≥ aiDiffThreshold.
function aiDepth2() {
  const d = parseInt(PREFS.aiAnalysisDepth2, 10);
  return Number.isFinite(d) && d >= 1 && d <= 30 ? d : 20;
}
function aiDualEnabled() {
  return PREFS.aiDualDepth === true || PREFS.aiDualDepth === "true";
}
function aiDiffThreshold() {
  const t = parseInt(PREFS.aiDiffThreshold, 10);
  return Number.isFinite(t) && t >= 0 ? t : 200;
}
// Per-ply loss (cp) at or above which a move is flagged 漏著 on the trend chart.
function aiBlunderThreshold() {
  const t = parseInt(PREFS.aiBlunderThreshold, 10);
  return Number.isFinite(t) && t >= 0 ? t : 200;
}

// 5-level move grade (优/好/中/差/劣) from the per-ply cp loss — the SAME metric
// as the 漏著 ✖ markers (aiPlyLoss: mover-POV drop, positive = worse). A gain or
// near-best move is 优; bands widen toward 劣. Coarse on purpose (a study-at-a-
// glance read); tunable. Bands are independent of aiBlunderThreshold — 差/劣 ⊇
// the moves the chart flags at the default 200 threshold. Colours: the report/
// chip reuse the theme-aware --delta ramp (优=green … 劣=red), no hardcoded hex.
const AI_GRADE_BANDS = [
  { key: "best", label: "优", max: 30 },
  { key: "good", label: "好", max: 80 },
  { key: "ok", label: "中", max: 150 },
  { key: "poor", label: "差", max: 350 },
  { key: "blunder", label: "劣", max: Infinity },
];
function aiGrade(loss) {
  if (loss == null) return null;
  for (const b of AI_GRADE_BANDS) if (loss <= b.max) return b;
  return AI_GRADE_BANDS[AI_GRADE_BANDS.length - 1];
}

// Red-POV sign of a mate score (+1 = red mating/winning, -1 = red being mated).
// Non-zero mates already carry the sign (engine score × flip). `mate 0` is the
// terminal checkmate: the side to move is mated NOW, but 0 is unsigned so the
// engine drops the sign and `0 × flip` is still 0. Recover it from whose turn
// it is in the position's fen — that side is the LOSER, so red wins iff black
// is to move. Falls back to red-loss when the fen is unknown.
function mateSign(mate, fen) {
  if (mate > 0) return 1;
  if (mate < 0) return -1;
  return fenSide(fen) === "b" ? 1 : -1;
}

function aiScoreNum(cp, mate, fen) {
  if (mate != null) return mateSign(mate, fen) > 0 ? 100000 : -100000;
  return cp != null ? cp : null;
}
// Deep-minus-shallow gap for a point, or null when dual data is absent. flagged
// uses the *current* threshold so adjusting it re-evaluates on the next render.
function aiPointDiff(p) {
  if (!p || (p.cp2 == null && p.mate2 == null)) return null;
  const a = aiScoreNum(p.cp, p.mate, p.fen);
  const b = aiScoreNum(p.cp2, p.mate2, p.fen);
  if (a == null || b == null) return null;
  const diff = b - a;
  return { diff, flagged: Math.abs(diff) >= aiDiffThreshold() };
}

// Red-POV centipawns for a point, mate folded to a large signed magnitude so a
// move that walks into (or delivers) mate registers as a huge swing (mirrors
// scoreCp / chess-book-ai). null when the point has no score yet.
function aiCpRed(p) {
  if (!p) return null;
  if (p.mate != null) return mateSign(p.mate, p.fen) * (30000 - Math.abs(p.mate));
  return p.cp != null ? p.cp : null;
}

// Centipawns the move LEADING TO point i cost its mover — live per-ply loss from
// the red-POV sweep scores, no positions.db. Positive = a loss (worse after the
// move), negative = a gain. The mover is the side to move at the pre-move point
// (i-1); the loss is the drop from that side's POV (= chess-book-ai's _ply_loss,
// here derived from red-POV scores). null when a score is missing.
function aiPlyLoss(points, i) {
  if (i < 1 || i >= points.length) return null;
  const before = aiCpRed(points[i - 1]);
  const after = aiCpRed(points[i]);
  if (before == null || after == null) return null;
  const moverRed = fenSide(points[i - 1].fen) === "w";
  return moverRed ? before - after : after - before;
}

// Position list for the current branch: index 0 = start, index k = the board
// after the k-th move. Each carries a label + the node path that reaches it
// (for click-to-navigate). Built off currentLine() so it follows exactly what
// the 棋譜 list shows.
function aiLinePositions() {
  if (!EDITOR.data) return [];
  const out = [{ fen: EDITOR.data.init_fen, label: "起始局面", path: [] }];
  for (const item of currentLine()) {
    out.push({
      fen: applyIccs(item.fen, item.node.iccs),
      label: `${item.ply}. ${item.node.notation}`,
      path: item.path,
    });
  }
  return out;
}

// After a sweep, translate the engine's best move (UCI→中文) at each 漏著's
// decision point so the readout can show what should have been played. Only the
// (few) flagged points are translated, batched by fen; cached + cheap. Re-runs
// when the threshold changes; refreshes the view when done.
async function fillAiBlunderBest() {
  const pts = EDITOR.aiAnalysis.points;
  const byFen = new Map();   // fen -> Set(best iccs) for the 漏著 decision points
  const thresh = aiBlunderThreshold();
  for (let i = 1; i < pts.length; i++) {
    const loss = aiPlyLoss(pts, i);
    if (loss == null) continue;
    // Translate the decision-point best for BOTH 漏著 chart markers (loss ≥
    // threshold) AND report flaws (差/劣 grade), so the 全畫面 report can show
    // 建議走法 next to 轉折/失準 even below the 漏著 threshold (151–200cp band).
    const g = aiGrade(loss);
    if (loss < thresh && !(g && (g.key === "poor" || g.key === "blunder"))) continue;
    const dp = pts[i - 1];
    if (dp && dp.best && dp.fen && dp.bestZh == null) {
      if (!byFen.has(dp.fen)) byFen.set(dp.fen, new Set());
      byFen.get(dp.fen).add(dp.best);
    }
  }
  if (!byFen.size) return;
  for (const [fen, set] of byFen) {
    const map = await notationsForBatch(fen, [...set]);
    if (!map) continue;
    pts.forEach((p) => { if (p.fen === fen && p.best && map[p.best]) p.bestZh = map[p.best]; });
  }
  renderAiView();
}

async function analyzeCurrentLine() {
  if (!EDITOR.data) { setStatus("尚未載入棋譜", "err"); return; }
  if (!EDITOR.engineInfo || !EDITOR.engineInfo.ok) {
    $("#aiState").textContent = "引擎未設定（請在設定中選擇引擎）";
    return;
  }
  const ai = EDITOR.aiAnalysis;
  if (ai.running) return;
  const positions = aiLinePositions();
  if (positions.length === 0) { $("#aiState").textContent = "此分支無著法"; return; }
  // Seed points with labels/paths/fen; scores fill in as records arrive. The
  // fen is kept so a terminal `mate 0` can recover its red-POV sign from the
  // side to move (see mateSign).
  ai.points = positions.map((p, i) => ({ ply: i, label: p.label, path: p.path, fen: p.fen, cp: null, mate: null, best: null, cp2: null, mate2: null }));
  ai.running = true;
  ai.queryIdx = null;
  const depth = aiDepth();
  const dual = aiDualEnabled();
  const depth2 = aiDepth2();
  ai.depth = depth;
  ai.depth2 = dual ? depth2 : null;   // latched so the readout labels match this sweep
  const dlabel = dual ? `d${depth}+d${depth2}` : `d${depth}`;
  $("#aiAnalyzeBtn").disabled = true;
  $("#aiState").textContent = `分析中 (${dlabel})… 0/${positions.length}`;
  renderAiView();
  try {
    const resp = await fetch("/api/engine/analyze-line", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fens: positions.map((p) => p.fen), depth, ...(dual ? { depth2 } : {}) }),
    });
    if (!resp.ok || !resp.body) {
      let msg = "分析失敗";
      try { const j = await resp.json(); if (j.error) msg = j.error; } catch (_) { }
      $("#aiState").textContent = msg;
      return;
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "", done = 0;
    for (; ;) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const ln = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!ln) continue;
        let ev; try { ev = JSON.parse(ln); } catch (_) { continue; }
        if (ev.error) { $("#aiState").textContent = ev.error; continue; }
        const pt = ai.points[ev.ply];
        if (pt) {
          pt.cp = ev.cp; pt.mate = ev.mate; pt.best = ev.best;
          pt.cp2 = ev.cp2 != null ? ev.cp2 : null;
          pt.mate2 = ev.mate2 != null ? ev.mate2 : null;
        }
        done++;
        // No progressive plot — just tick the count; the chart shows 分析中.
        $("#aiState").textContent = `分析中 (${dlabel})… ${done}/${ai.points.length}`;
      }
    }
    $("#aiState").textContent = `完成 (${dlabel}) · ${ai.points.length} 步`;
    ai.queryIdx = ai.points.length - 1;   // rest the query line on the final position
    fillAiBlunderBest();   // translate 漏著 best alternatives for the readout (async)
  } catch (e) {
    $("#aiState").textContent = "分析中斷：" + (e && e.message || e);
  } finally {
    ai.running = false;
    $("#aiAnalyzeBtn").disabled = false;
    renderAiView();
  }
}

function clearAiAnalysis() {
  EDITOR.aiAnalysis.points = [];
  // Bump the load sequence so a cache auto-load awaiting its fetch (started for
  // the PREVIOUS line) discards its result instead of painting onto the new one.
  EDITOR.aiAnalysis.loadSeq = (EDITOR.aiAnalysis.loadSeq || 0) + 1;
  const st = $("#aiState"); if (st) st.textContent = "尚未分析";
  renderAiView();
}

// Auto-load prior sweep results from the editor eval cache for the current line —
// CACHE-ONLY (never runs the engine). Called when the AI tab is opened or a file
// is switched while it's open, so previously-analysed lines show instantly
// without pressing 掃描. A miss (nothing cached at the current depth settings, or
// no engine to key the cache by) leaves the tab idle. Silent: no error toast, no
// button disable — it's a best-effort convenience, the 掃描 button is the real path.
async function loadAiCacheForCurrentLine() {
  if (!EDITOR.data) return;
  if (!EDITOR.engineInfo || !EDITOR.engineInfo.ok) return;  // no engine → no cache key
  const ai = EDITOR.aiAnalysis;
  if (ai.running || ai.points.length) return;
  const positions = aiLinePositions();
  if (!positions.length) return;
  const depth = aiDepth();
  const dual = aiDualEnabled();
  const depth2 = aiDepth2();
  const seq = (ai.loadSeq = (ai.loadSeq || 0) + 1);   // token to detect a stale await
  let data;
  try {
    const resp = await fetch("/api/engine/eval-cache", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fens: positions.map((p) => p.fen), depth, ...(dual ? { depth2 } : {}) }),
    });
    if (!resp.ok) return;
    data = await resp.json();
  } catch (_) { return; }
  // The line may have changed (file/tab) while awaiting — bail if so.
  if (seq !== ai.loadSeq || ai.running || ai.points.length) return;
  const recs = (data && data.records) || [];
  const hits = recs.filter((r) => r && (r.cp != null || r.mate != null)).length;
  if (!hits) return;   // nothing cached → stay on the "按掃描" idle state
  ai.points = positions.map((p, i) => {
    const r = recs[i] || {};
    return {
      ply: i, label: p.label, path: p.path, fen: p.fen,
      cp: r.cp != null ? r.cp : null, mate: r.mate != null ? r.mate : null,
      best: r.best != null ? r.best : null,
      cp2: r.cp2 != null ? r.cp2 : null, mate2: r.mate2 != null ? r.mate2 : null,
    };
  });
  ai.depth = depth;
  ai.depth2 = dual ? depth2 : null;
  ai.queryIdx = ai.points.length - 1;
  const st = $("#aiState");
  if (st) st.textContent = hits === positions.length
    ? `快取載入 · ${positions.length} 步（按掃描重算）`
    : `快取部分載入 · ${hits}/${positions.length} 步（按掃描補全）`;
  renderAiView();
  fillAiBlunderBest();   // translate 漏著 best alternatives for the readout (async)
}

// Trigger the cache auto-load only when it won't clobber existing work: the AI
// tab must be visible and there must be no running sweep / already-loaded line.
function maybeAutoLoadAiCache() {
  const ai = EDITOR.aiAnalysis;
  if (ai.running || ai.points.length) return;
  const body = document.getElementById("anBodyAi");
  if (!body || body.hidden) return;   // only when the AI 分析 tab is actually shown
  loadAiCacheForCurrentLine();
}

// Index on the analysed line matching the board now (= moves made so far).
function aiActiveIdx() {
  const n = EDITOR.aiAnalysis.points.length;
  if (!n) return -1;
  return Math.max(0, Math.min(n - 1, EDITOR.activePath.length));
}

// The cursor follows the hovered point (queryIdx); with no hover it rests on
// the position currently on the board.
function aiCursorIdx() {
  const q = EDITOR.aiAnalysis.queryIdx;
  return q != null ? q : aiActiveIdx();
}

// Nearest point index under a pointer event over the chart. The SVG uses
// preserveAspectRatio="none", so viewBox-x maps linearly to client width.
// Chart geometry — kept in one place so drawing and hit-testing agree.
const AI_PAD = { l: 38, r: 8, t: 10, b: 10 };
const AI_RANGE_MIN = 100;   // floor so a near-level game isn't over-zoomed

// Round up to a "nice" axis bound (1/2/2.5/5 × 10^k).
function aiNiceCeil(v) {
  if (v <= 0) return AI_RANGE_MIN;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * pow;
}

// Y-axis max from the data (red-POV |cp|), so the curve uses the full height
// instead of being squashed under a fixed ±800. Mate clamps to whatever bound
// the cp values set (it draws at the edge regardless).
function aiRange(points) {
  let m = 0;
  for (const p of points) if (p.cp != null) m = Math.max(m, Math.abs(p.cp));
  return Math.max(AI_RANGE_MIN, aiNiceCeil(m));
}

function aiIndexFromEvent(e) {
  const svg = $("#aiChart");
  const n = EDITOR.aiAnalysis.points.length;
  if (!svg || !n) return -1;
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0) return -1;
  // viewBox is set to the pixel size (1:1), so client-x maps straight in.
  const frac = (e.clientX - rect.left - AI_PAD.l) / (rect.width - AI_PAD.l - AI_PAD.r);
  return Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));
}

function renderAiView() {
  const a = EDITOR.aiAnalysis;
  const svg = $("#aiChart");
  // During the sweep we don't plot partial data — just a "分析中" pill.
  if (a.running) {
    if (svg) drawAiBusy(svg, "分析中…");
    const box = $("#aiReadout");
    if (box) box.innerHTML = `<div class="varEmpty">分析中…（皮卡魚 d${aiDepth()}）</div>`;
    const rep = $("#aiReport");
    if (rep) rep.innerHTML = "";          // collapse the report while sweeping
    return;
  }
  const idx = aiCursorIdx();
  if (svg) drawAiChart(svg, a.points, idx);
  renderAiReadout(idx);
  renderAiReport();
}

// Whole-game review built entirely from the sweep — no extra engine work, no
// positions.db: grade every scored move (aiGrade), bucket each under the side
// that played it, then show ONE side at a time behind a 紅/黑 頁籤 — 評價統計 +
// 關鍵轉折 (that side's biggest-loss move) + 失準手數 (that side's 差/劣 list, each
// click-to-navigate). Per-side throughout (master's call): a side's view shows
// only its own flaws, never a mixed aggregate. Mirrors xqpoint's 報告 view but on
// the LOCAL engine (no quota/login). Collapses (empty) until ≥1 move is scored.
function renderAiReport() {
  const box = $("#aiReport");
  if (!box) return;
  const a = EDITOR.aiAnalysis;
  if (a.running || a.points.length < 2) { box.innerHTML = ""; return; }
  // Grade every scored move and bucket it under the side that PLAYED it (side to
  // move at the pre-move point i-1; read from the fen, not i%2, so a black-first
  // XQF is correct). Each side keeps its own tallies, 失準 rows, and worst move.
  const newSide = () => ({ sc: { best: 0, good: 0, ok: 0, poor: 0, blunder: 0, total: 0 }, rows: [], worst: null });
  const data = { red: newSide(), black: newSide() };
  for (let i = 1; i < a.points.length; i++) {
    const loss = aiPlyLoss(a.points, i);
    if (loss == null) continue;
    const g = aiGrade(loss);
    const sd = data[fenSide(a.points[i - 1].fen) === "w" ? "red" : "black"];
    sd.sc[g.key]++; sd.sc.total++;
    const r = { idx: i, loss, g, p: a.points[i] };
    sd.rows.push(r);
    if (!sd.worst || loss > sd.worst.loss) sd.worst = r;
  }
  if (!data.red.sc.total && !data.black.sc.total) { box.innerHTML = ""; return; }

  // 頁籤: 紅／黑 only (no mixed 全部) — a side's view shows ONLY its own stats +
  // 失準 + 關鍵轉折. Fall back to the other side if the chosen one never moved
  // (1-ply line) so the panel is never blank.
  let side = a.flawSide === "black" ? "black" : "red";
  if (!data[side].sc.total) side = side === "red" ? "black" : "red";
  const sd = data[side];
  const flawN = (s) => data[s].rows.filter((r) => r.g.key === "poor" || r.g.key === "blunder").length;
  const tabs = `<div class="aiSideTabs">`
    + [["red", "紅"], ["black", "黑"]].map(([k, lbl]) =>
        `<a class="aiSideTab ${k}${side === k ? " on" : ""}" data-flawside="${k}">${lbl} ${flawN(k)}</a>`).join("")
    + `</div>`;

  // 共N手 + 偏差率 + the five grade tallies for the SELECTED side (the active
  // 頁籤 already names 紅/黑, so the stat row drops the leading side tag).
  const head = aiSideHeadHtml(sd.sc);

  // 建議走法 ALWAYS shows next to 轉折/失準 (master's call — it must not vanish when
  // the panel is short). roomy now gates ONLY the secondary 評級門檻 legend. Re-
  // evaluated on resize via the chart's ResizeObserver → renderAiView; panel height
  // is set by the splitter (stable) so this can't feedback-loop the decision.
  const panel = document.getElementById("anBodyAi");
  const roomy = !!(panel && panel.clientHeight >= 480);
  const cur = aiCursorIdx();

  // 關鍵轉折: THIS side's most damaging single move. Only crowned when it's a real
  // swing (≥100cp) — a clean side shows 平穩 instead of a trivial wobble.
  const worst = sd.worst;
  const turnVal = (worst && worst.loss >= 100)
    ? `<a class="aiRepMove" data-aiidx="${worst.idx}">${worst.p.label}</a>`
        + `<span class="aiRepLoss">${aiLossTag(worst)}</span>`
        + aiSuggestHtml(worst.idx, "建議 ")
    : `<span class="aiRepNone">走勢平穩，無明顯轉折</span>`;

  // 失準手數: THIS side's 差/劣 moves, grade-coloured, click-to-navigate. The
  // queried/hovered row carries .hot so it lights up in sync with the chart
  // cursor (圖↔清單 連動).
  const flaws = sd.rows.filter((r) => r.g.key === "poor" || r.g.key === "blunder");
  const flawVal = flaws.length
    ? flaws.map((r) => `<a class="aiFlaw g-${r.g.key}${r.idx === cur ? " hot" : ""}" data-aiidx="${r.idx}">`
        + `${r.p.label} <span class="aiFlawEval">${aiEvalRed(r.p)}</span> ${aiLossTag(r)}`
        + `${aiSuggestHtml(r.idx, "建議 ")}</a>`).join("")
    : `<span class="aiRepNone">無（皆中等以上）</span>`;

  // 關鍵轉折 + 失準手數 in an aligned label↔content grid (report-form look).
  let html = tabs + head
    + `<div class="aiRepGrid">`
    + `<span class="aiRepLbl">關鍵轉折</span><span class="aiRepTurn">${turnVal}</span>`
    + `<span class="aiRepLbl">失準手數</span><span class="aiFlawList">${flawVal}</span>`
    + `</div>`;
  if (roomy) html += aiThresholdLegendHtml();
  box.innerHTML = html;
  // Click any move reference to navigate there (path carried by the sweep point).
  box.querySelectorAll("[data-aiidx]").forEach((el) => {
    el.onclick = () => {
      const p = a.points[+el.dataset.aiidx];
      if (p && p.path) navigateTo(p.path);
    };
  });
  // 紅/黑 頁籤: switch the whole per-side view (re-render the report only — the
  // chart is side-agnostic, so it stays as drawn).
  box.querySelectorAll("[data-flawside]").forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); a.flawSide = el.dataset.flawside; renderAiReport(); };
  });
  // 圖↔清單 連動: hovering a 失準 row jumps the chart cursor (its amber dot pops) +
  // the readout to that move — chart/readout repaint ONLY, so the list DOM stays
  // stable under the pointer (a full re-render would yank the row mid-hover).
  // Leaving restores the resting cursor.
  box.querySelectorAll(".aiFlaw[data-aiidx]").forEach((el) => {
    const idx = +el.dataset.aiidx;
    el.onmouseenter = () => {
      a.queryIdx = idx;
      const svg = $("#aiChart"); if (svg) drawAiChart(svg, a.points, idx);
      renderAiReadout(idx);
    };
    el.onmouseleave = () => {
      a.queryIdx = null;
      const svg = $("#aiChart"); if (svg) drawAiChart(svg, a.points, aiCursorIdx());
      renderAiReadout(aiCursorIdx());
    };
  });
}

// The SELECTED side's stat row: 共N手 + 偏差率 (the 差/劣 share, = the 失準清單) +
// that side's five grade tallies. No leading 紅/黑 tag — the active 頁籤 already
// names the side. Returns "" for a side with no graded moves.
function aiSideHeadHtml(sc) {
  if (!sc.total) return "";
  const rate = Math.round((sc.poor + sc.blunder) / sc.total * 100);
  return `<div class="aiRepHead">`
    + `<span class="aiRepTotal">共 ${sc.total} 手 · 偏差率 ${rate}%</span>`
    + AI_GRADE_BANDS.map((b) => `<span class="aiGradeChip g-${b.key}">${b.label} ${sc[b.key]}</span>`).join("")
    + `</div>`;
}

// The engine's best alternative at a flaw's DECISION POINT (points[idx-1]),
// translated UCI→中文 by fillAiBlunderBest, WITH that alternative's 走後分 — the
// decision-point eval (= what best play preserves), red POV, the SAME +N the
// readout card shows. Binding the suggestion's own score beside it (the played
// move's 走後分 sits by the played move) kills the "which number is the
// suggestion's?" ambiguity. Empty until the async translation lands. Both the
// 轉折 headline and the 失準 list pass prefix "建議 " so the suggestion reads
// identically in either place.
function aiSuggestHtml(idx, prefix) {
  const sp = EDITOR.aiAnalysis.points[idx - 1];
  const zh = sp && sp.bestZh;
  if (!zh) return "";
  const ev = aiEvalRed(sp);   // decision-point (best-play) eval, red POV
  return ` <span class="aiRepSug">${prefix}${zh}${ev ? " " + ev : ""}</span>`;
}

// The 5-level grade thresholds (per-move cp loss), derived from AI_GRADE_BANDS so
// the legend tracks any threshold change. Shown only when the panel is tall.
function aiThresholdLegendHtml() {
  let prev = null;
  const chips = AI_GRADE_BANDS.map((b, i) => {
    const range = i === 0 ? `≤${b.max}` : (b.max === Infinity ? `>${prev}` : `${prev + 1}–${b.max}`);
    prev = b.max;
    return `<span class="aiGradeChip g-${b.key}">${b.label} ${range}</span>`;
  }).join("");
  return `<div class="aiRepGrid"><span class="aiRepLbl">評級門檻</span>`
    + `<span class="aiThList">${chips}<span class="aiThUnit">每手失分 cp</span></span></div>`;
}

// Mate-aware loss tag. A folded-mate loss (~30000 cp scale) means the move
// crossed the win/loss line — print 殺 instead of the meaningless huge number
// (e.g. the old "虧29358"). Detected by the resulting position being a forced
// mate (point.mate) or the cp being in mate-fold territory. Used by BOTH the
// 關鍵轉折 headline and the 失準清單 so the same move reads identically (虧N / 殺).
function aiMateLoss(r) { return r.p.mate != null || Math.abs(r.loss) >= 9000; }
function aiLossTag(r) { return aiMateLoss(r) ? "殺" : "虧" + Math.round(r.loss); }

// Red-POV score string for a swept point's POST-move position (the 走後分 shown
// in the 失準清單): mate folded to #±N, else signed cp. Mirrors renderAiReadout's
// fmt so the report list and the hover card read identically. "" with no score.
function aiEvalRed(p) {
  if (!p) return "";
  if (p.mate != null) return mateSign(p.mate, p.fen) > 0 ? `#+${Math.abs(p.mate)}` : `#-${Math.abs(p.mate)}`;
  return p.cp != null ? (p.cp > 0 ? "+" + p.cp : "" + p.cp) : "";
}

// Centred rounded "analysing" badge shown while the sweep runs.
function drawAiBusy(svg, text) {
  const W = svg.clientWidth || 300, H = svg.clientHeight || 160;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const mk = (tag, attrs, cls) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (cls) e.setAttribute("class", cls);
    svg.appendChild(e);
    return e;
  };
  const w = 116, h = 30;
  mk("rect", { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h, rx: 15, ry: 15 }, "aiBusyPill");
  mk("text", { x: W / 2, y: H / 2 + 4.5, "text-anchor": "middle" }, "aiBusyTxt").textContent = text;
}

// Loading shimmer on the board — same pulsing-pill aesthetic as the AI sweep
// (drawAiBusy), shown while a chessbook is being fetched on UI open / file
// switch. drawBoard() wipes the SVG the moment the real position renders, so
// this needs no explicit teardown on success. Pass pulse=false for a static
// badge (idle "尚未載入" / "載入失敗" states that shouldn't keep animating).
function drawBoardLoading(text, pulse = true) {
  const svg = $("#board");
  if (!svg) return;
  svg.setAttribute("viewBox", "0 0 540 600");
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const mk = (tag, attrs, cls) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (cls) e.setAttribute("class", cls);
    svg.appendChild(e);
    return e;
  };
  const W = 540, H = 600, w = 220, h = 46;
  mk("rect", { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h, rx: 23, ry: 23 },
    "boardBusyPill" + (pulse ? "" : " static"));
  mk("text", { x: W / 2, y: H / 2 + 6, "text-anchor": "middle" }, "boardBusyTxt").textContent = text;
}

// Red-POV score trend. Positive (red better) sits high; mate clamps to the
// edge. Colours come from CSS classes so the chart tracks the UI theme.
function drawAiChart(svg, points, cursorIdx) {
  // viewBox = pixel size so the chart can grow to fill its box without
  // distorting strokes/text, and so axis labels can live inside the SVG.
  const W = svg.clientWidth || 300, H = svg.clientHeight || 160;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const { l: padL, r: padR, t: padT, b: padB } = AI_PAD;
  const RANGE = aiRange(points);   // dynamic Y bound from the data
  const n = points.length;
  const xAt = (i) => padL + (n <= 1 ? 0 : (i / (n - 1)) * (W - padL - padR));
  const yAt = (cp) => {
    const c = Math.max(-RANGE, Math.min(RANGE, cp));
    return padT + (1 - (c + RANGE) / (2 * RANGE)) * (H - padT - padB);
  };
  const mk = (tag, attrs, cls) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (cls) e.setAttribute("class", cls);
    svg.appendChild(e);
    return e;
  };
  // Gridlines + Y labels at ±RANGE, ±RANGE/2, 0 (0 line emphasised).
  for (const g of [RANGE, RANGE / 2, 0, -RANGE / 2, -RANGE]) {
    const lbl = Math.round(g);
    mk("line", { x1: padL, y1: yAt(g), x2: W - padR, y2: yAt(g) }, g === 0 ? "aiZero" : "aiGrid");
    mk("text", { x: padL - 6, y: yAt(g) + 3.5, "text-anchor": "end" }, "aiAxisTxt")
      .textContent = lbl > 0 ? "+" + lbl : "" + lbl;
  }
  if (!n) return;
  const val = (p) => (p.mate != null ? (mateSign(p.mate, p.fen) > 0 ? RANGE : -RANGE) : p.cp);
  const scored = points.map((p, i) => ({ i, v: val(p) })).filter((p) => p.v != null);

  // Advantage area: fill between the eval curve and the 0 line — red where red
  // leads (above 0), blue where black leads (below 0). One area path filled
  // with a vertical gradient that hard-stops at the 0 line and fades toward it,
  // so colour depth reads as lead magnitude. (Only the shallow/primary series
  // is plotted; the deep series, when dual is on, surfaces via the Δ flags.)
  if (scored.length >= 2) {
    const y0 = yAt(0);
    const f = Math.max(0, Math.min(1, (y0 - padT) / (H - padT - padB)));
    const defs = mk("defs", {});
    const grad = document.createElementNS(SVG_NS, "linearGradient");
    grad.setAttribute("id", "aiAreaGrad");
    grad.setAttribute("gradientUnits", "userSpaceOnUse");
    grad.setAttribute("x1", 0); grad.setAttribute("y1", padT);
    grad.setAttribute("x2", 0); grad.setAttribute("y2", H - padB);
    // Area tint follows the theme's semantic side colours (same source as the
    // pills + dots), so red-lead/black-lead zones match everywhere.
    // Read the LEAF hex tokens (getComputedStyle doesn't resolve nested var()).
    const aRed = cssVar("--side-red-strong") || "#e2594f";
    const aBlk = cssVar("--side-black-strong") || "#5b9be0";
    // Area depth is theme-tunable: light theme dials it down (--chart-area-alpha
    // 0.16) for a 素淨 look; dark keeps the original 0.42.
    const aA = parseFloat(cssVar("--chart-area-alpha")) || 0.42;
    for (const [off, col] of [
      [0, hexToRgba(aRed, aA)], [f, hexToRgba(aRed, 0.05)],
      [f, hexToRgba(aBlk, 0.05)], [1, hexToRgba(aBlk, aA)],
    ]) {
      const s = document.createElementNS(SVG_NS, "stop");
      s.setAttribute("offset", off); s.setAttribute("stop-color", col);
      grad.appendChild(s);
    }
    defs.appendChild(grad);
    const curve = scored.map((p) => `${xAt(p.i)},${yAt(p.v)}`).join(" L ");
    const xa = xAt(scored[0].i), xb = xAt(scored[scored.length - 1].i);
    mk("path", { d: `M ${curve} L ${xb},${y0} L ${xa},${y0} Z`, fill: "url(#aiAreaGrad)", stroke: "none" });
  }
  // Eval line on top of the fill — a light neutral stroke so it belongs to both
  // the red and blue zones rather than fighting them.
  if (scored.length >= 2) {
    mk("polyline", { points: scored.map((p) => `${xAt(p.i)},${yAt(p.v)}`).join(" "), fill: "none" }, "aiLine");
  }
  // Vertical query line at the cursor.
  if (cursorIdx >= 0 && cursorIdx < n) {
    mk("line", { x1: xAt(cursorIdx), y1: padT, x2: xAt(cursorIdx), y2: H - padB }, "aiCursor");
  }
  // Small dots coloured by the side that moved (odd ply = red, even = black);
  // the start position is neutral. Secondary to the fill, but keep the per-move
  // detail + hover targets.
  scored.forEach((p) => {
    const cls = p.i === 0 ? "aiDotBlk" : (p.i % 2 === 1 ? "aiDotRed" : "aiDotBlk");
    mk("circle", { cx: xAt(p.i), cy: yAt(p.v), r: 2.6 }, cls);
  });
  // Dual-depth divergence flags: a small alert triangle above any point where
  // deep vs shallow disagree by ≥ threshold (only present when dual ran).
  points.forEach((p, i) => {
    const d = aiPointDiff(p);
    if (!d || !d.flagged) return;
    const v = val(p);
    if (v == null) return;
    const x = xAt(i), y = yAt(v);
    mk("polygon", { points: `${x - 5},${y - 13} ${x + 5},${y - 13} ${x},${y - 4}` }, "aiFlag");
  });
  // 漏著 markers: a ✖ glyph (= a mistake) above any point whose incoming move lost
  // ≥ the blunder threshold (live per-ply loss; no positions.db). A bg-haloed
  // vivid rose (--eval-blunder) so it stays legible over the red OR blue zone and
  // on either theme — distinct from the amber divergence flag.
  const blThresh = aiBlunderThreshold();
  for (let i = 1; i < n; i++) {
    const loss = aiPlyLoss(points, i);
    if (loss == null || loss < blThresh) continue;
    const v = val(points[i]);
    if (v == null) continue;
    const ty = Math.max(padT + 11, yAt(v) - 5);   // clamp so the glyph stays on canvas
    mk("text", { x: xAt(i), y: ty, "text-anchor": "middle" }, "aiBlunder").textContent = "✖";
  }
  // Orange ring highlighting the queried point.
  if (cursorIdx >= 0 && cursorIdx < n && val(points[cursorIdx]) != null) {
    mk("circle", { cx: xAt(cursorIdx), cy: yAt(val(points[cursorIdx])), r: 6.5, fill: "none" }, "aiRing");
  }
}

// Single-row readout for the point under the query line (走法 + 分數). Falls
// back to a hint before analysis runs.
function renderAiReadout(idx) {
  const box = $("#aiReadout");
  if (!box) return;
  const pts = EDITOR.aiAnalysis.points;
  if (!pts.length) { box.innerHTML = `<div class="varEmpty">按「掃描」開始；分析後可在走勢圖上查詢各步</div>`; return; }
  if (idx < 0 || idx >= pts.length) { box.innerHTML = `<div class="varEmpty">移到走勢圖上查看各步分數</div>`; return; }
  const p = pts[idx];
  const fmt = (cp, mate, fen) => mate != null
    ? (mateSign(mate, fen !== undefined ? fen : p.fen) > 0 ? `#+${Math.abs(mate)}` : `#-${Math.abs(mate)}`)
    : (cp != null ? (cp > 0 ? "+" + cp : "" + cp) : "…");
  const isActive = idx === aiActiveIdx();
  const d = aiPointDiff(p);
  let scoreHtml;
  if (d) {
    const D1 = EDITOR.aiAnalysis.depth || aiDepth();
    const D2 = EDITOR.aiAnalysis.depth2 || aiDepth2();
    const dtxt = (d.diff > 0 ? "+" : "") + d.diff;
    scoreHtml = `<span class="aiReadScore aiReadDual">`
      + `<span class="aiScorePair"><i>d${D1}</i>${fmt(p.cp, p.mate)}</span>`
      + `<span class="aiScorePair"><i>d${D2}</i>${fmt(p.cp2, p.mate2)}</span>`
      + `<span class="aiDiff${d.flagged ? " flag" : ""}">Δ${dtxt}${d.flagged ? " ⚠" : ""}</span>`
      + `</span>`;
  } else {
    scoreHtml = `<span class="aiReadScore">${fmt(p.cp, p.mate)}</span>`;
  }
  // 漏著: the move into this point lost ≥ threshold. Shown inline (same row) in
  // red POV — a ✗ mark + the engine's best alternative at the decision point and
  // that point's red-POV eval (what best play preserves; compare to the score).
  let blunderHtml = "";
  const loss = aiPlyLoss(pts, idx);
  if (loss != null && loss >= aiBlunderThreshold()) {
    const dp = pts[idx - 1];
    const best = dp && dp.bestZh ? dp.bestZh : (dp && dp.best ? "…" : "");
    const bestEval = dp ? fmt(dp.cp, dp.mate, dp.fen) : "";
    blunderHtml = `<span class="aiReadBlunder">`
      + `<span class="aiBlunderTag">✖</span>`
      + (best ? `<span class="aiBlunderBest">${best} <b>${bestEval}</b></span>` : "")
      + `</span>`;
  }
  // Per-move 5-level grade chip from the incoming move's loss — surfaces 逐手
  // 評價 inline as you scrub the chart. Absent on the start point / when the
  // loss can't be measured. Sits next to the score; the 漏著 cluster stays right.
  const g = aiGrade(aiPlyLoss(pts, idx));
  const gradeHtml = g ? `<span class="aiGradeChip g-${g.key}">${g.label}</span>` : "";
  // One line: label (ellipsis when tight) + grade chip + red-POV score + optional
  // 漏著 info — constant height whether or not the point is flagged (no layout
  // drift). Chip before score (膠囊在分數前) per master's preference.
  box.innerHTML = `<div class="aiReadCard${isActive ? " active" : ""}">`
    + `<span class="aiReadLabel">${p.label}</span>`
    + gradeHtml
    + scoreHtml
    + blunderHtml
    + `</div>`;
}
