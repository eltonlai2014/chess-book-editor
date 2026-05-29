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

function setStatus(text, cls) {
  const s = $("#status");
  s.textContent = text || "";
  s.className = cls || "";
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
    const outcome = insertMoveAt(EDITOR.activePath, {
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
function deleteCurrentMove() {
  if (!EDITOR.data || EDITOR.activePath.length === 0) return;
  const node = nodeAt(EDITOR.activePath);
  if (!node) return;
  const label = node.notation || node.iccs;
  const desc = countDescendants(node);
  const prompt = desc > 0
    ? `『${label}』之後還有 ${desc} 步走法／分支，全部一併刪除？`
    : `確定刪除『${label}』？`;
  if (!window.confirm(prompt)) return;

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
function insertMoveAt(parentPath, newNode) {
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
    const ok = window.confirm(
      `此步已有續著：${existingLabels}\n新增『${newLabel}』為分支走法？`,
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
  } catch (e) {
    setStatus("載入失敗：" + e.message, "err");
  }
}

// ---------- 棋譜 (move list) — XQStudio style: linearised current path ----------

function currentLine() {
  if (!EDITOR.data) return [];
  const out = [];
  let nodes = EDITOR.data.roots || [];
  const pathSoFar = [];
  let ply = 1;
  for (const idx of EDITOR.activePath) {
    const node = nodes[idx];
    if (!node) break;
    pathSoFar.push(idx);
    out.push({ node, path: pathSoFar.slice(), ply, hasSiblings: nodes.length > 1 });
    nodes = node.children || [];
    ply++;
  }
  while (nodes.length > 0) {
    const node = nodes[0];
    pathSoFar.push(0);
    out.push({ node, path: pathSoFar.slice(), ply, hasSiblings: nodes.length > 1 });
    nodes = node.children || [];
    ply++;
  }
  return out;
}

function renderMoveList() {
  const list = $("#moveList");
  list.innerHTML = "";
  // No "（開局）" pseudo-row — master prefers a clean numbered list. To get
  // back to the initial position, use |◀ button or Home key.
  for (const item of currentLine()) {
    list.appendChild(renderPlyRow(item));
  }
}

function renderPlyRow(item) {
  const { node, path, ply, hasSiblings } = item;
  const isFirstOfPair = (ply % 2 === 1);
  const pairNo = Math.ceil(ply / 2);

  const row = document.createElement("div");
  row.className = "plyLine" + (isFirstOfPair ? "" : " black");
  row.dataset.pathkey = path.join("/");

  const numEl = document.createElement("span");
  numEl.className = "plyNum";
  numEl.textContent = isFirstOfPair ? (pairNo + ".") : "";
  row.appendChild(numEl);

  const txtEl = document.createElement("span");
  txtEl.className = "plyText";
  txtEl.textContent = node.notation || node.iccs;
  row.appendChild(txtEl);

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
}

function renderVarPicker() {
  const path = EDITOR.activePath;
  const picker = $("#varPicker");
  const rightPane = $("#rightPane");
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
    rightPane.classList.add("noVars");  // CSS makes 注解 span both rows
    return;
  }
  rightPane.classList.remove("noVars");
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

// ---------- keyboard ----------

window.addEventListener("keydown", (e) => {
  // Esc closes any open modal from anywhere.
  if (e.key === "Escape") {
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

// Board theme picker. Initial value applied in boot() after PREFS load.
const themeSel = $("#boardThemeSel");
themeSel.addEventListener("change", () => applyBoardTheme(themeSel.value));

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
  if (savedTheme && ["traditional", "stone", "gilded"].includes(savedTheme)) {
    themeSel.value = savedTheme;
    document.documentElement.dataset.board = savedTheme;
  }
  setupSplitters();
  await loadFileTree();
  await tryAutoLoadLastFile();
})();
