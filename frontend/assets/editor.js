"use strict";
/* XQF editor — uses board.js's full theme renderer.
 *
 * board.js is loaded as a sibling non-module script BEFORE this file. Its
 * top-level function declarations (drawBoard, parseFen, applyIccs,
 * iccsToCoord) and module-scoped `let`s (CURRENT_REDP, BOARD_STYLES) are
 * visible here via the shared script lexical environment.
 *
 * board.js's full UI bootstrap (initGamePage) is NOT invoked — we only use
 * its renderer + helpers. REDP_BOX is wired via the hidden checkbox in
 * index.html so isRedPerspective() returns a real value. */

// ---------- editor state ----------

const EDITOR = {
  currentPath: null,
  data: null,
  activePath: [],     // index path into roots[][.children]... — [] = init position
  selectedSquare: null,  // "h2" when user has selected a from-square via click
  legalTargets: [],   // list of dest iccs ("e2",...) for currently selected piece
  // Read-only eval data from chess-book-ai's positions.db. Loaded by
  // fetchEvalsForFile() after each selectFile. {fen -> {d12?,d22?,d28?,d32?,cdb?}}.
  // Empty object when the DB is missing or the file's FENs aren't in it.
  evalsByFen: {},
  evalDbInfo: null,   // result of GET /api/eval/info — drives UI gating
  engineInfo: null,   // result of GET /api/engine/info — Pikafish config chip
  engineAnalysis: { es: null, running: false, fen: null, history: [] },  // live SSE analysis
};

// Per-theme editor colours for selection halo + legal-destination markers.
// Each theme has its own palette in board.js; we pick contrasting accents:
//   select : ring drawn around the selected own-piece (vivid, not gold so it
//            doesn't clash with the lastMove gold rings in stone/gilded)
//   target : dot/ring shown on each legal destination square
// Falls back to traditional's palette if the active theme key is missing.
const EDITOR_THEME_COLORS = {
  traditional: { select: "#e67e22", target: "#16a085" },  // orange / teal on warm wood (teal pops harder than the original steel-blue against mid-tone wood)
  stone:       { select: "#c0392b", target: "#3a6b3a" },  // cinnabar / pine green on cream stone
  gilded:      { select: "#e8b75c", target: "#5fa8d6" },  // brighter gold / cool blue on dark slate
  copperwood:  { select: "#cf6a32", target: "#7aa6a1" },
  celadon:     { select: "#c75b4a", target: "#5b8f7a" },
};

const UI_THEMES = {
  ember: "琥珀夜",
  jade: "青玉霧",
  ink: "墨夜藍",
  plum: "梅影紫",
  copper: "赤銅棕",
  pineash: "松煙灰",
};
function editorColors() {
  const t = document.documentElement.dataset.board || "traditional";
  return EDITOR_THEME_COLORS[t] || EDITOR_THEME_COLORS.traditional;
}

// Server-persisted preferences (splitter sizes, board theme, ...).
// Loaded once on boot; mutations posted back to /api/preferences immediately.
const PREFS = {};
async function loadPreferences() {
  try {
    const r = await fetch("/api/preferences");
    const data = await r.json();
    Object.assign(PREFS, data);
  } catch (_) { /* first run; PREFS stays empty */ }
}
async function savePreference(key, value) {
  PREFS[key] = value;
  try {
    await fetch("/api/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    });
  } catch (_) {}
}

const $ = (sel) => document.querySelector(sel);

function ensureBoardThemeOptions() {
  const select = document.getElementById("boardThemeSel");
  if (!select) return;
  const labels = {
    traditional: "傳統手繪",
    stone: "雅石回紋",
    gilded: "鎏金歲月",
    copperwood: "赤銅古木",
    celadon: "青瓷素雅",
  };
  for (const [value, text] of Object.entries(labels)) {
    let option = select.querySelector(`option[value="${value}"]`);
    if (!option) {
      option = document.createElement("option");
      option.value = value;
      select.appendChild(option);
    }
    option.textContent = text;
  }
}

function reorderEvalRows() {
  const evalLine = $("#evalLine");
  const evalDbRow = document.querySelector("#boardPane > .evalDbRow");
  if (!evalLine || !evalDbRow) return;
  const parent = evalLine.parentElement;
  if (!parent || evalDbRow.parentElement !== parent) return;
  if (evalLine.previousElementSibling === evalDbRow) return;
  parent.insertBefore(evalLine, evalDbRow);
}

function setStatus(text, cls) {
  const s = $("#status");
  s.textContent = text || "";
  s.className = cls || "";
}

function showConfirmDialog(message, title = "請確認") {
  return new Promise((resolve) => {
    const modal = $("#confirmModal");
    const titleEl = $("#confirmTitle");
    const msgEl = $("#confirmMessage");
    const okBtn = $("#confirmOk");
    const cancelBtn = $("#confirmCancel");
    if (!modal || !titleEl || !msgEl || !okBtn || !cancelBtn) {
      resolve(window.confirm(message));
      return;
    }

    titleEl.textContent = title;
    msgEl.textContent = message;
    modal.hidden = false;

    const cleanup = () => {
      modal.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKeydown);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onBackdrop = (e) => {
      if (e.target.id === "confirmModal") onCancel();
    };
    const onKeydown = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      else if (e.key === "Enter") { e.preventDefault(); onOk(); }
    };

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKeydown);
    cancelBtn.focus();
  });
}

// ---------- path / tree helpers ----------

function nodeAt(path) {
  if (!EDITOR.data || path.length === 0) return null;
  let nodes = EDITOR.data.roots;
  let node = null;
  for (const idx of path) {
    node = nodes[idx];
    if (!node) return null;
    nodes = node.children || [];
  }
  return node;
}

function siblingsAt(path) {
  if (!EDITOR.data) return [];
  if (path.length <= 1) return EDITOR.data.roots || [];
  const parent = nodeAt(path.slice(0, -1));
  return parent ? (parent.children || []) : [];
}

function fenAndLastIccsFor(path) {
  let fen = EDITOR.data.init_fen;
  let lastIccs = null;
  let nodes = EDITOR.data.roots;
  for (const idx of path) {
    const node = nodes[idx];
    if (!node) break;
    fen = applyIccs(fen, node.iccs);  // from board.js
    lastIccs = node.iccs;
    nodes = node.children || [];
  }
  return { fen, lastIccs };
}

// ---------- click-to-add-move ----------
// Two-step interaction:
//   1. Click an own-side piece → that square becomes EDITOR.selectedSquare
//   2. Click any other square → POST /api/xqf/move-info to validate +
//      compute notation; on success, insert a new node and navigate to it
//
// Implementation: drawBoard() in board.js wipes the SVG on every redraw, so
// after each redraw we install a transparent 90-cell <g class="clickLayer">
// on top to catch pointer events. Selection halo is drawn in the same pass.
//
// SVG_NS, screenX, screenY, parseFen are all declared at module-top in
// board.js and reused here via shared classic-script scope.

function squareIccs(col, row) {
  // ICCS: cols a-i = 0-8, rows 0-9 as digits.
  return String.fromCharCode(97 + col) + row;
}
function parseSquare(sq) {
  return { col: sq.charCodeAt(0) - 97, row: parseInt(sq[1], 10) };
}
function currentFen() {
  if (!EDITOR.data) return null;
  return fenAndLastIccsFor(EDITOR.activePath).fen;
}
function pieceAt(sq) {
  // Returns piece char (e.g. "R" / "k") or null if empty / no game loaded.
  const fen = currentFen();
  if (!fen) return null;
  const { rows } = parseFen(fen);   // board.js helper
  const { col, row } = parseSquare(sq);
  return rows[row][col] || null;
}
function isFriendlyPiece(piece, sideToMove) {
  if (!piece) return false;
  const isRed = piece === piece.toUpperCase();
  return (isRed && sideToMove === "w") || (!isRed && sideToMove === "b");
}

function installBoardOverlay(svg) {
  // 90 transparent rects (data-iccs="<square>") + an optional selection halo
  // + legal-target dots, bundled into <g class="clickLayer"> so it's clear
  // what redraws own.
  const colors = editorColors();
  const layer = document.createElementNS(SVG_NS, "g");
  layer.setAttribute("class", "clickLayer");

  // Legal-destination markers: ring around enemy occupied square (capture),
  // small dot on empty square (move). Drawn first so they sit under the
  // click-rects but above the pieces (after halo is inserted below).
  const fen = currentFen();
  const occupiedSet = new Set();
  if (fen) {
    const { rows } = parseFen(fen);
    for (let r = 0; r <= 9; r++) {
      for (let c = 0; c <= 8; c++) {
        if (rows[r][c]) occupiedSet.add(squareIccs(c, r));
      }
    }
  }
  for (const sq of EDITOR.legalTargets) {
    const { col, row } = parseSquare(sq);
    const cx = screenX(col), cy = screenY(row);
    if (occupiedSet.has(sq)) {
      // Capture: hollow ring around the enemy piece
      const ring = document.createElementNS(SVG_NS, "circle");
      ring.setAttribute("cx", cx);
      ring.setAttribute("cy", cy);
      ring.setAttribute("r", 29);
      ring.setAttribute("fill", "none");
      ring.setAttribute("stroke", colors.target);
      ring.setAttribute("stroke-width", 2.5);
      ring.setAttribute("stroke-opacity", 0.85);
      ring.style.pointerEvents = "none";
      layer.appendChild(ring);
    } else {
      // Empty square: filled dot at the centre
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("cx", cx);
      dot.setAttribute("cy", cy);
      dot.setAttribute("r", 7);
      dot.setAttribute("fill", colors.target);
      dot.setAttribute("fill-opacity", 0.65);
      dot.style.pointerEvents = "none";
      layer.appendChild(dot);
    }
  }

  // Click-capture rects on top so destination markers don't swallow clicks.
  for (let r = 0; r <= 9; r++) {
    for (let c = 0; c <= 8; c++) {
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", screenX(c) - 30);
      rect.setAttribute("y", screenY(r) - 30);
      rect.setAttribute("width", 60);
      rect.setAttribute("height", 60);
      rect.setAttribute("fill", "transparent");
      rect.setAttribute("data-iccs", squareIccs(c, r));
      rect.style.cursor = "pointer";
      layer.appendChild(rect);
    }
  }

  // Selection halo on the source square — inserted first so it sits visually
  // behind everything else in this layer but on top of the piece drawing.
  if (EDITOR.selectedSquare) {
    const { col, row } = parseSquare(EDITOR.selectedSquare);
    const halo = document.createElementNS(SVG_NS, "circle");
    halo.setAttribute("cx", screenX(col));
    halo.setAttribute("cy", screenY(row));
    halo.setAttribute("r", 29);
    halo.setAttribute("fill", "none");
    halo.setAttribute("stroke", colors.select);
    halo.setAttribute("stroke-width", 3);
    halo.setAttribute("stroke-opacity", 0.95);
    halo.style.pointerEvents = "none";
    layer.insertBefore(halo, layer.firstChild);
  }
  svg.appendChild(layer);
}

function onSquareClick(sq) {
  if (!EDITOR.data) return;
  const fen = currentFen();
  if (!fen) return;
  const sideToMove = parseFen(fen).side;
  const piece = pieceAt(sq);

  // Same square clicked → deselect
  if (EDITOR.selectedSquare === sq) {
    clearSelection();
    refreshActive();
    return;
  }
  // No selection yet: clicking own piece selects it; anything else is a no-op
  if (!EDITOR.selectedSquare) {
    if (isFriendlyPiece(piece, sideToMove)) selectSquare(sq);
    return;
  }
  // Have a selection: clicking another own piece re-selects (handy when user
  // changes mind); otherwise attempt the move.
  if (isFriendlyPiece(piece, sideToMove)) {
    selectSquare(sq);
    return;
  }
  tryAddMove(EDITOR.selectedSquare, sq);
}

function clearSelection() {
  EDITOR.selectedSquare = null;
  EDITOR.legalTargets = [];
}

// Show selection immediately, then async-fetch legal destinations and redraw
// when they arrive. Two refreshActive() calls so the halo doesn't visibly lag
// the click — destination dots can pop in a frame later, which is fine.
async function selectSquare(sq) {
  EDITOR.selectedSquare = sq;
  EDITOR.legalTargets = [];
  refreshActive();
  const fen = currentFen();
  const reqSquare = sq;   // capture for the race-check below
  try {
    const r = await fetch("/api/xqf/legal-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fen, from: sq }),
    });
    const resp = await r.json();
    if (resp.error || !resp.targets) return;
    // Race guard: if the user clicked a different square (or deselected)
    // while we were awaiting, drop the stale response.
    if (EDITOR.selectedSquare !== reqSquare) return;
    EDITOR.legalTargets = resp.targets;
    refreshActive();
  } catch (_) { /* network glitch — leave dots empty, click-to-move still works */ }
}

async function tryAddMove(fromSq, toSq) {
  const iccs = fromSq + toSq;
  const fen = currentFen();
  setStatus("驗證走法…");
  try {
    const r = await fetch("/api/xqf/move-info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fen, iccs }),
    });
    const resp = await r.json();
    if (resp.error) { setStatus(resp.error, "err"); return; }
    const outcome = await insertMoveAt(EDITOR.activePath, {
      iccs,
      notation: resp.notation,
      side: resp.side,
      ply: EDITOR.activePath.length + 1,
      annote: "",
      children: [],
    });
    if (outcome === "added")        setStatus(`已新增 ${resp.notation}`, "ok");
    else if (outcome === "existing") setStatus(`已切換至 ${resp.notation}`, "ok");
    else                             setStatus("");  // cancelled
  } catch (e) {
    setStatus("新增失敗：" + e.message, "err");
  }
}

// Count moves under `node` (excluding `node` itself). Used by the delete
// confirmation prompt: any descendants → user must explicitly approve.
function countDescendants(node) {
  let n = 0;
  const stack = [...(node.children || [])];
  while (stack.length) {
    const cur = stack.pop();
    n++;
    if (cur.children) stack.push(...cur.children);
  }
  return n;
}

// Delete the node at EDITOR.activePath (i.e. the currently-active move).
// To delete a non-active sibling variation, navigate to it first via the
// 本步可選 picker, then call this. The initial position (activePath = [])
// can't be deleted — there's no node there. Confirms before destroying any
// subtree (one or more descendant moves).
async function deleteCurrentMove() {
  if (!EDITOR.data || EDITOR.activePath.length === 0) return;
  const node = nodeAt(EDITOR.activePath);
  if (!node) return;
  const label = node.notation || node.iccs;
  const desc = countDescendants(node);
  const prompt = desc > 0
    ? `『${label}』之後還有 ${desc} 步走法／分支，全部一併刪除？`
    : `確定刪除『${label}』？`;
  const ok = await showConfirmDialog(prompt, "刪除走法");
  if (!ok) return;

  const parentPath = EDITOR.activePath.slice(0, -1);
  const idx = EDITOR.activePath[EDITOR.activePath.length - 1];
  const siblings = parentPath.length === 0
    ? EDITOR.data.roots
    : (nodeAt(parentPath).children || []);
  siblings.splice(idx, 1);

  clearSelection();
  EDITOR.activePath = parentPath;
  refreshActive();
  setStatus(`已刪除 ${label}` + (desc > 0 ? `（連同 ${desc} 步）` : ""), "ok");
}

// Promote a sibling at `parentPath.children[siblingIdx]` to be the new main
// line (children[0]). Implementation: swap siblings[0] with siblings[siblingIdx]
// and patch EDITOR.activePath if it currently traverses one of the two.
//
// parentPath = [] means root-level siblings live in EDITOR.data.roots.
// Subtrees move atomically with their sibling — no re-indexing of descendants.
function promoteToMain(parentPath, siblingIdx) {
  if (siblingIdx === 0) return;  // already main line
  const siblings = parentPath.length === 0
    ? (EDITOR.data ? EDITOR.data.roots : null)
    : (nodeAt(parentPath)?.children || null);
  if (!siblings || siblingIdx >= siblings.length) return;

  const tmp = siblings[0];
  siblings[0] = siblings[siblingIdx];
  siblings[siblingIdx] = tmp;

  // If the active path passes through one of the two swapped siblings at the
  // ply right after parentPath, follow the swap so the user stays on the same
  // physical line.
  if (EDITOR.activePath.length > parentPath.length) {
    const depthIdx = EDITOR.activePath[parentPath.length];
    if (depthIdx === 0)             EDITOR.activePath[parentPath.length] = siblingIdx;
    else if (depthIdx === siblingIdx) EDITOR.activePath[parentPath.length] = 0;
  }
  const promotedLabel = siblings[0].notation || siblings[0].iccs;
  refreshActive();
  setStatus(`已升『${promotedLabel}』為主線`, "ok");
}

// Insert a freshly-built node as a child of the node at `parentPath`.
//   - If an existing child already has this iccs, navigate to it (no dup,
//     no confirm — re-selecting an existing variation is not destructive)
//   - If `parentPath` already has children of different iccs, this insert
//     creates a new variation branch — pop a confirm dialog first
//   - Otherwise (parent was a leaf) just extend the line, no confirm
//
// children[0] is the main continuation; pushing later entries makes the new
// move a sibling variation. Matches XQStudio behaviour and the JSON shape
// documented in xqf_service.py.
// Returns: "added" | "existing" | "cancelled"
async function insertMoveAt(parentPath, newNode) {
  let siblings;
  if (parentPath.length === 0) {
    if (!EDITOR.data.roots) EDITOR.data.roots = [];
    siblings = EDITOR.data.roots;
  } else {
    const parent = nodeAt(parentPath);
    if (!parent) return "cancelled";
    if (!parent.children) parent.children = [];
    siblings = parent.children;
  }
  const existing = siblings.findIndex((n) => n.iccs === newNode.iccs);
  if (existing >= 0) {
    clearSelection();
    navigateTo(parentPath.concat([existing]));
    return "existing";
  }
  if (siblings.length > 0) {
    const existingLabels = siblings.map((c) => c.notation || c.iccs).join("、");
    const newLabel = newNode.notation || newNode.iccs;
    const ok = await showConfirmDialog(
      `此步已有續著：${existingLabels}\n新增『${newLabel}』為分支走法？`,
      "新增分支",
    );
    if (!ok) { clearSelection(); refreshActive(); return "cancelled"; }
  }
  clearSelection();
  siblings.push(newNode);
  navigateTo(parentPath.concat([siblings.length - 1]));
  return "added";
}

// ---------- file tree ----------

async function loadFileTree() {
  const r = await fetch("/api/xqf/list");
  const tree = await r.json();
  if (tree.root) updateRootDisplay(tree.root);
  if (tree.error) { $("#fileTree").textContent = "錯誤：" + tree.error; return; }
  $("#fileTree").innerHTML = "";
  $("#fileTree").appendChild(renderDir(tree));
  // Tree loaded → user can create a new file under it.
  const newBtn = $("#newXqfBtn");
  if (newBtn) newBtn.disabled = false;
}

function updateRootDisplay(root) {
  const el = $("#rootPathDisplay");
  if (!el) return;
  el.textContent = "📂 " + root;
  el.title = root;
}

// ---------- root directory picker ----------
// Native Windows folder dialog via /api/xqf/pick-root (tkinter subprocess).
// On selection: POST the path to /api/xqf/root, then reload the file tree.

async function pickRoot() {
  const btn = $("#rootPickBtn");
  btn.disabled = true;
  setStatus("選擇目錄中…");
  try {
    const r = await fetch("/api/xqf/pick-root", { method: "POST" });
    const resp = await r.json();
    if (resp.error) { setStatus("選擇失敗：" + resp.error, "err"); return; }
    if (!resp.ok || !resp.path) { setStatus(""); return; }   // cancelled
    await applyRoot(resp.path);
  } catch (e) {
    setStatus("選擇失敗：" + e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function applyRoot(path) {
  setStatus("套用中…");
  const r = await fetch("/api/xqf/root", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const resp = await r.json();
  if (resp.error) { setStatus("套用失敗：" + resp.error, "err"); return; }
  // Root changed: lastFile was cleared server-side, drop in-memory state too
  // so we don't try to save back to a now-orphan rel path.
  EDITOR.currentPath = null;
  EDITOR.data = null;
  EDITOR.activePath = [];
  clearSelection();
  $("#saveBtn").disabled = true;
  $("#metaBtn").disabled = true;
  $("#fileTitle").textContent = "尚未載入";
  $("#moveList").innerHTML = "";
  $("#annoteBox").value = "";
  $("#annoteBox").disabled = true;
  $("#moveInfo").textContent = "";
  await loadFileTree();
  setStatus("已切換目錄", "ok");
}

function renderDir(node) {
  const ul = document.createElement("ul");
  for (const child of node.children || []) {
    const li = document.createElement("li");
    if (child.type === "dir") {
      li.className = "dir";
      const span = document.createElement("span");
      span.className = "dirname";
      span.textContent = "📁 " + child.name;
      li.appendChild(span);
      const sub = renderDir(child);
      sub.style.display = "none";
      span.onclick = () => { sub.style.display = sub.style.display === "none" ? "" : "none"; };
      li.appendChild(sub);
    } else {
      li.className = "file";
      li.textContent = child.name;
      li.dataset.rel = child.rel;
      li.onclick = () => selectFile(child.rel, li);
    }
    ul.appendChild(li);
  }
  return ul;
}

async function selectFile(rel, liEl) {
  document.querySelectorAll("#fileTree li.file.active").forEach(el => el.classList.remove("active"));
  if (liEl) liEl.classList.add("active");
  setStatus("載入中…");
  try {
    const r = await fetch("/api/xqf/load?path=" + encodeURIComponent(rel));
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    EDITOR.currentPath = rel;
    EDITOR.data = data;
    EDITOR.activePath = [];
    clearSelection();
    const fileName = rel.split("/").pop();
    $("#fileTitle").textContent = fileName;
    $("#fileTitle").title = rel;  // full path on hover
    $("#saveBtn").disabled = false;
    $("#metaBtn").disabled = false;
    refreshActive();
    setStatus("已載入", "ok");
    // Remember for next session — boot() reopens this file automatically.
    savePreference("lastFile", rel);
    // Eval lookup is fire-and-forget: don't block file load on it. When it
    // resolves, re-render so #evalLine populates.
    fetchEvalsForFile().then(() => renderEvalLine());
  } catch (e) {
    setStatus("載入失敗：" + e.message, "err");
  }
}

// ---------- eval data (read-only from chess-book-ai's positions.db) ----------
// On boot we ping /api/eval/info to see if the DB is wired up. On every file
// load, we walk the whole tree, derive each node's pre-move FEN via applyIccs
// (same in-browser xiangqi mover board.js ships with), and POST one batch
// request. Results are stored fen-keyed so refreshActive() is sync — no
// per-navigation network roundtrip.

function collectAllFens() {
  // BFS over the whole tree, applying iccs from init_fen onward. Returns the
  // de-duplicated set of pre-move FENs reachable from any node. Init position
  // is included so we can look up the "before move 1" eval too.
  if (!EDITOR.data) return [];
  const seen = new Set();
  seen.add(EDITOR.data.init_fen);
  const stack = [{ fen: EDITOR.data.init_fen, children: EDITOR.data.roots || [] }];
  while (stack.length) {
    const { fen, children } = stack.pop();
    for (const node of children) {
      const next = applyIccs(fen, node.iccs);
      if (!seen.has(next)) {
        seen.add(next);
        stack.push({ fen: next, children: node.children || [] });
      }
    }
  }
  return [...seen];
}

async function fetchEvalDbInfo() {
  try {
    const r = await fetch("/api/eval/info");
    EDITOR.evalDbInfo = await r.json();
  } catch (_) {
    EDITOR.evalDbInfo = { exists: false };
  }
  renderEvalDbRow();
}

// Render the small DB-path chip above #evalLine. Shows the DB filename + a
// short total-positions / cdb-count summary in the visible row, with the
// full path + per-depth breakdown in the hover title so the chip never
// outgrows the 568px boardPane.
function renderEvalDbRow() {
  const pathEl = $("#evalDbPath");
  const row = pathEl ? pathEl.parentElement : null;
  if (!pathEl || !row) return;
  const info = EDITOR.evalDbInfo || {};
  const p = info.path || "";
  if (!info.exists) {
    row.classList.add("warn");
    pathEl.textContent = "📊 評估資料庫未連線（點 📁 選擇）";
    pathEl.title = p || "尚未設定資料庫位置";
    return;
  }
  row.classList.remove("warn");
  const byDepth = info.evals_by_depth || {};
  const totalEvals = Object.values(byDepth).reduce((a, b) => a + b, 0);
  const cdb = info.chessdb_rows || 0;
  // Visible line — filename, total positions, cdb count. Compact.
  const fname = p.split(/[\\/]/).pop() || p;
  const cdbCell = cdb ? `  ·  雲庫 ${cdb.toLocaleString()}` : "";
  pathEl.textContent = `📊 ${fname}  ·  ${totalEvals.toLocaleString()} 局面${cdbCell}`;
  // Tooltip — full path + per-depth breakdown so power users still see it.
  const depthDetail = Object.keys(byDepth)
    .sort((a, b) => Number(a) - Number(b))
    .map(d => `d${d}: ${byDepth[d].toLocaleString()}`)
    .join("　");
  pathEl.title = `${p}\n${depthDetail}`;
}

// Native file picker for evalDb. POSTs the chosen path, refreshes the row
// + the per-file eval cache, re-renders the strip for the active ply.
async function pickEvalDb() {
  const btn = $("#evalDbPickBtn");
  if (btn) btn.disabled = true;
  setStatus("選擇評估資料庫…");
  try {
    const r = await fetch("/api/eval/pick-db", { method: "POST" });
    const resp = await r.json();
    if (resp.error) { setStatus("選擇失敗：" + resp.error, "err"); return; }
    if (!resp.ok) { setStatus(""); return; }  // user cancelled
    const set = await fetch("/api/eval/db", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: resp.path }),
    });
    const setResp = await set.json();
    if (setResp.error) { setStatus("設定失敗：" + setResp.error, "err"); return; }
    EDITOR.evalDbInfo = setResp.info || { exists: true, path: setResp.path };
    EDITOR.evalDbInfo.path = setResp.path;
    renderEvalDbRow();
    await fetchEvalsForFile();
    renderEvalLine();
    renderMoveList();   // trap / brilliant markers re-evaluate against the new DB
    setStatus("已更新評估資料庫", "ok");
  } catch (e) {
    setStatus("選擇失敗：" + e.message, "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---- Pikafish engine config chip (live-analysis source, not persisted) ----
async function fetchEngineInfo() {
  try {
    const r = await fetch("/api/engine/info");
    EDITOR.engineInfo = await r.json();
  } catch (_) {
    EDITOR.engineInfo = { exists: false };
  }
  renderEngineRow();
}

// Render the 🐟 engine chip below the eval-DB chip. Shows the engine's UCI
// id-name when the handshake succeeded, else the filename + a warning state.
function renderEngineRow() {
  const pathEl = $("#enginePath");
  const row = pathEl ? pathEl.parentElement : null;
  if (!pathEl || !row) return;
  const info = EDITOR.engineInfo || {};
  const p = info.path || "";
  if (!info.exists) {
    row.classList.add("warn");
    pathEl.textContent = "🐟 皮卡魚引擎未設定（點 📁 選擇）";
    pathEl.title = p || "尚未設定引擎位置";
    return;
  }
  const fname = p.split(/[\\/]/).pop() || p;
  if (!info.ok) {
    row.classList.add("warn");
    pathEl.textContent = `🐟 ${fname}（無法握手）`;
    pathEl.title = `${p}\n${info.error || "未回應 uciok"}`;
    return;
  }
  row.classList.remove("warn");
  pathEl.textContent = `🐟 ${info.name || fname}`;
  pathEl.title = `${p}\n${info.name || ""}`.trim();
}

// Native file picker for the Pikafish executable. POSTs the chosen path,
// which is validated via a UCI handshake server-side before persisting.
async function pickEngine() {
  const btn = $("#enginePickBtn");
  if (btn) btn.disabled = true;
  setStatus("選擇皮卡魚引擎…");
  try {
    const r = await fetch("/api/engine/pick", { method: "POST" });
    const resp = await r.json();
    if (resp.error) { setStatus("選擇失敗：" + resp.error, "err"); return; }
    if (!resp.ok) { setStatus(""); return; }  // user cancelled
    const set = await fetch("/api/engine/path", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: resp.path }),
    });
    const setResp = await set.json();
    if (setResp.error) { setStatus("設定失敗：" + setResp.error, "err"); return; }
    EDITOR.engineInfo = setResp.info || { exists: true, ok: true, path: setResp.path };
    renderEngineRow();
    setStatus("已更新皮卡魚引擎", "ok");
  } catch (e) {
    setStatus("選擇失敗：" + e.message, "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function fetchEvalsForFile() {
  EDITOR.evalsByFen = {};
  if (!EDITOR.data || !EDITOR.evalDbInfo || !EDITOR.evalDbInfo.exists) return;
  const fens = collectAllFens();
  if (fens.length === 0) return;
  try {
    const r = await fetch("/api/eval/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fens }),
    });
    const body = await r.json();
    EDITOR.evalsByFen = body.evals || {};
  } catch (_) {
    EDITOR.evalsByFen = {};
  }
}

// Format DB eval for UI in fixed red POV.
// positions.db stores mover-POV values in centipawns; this editor treats
// 100 = 1 兵, so we display the integer cp-like value directly as "分".
function fmtEvalScore(entry, fen) {
  if (!entry) return "—";
  const side = (fen && fen.trim().split(/\s+/)[1]) || "w";
  const flip = side === "b" ? -1 : 1;
  if (entry.mate != null) {
    const m = Number(entry.mate);
    if (!Number.isFinite(m)) return "—";
    const redMate = m * flip;
    return redMate > 0 ? `#+${Math.abs(redMate)}` : `#-${Math.abs(redMate)}`;
  }
  if (entry.score == null) return "—";
  const cp = Number(entry.score);
  if (!Number.isFinite(cp)) return "—";
  const redScore = Math.round(cp * flip);
  const sign = redScore > 0 ? "+" : "";
  return `${sign}${redScore}`;
}

// Translate a single ICCS move under `fen` to traditional Chinese via the
// existing /api/xqf/move-info endpoint, lightly cached. We use this to label
// the engine's best move (e.g. "車１平６ (a7f7)") without hard-coding any
// xiangqi notation rules in the browser.
const NOTATION_CACHE = new Map();
async function notationFor(fen, iccs) {
  const k = fen + "|" + iccs;
  if (NOTATION_CACHE.has(k)) return NOTATION_CACHE.get(k);
  try {
    const r = await fetch("/api/xqf/move-info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fen, iccs }),
    });
    const body = await r.json();
    const out = body.ok ? body.notation : null;
    NOTATION_CACHE.set(k, out);
    return out;
  } catch (_) {
    NOTATION_CACHE.set(k, null);
    return null;
  }
}

async function renderEvalLine() {
  // Analysis is position-specific: if the board moved, drop the stale stream.
  const ea = EDITOR.engineAnalysis;
  if (ea.running && ea.fen && ea.fen !== analysisFen()) {
    stopAnalysis("局面已變，請重新分析");
  }
  const el = $("#evalLine");
  if (!el) return;
  el.innerHTML = "";
  if (!EDITOR.data) return;
  if (!EDITOR.evalDbInfo || !EDITOR.evalDbInfo.exists) {
    el.innerHTML = `<span class="evalNote">引擎資料未連線</span>`;
    return;
  }
  const fen = currentFen();
  const entry = EDITOR.evalsByFen[fen];
  if (!entry || Object.keys(entry).length === 0) {
    el.innerHTML = `<span class="evalNote">此局面未分析</span>`;
    return;
  }

  const cells = [];
  for (const d of [12, 22, 28, 32]) {
    const e = entry[`d${d}`];
    if (!e) continue;
    const suffix = (e.mate == null) ? `<span class="evalLabel"> 分</span>` : "";
    cells.push(`<span class="evalCell"><span class="evalLabel">深${d}</span> <span class="evalScore">${fmtEvalScore(e, fen)}</span>${suffix}</span>`);
  }
  // Prefer deepest available eval's best move for the suggestion line.
  const deepest = entry.d32 || entry.d28 || entry.d22 || entry.d12;
  const bestIccs = deepest && deepest.best_iccs;
  let bestHtml = "";
  if (bestIccs) {
    bestHtml = `<span class="evalCell evalBest"><span class="evalLabel">建議</span> <span class="evalMove" data-iccs="${bestIccs}">${bestIccs}</span></span>`;
  }
  if (entry.cdb && entry.cdb.best) {
    const b = entry.cdb.best;
    const wr = b.winrate != null ? `${b.winrate.toFixed(1)}%` : "—";
    cells.push(`<span class="evalCell evalCdb"><span class="evalLabel">雲</span> ${b.iccs} (${wr})</span>`);
  }
  el.innerHTML = cells.join("") + bestHtml;

  // Async: replace bestIccs with its traditional-Chinese notation when ready.
  if (bestIccs) {
    notationFor(fen, bestIccs).then((notation) => {
      const span = el.querySelector(`.evalMove[data-iccs="${bestIccs}"]`);
      if (span && notation) span.textContent = `${notation} (${bestIccs})`;
    });
  }
}

// ---------- 棋譜 (move list) — XQStudio style: linearised current path ----------

function currentLine() {
  if (!EDITOR.data) return [];
  const out = [];
  let nodes = EDITOR.data.roots || [];
  const pathSoFar = [];
  let ply = 1;
  // Track pre-move FEN as we walk so each ply item carries it. Required for
  // computing per-ply loss against the eval DB without re-walking later.
  let fen = EDITOR.data.init_fen;
  for (const idx of EDITOR.activePath) {
    const node = nodes[idx];
    if (!node) break;
    pathSoFar.push(idx);
    out.push({ node, path: pathSoFar.slice(), ply, fen, hasSiblings: nodes.length > 1 });
    fen = applyIccs(fen, node.iccs);
    nodes = node.children || [];
    ply++;
  }
  while (nodes.length > 0) {
    const node = nodes[0];
    pathSoFar.push(0);
    out.push({ node, path: pathSoFar.slice(), ply, fen, hasSiblings: nodes.length > 1 });
    fen = applyIccs(fen, node.iccs);
    nodes = node.children || [];
    ply++;
  }
  return out;
}

// ---------- per-ply loss + trap/brilliant detection ----------
// Mirrors chess-book-ai's site_builder/render_site.py:
//   _ply_loss(fen_before, fen_after) = score_cp(before) + score_cp(after)
// Both POV-relative — that's why the SUM (not the diff) gives the mover-cp loss.
// Thresholds and SKIP_OPENING_PLIES must stay in sync with render_site.py.

const SKIP_OPENING_PLIES = 15;     // skip plies 1..15; trap/brilliant from ply 16
const TRAP_SHALLOW_MAX  = 50;      // shallow says "fine"
const TRAP_DEEP_MIN     = 100;     // deep says "blunder"
const TRAP_DEEP_MAX     = 2000;    // sanity cap
const BRILLIANT_MIN     = 50;
const BRILLIANT_MAX     = 300;

function scoreCp(e) {
  if (!e) return null;
  if (e.mate != null) {
    const m = e.mate;
    return m > 0 ? 30000 - Math.abs(m) : -(30000 - Math.abs(m));
  }
  return typeof e.score === "number" ? e.score : null;
}

function plyLossAt(items, i, depthKey) {
  // Loss the mover at items[i] took, measured at the given depth (e.g. "d22").
  if (i < 0 || i >= items.length - 1) return null;
  const a = EDITOR.evalsByFen[items[i].fen];
  const b = EDITOR.evalsByFen[items[i + 1].fen];
  if (!a || !b) return null;
  const sa = scoreCp(a[depthKey]);
  const sb = scoreCp(b[depthKey]);
  if (sa == null || sb == null) return null;
  return sa + sb;
}

// Classify a ply: returns "trap" | "brilliant" | null. Mirrors render_site.py's
// compute_game_stats (trap, with d22 + d28 rules) and _compute_brilliants.
function plyVerdict(items, i) {
  if (items[i].ply <= SKIP_OPENING_PLIES) return null;
  const sLoss = plyLossAt(items, i, "d12");
  const dLoss = plyLossAt(items, i, "d22");
  const vdLoss = plyLossAt(items, i, "d28");

  // Trap rule A: shallow says fine, d22 says blunder.
  const trapA = (sLoss != null && sLoss < TRAP_SHALLOW_MAX
                 && dLoss != null && dLoss > TRAP_DEEP_MIN && dLoss < TRAP_DEEP_MAX);
  // Trap rule B: shallow says fine, d22 missed it, d28 catches it.
  const trapB = (!trapA
                 && sLoss != null && sLoss < TRAP_SHALLOW_MAX
                 && vdLoss != null && vdLoss > TRAP_DEEP_MIN && vdLoss < TRAP_DEEP_MAX);
  if (trapA || trapB) {
    return { kind: "trap", sLoss, dLoss, vdLoss, source: trapA ? "d22" : "d28" };
  }
  // Brilliant: deep says mover GAINED 50-300 cp (i.e. negative loss in band).
  if (dLoss != null) {
    const gain = -dLoss;
    if (gain >= BRILLIANT_MIN && gain <= BRILLIANT_MAX) {
      return { kind: "brilliant", gain, sLoss, dLoss, vdLoss };
    }
  }
  return null;
}

function renderMoveList() {
  const list = $("#moveList");
  list.innerHTML = "";
  // No "（開局）" pseudo-row — master prefers a clean numbered list. To get
  // back to the initial position, use |◀ button or Home key.
  const items = currentLine();
  items.forEach((item, i) => {
    list.appendChild(renderPlyRow(item, plyVerdict(items, i)));
  });
}

function renderPlyRow(item, verdict) {
  const { node, path, ply, hasSiblings } = item;
  const isFirstOfPair = (ply % 2 === 1);
  const pairNo = Math.ceil(ply / 2);

  const row = document.createElement("div");
  row.className = "plyLine" + (isFirstOfPair ? "" : " black");
  if (verdict) row.classList.add("ply-" + verdict.kind);
  row.dataset.pathkey = path.join("/");

  const numEl = document.createElement("span");
  numEl.className = "plyNum";
  numEl.textContent = isFirstOfPair ? (pairNo + ".") : "";
  row.appendChild(numEl);

  const txtEl = document.createElement("span");
  txtEl.className = "plyText";
  txtEl.textContent = node.notation || node.iccs;
  row.appendChild(txtEl);

  if (verdict) {
    const v = document.createElement("span");
    v.className = "plyMark plyMark-" + verdict.kind;
    if (verdict.kind === "trap") {
      v.textContent = "⚠";
      const parts = [`陷阱（${verdict.source}）`];
      if (verdict.sLoss != null) parts.push(`淺失分 ${verdict.sLoss}`);
      if (verdict.dLoss != null) parts.push(`深失分 ${verdict.dLoss}`);
      if (verdict.vdLoss != null) parts.push(`d28 失分 ${verdict.vdLoss}`);
      v.title = parts.join(" · ");
    } else {
      v.textContent = "✨";
      v.title = `妙手 · 深算多賺 ${verdict.gain} cp`;
    }
    row.appendChild(v);
  }
  if (hasSiblings) {
    const m = document.createElement("span");
    m.className = "plyMark";
    m.textContent = "分支";
    m.title = "本步有其他走法";
    row.appendChild(m);
  }
  if (node.annote) {
    const a = document.createElement("span");
    a.className = "plyMark";
    a.title = node.annote;
    a.textContent = "注解";
    row.appendChild(a);
  }
  row.onclick = () => navigateTo(path);
  return row;
}

// ---------- navigation ----------

function navigateTo(path) {
  // Before navigating away, ensure any pending annote edit is committed.
  commitAnnoteEdit();
  EDITOR.activePath = path;
  clearSelection();
  refreshActive();
}

function refreshActive() {
  const path = EDITOR.activePath;
  const { fen, lastIccs } = fenAndLastIccsFor(path);
  // board.js drawBoard signature: drawBoard(svg, fen, bookMove, engineMove)
  drawBoard($("#board"), fen, lastIccs, null);
  installBoardOverlay($("#board"));   // click rects + selection halo on top

  renderMoveList();

  document.querySelectorAll("#moveList .plyLine.active").forEach(el => el.classList.remove("active"));
  const key = path.length === 0 ? "init" : path.join("/");
  const row = document.querySelector(`#moveList .plyLine[data-pathkey="${key}"]`);
  if (row) {
    row.classList.add("active");
    row.scrollIntoView({ block: "nearest" });
  }

  const node = nodeAt(path);
  const annoteBox = $("#annoteBox");
  if (node) {
    annoteBox.value = node.annote || "";
    annoteBox.disabled = false;
  } else {
    // Initial position — annote box shows the book-level intro (譜首引言).
    annoteBox.value = (EDITOR.data && EDITOR.data.init_annote) || "";
    annoteBox.disabled = !EDITOR.data;  // editable when a file is loaded
  }

  renderVarPicker();

  if (node) {
    $("#moveInfo").textContent = `第 ${node.ply} 步：${node.notation}（${node.iccs}）`;
  } else {
    $("#moveInfo").textContent = "初始局面";
  }

  $("#navFirst").disabled  = path.length === 0;
  $("#navPrev").disabled   = path.length === 0;
  $("#navBranch").disabled = path.length === 0;
  $("#navDelete").disabled = path.length === 0;
  const next = node ? (node.children || [])[0] : (EDITOR.data && EDITOR.data.roots && EDITOR.data.roots[0]);
  $("#navNext").disabled = !next;
  $("#navLast").disabled = !next;

  renderEvalLine();
}

function renderVarPicker() {
  const path = EDITOR.activePath;
  const picker = $("#varPicker");
  picker.innerHTML = "";
  let opts, activeIdx;
  if (path.length === 0) {
    opts = EDITOR.data.roots || [];
    activeIdx = -1;
  } else {
    opts = siblingsAt(path);
    activeIdx = path[path.length - 1];
  }
  if (opts.length <= 1) {
    picker.innerHTML = `<div class="varEmpty">此步無其他分支</div>`;
    return;
  }
  const letters = "ABCDEFGHIJKLMN";
  const parentPath = path.length === 0 ? [] : path.slice(0, -1);
  opts.forEach((opt, i) => {
    const row = document.createElement("div");
    row.className = "varOpt"
      + (i === activeIdx ? " active" : "")
      + (i === 0 ? " mainLine" : "");
    const L = document.createElement("span");
    L.className = "varLetter";
    L.textContent = letters[i] + ".";
    row.appendChild(L);
    const t = document.createElement("span");
    t.textContent = `${opt.notation}　(${opt.iccs})`;
    row.appendChild(t);
    if (i === activeIdx) {
      const arrow = document.createElement("span");
      arrow.className = "varArrow";
      arrow.textContent = "←";
      row.appendChild(arrow);
    } else if (i !== 0) {
      // Non-main-line, non-active row: offer "升主線".
      const btn = document.createElement("button");
      btn.className = "varPromote";
      btn.type = "button";
      btn.textContent = "升主線";
      btn.title = "把此變例升為主線（與主線交換位置）";
      btn.onclick = (e) => {
        e.stopPropagation();  // don't also navigate
        promoteToMain(parentPath, i);
      };
      row.appendChild(btn);
    }
    row.onclick = () => {
      const newPath = path.length === 0 ? [i] : path.slice(0, -1).concat([i]);
      navigateTo(newPath);
    };
    picker.appendChild(row);
  });
}

// ---------- annote editing ----------
// The textarea is wired to the active node. Edits are buffered locally and
// pushed into EDITOR.data on input — the next /api/xqf/save POST carries them.

function commitAnnoteEdit() {
  const newVal = $("#annoteBox").value;
  const node = nodeAt(EDITOR.activePath);
  if (node) {
    if (node.annote !== newVal) node.annote = newVal;
    return;
  }
  // Initial position — edits go to the book-level intro.
  if (EDITOR.data && (EDITOR.data.init_annote || "") !== newVal) {
    EDITOR.data.init_annote = newVal;
  }
}

// ---------- metadata edit modal ----------
// Fields map directly to XQF header slots (see cchess.io_xqf.XQFWriter
// __init__: title/event/date/location/red_player/black_player/commentator are
// fixed-length GB18030 strings; result is a 1-byte enum we map server-side).
// Editing applies straight into EDITOR.data.info; the next save POST carries
// the new values, and backend xqf_service.save_xqf writes both the string
// fields (via PatchedXQFWriter's parent __init__) and the result byte.
const META_FIELDS = [
  "title", "event", "date", "location",
  "red_player", "black_player", "commentator", "result",
];

function openMetaModal() {
  if (!EDITOR.data) return;
  const info = EDITOR.data.info || {};
  for (const k of META_FIELDS) {
    const el = $("#metaField-" + k);
    if (!el) continue;
    el.value = info[k] != null ? String(info[k]) : (k === "result" ? "*" : "");
  }
  $("#metaModal").hidden = false;
  // Focus title for immediate keyboard input.
  const first = $("#metaField-title");
  if (first) first.focus();
}

function closeMetaModal() {
  $("#metaModal").hidden = true;
}

function applyMetaEdits() {
  if (!EDITOR.data) { closeMetaModal(); return; }
  if (!EDITOR.data.info) EDITOR.data.info = {};
  const info = EDITOR.data.info;
  let changed = false;
  for (const k of META_FIELDS) {
    const el = $("#metaField-" + k);
    if (!el) continue;
    const newVal = el.value;
    const oldVal = info[k] != null ? String(info[k]) : "";
    if (newVal !== oldVal) {
      info[k] = newVal;
      changed = true;
    }
  }
  closeMetaModal();
  if (changed) setStatus("資訊已更新（記得存檔）", "ok");
}

// ---------- new-XQF dialog ----------
// Opens an empty XQF at <root>[/subdir]/<filename>. Backend sanitises the
// filename and refuses to overwrite an existing file (409).

function openNewModal() {
  // Pre-fill subdir with the parent folder of the currently-open file, so
  // master typically just types a title and presses 建立.
  const cur = EDITOR.currentPath || "";
  const lastSlash = cur.lastIndexOf("/");
  const defaultSubdir = lastSlash > 0 ? cur.slice(0, lastSlash) : "";
  $("#newField-title").value = "";
  $("#newField-subdir").value = defaultSubdir;
  $("#newField-filename").value = "";
  $("#newModal").hidden = false;
  $("#newField-title").focus();
}

function closeNewModal() {
  $("#newModal").hidden = true;
}

async function submitNewXqf() {
  const title = $("#newField-title").value.trim();
  if (!title) {
    setStatus("標題不可為空", "err");
    $("#newField-title").focus();
    return;
  }
  const body = {
    title,
    subdir: $("#newField-subdir").value.trim(),
    filename: $("#newField-filename").value.trim(),
  };
  setStatus("建立中…");
  try {
    const r = await fetch("/api/xqf/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const resp = await r.json();
    if (!r.ok || resp.error) {
      setStatus(resp.error || "建立失敗", "err");
      return;
    }
    closeNewModal();
    // Refresh tree, then open the new file the same way auto-open does.
    await loadFileTree();
    const newLi = Array.from(document.querySelectorAll("#fileTree li.file"))
      .find((li) => li.dataset.rel === resp.path);
    // Expand ancestor <ul>s so the new file is visible.
    if (newLi) {
      let el = newLi.parentElement;
      const treeRoot = document.getElementById("fileTree");
      while (el && el !== treeRoot) {
        if (el.tagName === "UL") el.style.display = "";
        el = el.parentElement;
      }
      newLi.scrollIntoView({ block: "nearest" });
    }
    await selectFile(resp.path, newLi || null);
    setStatus(`已建立 ${resp.path}`, "ok");
  } catch (e) {
    setStatus("建立失敗：" + e.message, "err");
  }
}

// ---------- nav button handlers ----------

function navFirst() { navigateTo([]); }
function navPrev() {
  if (EDITOR.activePath.length === 0) return;
  navigateTo(EDITOR.activePath.slice(0, -1));
}
function navNext() {
  const node = nodeAt(EDITOR.activePath);
  if (EDITOR.activePath.length === 0) {
    if (EDITOR.data && (EDITOR.data.roots || []).length) navigateTo([0]);
    return;
  }
  if (node && (node.children || []).length) {
    navigateTo(EDITOR.activePath.concat([0]));
  }
}
function navLast() {
  let path = EDITOR.activePath.slice();
  let node = nodeAt(path);
  if (path.length === 0) {
    if (!EDITOR.data || !(EDITOR.data.roots || []).length) return;
    path = [0];
    node = EDITOR.data.roots[0];
  }
  while (node && (node.children || []).length) {
    path.push(0);
    node = node.children[0];
  }
  navigateTo(path);
}

// Walk the active path from end to start; find the deepest ply that was a
// branch CHOICE (a node with siblings), then navigate to its PARENT — i.e.
// one level above the branching ply. From there next-step takes you forward
// to the branching ply itself, where 本步可選 lets you switch variations.
//
// Example: active = 車3進5 (which has sibling 車3退1). Parent is 砲八平六.
// Pressing 分支 lands on 砲八平六; pressing again walks back to the next
// earlier branch parent (or to init if none).
function navToNearestBranch() {
  if (!EDITOR.data || EDITOR.activePath.length === 0) return;
  for (let i = EDITOR.activePath.length; i >= 1; i--) {
    const partial = EDITOR.activePath.slice(0, i);
    if (siblingsAt(partial).length > 1) {
      // partial points at the branch choice; partial[:-1] is its parent.
      // If partial.length === 1 (root-level alternative), partial[:-1] = []
      // i.e. initial position — also correct.
      navigateTo(partial.slice(0, -1));
      return;
    }
  }
  navigateTo([]);
}

function navVarUp() {
  const path = EDITOR.activePath;
  const sibs = path.length === 0 ? (EDITOR.data ? EDITOR.data.roots : []) : siblingsAt(path);
  if (sibs.length <= 1) return;
  const curIdx = path.length === 0 ? -1 : path[path.length - 1];
  const newIdx = curIdx <= 0 ? sibs.length - 1 : curIdx - 1;
  const newPath = path.length === 0 ? [newIdx] : path.slice(0, -1).concat([newIdx]);
  navigateTo(newPath);
}
function navVarDown() {
  const path = EDITOR.activePath;
  const sibs = path.length === 0 ? (EDITOR.data ? EDITOR.data.roots : []) : siblingsAt(path);
  if (sibs.length <= 1) return;
  const curIdx = path.length === 0 ? -1 : path[path.length - 1];
  const newIdx = (curIdx + 1) % sibs.length;
  const newPath = path.length === 0 ? [newIdx] : path.slice(0, -1).concat([newIdx]);
  navigateTo(newPath);
}

// ---------- save ----------

async function save() {
  if (!EDITOR.data || !EDITOR.currentPath) return;
  commitAnnoteEdit();
  setStatus("儲存中…");
  try {
    const body = { ...EDITOR.data, path: EDITOR.currentPath };
    const r = await fetch("/api/xqf/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const resp = await r.json();
    if (resp.error) throw new Error(resp.error);
    setStatus("已儲存", "ok");
  } catch (e) {
    setStatus("儲存失敗：" + e.message, "err");
  }
}

// ---------- board theme picker ----------

function applyBoardTheme(name) {
  document.documentElement.dataset.board = name;
  if (EDITOR.data) refreshActive();  // re-render board with new style
  savePreference("boardTheme", name);
}

function applyBoardPerspective(name) {
  const isRed = name !== "black";
  const checkbox = document.getElementById("redPerspective");
  if (checkbox) checkbox.checked = isRed;
  if (EDITOR.data) refreshActive();
  savePreference("boardPerspective", isRed ? "red" : "black");
}

function applyUiTheme(name) {
  const theme = UI_THEMES[name] ? name : "ember";
  document.documentElement.dataset.uiTheme = theme;
  savePreference("uiTheme", theme);
}

function ensureUiThemePicker() {
  const actions = document.querySelector("header .actions");
  if (!actions || document.getElementById("uiThemeSel")) return;

  const label = document.createElement("label");
  label.className = "boardThemePicker uiThemePicker";
  label.append("介面");

  const select = document.createElement("select");
  select.id = "uiThemeSel";
  for (const [value, text] of Object.entries(UI_THEMES)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.appendChild(option);
  }
  label.appendChild(select);

  const boardPicker = document.getElementById("boardThemeSel")?.closest("label");
  if (boardPicker && boardPicker.nextSibling) actions.insertBefore(label, boardPicker.nextSibling);
  else actions.prepend(label);

  select.addEventListener("change", () => applyUiTheme(select.value));
}

// ---------- keyboard ----------

window.addEventListener("keydown", (e) => {
  // Esc closes any open modal from anywhere.
  if (e.key === "Escape") {
    if (!$("#settingsModal").hidden) { closeSettingsModal(); e.preventDefault(); return; }
    if (!$("#metaModal").hidden) { closeMetaModal(); e.preventDefault(); return; }
    if (!$("#newModal").hidden)  { closeNewModal();  e.preventDefault(); return; }
  }
  // Don't intercept other keys while typing in form controls
  // (textarea for annote, inputs in the metadata modal).
  const tag = document.activeElement ? document.activeElement.tagName : "";
  if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
  if (!EDITOR.data) return;
  switch (e.key) {
    case "ArrowLeft":  navPrev();    e.preventDefault(); break;
    case "ArrowRight": navNext();    e.preventDefault(); break;
    case "ArrowUp":    navVarUp();   e.preventDefault(); break;
    case "ArrowDown":  navVarDown(); e.preventDefault(); break;
    case "Home":       navFirst();          e.preventDefault(); break;
    case "End":        navLast();           e.preventDefault(); break;
    case "Delete":     deleteCurrentMove(); e.preventDefault(); break;
    case "b": case "B":
      if (!e.ctrlKey && !e.metaKey) { navToNearestBranch(); e.preventDefault(); }
      break;
    case "s": case "S":
      if (e.ctrlKey || e.metaKey) { save(); e.preventDefault(); }
      break;
  }
});

// ---------- right-column tabs + live Pikafish analysis ----------

function switchRpTab(tab) {
  document.querySelectorAll(".rpTab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  document.querySelectorAll(".rpTabBody").forEach((p) => {
    p.hidden = p.dataset.tab !== tab;
  });
}

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
  const entry = {
    depth: ev.depth, cp: ev.cp, mate: ev.mate, wdl: ev.wdl,
    time_ms: ev.time_ms, pv: ev.pv || [],
  };
  if (h.length && h[0].depth === entry.depth) h[0] = entry;
  else h.unshift(entry);
  renderEngineHistory();
}

function renderEngineHistory() {
  const box = $("#engineHistory");
  if (!box) return;
  const h = EDITOR.engineAnalysis.history;
  if (!h.length) { box.innerHTML = `<div class="varEmpty">尚無分析結果</div>`; return; }
  box.innerHTML = h.map((e) => {
    const t = e.time_ms ? (e.time_ms / 1000).toFixed(1) + "s" : "—";
    const pv = (e.pv || []).join("　");
    return `<div class="engEntry">`
      + `<div class="engMeta">`
      +   `<span>深度 <b class="engBig">${e.depth}</b></span>`
      +   `<span>紅分 <b class="engBig">${fmtEngineScore(e)}</b></span>`
      +   `<span>耗時 ${t}</span>`
      +   fmtWdlHtml(e.wdl)
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
  if (a.es) { try { a.es.close(); } catch (_) {} }
  a.es = null;
  a.running = false;
  a.fen = null;
  const btn = $("#engineToggleBtn");
  if (btn) btn.textContent = "▶ 開始分析";
  const st = $("#engineState");
  if (st && stateText != null) st.textContent = stateText;
}

function startAnalysis() {
  switchRpTab("engine");
  if (!EDITOR.engineInfo || !EDITOR.engineInfo.ok) {
    $("#engineState").textContent = "引擎未設定（請在檔案窗格選 🐟）";
    return;
  }
  const fen = analysisFen();
  if (!fen) { $("#engineState").textContent = "尚未載入棋譜"; return; }
  stopAnalysis(null);
  const a = EDITOR.engineAnalysis;
  a.fen = fen;
  a.running = true;
  a.history = [];
  renderEngineHistory();
  $("#engineState").textContent = "分析中…";
  $("#engineToggleBtn").textContent = "■ 停止";
  const es = new EventSource("/api/engine/analyze?fen=" + encodeURIComponent(fen));
  a.es = es;
  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch (_) { return; }
    if (ev.error) { stopAnalysis("錯誤：" + ev.error); return; }
    recordEngineEvent(ev);
    if (ev.done) stopAnalysis("完成");
  };
  es.onerror = () => { stopAnalysis("連線中斷"); };
}

function toggleAnalysis() {
  if (EDITOR.engineAnalysis.running) stopAnalysis("已停止");
  else startAnalysis();
}

// ---------- boot ----------

$("#saveBtn").onclick = save;
$("#metaBtn").onclick = openMetaModal;
$("#metaCancel").onclick = closeMetaModal;
$("#metaOk").onclick = applyMetaEdits;
$("#metaModal").addEventListener("click", (e) => {
  if (e.target.id === "metaModal") closeMetaModal();  // click backdrop to close
});
$("#newXqfBtn").onclick = openNewModal;
$("#newCancel").onclick = closeNewModal;
$("#newOk").onclick = submitNewXqf;
$("#newModal").addEventListener("click", (e) => {
  if (e.target.id === "newModal") closeNewModal();
});
// Settings dialog (paths moved out of the file pane to save space).
function openSettingsModal() { $("#settingsModal").hidden = false; }
function closeSettingsModal() { $("#settingsModal").hidden = true; }
$("#settingsBtn").onclick = openSettingsModal;
$("#settingsClose").onclick = closeSettingsModal;
$("#settingsModal").addEventListener("click", (e) => {
  if (e.target.id === "settingsModal") closeSettingsModal();
});
// Enter inside any new-XQF field submits.
$("#newModal").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { submitNewXqf(); e.preventDefault(); }
});
$("#navFirst").onclick = navFirst;
$("#navPrev").onclick = navPrev;
$("#navBranch").onclick = navToNearestBranch;
$("#navNext").onclick = navNext;
$("#navLast").onclick = navLast;
$("#navDelete").onclick = deleteCurrentMove;

// Annote textarea: commit on every keystroke so EDITOR.data stays in sync.
$("#annoteBox").addEventListener("input", commitAnnoteEdit);

// Click-to-add-move: delegate clicks on the board SVG to onSquareClick.
// The transparent overlay rects in installBoardOverlay() carry data-iccs.
$("#board").addEventListener("click", (e) => {
  const target = e.target.closest("[data-iccs]");
  if (!target) return;
  onSquareClick(target.getAttribute("data-iccs"));
});

// Root directory picker — opens native Windows folder dialog.
$("#rootPickBtn").onclick = pickRoot;

// Eval DB picker — opens native file dialog (positions.db / .sqlite).
$("#evalDbPickBtn").onclick = pickEvalDb;
// Pikafish engine picker — opens native file dialog (pikafish*.exe).
$("#enginePickBtn").onclick = pickEngine;
// Right-column tabs + live-analysis toggle.
document.querySelectorAll(".rpTab").forEach((b) => {
  b.addEventListener("click", () => switchRpTab(b.dataset.tab));
});
$("#engineToggleBtn").onclick = toggleAnalysis;
$("#engineClearBtn").onclick = clearAnalysisHistory;
$("#engineExportBtn").onclick = exportAnalysisHistory;
reorderEvalRows();

// Board theme picker. Initial value applied in boot() after PREFS load.
ensureBoardThemeOptions();
const themeSel = $("#boardThemeSel");
themeSel.addEventListener("change", () => applyBoardTheme(themeSel.value));
const boardViewToggle = $("#boardViewToggle");
if (boardViewToggle) boardViewToggle.addEventListener("change", () => applyBoardPerspective(boardViewToggle.checked ? "black" : "red"));
ensureUiThemePicker();
const uiThemeSel = $("#uiThemeSel");

// Ensure board.js's WenKai TC font is registered (Google Fonts injected on
// demand). All three themes use the "wenkai" font key. Without this the board
// pieces fall back to a generic serif and look slightly off vs chess-book-ai.
if (typeof ensurePieceFontLoaded === "function") {
  ensurePieceFontLoaded("wenkai");
}

// ---------- splitters ----------
// Each splitter element carries:
//   data-resize    : id of target element whose flex-basis the splitter drives
//   data-direction : "row" => vertical drag (resize height); default => horizontal
//   data-pref      : key in PREFS where the size is persisted (server-side)
//
// Why we mutate flexBasis (not width/height): inside a flex container,
// `flex-basis` (set by `flex: 0 0 240px` etc.) is the main-axis size and
// overrides plain `width`/`height`. Setting style.width/.height would look
// like it's dragging but the layout wouldn't actually resize.
function setupSplitters() {
  document.querySelectorAll(".splitter").forEach((splitter) => {
    const targetId = splitter.dataset.resize;
    const target = document.getElementById(targetId);
    if (!target) {
      console.warn("splitter: target not found:", targetId);
      return;
    }
    const isRow = splitter.dataset.direction === "row";
    const prefKey = splitter.dataset.pref;

    // Restore from PREFS (populated from the server before setupSplitters runs).
    if (prefKey) {
      const saved = PREFS[prefKey];
      if (Number.isFinite(saved) && saved > 60) {
        target.style.flexBasis = saved + "px";
      }
    }

    splitter.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const rect = target.getBoundingClientRect();
      const startSize = isRow ? rect.height : rect.width;
      const startPos  = isRow ? e.clientY : e.clientX;

      splitter.classList.add("dragging");
      document.body.classList.add("dragging");
      if (isRow) document.body.classList.add("dragging-row");

      const onMove = (ev) => {
        const cur   = isRow ? ev.clientY : ev.clientX;
        const delta = cur - startPos;
        const next  = Math.max(80, startSize + delta);
        target.style.flexBasis = next + "px";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup",   onUp);
        splitter.classList.remove("dragging");
        document.body.classList.remove("dragging", "dragging-row");
        if (prefKey) {
          const size = isRow ? target.offsetHeight : target.offsetWidth;
          savePreference(prefKey, size);
        }
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup",   onUp);
    });
  });
}

// Restore the last opened file: expand the path of folders down to it,
// highlight it, and trigger the same load flow as a click would.
async function tryAutoLoadLastFile() {
  const rel = PREFS.lastFile;
  if (!rel) return;
  // data-rel uniquely identifies each file li. Linear scan is fine for any
  // realistic library size.
  const fileLi = Array.from(document.querySelectorAll("#fileTree li.file"))
    .find((li) => li.dataset.rel === rel);
  if (!fileLi) return;
  // Expand every ancestor <ul> (collapsed by default).
  let el = fileLi.parentElement;
  const treeRoot = document.getElementById("fileTree");
  while (el && el !== treeRoot) {
    if (el.tagName === "UL") el.style.display = "";
    el = el.parentElement;
  }
  await selectFile(rel, fileLi);
  fileLi.scrollIntoView({ block: "nearest" });
}

// ---------- async boot ----------
// Order: PREFS -> theme -> splitters -> file tree -> auto-open last file.
(async function boot() {
  await loadPreferences();
  const savedTheme = PREFS.boardTheme;
  if (savedTheme && ["traditional", "stone", "gilded", "copperwood", "celadon"].includes(savedTheme)) {
    themeSel.value = savedTheme;
    document.documentElement.dataset.board = savedTheme;
  }
  const savedBoardPerspective = PREFS.boardPerspective === "black" ? "black" : "red";
  if (boardViewToggle) boardViewToggle.checked = savedBoardPerspective === "black";
  applyBoardPerspective(savedBoardPerspective);
  const savedUiTheme = PREFS.uiTheme;
  const initialUiTheme = UI_THEMES[savedUiTheme] ? savedUiTheme : "ember";
  if (uiThemeSel) uiThemeSel.value = initialUiTheme;
  document.documentElement.dataset.uiTheme = initialUiTheme;
  setupSplitters();
  // Parallelisable on boot — eval info is independent of the XQF tree fetch
  // and we want it ready before tryAutoLoadLastFile triggers fetchEvalsForFile.
  await Promise.all([fetchEvalDbInfo(), fetchEngineInfo(), loadFileTree()]);
  await tryAutoLoadLastFile();
})();
