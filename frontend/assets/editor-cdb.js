// editor-cdb.js — extracted from editor.js (T2-1 incremental split).
// Classic script: shares the global lexical scope with editor.js and is
// loaded BEFORE it in index.html, so its functions may freely reference
// editor.js globals (EDITOR, $, helpers) — they're only called at runtime,
// after every script has loaded. Do NOT convert to an ES module.

// ---------- live chessdb.cn cloud-library lookup ----------
// positions.db only covers the AI library; the editor lets the user set up
// any position, so on navigation we lazily query chessdb.cn for the current
// FEN and merge the result into evalsByFen[fen].cdb. Cache-first server-side
// (positions.db → editor cache → live), debounced here so fast arrow-key
// paging fires one request for the position you land on, not every step.

function ensureCdbLive(fen) {
  if (!fen || !EDITOR.data) return;
  clearTimeout(EDITOR.cdbLive.timer);
  const entry = EDITOR.evalsByFen[fen];
  if (entry && entry.cdb) {            // already have it (batch or prior fetch)
    EDITOR.cdbLive.loading = false;
    EDITOR.cdbLive.error = null;
    EDITOR.cdbLive.endgame = false;
    renderCdbTab();
    return;
  }
  // 殘局：雲庫無有效資料，不發查詢（標記讓 UI 說明，而非卡在「查詢中…」）。
  if (isEndgameFen(fen)) {
    EDITOR.cdbLive.fen = fen;
    EDITOR.cdbLive.loading = false;
    EDITOR.cdbLive.error = null;
    EDITOR.cdbLive.endgame = true;
    renderCdbTab();
    renderEvalLine();
    return;
  }
  EDITOR.cdbLive.endgame = false;
  EDITOR.cdbLive.fen = fen;
  EDITOR.cdbLive.loading = true;
  EDITOR.cdbLive.error = null;
  renderCdbTab();                       // show 查詢中…
  renderEvalLine();                     // evalLine 雲 cell → 查詢中…
  EDITOR.cdbLive.timer = setTimeout(() => fetchCdbLive(fen, false), 220);
}

// ---------- shared /api/chessdb client (T2-5) ----------
// One place to fetch + normalise + cache the cloud-library response, shared by
// the navigation live-query (fetchCdbLive) and the 雲庫演繹 loop (deriveCdbLine).
// NOTE: only the response parsing + cache are shared — deriveCdbLine keeps its
// OWN throttled loop (the CLAUDE.md-sanctioned "唯一多次查詢"); do NOT merge it.

// Normalise a /api/chessdb body to the cdb shape the UI renders. Throws on the
// documented error envelopes (status:'error', or a bare {error}) so callers
// handle failures uniformly.
function parseCdbResponse(body) {
  if (!body) throw new Error("空回應");
  if (body.status === "error") throw new Error(body.error || "查詢失敗");
  if (body.error && !body.status) throw new Error(body.error);
  return {
    status: body.status,
    moves: body.moves || [],
    best: body.best || null,
    source: body.source,
  };
}

// Fetch one position from the cache-first cloud route. fresh=1 skips server
// caches and re-queries chessdb.cn. Returns the normalised cdb (or throws).
async function fetchCdb(fen, fresh) {
  const r = await fetch(
    "/api/chessdb?fen=" + encodeURIComponent(fen) + (fresh ? "&fresh=1" : ""));
  return parseCdbResponse(await r.json());
}

// Merge a cdb result into the per-fen cache so later navigation reuses it
// (ensureCdbLive's fast path serves entry.cdb without a re-query).
function cacheCdb(fen, cdb) {
  if (!fen || !cdb) return;
  if (!EDITOR.evalsByFen[fen]) EDITOR.evalsByFen[fen] = {};
  EDITOR.evalsByFen[fen].cdb = cdb;
}

async function fetchCdbLive(fen, fresh) {
  if (!fen) return;
  EDITOR.cdbLive.fen = fen;
  EDITOR.cdbLive.loading = true;
  EDITOR.cdbLive.error = null;
  renderCdbTab();
  try {
    cacheCdb(fen, await fetchCdb(fen, fresh));
  } catch (e) {
    // Don't cache transient failures into evalsByFen — leave it absent so the
    // next visit (or 重查) retries instead of sticking on "查詢失敗".
    EDITOR.cdbLive.error = e.message || "網路錯誤";
  } finally {
    EDITOR.cdbLive.loading = false;
    // The eval line keys to currentFen, the 雲庫 tab to cdbTabFen — repaint
    // whichever this result still matches (navigating away makes both false, so a
    // stale late response can't overwrite the new position).
    if (fen === currentFen()) renderEvalLine();
    if (fen === cdbTabFen()) renderCdbTab();
  }
}

// Map chessdb non-ok statuses to a human label for the 雲庫 tab.
const CDB_STATUS_LABEL = {
  unknown: "雲庫尚無此局面",
  "invalid board": "局面不合法",
  checkmate: "已將死",
  stalemate: "已困斃",
  nobestmove: "無著可走",
  error: "查詢失敗",
};

function renderCdbTab() {
  const list = $("#cdbList");
  const stateEl = $("#cdbState");
  if (!list) return;
  const setState = (t) => { if (stateEl) stateEl.textContent = t; };
  if (!EDITOR.data) { list.innerHTML = ""; setState("—"); return; }
  const fen = cdbTabFen();   // 當前步(前一步決策點) 或 下一步(走完本步後) — 見 cdbTabFen()
  const entry = fen && EDITOR.evalsByFen[fen];
  const cdb = entry && entry.cdb;
  const cl = EDITOR.cdbLive;
  // Which listed moves to mark, and how:
  //   當前步: the move actually taken here (current move) → "目前所在變化" ←
  //   下一步: moves already present as children of the active node → "已在棋譜" ✓
  const activeNode = nodeAt(EDITOR.activePath);
  let markedSet, hereGlyph, hereTitle, clickHint;
  if (EDITOR.cdbScope === "next") {
    const kids = (activeNode ? activeNode.children : (EDITOR.data.roots || [])) || [];
    markedSet = new Set(kids.map((k) => k.iccs));
    hereGlyph = "✓"; hereTitle = "已在棋譜的後續著";
    clickHint = "點擊：加入為當前著的後續／切換至此著";
  } else {
    markedSet = new Set(activeNode && activeNode.iccs ? [activeNode.iccs] : []);
    hereGlyph = "←"; hereTitle = "目前所在變化";
    clickHint = "點擊：加入此分支／切換至此著";
  }

  if (!cdb) {
    if (cl.endgame && cl.fen === fen) {
      setState("殘局・不查雲庫");
      list.innerHTML = `<div class="cdbEmpty">已進入殘局，雲庫僅涵蓋開局／中局，停止查詢。</div>`;
    } else if (cl.loading && cl.fen === fen) {
      setState("查詢中…");
      list.innerHTML = `<div class="cdbEmpty">向 chessdb.cn 查詢中…</div>`;
    } else if (cl.error && cl.fen === fen) {
      setState("查詢失敗");
      list.innerHTML = `<div class="cdbEmpty cdbErr">查詢失敗：${cl.error}</div>`;
    } else {
      setState("—");
      list.innerHTML = `<div class="cdbEmpty">尚無雲庫資料</div>`;
    }
    return;
  }

  const moves = cdb.moves || [];
  if (cdb.status !== "ok" || moves.length === 0) {
    const label = CDB_STATUS_LABEL[cdb.status] || "雲庫無資料";
    setState(label);
    list.innerHTML = `<div class="cdbEmpty">${label}</div>`;
    return;
  }

  const side = fenSide(fen);
  const flip = side === "b" ? -1 : 1;
  const srcLabel = { db: "庫", cache: "快取", live: "即時" }[cdb.source] || "";
  setState(`${moves.length} 個著法${srcLabel ? "・" + srcLabel : ""}`);

  list.innerHTML = "";
  moves.forEach((m, i) => {
    const sRed = m.score == null ? null : Math.round(m.score * flip);
    const sMate = mateFromCdbScore(sRed);
    const sTxt = sMate != null ? sMate : (sRed == null ? "?" : (sRed > 0 ? "+" : "") + sRed);
    const wr = m.winrate == null ? "—" : m.winrate.toFixed(1) + "%";
    const isCurrent = markedSet.has(m.iccs);
    const row = document.createElement("div");
    row.className = "cdbOpt" + (i === 0 ? " best" : "") + (isCurrent ? " current" : "");
    row.innerHTML =
      `<span class="cdbRank">${i === 0 ? "★" : i + 1}</span>` +
      `<span class="cdbMove" data-iccs="${m.iccs}">…</span>` +
      `<span class="cdbWr">${wr}</span>` +
      `<span class="cdbScore ${deltaSignClass(sRed)}">${sTxt}</span>` +
      (isCurrent ? `<span class="cdbHere" title="${hereTitle}">${hereGlyph}</span>` : "");
    row.title = `${m.iccs}　雲庫分 ${sTxt}（紅方視角）　勝率 ${wr}`
      + (m.note ? `　${m.note}` : "")
      + (isCurrent ? `\n${hereTitle}` : `\n${clickHint}`);
    row.onclick = () => addCdbMove(m.iccs);
    list.appendChild(row);
  });
  // Translate the candidate moves to Chinese in ONE batched request — and only
  // while the 雲庫 tab is visible (fillCdbNotations no-ops when hidden). Rows
  // show the … placeholder until then (and fall back to the raw iccs if a
  // conversion fails).
  fillCdbNotations();
}

// Add a cloud-library move into the tree. Where depends on the 雲庫 scope:
//   當前步 (prev): a SIBLING of the active move (insert at the 前一步 branch
//                  point) — "also try this here".
//   下一步 (next): a CHILD of the active move (the next ply) — "continue with
//                  this". The cloud list is the moves playable from cdbTabFen().
// Either way, if the move already exists among that point's continuations,
// insertMoveAt navigates to it instead of duplicating.
async function addCdbMove(iccs) {
  const fen = cdbTabFen();
  if (!fen) return;
  // 當前步: sibling of the active move (insert at the 前一步 branch point).
  // 下一步: child of the active move (the next ply) → insert at the active path.
  const branchPath = EDITOR.cdbScope === "next"
    ? EDITOR.activePath.slice()
    : (EDITOR.activePath.length ? EDITOR.activePath.slice(0, -1) : []);
  setStatus("驗證走法…");
  try {
    const r = await fetch("/api/xqf/move-info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fen, iccs }),
    });
    const resp = await r.json();
    if (resp.error) { setStatus(resp.error, "err"); return; }
    const outcome = await insertMoveAt(branchPath, {
      iccs,
      notation: resp.notation,
      side: resp.side,
      ply: branchPath.length + 1,
      annote: "",
      children: [],
    });
    if (outcome === "added") setStatus(`已加入分支 ${resp.notation}`, "ok");
    else if (outcome === "existing") setStatus(`已切換至 ${resp.notation}`, "ok");
    else setStatus("");  // cancelled
  } catch (e) {
    setStatus("新增失敗：" + e.message, "err");
  }
}

// ---------- ☁ 雲庫演繹: forward chessdb principal variation -------------------
// From the CURRENT position, repeatedly take chessdb's best move, apply it, and
// query the next position — building one "if both sides play the cloud's best"
// main line up to cdbLineDepth() plies. On-demand only (a button), NOT auto on
// navigation: it is a sequential burst of live lookups, so it must respect
// chessdb's politeness budget. Cache hits (positions.db / editor cache) are
// free; only live misses sleep 250ms between calls. The line naturally stops
// where the book ends (chessdb has no row) — that endpoint is itself a signal.
// Display / 演示 / 加入 reuse the engine line's openDemo + addPvLine via a
// {fen, path, pvUci, pv} entry, so there is no new demo/add logic here.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdbLineDepth() {
  const d = parseInt(PREFS.cdbLineDepth, 10);
  return Number.isFinite(d) && d >= 1 && d <= 30 ? d : 12;
}

// Sleep between LIVE chessdb lookups during 演繹 (cache hits don't wait). Lower
// = faster but more likely to trip chessdb's ~5 req/s limit; 250ms is the
// conservative default. Clamped so a stray pref can't go fully unthrottled.
function cdbLineThrottle() {
  const m = parseInt(PREFS.cdbLineThrottleMs, 10);
  return Number.isFinite(m) && m >= 0 && m <= 5000 ? m : 250;
}

// 🎬 匯出 GIF 時每一手停留的秒數。gifexport.js 也讀這個 getter（共用全域）。
function gifFrameDelaySec() {
  const s = parseFloat(PREFS.gifFrameDelaySec);
  return Number.isFinite(s) && s >= 0.2 && s <= 5 ? s : 0.65;
}

// Build the {fen, path, pvUci, pv} entry openDemo/addPvLine expect from the
// derived line (start position + the chessdb-best move sequence).
function cdbLineEntry() {
  const s = EDITOR.cdbLine;
  return {
    fen: s.startFen,
    path: s.startPath,
    pvUci: s.steps.map((x) => x.iccs),
    pv: s.steps.map((x) => x.notation),
  };
}

function clearCdbLine() {
  EDITOR.cdbLine = { running: false, steps: [], startFen: null, startPath: [], endReason: "" };
  renderCdbLineView();
}

async function deriveCdbLine() {
  if (!EDITOR.data) { setStatus("尚未載入棋譜", "err"); return; }
  const s = EDITOR.cdbLine;
  if (s.running) return;
  s.running = true;
  s.steps = [];
  s.endReason = "";
  s.startFen = currentFen();
  s.startPath = [...EDITOR.activePath];
  const maxDepth = cdbLineDepth();
  renderCdbLineView();
  let fen = s.startFen;
  try {
    for (let i = 0; i < maxDepth; i++) {
      // 殘局：雲庫無有效資料，停止演繹（起點殘局即不查；走到殘局也收手）。
      if (isEndgameFen(fen)) {
        s.endReason = i === 0 ? "殘局・雲庫不適用" : "已演繹至殘局";
        break;
      }
      let cdb;
      try {
        cdb = await fetchCdb(fen, false);   // shared fetch+parse (T2-5)
      } catch (_) {
        s.endReason = "查詢失敗（網路）";
        break;
      }
      // Backfill the per-fen cache so navigating onto a derived position later
      // reuses this result instead of re-querying (T2-5). Caches "unknown" too
      // (a confirmed out-of-book answer is worth not re-asking).
      cacheCdb(fen, cdb);
      if (cdb.status !== "ok" || !cdb.best || !cdb.best.iccs) {
        s.endReason = i === 0 ? "雲庫無此局面" : "雲庫到此無資料";
        break;
      }
      const best = cdb.best;
      const side = fenSide(fen);
      const flip = side === "b" ? -1 : 1;
      const scoreRed = best.score != null ? Math.round(best.score * flip) : null;
      const mate = mateFromCdbScore(scoreRed);
      const notation = (await notationFor(fen, best.iccs)) || best.iccs;
      s.steps.push({ iccs: best.iccs, notation, scoreRed, mate });
      renderCdbLineView();                      // progressive: show each step as it lands
      fen = applyIccs(fen, best.iccs);          // advance to the next position
      if (mate != null) { s.endReason = "將死終局"; break; }
      if (i === maxDepth - 1) { s.endReason = "已達設定步數"; break; }
      if (cdb.source === "live") await sleep(cdbLineThrottle());   // politeness: only throttle live misses
    }
  } finally {
    s.running = false;
    renderCdbLineView();
    // Surface a clear notice when the derivation yielded nothing (e.g. the start
    // position is out of book / 殘局 / 查詢失敗) — otherwise the empty panel reads
    // like the button did nothing.
    if (!s.steps.length) setStatus(`雲庫演繹：${s.endReason || "查無資料"}`, "warn");
  }
}

function renderCdbLineView() {
  const list = $("#cdbLineList");
  if (!list) return;
  const s = EDITOR.cdbLine;
  const stateEl = $("#cdbLineState");
  const runBtn = $("#cdbLineRunBtn");
  const demoBtn = $("#cdbLineDemoBtn");
  const addBtn = $("#cdbLineAddBtn");
  if (runBtn) runBtn.disabled = s.running;
  const hasLine = s.steps.length > 0 && !s.running;
  if (demoBtn) demoBtn.disabled = !hasLine;
  if (addBtn) addBtn.disabled = !hasLine;
  if (stateEl) {
    // A zero-step run still has an endReason (e.g. 雲庫無此局面) — show it instead
    // of "尚未演繹" so 「按了演繹卻查無」doesn't look like nothing happened.
    stateEl.textContent = s.running
      ? `演繹中… 已 ${s.steps.length} 步`
      : (s.steps.length
          ? `${s.steps.length} 步${s.endReason ? "・" + s.endReason : ""}`
          : (s.endReason || "尚未演繹"));
  }
  if (!s.steps.length) {
    // Distinguish "never run" (generic hint) from "ran, found nothing" (show why).
    list.innerHTML = (s.endReason && !s.running)
      ? `<div class="cdbEmpty cdbErr">雲庫演繹查無結果：${s.endReason}。<br>此局面雲庫未收錄，無法沿最佳著推演。</div>`
      : `<div class="cdbEmpty">按「演繹」從本局面沿雲庫最佳著推演一條主線（最多 ${cdbLineDepth()} 步；雲庫無資料即止）。</div>`;
    return;
  }
  // Per-row layout mirroring the 🤖AI走棋 log: 第N步 · 紅/黑 著法(side-tinted) ·
  // 紅分. Forward order (1→N) since this is a single forward-derived line.
  const startSide = fenSideName(s.startFen);
  list.innerHTML = s.steps.map((st, i) => {
    const side = (i % 2 === 0) ? startSide : (startSide === "red" ? "black" : "red");
    const sideTxt = side === "red" ? "紅" : "黑";
    const cls = side === "red" ? "moveRed" : "moveBlk";
    const sc = fmtEngineScore({ cp: st.scoreRed, mate: st.mate });
    return `<div class="engEntry">`
      + `<div class="engMeta">`
      + `<span>第 <b class="engBig">${i + 1}</b> 步</span>`
      + `<span class="${cls}">${sideTxt} <b class="engBig">${st.notation || st.iccs}</b></span>`
      + `<span>紅分 <b class="engBig">${sc}</b></span>`
      + `</div>`
      + `</div>`;
  }).join("");
}
