"use strict";
/* XQF editor — uses board.js's theme renderer + FEN/ICCS primitives.
 *
 * board.js is loaded as a sibling non-module script BEFORE this file. Its
 * top-level function declarations (drawBoard, parseFen, applyIccs, iccsToCoord,
 * makeFloatingPiece, deltaSignClass) and module-scoped `let`s (CURRENT_REDP,
 * BOARD_STYLES) are visible here via the shared script lexical environment.
 *
 * board.js used to carry a whole static-site UI bootstrap (initGamePage, STATE,
 * the score chart, demo player); all of it was dead in the editor and was
 * removed in T3-3 A1 (2026-06-22). isRedPerspective() now reads the hidden,
 * permanently-checked #redPerspective in index.html directly — the REDP_BOX
 * module var is gone. */

// ---------- editor state ----------

// Single mutable singleton = the editor's whole UI state. This declaration is
// the ownership map: each field's `[owner: …]` tag names the module that
// writes/drives that field's live state (T3-3 B2). editor.js declares them all
// and resets them on file load; untagged fields are editor.js-core. For the
// call coupling between modules see ARCHITECTURE.md「跨模組全域函式 API」.
const EDITOR = {
  currentPath: null,  // [owner: editor.js] rel of the open file
  data: null,         // [owner: editor.js] book JSON (roots/info/init_annote/…); the /xqf/save payload
  activePath: [],     // [owner: editor.js] index path into roots[][.children]... — [] = init position
  selectedSquare: null,  // [owner: editor.js] "h2" when user has selected a from-square via click
  legalTargets: [],   // [owner: editor.js] list of dest iccs ("e2",...) for currently selected piece
  floatEl: null,      // [owner: editor.js] <g> of the carried piece following the cursor (or null)
  boardPtr: null,     // [owner: editor.js] last cursor position in board viewBox coords {x,y}
  // [owner: editor.js fetchEvalsForFile; read by editor-cdb/-aichart + eval line]
  // Read-only eval data from chess-book-ai's positions.db. Loaded by
  // fetchEvalsForFile() after each selectFile. {fen -> {d12?,d22?,d28?,d32?,cdb?}}.
  // Empty object when the DB is missing or the file's FENs aren't in it.
  evalsByFen: {},
  // [owner: editor-cdb] Live chessdb.cn cloud-library lookup state. positions.db
  // only covers the AI library; the editor queries chessdb.cn on navigation for
  // whatever the user has on the board, merging results into evalsByFen[fen].cdb.
  cdbLive: { fen: null, timer: null, loading: false, error: null, endgame: false },
  cdbScope: "prev",   // [owner: editor-cdb] 雲庫分頁查哪個局面："prev"=當前步(前一步決策點)／"next"=下一步(走完本步後)
  evalDbInfo: null,   // [owner: editor.js] result of GET /api/eval/info — drives UI gating
  engineInfo: null,   // [owner: editor.js] result of GET /api/engine/info — Pikafish config chip
  engineAnalysis: { es: null, running: false, fen: null, mode: null, startPath: [], history: [] },  // [owner: editor-engine] live SSE analysis
  aiAnalysis: { running: false, points: [], queryIdx: null },  // [owner: editor-aichart] depth-limited whole-line sweep → trend chart (queryIdx = hovered point)
  cdbLine: { running: false, steps: [], startFen: null, startPath: [], endReason: "" },  // [owner: editor-cdb] 雲庫演繹: forward chessdb principal variation
  demo: { fens: [], notations: [], lastIccs: [], idx: 0, timer: null },  // [owner: editor-demo] 演示 playback state
  // [owner: editor-autoplay] AI 自動走棋: pikafish drives one or both sides; per-side
  // think-time (步時), bestmove at time-out. `recording` is snapshotted at start
  // (true = write into the tree; false = ephemeral sandbox line that never touches
  // EDITOR.data and is discarded — board restored to `startPath` — on stop).
  // `waitingHuman` is the 人機輪替 pause: only one side is AI, idle until human moves.
  autoPlay: { running: false, recording: true, waitingHuman: false, es: null, startPath: null, sandboxBaseFen: null, sandboxLine: [], history: [] },
  rootOk: true,       // [owner: editor.js] false when the configured library root is missing (drives LS recovery)
  treeSig: "",        // [owner: editor.js] JSON sig of the last-rendered /api/xqf/list — focus auto-rescan only repaints on change
  rootPath: "",       // [owner: editor.js] last root reported by the server (valid or not)
  dirty: false,       // [owner: editor.js] 目前棋譜有未存檔的編輯 → 切檔前提示存/棄（見 maybeSaveBeforeLeaving）
};

// 任何會改動 EDITOR.data 的編輯都呼叫這個；切換棋譜前用 EDITOR.dirty 判斷是否提示。
function markDirty() { EDITOR.dirty = true; }

// Side-to-move ("w"/"b") from a `<board> <side> …` FEN — the editor's FEN
// contract. The lightweight counterpart to board.js's parseFen (which also
// expands the board into a 90-cell array we don't need here). Centralised so
// every caller reads the side field ONE way, and a `<board> <side>` format
// drift fails in one place instead of eight. Defaults to "w" for a missing or
// blank side (matches the prior inline behaviour at every call site).
function fenSide(fen) { return ((fen || "").trim().split(/\s+/)[1]) || "w"; }

// Per-theme editor colours for selection halo + legal-destination markers.
// Each theme has its own palette in board.js; we pick contrasting accents:
//   select : ring drawn around the selected own-piece (vivid, not gold so it
//            doesn't clash with the lastMove gold rings in stone/gilded)
//   target : dot/ring shown on each legal destination square
// Falls back to traditional's palette if the active theme key is missing.
const EDITOR_THEME_COLORS = {
  traditional: { select: "#e67e22", target: "#16a085" },  // orange / teal on warm wood (teal pops harder than the original steel-blue against mid-tone wood)
  stone: { select: "#c0392b", target: "#3a6b3a" },  // cinnabar / pine green on cream stone
  gilded: { select: "#e8b75c", target: "#5fa8d6" },  // brighter gold / cool blue on dark slate
  copperwood: { select: "#cf6a32", target: "#7aa6a1" },
  celadon: { select: "#c75b4a", target: "#5b8f7a" },
};

const UI_THEMES = {
  ember: "琥珀夜",
  jade: "青玉霧",
  ink: "墨夜藍",
  plum: "梅影紫",
  copper: "赤銅棕",
  pineash: "松煙灰",
  moxa: "摩莎青",
  light: "霜月白",
};
function editorColors() {
  const t = document.documentElement.dataset.board || "traditional";
  return EDITOR_THEME_COLORS[t] || EDITOR_THEME_COLORS.traditional;
}

// Read a CSS custom property off :root (resolves the active UI-theme value).
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
// #rrggbb (or already-rgb/var-resolved hex) → "rgba(r,g,b,a)". Used to tint the
// analysis-chart advantage area from the theme's --side-* tokens at runtime.
function hexToRgba(hex, a) {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
// Set an element's content to an SVG icon (from the ICON registry) followed by
// plain text. The text is appended as a text node, so it's never HTML-parsed —
// safe for file paths / engine names that might contain < or &. ICON keys are
// defined later in the file; this is only ever called at runtime, never at load.
function setIconText(el, iconKey, text) {
  if (!el) return;
  el.innerHTML = (typeof ICON !== "undefined" && ICON[iconKey]) || "";
  el.append(" " + text);
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
  } catch (_) { }
}

// Browser-local backup of the three "last known good" config paths. Mirrors
// the server-side preferences.json but survives a wiped/relocated prefs file,
// so if the configured path goes missing we can offer to restore it on boot.
// Written by the chip renderers whenever a path validates; read by
// recoverSettingsFromLocalStorage().
const LS_KEYS = { root: "xqfRoot", evalDb: "evalDbPath", engine: "pikafishPath" };
function lsGet(k) { try { return localStorage.getItem(k) || ""; } catch (_) { return ""; } }
function lsSet(k, v) { try { if (v) localStorage.setItem(k, v); } catch (_) { } }

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
  s.title = text || "";   // header span is ellipsised; keep the full text on hover
  s.className = cls || "";
}

// Feedback line INSIDE the 演示窗 (延伸／加入). Lives there rather than the header
// #status so a long message (depth / dropped tail / total / next action) has the
// dialog's full width to wrap, instead of squeezing the header title + buttons.
function setDemoStatus(text, cls) {
  const s = $("#demoStatus");
  if (!s) return;
  s.textContent = text || "";
  s.className = "demoStatus" + (cls ? " " + cls : "");
  s.hidden = !text;
}

function showConfirmDialog(message, title = "請確認", okLabel = "確定", cancelLabel = "取消") {
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
    okBtn.textContent = okLabel;        // 預設「確定」；未存檔提示等可自訂
    cancelBtn.textContent = cancelLabel; // 預設「取消」
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

// 切換棋譜（換檔／換盤／換目錄）前的未存檔守門。
//   - 沒有未存檔 → 直接放行。
//   - 有未存檔 → 提示「先存檔／放棄變更」。選存檔且成功才放行；存檔失敗則留在
//     原棋譜（不丟編輯）。選放棄則清掉未存檔狀態後放行。
// 一次只編輯一盤、切走前強迫做決定，所以不會累積「多盤待存」的狀態。
async function maybeSaveBeforeLeaving() {
  if (!EDITOR.dirty) return true;
  const doSave = await showConfirmDialog(
    "目前棋譜尚未存檔。要先存檔，還是放棄變更？",
    "尚未存檔", "先存檔", "放棄變更",
  );
  if (doSave) {
    const ok = await save();
    if (!ok) { setStatus("存檔失敗，已留在原棋譜", "err"); return false; }
  } else {
    EDITOR.dirty = false;   // 放棄
  }
  return true;
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

// Leaf count under a subtree = how many distinct complete lines (變例) it holds.
// A node with no children is itself one line (1).
function countLeaves(node) {
  const ch = node.children || [];
  if (ch.length === 0) return 1;
  return ch.reduce((s, c) => s + countLeaves(c), 0);
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
// Carried-piece visual: when a piece is selected it lifts off its square and
// follows the cursor (makeFloatingPiece in board.js). A slight scale sells the
// "picked up" feel; the same transform is applied on creation and on each move.
const FLOAT_SCALE = 1.08;
function floatTransform(p) { return `translate(${p.x},${p.y}) scale(${FLOAT_SCALE})`; }
// Client (mouse) coords → board viewBox (540×600) coords, accounting for the
// CSS-scaled SVG, so the floating piece sits exactly under the cursor.
function boardPointFromEvent(e) {
  const svg = $("#board");
  if (!svg || !svg.getScreenCTM) return null;
  const m = svg.getScreenCTM();
  if (!m) return null;
  const pt = svg.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  const loc = pt.matrixTransform(m.inverse());
  return { x: loc.x, y: loc.y };
}
function parseSquare(sq) {
  return { col: sq.charCodeAt(0) - 97, row: parseInt(sq[1], 10) };
}
function currentFen() {
  if (!EDITOR.data) return null;
  return fenAndLastIccsFor(EDITOR.activePath).fen;
}
// The FEN the board is currently SHOWING and accepting input against. Normally
// equals currentFen() (the active tree path). During a *sandbox* auto-play
// session (running + not recording), the board shows an ephemeral line that
// never touches EDITOR.data, so overlay rendering and human input must key off
// that line's tip instead. Outside a sandbox session this is a pure pass-through.
function boardFen() {
  const ap = EDITOR.autoPlay;
  if (ap.running && !ap.recording && ap.sandboxLine.length) {
    return ap.sandboxLine[ap.sandboxLine.length - 1].fen;
  }
  return currentFen();
}
// Which position the 雲庫 TAB queries (selectable via the 當前步/下一步 toggle):
//   "prev" 當前步 — the decision point (前一步 = analysisFen): the moves playable
//          for THIS move (current move + siblings). DEFAULT.
//   "next" 下一步 — the position AFTER the active move (currentFen): the next
//          move's options; clicking one adds it as a CHILD of the active move.
// NOTE: the eval line keys to currentFen() — the position AFTER the active move
// (master's call 2026-06-18; see renderEvalLine). So in the default 當前步 mode
// the tab (analysisFen, the decision point) and the eval line (currentFen)
// deliberately describe different positions; only the tab honours EDITOR.cdbScope.
function cdbTabFen() {
  if (!EDITOR.data) return null;
  return EDITOR.cdbScope === "next" ? currentFen() : analysisFen();
}
// chessdb.cn 的雲庫只涵蓋開局＋中局，殘局子力一稀疏就查無資料。當盤面進入
// 殘局時不再向雲庫發查詢（也不演繹）。判定（雙方合計，大子＝車R/馬N/炮C）：
//   1. 無車（剩馬包）              → rooks === 0
//   2. 僅剩兩個大子（如車馬、車包）→ bigPieces <= 2
// 任一成立即視為殘局。FEN 字母見 board.js PIECE_CHAR（R/N/C 紅、r/n/c 黑）。
function isEndgameFen(fen) {
  if (!fen) return false;
  const board = fen.trim().split(/\s+/)[0] || "";
  let rooks = 0, bigPieces = 0;
  for (const ch of board) {
    if (ch === "R" || ch === "r") { rooks++; bigPieces++; }
    else if (ch === "N" || ch === "n" || ch === "C" || ch === "c") bigPieces++;
  }
  return rooks === 0 || bigPieces <= 2;
}
function pieceAt(sq) {
  // Returns piece char (e.g. "R" / "k") or null if empty / no game loaded.
  const fen = boardFen();
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
  const fen = boardFen();
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

  // Carried piece: when a source square is selected, drawBoard() already lifted
  // that piece off its square (liftIccs), so draw a floating copy that tracks
  // the cursor. Recreated on every redraw (drawBoard wipes the SVG); the
  // pointermove handler then keeps EDITOR.floatEl positioned without redrawing.
  EDITOR.floatEl = null;
  if (EDITOR.selectedSquare) {
    const piece = pieceAt(EDITOR.selectedSquare);
    if (piece) {
      const { col, row } = parseSquare(EDITOR.selectedSquare);
      const ptr = EDITOR.boardPtr || { x: screenX(col), y: screenY(row) };
      const fg = makeFloatingPiece(svg, piece);   // board.js
      fg.setAttribute("transform", floatTransform(ptr));
      EDITOR.floatEl = fg;
    }
  }
}

function onSquareClick(sq) {
  if (!EDITOR.data) return;
  const fen = boardFen();
  if (!fen) return;
  const sideToMove = parseFen(fen).side;
  const piece = pieceAt(sq);

  // Same square clicked → deselect
  if (EDITOR.selectedSquare === sq) {
    clearSelection();
    redrawBoardView();
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
  // Drop the carried piece. The next redraw won't recreate it (no selection),
  // but remove it now in case a caller doesn't immediately redraw.
  if (EDITOR.floatEl) { EDITOR.floatEl.remove(); EDITOR.floatEl = null; }
}

// Show selection immediately, then async-fetch legal destinations and redraw
// when they arrive. Two refreshActive() calls so the halo doesn't visibly lag
// the click — destination dots can pop in a frame later, which is fine.
async function selectSquare(sq) {
  EDITOR.selectedSquare = sq;
  EDITOR.legalTargets = [];
  redrawBoardView();
  const fen = boardFen();
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
    redrawBoardView();
  } catch (_) { /* network glitch — leave dots empty, click-to-move still works */ }
}

async function tryAddMove(fromSq, toSq) {
  const iccs = fromSq + toSq;
  const fen = boardFen();
  try {
    const r = await fetch("/api/xqf/move-info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fen, iccs }),
    });
    const resp = await r.json();
    if (resp.error) {
      // Illegal move: silently drop the selection and put the carried piece back
      // on its square (clearSelection removes the float; redraw un-lifts it). No
      // status message — an illegal target just resets, nothing to announce.
      setStatus("");
      clearSelection();
      redrawBoardView();
      return;
    }
    const ap = EDITOR.autoPlay;
    if (ap.running && !ap.recording) {
      // Sandbox auto-play: the human's move joins the ephemeral line, never the
      // tree. (boardFen() already pointed move-info at the sandbox tip above.)
      sandboxPush(iccs, resp.notation, resp.side);
      setStatus(`沙盒：${resp.notation}`, "ok");
    } else {
      const outcome = await insertMoveAt(EDITOR.activePath, {
        iccs,
        notation: resp.notation,
        side: resp.side,
        ply: EDITOR.activePath.length + 1,
        annote: "",
        children: [],
      });
      if (outcome === "added") setStatus(`已新增 ${resp.notation}`, "ok");
      else if (outcome === "existing") setStatus(`已切換至 ${resp.notation}`, "ok");
      else { setStatus(""); return; }  // cancelled → don't hand control to the AI
    }
    // 人機輪替: the human just moved; if an auto-play session is idling for them
    // and the next side is AI, resume the loop.
    maybeResumeAutoPlay();
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
  markDirty();

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
// Reorder a variation within its sibling list by `delta` slots — move/splice
// semantics, NOT a swap, so every other branch keeps its relative order.
// children[0] is the main line, so moving toward 0 promotes; reaching 0 makes
// it the main line. The active path is remapped so the user stays on the same
// physical line after the shuffle. Persisted on the next save like any other
// tree edit (XQF writer emits children in array order).
function moveVariation(parentPath, idx, delta) {
  const siblings = parentPath.length === 0
    ? (EDITOR.data ? EDITOR.data.roots : null)
    : (nodeAt(parentPath)?.children || null);
  if (!siblings) return;
  const to = idx + delta;
  if (to < 0 || to >= siblings.length) return;
  const [moved] = siblings.splice(idx, 1);
  siblings.splice(to, 0, moved);
  markDirty();
  // Keep the active path on the same physical line if it runs through these
  // siblings at the ply right after parentPath.
  if (EDITOR.activePath.length > parentPath.length) {
    const d = parentPath.length;
    EDITOR.activePath[d] = remapAfterMove(EDITOR.activePath[d], idx, to);
  }
  refreshActive();
  setStatus(`已移動『${moved.notation || moved.iccs}』`, "ok");
}

// New index of an element originally at `cur` after the element at `from` is
// spliced out and reinserted at `to`.
function remapAfterMove(cur, from, to) {
  if (cur === from) return to;
  if (from < to && cur > from && cur <= to) return cur - 1;
  if (from > to && cur >= to && cur < from) return cur + 1;
  return cur;
}

// Reorder the currently-active variation (keyboard: Alt+↑/↓).
function moveActiveVariation(delta) {
  const path = EDITOR.activePath;
  if (path.length === 0) return;   // init position has no active variation
  moveVariation(path.slice(0, -1), path[path.length - 1], delta);
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
  markDirty();
  navigateTo(parentPath.concat([siblings.length - 1]));
  return "added";
}

// ---------- file tree ----------

async function loadFileTree(prefetched) {
  // `prefetched` lets the focus auto-rescan reuse the list it already fetched
  // (for the change-detection compare) instead of hitting the endpoint twice.
  let tree = prefetched;
  if (!tree) {
    const r = await fetch("/api/xqf/list");
    tree = await r.json();
  }
  EDITOR.rootPath = tree.root || "";
  if (tree.root) updateRootDisplay(tree.root);
  if (tree.needsRoot) {
    // Fresh machine: no valid library root yet. Show an actionable prompt with
    // a one-click picker instead of a raw error string (recoverSettings… may
    // still offer a remembered root afterwards).
    EDITOR.rootOk = false;
    const box = $("#fileTree");
    box.innerHTML = "";
    const msg = document.createElement("p");
    msg.className = "tree-hint";
    msg.textContent = tree.error || "尚未設定棋譜根目錄。";
    const btn = document.createElement("button");
    btn.innerHTML = iconLabel("folder", "選擇棋譜根目錄");
    btn.onclick = pickRoot;
    box.appendChild(msg);
    box.appendChild(btn);
    return;
  }
  if (tree.error) { EDITOR.rootOk = false; $("#fileTree").textContent = "錯誤：" + tree.error; return; }
  EDITOR.rootOk = true;
  EDITOR.treeSig = JSON.stringify(tree);   // structure signature for focus auto-rescan
  $("#fileTree").innerHTML = "";
  $("#fileTree").appendChild(renderDir(tree));
  // Tree loaded → user can create a new file under it, and rescan for new ones.
  const newBtn = $("#newXqfBtn");
  if (newBtn) newBtn.disabled = false;
  const rescanBtn = $("#rescanBtn");
  if (rescanBtn) rescanBtn.disabled = false;
}

function updateRootDisplay(root) {
  const el = $("#rootPathDisplay");
  if (!el) return;
  setIconText(el, "folder", root);
  el.title = root;
  lsSet(LS_KEYS.root, root);   // remember last-good root for boot recovery
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
  // 換目錄會丟掉目前棋譜 → 先過未存檔守門。
  if (!(await maybeSaveBeforeLeaving())) return;
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
  stopAutoPlay(null, false);   // data just dropped — clear session, don't restore old path
  clearAutoHistory();
  stopAnalysis("尚未開始");
  clearAnalysisHistory();
  clearAiAnalysis();
  clearCdbLine();
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

function makeFileLi(child) {
  const li = document.createElement("li");
  li.className = "file";
  li.textContent = child.name;
  li.dataset.rel = child.rel;
  li.dataset.title = child.name;   // 顯示用（CBL 盤 name 是「1. 標題」，比 rel 漂亮）
  li.onclick = () => selectFile(child.rel, li);
  return li;
}

function renderDir(node) {
  const ul = document.createElement("ul");
  for (const child of node.children || []) {
    const li = document.createElement("li");
    if (child.cbl) {
      // .cbl 多盤庫：可展開資料夾，盤目懶載入（首次展開才打 cbl-children）。
      li.className = "dir cbl";
      li.dataset.rel = child.rel;    // 供開機自動重開時定位此庫
      const span = document.createElement("span");
      span.className = "dirname";
      // File tree keeps the COLOURED emoji (📚/📁): at-a-glance colour coding
      // reads better here than monochrome SVG (master preference). Toolbar/tabs
      // stay on the SVG ICON set.
      span.textContent = "📚 " + child.name;
      li.appendChild(span);
      const sub = document.createElement("ul");
      sub.style.display = "none";
      li.appendChild(sub);
      span.onclick = () => toggleCblDir(span, sub, child.rel);
    } else if (child.type === "dir") {
      li.className = "dir";
      const span = document.createElement("span");
      span.className = "dirname";
      span.textContent = "📁 " + child.name;   // coloured emoji — see .cbl branch above
      li.appendChild(span);
      const sub = renderDir(child);
      sub.style.display = "none";
      span.onclick = () => { sub.style.display = sub.style.display === "none" ? "" : "none"; };
      li.appendChild(sub);
    } else {
      ul.appendChild(makeFileLi(child));
      continue;
    }
    ul.appendChild(li);
  }
  return ul;
}

async function toggleCblDir(span, sub, rel) {
  // 已載過：純展開/收合。
  if (sub.dataset.loaded === "1") {
    sub.style.display = sub.style.display === "none" ? "" : "none";
    return;
  }
  sub.style.display = "";
  sub.dataset.loaded = "1";          // 先卡住，避免快速重複點擊重抓
  const hint = document.createElement("li");
  hint.className = "tree-hint";
  hint.textContent = "讀取中…";
  sub.appendChild(hint);
  // 還沒開任何棋譜時，盤面是閒置膠囊：載大棋庫期間也用膠囊顯示「載入中」。
  // 已開棋譜則不動其盤面（展開棋庫不該干擾正在看的局）。
  const showPill = !EDITOR.data;
  if (showPill) drawBoardLoading("棋庫載入中…");
  try {
    const r = await fetch("/api/xqf/cbl-children?path=" + encodeURIComponent(rel));
    const data = await r.json();
    sub.innerHTML = "";
    if (data.error) throw new Error(data.error);
    const children = data.children || [];
    if (!children.length) {
      const empty = document.createElement("li");
      empty.className = "tree-hint";
      empty.textContent = "（空棋庫）";
      sub.appendChild(empty);
      return;
    }
    for (const child of children) sub.appendChild(makeFileLi(child));
  } catch (e) {
    sub.innerHTML = "";
    sub.dataset.loaded = "";        // 失敗：允許重試
    const err = document.createElement("li");
    err.className = "tree-hint";
    err.textContent = "讀取失敗：" + e.message;
    sub.appendChild(err);
  } finally {
    // 還原閒置盤面（仍未開棋譜時）。已開棋譜的盤面全程未動。
    if (showPill && !EDITOR.data) drawBoardLoading("尚未載入棋譜 · 從左側選擇", false);
  }
}

async function selectFile(rel, liEl) {
  // 未存檔守門：切到別盤前先問存/棄（存檔失敗則留在原棋譜，不丟編輯）。
  if (!(await maybeSaveBeforeLeaving())) return;
  document.querySelectorAll("#fileTree li.file.active").forEach(el => el.classList.remove("active"));
  if (liEl) liEl.classList.add("active");
  setStatus("載入中…");
  drawBoardLoading("棋譜載入中…");   // pulsing badge until refreshActive() draws the position
  try {
    const r = await fetch("/api/xqf/load?path=" + encodeURIComponent(rel));
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    EDITOR.currentPath = rel;
    EDITOR.data = data;
    EDITOR.activePath = [];
    EDITOR.dirty = false;   // 剛載入＝乾淨狀態
    clearSelection();
    // New file → the old analysis no longer applies. Stop any running stream
    // and wipe both the 引擎分析 history and the AI 分析 trend.
    stopAutoPlay(null, false);   // new tree loaded — clear session without restoring old path
    clearAutoHistory();
    stopAnalysis("尚未開始");
    clearAnalysisHistory();
    clearAiAnalysis();
    // CBL 盤的 rel 尾段是「lib.cbl#3」不好看，優先用樹節點的顯示名（1. 標題）。
    const fileName = (liEl && liEl.dataset.title) || rel.split("/").pop();
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
    drawBoardLoading("載入失敗", false);   // stop the pulse so it doesn't spin forever
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
    setIconText(pathEl, "database", "評估資料庫未連線（點此選擇）");
    pathEl.title = p || "尚未設定資料庫位置";
    return;
  }
  row.classList.remove("warn");
  lsSet(LS_KEYS.evalDb, p);   // remember last-good DB path for boot recovery
  const byDepth = info.evals_by_depth || {};
  const totalEvals = Object.values(byDepth).reduce((a, b) => a + b, 0);
  const cdb = info.chessdb_rows || 0;
  // Visible line — filename, total positions, cdb count. Compact.
  const fname = p.split(/[\\/]/).pop() || p;
  const cdbCell = cdb ? `  ·  雲庫 ${cdb.toLocaleString()}` : "";
  setIconText(pathEl, "database", `${fname}  ·  ${totalEvals.toLocaleString()} 局面${cdbCell}`);
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
    await applyEvalDbPath(resp.path);
  } catch (e) {
    setStatus("選擇失敗：" + e.message, "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// POST a DB path, refresh the chip + per-file eval cache. Shared by the picker
// and boot recovery. renderEvalDbRow() mirrors the validated path to
// localStorage on success. Returns true when the DB was set.
async function applyEvalDbPath(path) {
  const set = await fetch("/api/eval/db", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const setResp = await set.json();
  if (setResp.error) { setStatus("設定失敗：" + setResp.error, "err"); return false; }
  EDITOR.evalDbInfo = setResp.info || { exists: true, path: setResp.path };
  EDITOR.evalDbInfo.path = setResp.path || path;
  renderEvalDbRow();
  await fetchEvalsForFile();
  renderEvalLine();
  renderMoveList();   // trap / brilliant markers re-evaluate against the new DB
  setStatus("已更新評估資料庫", "ok");
  return true;
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
    setIconText(pathEl, "fish", "皮卡魚引擎未設定（點此選擇）");
    pathEl.title = p || "尚未設定引擎位置";
    return;
  }
  const fname = p.split(/[\\/]/).pop() || p;
  if (!info.ok) {
    row.classList.add("warn");
    setIconText(pathEl, "fish", `${fname}（無法握手）`);
    pathEl.title = `${p}\n${info.error || "未回應 uciok"}`;
    return;
  }
  row.classList.remove("warn");
  lsSet(LS_KEYS.engine, p);   // remember last-good engine path for boot recovery
  setIconText(pathEl, "fish", info.name || fname);
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
    await applyEnginePath(resp.path);
  } catch (e) {
    setStatus("選擇失敗：" + e.message, "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// POST an engine path (server validates via UCI handshake), refresh the chip.
// Shared by the picker and boot recovery; renderEngineRow() mirrors a working
// path to localStorage. Returns true when the engine handshake succeeded.
async function applyEnginePath(path) {
  const set = await fetch("/api/engine/path", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const setResp = await set.json();
  if (setResp.error) { setStatus("設定失敗：" + setResp.error, "err"); return false; }
  EDITOR.engineInfo = setResp.info || { exists: true, ok: true, path: setResp.path };
  renderEngineRow();
  setStatus("已更新皮卡魚引擎", "ok");
  return true;
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
  const side = fenSide(fen);
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

// chessdb encodes a forced result (mate / tablebase win) as a score near
// ±30000 with NO winrate field — |score| ≈ 30000 − plies_to_mate. Convert a
// RED-POV score to Pikafish-style "#+N" (red mates in N) / "#-N" (red gets
// mated in N), or null for a normal centipawn score. Threshold 25000 is far
// above any real cp eval, so this never misfires on a big-but-finite score.
function mateFromCdbScore(scoreRed) {
  if (scoreRed == null || Math.abs(scoreRed) < 25000) return null;
  const n = 30000 - Math.abs(scoreRed);
  return (scoreRed > 0 ? "#+" : "#-") + n;
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

// Batch variant of notationFor: ONE POST for many candidate moves from the
// SAME fen (the chessdb branch point). Fills NOTATION_CACHE and returns a
// {iccs: notation} map. Already-cached moves are served from cache and left out
// of the request, so repeated calls only ever fetch the genuinely-new moves.
async function notationsForBatch(fen, iccsList) {
  const out = {};
  const miss = [];
  for (const iccs of iccsList) {
    const k = fen + "|" + iccs;
    if (NOTATION_CACHE.has(k)) out[iccs] = NOTATION_CACHE.get(k);
    else miss.push(iccs);
  }
  if (miss.length) {
    try {
      const r = await fetch("/api/xqf/move-info-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fen, iccs: miss }),
      });
      const j = await r.json();
      const notations = (j && j.notations) || {};
      for (const iccs of miss) {
        const n = notations[iccs] || null;
        NOTATION_CACHE.set(fen + "|" + iccs, n);
        out[iccs] = n;
      }
    } catch (_) { /* network glitch — leave them as iccs fallback */ }
  }
  return out;
}

// Fill the 雲庫 list rows with Chinese notation — GATED on the tab being
// visible, and BATCHED into a single request. This is why landing on a position
// while looking at another tab no longer fires one /move-info per cloud move:
// renderCdbTab builds the rows (showing a … placeholder) and calls this, which
// no-ops while #rpCdbBody is hidden; switchRpTab fills them when you actually
// open the tab. Cached rows fill instantly.
async function fillCdbNotations() {
  const body = $("#rpCdbBody");
  if (!body || body.hidden) return;            // only translate when visible
  const list = $("#cdbList");
  if (!list) return;
  const fen = cdbTabFen();
  const entry = fen && EDITOR.evalsByFen[fen];
  const cdb = entry && entry.cdb;
  if (!cdb || cdb.status !== "ok" || !(cdb.moves || []).length) return;
  const map = await notationsForBatch(fen, cdb.moves.map((m) => m.iccs));
  // The await may have spanned a navigation; bail if we've moved on.
  if (cdbTabFen() !== fen || body.hidden) return;
  for (const m of cdb.moves) {
    const span = list.querySelector(`.cdbMove[data-iccs="${m.iccs}"]`);
    if (span) span.textContent = (map && map[m.iccs]) || m.iccs;
  }
}

async function renderEvalLine() {
  // Analysis is position-specific: if the board moved, drop the stale stream.
  const ea = EDITOR.engineAnalysis;
  if (ea.running && ea.fen) {
    const expected = ea.mode === "cur" ? currentFen() : analysisFen();
    if (ea.fen !== expected) stopAnalysis("局面已變，請重新分析");
  }
  const el = $("#evalLine");
  if (!el) return;
  el.innerHTML = "";
  if (!EDITOR.data) return;
  // The whole eval line describes the position AFTER the active move
  // (currentFen): 深N / 建議 / 雲 judge "how does this position stand, and what's
  // the best reply", aligning with the AI trend chart (which also scores each
  // move's post-move position). The LAST ply's terminal (post-move) position is
  // now scored at source (chess-book-ai commit 86c4c16, 2026-06-23): d12 covers
  // it immediately, d22 fills via the nightly sweep — so the final move shows
  // 深12 right away and 深22 once the sweep reaches that FEN. (Was an accepted gap
  // until 2026-06-23; no editor code change — read-only DB, this fn just reads
  // the new rows.)
  const fen = currentFen();
  const entry = (fen && EDITOR.evalsByFen[fen]) || {};

  const cells = [];
  // --- engine eval cells (depth scores), gated on positions.db ---
  const haveDb = EDITOR.evalDbInfo && EDITOR.evalDbInfo.exists;
  let bestIccs = null;
  if (haveDb) {
    for (const d of [12, 22, 28, 32]) {
      const e = entry[`d${d}`];
      if (!e) continue;
      const suffix = (e.mate == null) ? `<span class="evalLabel"> 分</span>` : "";
      cells.push(`<span class="evalCell"><span class="evalLabel">深${d}</span> <span class="evalScore">${fmtEvalScore(e, fen)}</span>${suffix}</span>`);
    }
    // Prefer deepest available eval's best move for the suggestion line.
    const deepest = entry.d32 || entry.d28 || entry.d22 || entry.d12;
    bestIccs = deepest && deepest.best_iccs;
  }

  // --- cloud-library cell (chessdb.cn) — same decision-point FEN as the depth
  // cells above (cFen === fen). 雲 shows the cloud's top move at this decision,
  // comparable to 建議. Independent of positions.db, so it shows even for
  // user-set positions the engine DB has never seen.
  let cdbIccs = null;
  const cFen = fen;
  const cEntry = entry;
  const cl = EDITOR.cdbLive;
  if (cEntry.cdb && cEntry.cdb.best) {
    const b = cEntry.cdb.best;
    cdbIccs = b.iccs;
    // Mate (#+N) takes precedence over winrate — chessdb omits winrate for
    // forced results and codes them as a ±30000-ish score (red POV via cFen).
    const cFlip = fenSide(cFen) === "b" ? -1 : 1;
    const cMate = mateFromCdbScore(b.score != null ? b.score * cFlip : null);
    const tag = cMate != null ? cMate : (b.winrate != null ? `${b.winrate.toFixed(1)}%` : "—");
    cells.push(`<span class="evalCell evalCdb"><span class="evalLabel">雲</span> <span class="evalMove" data-cdb-iccs="${cdbIccs}">…</span> (${tag})</span>`);
  } else if (cl.endgame && cl.fen === cFen) {
    cells.push(`<span class="evalCell evalCdb"><span class="evalLabel">雲</span> <span class="evalNote">殘局略</span></span>`);
  } else if (cl.loading && cl.fen === cFen) {
    cells.push(`<span class="evalCell evalCdb"><span class="evalLabel">雲</span> <span class="evalNote">查詢中…</span></span>`);
  } else if (cEntry.cdb && cEntry.cdb.status && cEntry.cdb.status !== "ok") {
    cells.push(`<span class="evalCell evalCdb"><span class="evalLabel">雲</span> <span class="evalNote">無資料</span></span>`);
  }

  let bestHtml = "";
  if (bestIccs) {
    bestHtml = `<span class="evalCell evalBest"><span class="evalLabel">建議</span> <span class="evalMove" data-iccs="${bestIccs}">…</span></span>`;
  }

  if (cells.length === 0 && !bestHtml) {
    el.innerHTML = haveDb
      ? `<span class="evalNote">此局面未分析</span>`
      : `<span class="evalNote">引擎資料未連線</span>`;
    return;
  }
  el.innerHTML = cells.join("") + bestHtml;

  // Fill in the Chinese notations when ready (fall back to the code only if
  // conversion genuinely fails).
  if (bestIccs) {
    notationFor(fen, bestIccs).then((notation) => {
      const span = el.querySelector(`.evalMove[data-iccs="${bestIccs}"]`);
      if (span) span.textContent = notation || bestIccs;
    });
  }
  if (cdbIccs) {
    notationFor(cFen, cdbIccs).then((notation) => {
      const span = el.querySelector(`.evalMove[data-cdb-iccs="${cdbIccs}"]`);
      if (span) span.textContent = notation || cdbIccs;
    });
  }
}

// [moved to editor-cdb.js — T2-1 split]


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
// Thresholds come from the backend single source (GET /api/eval/thresholds →
// eval_service.TRAP_THRESHOLDS) — fetched on boot by fetchThresholds(), before
// the first move-list render. The values below are a FALLBACK mirror used only
// if that fetch fails; they must match the backend (and render_site.py), but the
// backend is authoritative so the UI auto-follows it. (T3-2: was hand-copied.)
let SKIP_OPENING_PLIES = 15;     // skip plies 1..15; trap/brilliant from ply 16
let TRAP_SHALLOW_MAX = 50;      // shallow says "fine"
let TRAP_DEEP_MIN = 100;     // deep says "blunder"
let TRAP_DEEP_MAX = 2000;    // sanity cap
let BRILLIANT_MIN = 50;
let BRILLIANT_MAX = 300;

// Pull the authoritative thresholds from the backend. On failure the fallback
// values above stand in (graceful: trap/brilliant marking still works). Called
// in boot()'s parallel fetch batch so it resolves before any renderMoveList().
async function fetchThresholds() {
  try {
    const r = await fetch("/api/eval/thresholds");
    const t = await r.json();
    if (t && typeof t === "object") {
      if (Number.isFinite(t.skipOpeningPlies)) SKIP_OPENING_PLIES = t.skipOpeningPlies;
      if (Number.isFinite(t.trapShallowMax)) TRAP_SHALLOW_MAX = t.trapShallowMax;
      if (Number.isFinite(t.trapDeepMin)) TRAP_DEEP_MIN = t.trapDeepMin;
      if (Number.isFinite(t.trapDeepMax)) TRAP_DEEP_MAX = t.trapDeepMax;
      if (Number.isFinite(t.brilliantMin)) BRILLIANT_MIN = t.brilliantMin;
      if (Number.isFinite(t.brilliantMax)) BRILLIANT_MAX = t.brilliantMax;
    }
  } catch (_) { /* keep fallback values */ }
}

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
  // Release the trend chart's transient inspect state (set by chart hover, or
  // latched to the final point after a sweep). Otherwise the cursor stays stuck
  // on that point and keyboard/list navigation wouldn't move it — it'd only
  // free up on an incidental chart mouseleave. Cleared here so the cursor falls
  // back to aiActiveIdx() and tracks the board on every navigation.
  EDITOR.aiAnalysis.queryIdx = null;
  refreshActive();
}

// ---- board move animation gate ----
// Sync the board.js dataset hooks (data-board-anim / data-board-sound) from
// PREFS. Both default ON; only "off" disables. Call on boot + on toggle change.
function applyBoardFxPrefs() {
  document.documentElement.dataset.boardAnim = (PREFS.boardAnim === false) ? "off" : "on";
  document.documentElement.dataset.boardSound = (PREFS.boardSound === false) ? "off" : "on";
}
function fenBoard(f) { return f ? f.split(/\s+/)[0] : f; }
// Return the move iccs to animate, or null. We animate ONLY a true single-ply
// advance: applying lastIccs to the previously-rendered position reproduces the
// new board. That excludes back-nav, jumps, file switches, perspective/theme
// re-renders (prev === current there), and mid-carry redraws.
function animatableMove(newFen, lastIccs) {
  if (!lastIccs || lastIccs.length < 4) return null;
  if (EDITOR.selectedSquare) return null;            // carrying a piece — don't animate
  const prev = EDITOR.prevBoardFen;
  if (!prev) return null;
  if (fenBoard(applyIccs(prev, lastIccs)) !== fenBoard(newFen)) return null;
  return lastIccs;
}

function refreshActive() {
  const path = EDITOR.activePath;
  const { fen, lastIccs } = fenAndLastIccsFor(path);
  // board.js drawBoard signature: drawBoard(svg, fen, bookMove, engineMove, liftIccs)
  // liftIccs lifts the selected piece off its square so it can float at the cursor.
  // Animate ONLY a genuine single-ply advance (play / step-forward); back / jump /
  // file-switch redraw instantly. When animating, lift the destination piece so
  // drawBoard doesn't paint it before the slide lands (animateBoardMove drops it).
  const animIccs = animatableMove(fen, lastIccs);
  const lift = animIccs ? animIccs.slice(2, 4) : EDITOR.selectedSquare;
  drawBoard($("#board"), fen, lastIccs, null, lift);
  installBoardOverlay($("#board"));   // click rects + selection halo + carried piece
  updateBoardArrows();                // branch hints + live engine best-move
  if (animIccs) animateBoardMove($("#board"), fen, EDITOR.prevBoardFen, animIccs);
  EDITOR.prevBoardFen = fen;

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
    // Two spans so CSS can drop the 「第 N 步：」prefix when the board column is
    // too narrow, keeping just the move (e.g. 傌二進三). See #moveInfo .miPly.
    const mi = $("#moveInfo");
    mi.textContent = "";
    const ply = document.createElement("span");
    ply.className = "miPly";
    ply.textContent = `第 ${node.ply} 步：`;
    const mv = document.createElement("span");
    mv.className = "miMv";
    mv.textContent = node.notation;
    mi.append(ply, mv);
  } else {
    $("#moveInfo").textContent = "初始局面";
  }

  $("#navFirst").disabled = path.length === 0;
  $("#navPrev").disabled = path.length === 0;
  $("#navBranch").disabled = path.length === 0;
  $("#navDelete").disabled = path.length === 0;
  const next = node ? (node.children || [])[0] : (EDITOR.data && EDITOR.data.roots && EDITOR.data.roots[0]);
  $("#navNext").disabled = !next;
  $("#navLast").disabled = !next;

  renderEvalLine();
  // Live chessdb lookup keyed to the EVAL LINE's position (currentFen, post-move)
  // so its 雲 cell gets live data when positions.db misses. The 雲庫 tab's own
  // position (cdbTabFen) is (re)queried when you switch to that tab / toggle scope.
  ensureCdbLive(currentFen());
  if (EDITOR.aiAnalysis.points.length) renderAiView();   // move the trend cursor
  // A derived 雲庫演繹 line belongs to the position it started from; once the
  // board moves elsewhere it's stale — drop it so the panel doesn't show a line
  // for a different position (the user re-runs 演繹 on demand).
  const cdl = EDITOR.cdbLine;
  if (cdl.steps.length && !cdl.running && cdl.startFen !== currentFen()) clearCdbLine();
}

// ---------- board move-hint arrows ----------
// Drawn in their own <g class="arrowLayer"> so engine heartbeats can refresh
// them without re-running the (heavier) piece + click-rect render. screenX/Y
// read board.js's CURRENT_REDP, latched by the most recent drawBoard, so these
// honour the active perspective. Hint kinds (palette in ARROW):
//   jade  — every continuation from the current position when it branches
//           (≥2 children), numbered 1.. (1 = main line) to match the list.
//   azure — the engine's current best move (PV ply 1).
//   rose  — the engine's predicted reply (PV ply 2).
// The engine arrows only show while it's thinking AND the analysed position is
// the one on the board, so they map to the right pieces; in "前一步" mode the
// board shows the after-position, so no engine arrows there by design.
// Draw one arrow into `layer`. A dark casing is laid down first, the coloured
// arrow on top — that outline keeps it legible on wood / stone / dark slate
// alike. The numbered badge is drawn separately (boardArrowBadge) in a final
// pass so an overlapping arrow's line can never cover another arrow's number.
function boardArrow(layer, iccs, opts) {
  const c = iccsToCoord(iccs);
  if (!c) return;
  const fx = screenX(c.from.col), fy = screenY(c.from.row);
  const tx = screenX(c.to.col), ty = screenY(c.to.row);
  const dx = tx - fx, dy = ty - fy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const px = -uy, py = ux;                       // perpendicular for arrowhead corners
  const w = opts.width || 5, op = opts.opacity != null ? opts.opacity : 0.9;
  const headLen = w * 2.3, headHalf = w * 1.5;
  const sx = fx + ux * 18, sy = fy + uy * 18;    // start just outside the source piece
  const ex = tx, ey = ty;                        // tip lands on the destination intersection
  // (short one-step moves stay visible)
  // One stroke+head pass; called twice (casing, then colour).
  const pass = (color, lw, hl, hh, opacity) => {
    const bx = ex - ux * hl, by = ey - uy * hl;  // arrowhead base centre
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", sx); line.setAttribute("y1", sy);
    line.setAttribute("x2", bx); line.setAttribute("y2", by);
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", lw);
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("stroke-opacity", opacity);
    line.style.pointerEvents = "none";
    layer.appendChild(line);
    const head = document.createElementNS(SVG_NS, "polygon");
    head.setAttribute("points",
      `${ex},${ey} ${bx + px * hh},${by + py * hh} ${bx - px * hh},${by - py * hh}`);
    head.setAttribute("fill", color);
    head.setAttribute("fill-opacity", opacity);
    head.style.pointerEvents = "none";
    layer.appendChild(head);
  };
  pass("rgba(20,16,10,0.45)", w + 3, headLen + 2.5, headHalf + 2, 0.45);
  pass(opts.color, w, headLen, headHalf, op);
}

// Numbered badge at an arrow's midpoint. SVG has no z-index — paint order is
// document order — so updateBoardArrows() calls this for every branch AFTER all
// arrow lines are laid down, guaranteeing no line can cover a number. When two
// collinear branches would land their badges on the same spot, the dupes are
// nudged a touch along the arrow so both numbers stay readable.
function boardArrowBadge(layer, iccs, label, color, nudge) {
  const c = iccsToCoord(iccs);
  if (!c) return;
  const fx = screenX(c.from.col), fy = screenY(c.from.row);
  const tx = screenX(c.to.col), ty = screenY(c.to.row);
  // Sit the badge beside the arrowHEAD (just behind the tip, offset to the
  // side) so each number hugs the end of its own arrow, off the line. Collinear
  // branches share a file but end at different tips, so the numbers separate
  // naturally; same-tip dupes are stepped back along the arrow via `nudge`.
  const dx = tx - fx, dy = ty - fy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const px = -uy, py = ux;               // perpendicular unit
  const back = 13 + (nudge || 0), off = 15;
  const mx = tx - ux * back + px * off, my = ty - uy * back + py * off;
  const badge = document.createElementNS(SVG_NS, "circle");
  badge.setAttribute("cx", mx); badge.setAttribute("cy", my);
  badge.setAttribute("r", 9.5);
  badge.setAttribute("fill", color);
  badge.setAttribute("stroke", "#fff");
  badge.setAttribute("stroke-width", 1.5);
  badge.style.pointerEvents = "none";
  layer.appendChild(badge);
  const txt = document.createElementNS(SVG_NS, "text");
  txt.setAttribute("x", mx); txt.setAttribute("y", my + 4);
  txt.setAttribute("text-anchor", "middle");
  txt.setAttribute("font-size", "12.5");
  txt.setAttribute("font-weight", "700");
  txt.setAttribute("fill", "#fff");
  txt.style.pointerEvents = "none";
  txt.textContent = label;
  layer.appendChild(txt);
}

// Arrow palette — a blue/green/amber categorical trio whose lightness &
// chroma are retuned per board theme so the arrows belong to the wood / stone
// / slate they sit on instead of fighting it, while staying mutually
// distinguishable and legible over both red and black pieces. Semantics are
// constant across themes: green = book branch (numbered), blue = engine's best
// move, amber = opponent's predicted reply. Source hues run a notch hotter
// than the final look because everything renders at ARROW_OPACITY over the
// board, with a dark casing locking the edge. Notes per theme:
//   gilded   — dark slate ⇒ brighten all three so they lift off the ground.
//   celadon  — green-grey ground ⇒ deepen the branch green so it doesn't melt
//              into the board; warm amber pops against the cool field.
//   wood/copper — warm grounds ⇒ a cobalt best-move gives complementary punch.
const ARROW_THEMES = {
  traditional: { branch: "#0c8f63", engineMove: "#1763bf", engineReply: "#d06a12" },
  stone: { branch: "#0a8c5e", engineMove: "#155fb8", engineReply: "#c96412" },
  gilded: { branch: "#34c98c", engineMove: "#46a0e6", engineReply: "#ef9a4d" },
  copperwood: { branch: "#0e9778", engineMove: "#1d6cc0", engineReply: "#cf5a1e" },
  celadon: { branch: "#0a7d57", engineMove: "#1c6fb8", engineReply: "#c25d2a" },
};
const ARROW_WIDTH = 5.5;     // one width for every arrow — rank is carried by the badge
const ARROW_OPACITY = 0.6;   // translucent so pieces / board lines show through
function arrowPalette() {
  return ARROW_THEMES[document.documentElement.dataset.board] || ARROW_THEMES.traditional;
}

function updateBoardArrows() {
  const svg = $("#board");
  if (!svg) return;
  const old = svg.querySelector(".arrowLayer");
  if (old) old.remove();
  if (!EDITOR.data) return;
  const layer = document.createElementNS(SVG_NS, "g");
  layer.setAttribute("class", "arrowLayer");
  const pal = arrowPalette();

  // Branch hint: continuations from the current position (≥2 = a real branch),
  // numbered 1.. to match the variation list (1 = main line). Lines are drawn
  // now; numbers are deferred to a final pass so no overlapping branch can
  // cover another's badge. Collinear branches (same file, different depth)
  // would stack badges on one spot, so each repeat at a midpoint is nudged
  // along its own arrow.
  const node = nodeAt(EDITOR.activePath);
  const conts = node ? (node.children || []) : (EDITOR.data.roots || []);
  const branchBadges = [];
  if (conts.length >= 2) {
    const seen = new Map();   // dedupe by destination tip
    conts.forEach((ch, i) => {
      if (!ch.iccs) return;
      boardArrow(layer, ch.iccs, { color: pal.branch, width: ARROW_WIDTH, opacity: ARROW_OPACITY });
      const c = iccsToCoord(ch.iccs);
      const key = c.to.col + "," + c.to.row;
      const k = seen.get(key) || 0; seen.set(key, k + 1);
      branchBadges.push({ iccs: ch.iccs, label: String(i + 1), nudge: k * 19 });
    });
  }

  // Engine "thinking" arrows: the best move + the predicted reply (first two
  // PV plies). Only when the analysed FEN is the one currently on the board.
  // Reply drawn first so the primary move sits on top.
  const a = EDITOR.engineAnalysis;
  if (a.running && a.fen && a.fen === currentFen()) {
    const pv = (a.history[0] && a.history[0].pvUci) || [];
    if (pv[1]) boardArrow(layer, pv[1], { color: pal.engineReply, width: ARROW_WIDTH, opacity: ARROW_OPACITY });
    if (pv[0]) boardArrow(layer, pv[0], { color: pal.engineMove, width: ARROW_WIDTH, opacity: ARROW_OPACITY });
  }

  // Number badges last of all — guaranteed on top of every arrow line.
  branchBadges.forEach((b) => boardArrowBadge(layer, b.iccs, b.label, pal.branch, b.nudge));

  // Sit beneath the click layer so the transparent rects keep capturing clicks.
  const clickLayer = svg.querySelector(".clickLayer");
  if (clickLayer) svg.insertBefore(layer, clickLayer);
  else svg.appendChild(layer);
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
  const parentPath = path.length === 0 ? [] : path.slice(0, -1);
  opts.forEach((opt, i) => {
    const row = document.createElement("div");
    row.className = "varOpt"
      + (i === activeIdx ? " active" : "")
      + (i === 0 ? " mainLine" : "");
    const L = document.createElement("span");
    L.className = "varLetter";
    L.textContent = (i + 1) + ".";
    row.appendChild(L);
    const t = document.createElement("span");
    t.textContent = opt.notation;
    row.appendChild(t);
    // 變例數＝此分支底下走到底的不同變化線數；只在 >1 時標，避免一片 (1) 噪音。
    const leaves = countLeaves(opt);
    if (leaves > 1) {
      const c = document.createElement("span");
      c.className = "varCount";
      c.textContent = leaves;
      c.title = `此分支底下有 ${leaves} 條變例`;
      row.appendChild(c);
    }
    // Right-aligned controls: ▲▼ reorder (any slot; disabled at the ends) plus
    // a ← marker on the active row. Reordering is move/splice, so a row can be
    // walked to any position; children[0] is the main line.
    const ctrl = document.createElement("span");
    ctrl.className = "varCtrl";
    if (i === activeIdx) {
      const arrow = document.createElement("span");
      arrow.className = "varArrow";
      arrow.textContent = "←";
      ctrl.appendChild(arrow);
    }
    const mkMove = (delta, glyph, title, disabled) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "varMoveBtn";
      b.textContent = glyph;
      b.title = title;
      b.disabled = disabled;
      b.onclick = (e) => {
        e.stopPropagation();   // don't also navigate
        moveVariation(parentPath, i, delta);
      };
      return b;
    };
    ctrl.appendChild(mkMove(-1, "▲", "上移（更靠主線；移到頂端即為主線）", i === 0));
    ctrl.appendChild(mkMove(+1, "▼", "下移", i === opts.length - 1));
    row.appendChild(ctrl);
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
    if (node.annote !== newVal) { node.annote = newVal; markDirty(); }
    return;
  }
  // Initial position — edits go to the book-level intro.
  if (EDITOR.data && (EDITOR.data.init_annote || "") !== newVal) {
    EDITOR.data.init_annote = newVal;
    markDirty();
  }
}

// ---------- annote preset chips ----------
// One-click verdicts above the annote box. A position's annote is a single
// conclusion (a position can't be both 紅優 and 黑優), so a chip REPLACES the
// box content rather than appending. Presets are read from PREFS.annotePresets
// (a management UI will edit that later); until it exists, a default set ships
// so the bar isn't empty. A preset is a plain string, or { label, text } when
// the chip caption should differ from the inserted text.
const DEFAULT_ANNOTE_PRESETS = [
  "紅方先手", "紅方易走", "紅優", "紅稍優",
  "均勢", "黑稍優", "黑優", "黑方易走",
];

function annotePresets() {
  const p = PREFS.annotePresets;
  return Array.isArray(p) && p.length ? p : DEFAULT_ANNOTE_PRESETS;
}

function presetLabelText(p) {
  if (typeof p === "string") return { label: p, text: p };
  const text = p.text != null ? p.text : (p.label || "");
  return { label: p.label || text, text };
}

// Colour group for a chip: red-side verdicts → red, black-side → blue, the
// rest (均勢…) stay neutral. Inferred from a 紅/黑 prefix so plain-string
// presets work; an object preset can override with an explicit `tone`.
function presetTone(p) {
  if (p && typeof p === "object" && p.tone) return p.tone;
  const s = (typeof p === "string" ? p : (p.label || p.text || "")).trim();
  if (s.startsWith("紅")) return "red";
  if (s.startsWith("黑")) return "black";
  return "neutral";
}

function renderAnnotePresets() {
  const bar = $("#annotePresetBar");
  if (!bar) return;
  bar.innerHTML = "";
  annotePresets().forEach((p) => {
    const { label, text } = presetLabelText(p);
    if (!label) return;
    const tone = presetTone(p);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "annoteChip" + (tone !== "neutral" ? " tone-" + tone : "");
    chip.textContent = label;
    chip.title = `設為註解：${text}`;
    chip.onclick = () => applyAnnotePreset(text);
    bar.appendChild(chip);
  });
}

// Replace the annote with the preset verdict and push it into the tree via the
// same path manual edits take (commitAnnoteEdit → active node or init_annote).
function applyAnnotePreset(text) {
  const box = $("#annoteBox");
  if (!box || box.disabled) return;   // no file loaded → nothing to annotate
  box.value = text;
  commitAnnoteEdit();
  box.focus();
  box.setSelectionRange(text.length, text.length);
  setStatus("已套用註解", "ok");
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
  if (changed) { markDirty(); setStatus("資訊已更新（記得存檔）", "ok"); }
}

// ---------- new-XQF dialog ----------
// Opens an empty XQF at <root>[/subdir]/<filename>. Backend sanitises the
// filename and refuses to overwrite an existing file (409).

function openNewModal() {
  // Pre-fill subdir with the parent folder of the currently-open file, so
  // master typically just types a title and presses 建立.
  // 若目前開的是 CBL 盤（lib.cbl#3），父層應是 .cbl 所在目錄，不是 .cbl 本身。
  let cur = EDITOR.currentPath || "";
  const hash = cur.lastIndexOf("#");
  if (hash !== -1 && cur.slice(0, hash).toLowerCase().endsWith(".cbl")) cur = cur.slice(0, hash);
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
  if (!EDITOR.data || !EDITOR.currentPath) return false;
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
    EDITOR.dirty = false;   // 存檔成功 → 清未存檔狀態
    setStatus("已儲存", "ok");
    return true;
  } catch (e) {
    setStatus("儲存失敗：" + e.message, "err");
    return false;
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
  updatePerspectiveBtn();
  if (EDITOR.data) refreshActive();
  savePreference("boardPerspective", isRed ? "red" : "black");
}

// 紅黑視角＝棋盤視圖控制，在導航列末端用一顆按鈕呈現「目前視角」，點擊翻面。
// 視角的真實來源是隱藏的 #redPerspective（board.js 讀它）。
function currentPerspective() {
  const cb = document.getElementById("redPerspective");
  return (cb && cb.checked) ? "red" : "black";   // 預設紅方
}
function updatePerspectiveBtn() {
  const btn = $("#perspectiveBtn");
  if (!btn) return;
  const isRed = currentPerspective() === "red";
  btn.innerHTML = iconLabel("flip", isRed ? "紅" : "黑");
  btn.classList.toggle("persRed", isRed);
  btn.classList.toggle("persBlack", !isRed);
  btn.title = `目前：${isRed ? "紅方" : "黑方"}視角（點擊切換）`;
}
function togglePerspective() {
  applyBoardPerspective(currentPerspective() === "red" ? "black" : "red");
}

function applyUiTheme(name) {
  const theme = UI_THEMES[name] ? name : "pineash";
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
    if (!$("#demoModal").hidden) { closeDemo(); e.preventDefault(); return; }
    if (!$("#settingsModal").hidden) { closeSettingsModal(); e.preventDefault(); return; }
    if (!$("#metaModal").hidden) { closeMetaModal(); e.preventDefault(); return; }
    if (!$("#newModal").hidden) { closeNewModal(); e.preventDefault(); return; }
  }
  // Don't intercept other keys while typing in form controls
  // (textarea for annote, inputs in the metadata modal).
  const tag = document.activeElement ? document.activeElement.tagName : "";
  if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
  if (!EDITOR.data) return;
  switch (e.key) {
    case "ArrowLeft": navPrev(); e.preventDefault(); break;
    case "ArrowRight": navNext(); e.preventDefault(); break;
    case "ArrowUp": if (e.altKey) moveActiveVariation(-1); else navVarUp(); e.preventDefault(); break;
    case "ArrowDown": if (e.altKey) moveActiveVariation(+1); else navVarDown(); e.preventDefault(); break;
    case "Home": navFirst(); e.preventDefault(); break;
    case "End": navLast(); e.preventDefault(); break;
    case "Delete": deleteCurrentMove(); e.preventDefault(); break;
    case "b": case "B":
      if (!e.ctrlKey && !e.metaKey) { navToNearestBranch(); e.preventDefault(); }
      break;
    case "s": case "S":
      if (e.ctrlKey || e.metaKey) { save(); e.preventDefault(); }
      break;
  }
});

// ---------- right-column tabs + live Pikafish analysis ----------

// Inline Lucide-style stroke icons (MIT) — local, no CDN, theme-coloured via
// currentColor. Used for the analysis button bar + per-line actions.
const ICON = {
  rewind: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 19 2 12 11 5 11 19"/><polygon points="22 19 13 12 22 5 22 19"/></svg>',
  play: '<svg class="ico" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
  stop: '<svg class="ico" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>',
  trash: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  clipboard: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>',
  demo: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
  branch: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
  ai: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z"/></svg>',
  pause: '<svg class="ico" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  info: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  save: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg>',
  plus: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
  refresh: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>',
  flip: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/></svg>',
  settings: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>',
  folder: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  skipBack: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" x2="5" y1="19" y2="5"/></svg>',
  skipFwd: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/></svg>',
  chevL: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  chevR: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  cpu: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2"/><path d="M15 2v2"/><path d="M9 20v2"/><path d="M15 20v2"/><path d="M2 9h2"/><path d="M2 15h2"/><path d="M20 9h2"/><path d="M20 15h2"/></svg>',
  search: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  chart: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/></svg>',
  note: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>',
  cloud: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 9.5 4 4 0 0 0 7 17.5"/></svg>',
  bot: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>',
  film: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/></svg>',
  // 🐟 引擎 (Pikafish), 📚 棋庫 (CBL library folder), 📋 賽事資訊 (trophy).
  fish: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 12c.94-3.46 4.94-6 8.5-6 3.56 0 6.06 2.54 7 6-.94 3.47-3.44 6-7 6s-7.56-2.53-8.5-6Z"/><path d="M18 12v.5"/><path d="M16 17.93a9.77 9.77 0 0 1 0-11.86"/><path d="M7 10.67C7 8 5.58 5.97 2.73 5.5c-1 1.5-1 5 .23 6.5-1.24 1.5-1.24 5-.23 6.5C5.58 18.03 7 16 7 13.33"/><path d="M10.46 7.26C10.2 5.88 9.17 4.24 8 3h5.8a2 2 0 0 1 1.98 1.67l.23 1.4"/><path d="m16.01 17.93-.23 1.4A2 2 0 0 1 13.8 21H9.5a5.96 5.96 0 0 0 1.49-3.98"/></svg>',
  library: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/></svg>',
  trophy: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>',
  database: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>',
};
function iconLabel(icon, label) {
  return (ICON[icon] || "") + `<span>${label}</span>`;
}

// Tab switching is scoped to a container so the two independent tab strips
// (注解|AI分析 in #rpAnnote, 走法|引擎分析 in #rpVars) never clobber each other.
function switchTabsIn(container, tab) {
  if (!container) return;
  container.querySelectorAll(".rpTab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  container.querySelectorAll(".rpTabBody").forEach((p) => { p.hidden = p.dataset.tab !== tab; });
}
function switchRpTab(tab) {
  switchTabsIn($("#rpVars"), tab);
  // The 雲庫 list defers its Chinese-notation translation until visible — fill
  // it now that the tab is shown (batched; no-op if already cached).
  // Switching to 雲庫 tab: translate notations AND live-query the tab's own
  // position (navigation only live-queries the eval line's currentFen, so the
  // tab's cdbTabFen — 當前步=analysisFen — needs its own lookup when shown).
  if (tab === "cdb") { fillCdbNotations(); ensureCdbLive(cdbTabFen()); }
  if (tab === "cdbline") renderCdbLineView();
  if (tab === "auto") renderAutoHistory();
}
function switchAnnoteTab(tab) {
  switchTabsIn($("#rpAnnote"), tab);
  // The 分析本分支 trigger lives in the tab strip; only relevant on the AI tab.
  const bar = $("#aiBar");
  if (bar) bar.hidden = tab !== "ai";
  // The chart can't size itself while hidden — redraw now it's visible.
  if (tab === "ai") renderAiView();
}

// [moved to editor-engine.js — T2-1 split]


// [moved to editor-autoplay.js — T2-1 split]


// [moved to editor-aichart.js — T2-1 split]


// [moved to editor-demo.js — T2-1 split]


// ---------- boot ----------

$("#saveBtn").onclick = save;
$("#metaBtn").onclick = openMetaModal;
$("#metaCancel").onclick = closeMetaModal;
$("#metaOk").onclick = applyMetaEdits;
$("#metaModal").addEventListener("click", (e) => {
  if (e.target.id === "metaModal") closeMetaModal();  // click backdrop to close
});
$("#newXqfBtn").onclick = openNewModal;
$("#rescanBtn").onclick = rescanTree;
// C：切回分頁/視窗重新獲得焦點時自動偵測檔案增刪（節流＋僅變動才重繪）。
document.addEventListener("visibilitychange", autoRescanIfChanged);
window.addEventListener("focus", autoRescanIfChanged);
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
$("#settingsCloseX").onclick = closeSettingsModal;
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
$("#autoStartBtn").onclick = toggleAutoPlay;

// Annote textarea: commit on every keystroke so EDITOR.data stays in sync.
$("#annoteBox").addEventListener("input", commitAnnoteEdit);

// Click-to-add-move: delegate clicks on the board SVG to onSquareClick.
// The transparent overlay rects in installBoardOverlay() carry data-iccs.
$("#board").addEventListener("click", (e) => {
  const target = e.target.closest("[data-iccs]");
  if (!target) return;
  onSquareClick(target.getAttribute("data-iccs"));
});

// Carry-the-piece: track the cursor in board (viewBox) coords so a selected
// piece floats under the mouse. Live transform update — no full redraw.
$("#board").addEventListener("pointermove", (e) => {
  const p = boardPointFromEvent(e);
  if (!p) return;
  EDITOR.boardPtr = p;
  if (EDITOR.floatEl) EDITOR.floatEl.setAttribute("transform", floatTransform(p));
});

// Root directory picker — opens native Windows folder dialog.
$("#rootPickBtn").onclick = pickRoot;

// Eval DB picker — opens native file dialog (positions.db / .sqlite).
$("#evalDbPickBtn").onclick = pickEvalDb;
// Pikafish engine picker — opens native file dialog (pikafish*.exe).
$("#enginePickBtn").onclick = pickEngine;
// Right-column tabs (scoped so the two strips don't clobber each other) +
// live-analysis toggle.
$("#rpVars").querySelectorAll(".rpTab").forEach((b) => b.addEventListener("click", () => switchRpTab(b.dataset.tab)));
$("#rpAnnote").querySelectorAll(".rpTab").forEach((b) => b.addEventListener("click", () => switchAnnoteTab(b.dataset.tab)));
$("#engineToggleBtn").onclick = () => engineModeClick("prev");
$("#engineCurBtn").onclick = () => engineModeClick("cur");
$("#engineClearBtn").onclick = clearAnalysisHistory;
$("#engineExportBtn").onclick = exportAnalysisHistory;
// 🤖 AI走棋 tab: clear log + per-step 演示/加入 (reuse openDemo/addPvLine).
if ($("#autoClearBtn")) $("#autoClearBtn").onclick = clearAutoHistory;
$("#autoHistory").addEventListener("click", (e) => {
  const entryEl = e.target.closest(".engEntry");
  if (!entryEl) return;
  const entry = autoEntryUpTo(Number(entryEl.dataset.seq));
  if (e.target.closest(".autoDemo")) openDemo(entry);
  else if (e.target.closest(".autoAdd")) addPvLine(entry);
});
// ☁ 雲庫演繹: derive (on-demand) + reuse the engine line's demo / add-to-tree.
if ($("#cdbLineRunBtn")) $("#cdbLineRunBtn").onclick = deriveCdbLine;
if ($("#cdbLineDemoBtn")) $("#cdbLineDemoBtn").onclick = () => openDemo(cdbLineEntry());
if ($("#cdbLineAddBtn")) $("#cdbLineAddBtn").onclick = () => addPvLine(cdbLineEntry());
// AI 分析 (whole-line trend) — run button + chart query line (hover to read
// each step's move + score; click to jump the board to that position).
$("#aiAnalyzeBtn").onclick = analyzeCurrentLine;
$("#aiAnalyzeBtn").innerHTML = iconLabel("chart", "掃描");
const aiChartEl = $("#aiChart");
if (aiChartEl) {
  aiChartEl.addEventListener("mousemove", (e) => {
    const i = aiIndexFromEvent(e);
    if (i < 0 || i === EDITOR.aiAnalysis.queryIdx) return;
    EDITOR.aiAnalysis.queryIdx = i;
    renderAiView();
  });
  aiChartEl.addEventListener("mouseleave", () => {
    if (EDITOR.aiAnalysis.queryIdx == null) return;
    EDITOR.aiAnalysis.queryIdx = null;
    renderAiView();
  });
  aiChartEl.addEventListener("click", (e) => {
    const i = aiIndexFromEvent(e);
    const pt = EDITOR.aiAnalysis.points[i];
    if (pt) navigateTo(pt.path || []);
  });
  // Redraw when the pane/chart is resized (splitter drag, window resize) so the
  // viewBox tracks the pixel size.
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => { if (EDITOR.aiAnalysis.points.length) renderAiView(); }).observe(aiChartEl);
  }
}
// AI analysis search depth — adjustable in settings, persisted to prefs.
const aiDepthInput = $("#aiDepthInput");
if (aiDepthInput) {
  aiDepthInput.addEventListener("change", () => {
    let v = parseInt(aiDepthInput.value, 10);
    if (!Number.isFinite(v)) v = 12;
    v = Math.max(1, Math.min(30, v));
    aiDepthInput.value = v;
    savePreference("aiAnalysisDepth", v);
  });
}
const aiDepth2Input = $("#aiDepth2Input");
if (aiDepth2Input) {
  aiDepth2Input.addEventListener("change", () => {
    let v = parseInt(aiDepth2Input.value, 10);
    if (!Number.isFinite(v)) v = 20;
    v = Math.max(1, Math.min(30, v));
    aiDepth2Input.value = v;
    savePreference("aiAnalysisDepth2", v);
  });
}
// ☁ 雲庫演繹 max plies — adjustable in settings, persisted to prefs.
const cdbLineDepthInput = $("#cdbLineDepthInput");
if (cdbLineDepthInput) {
  cdbLineDepthInput.addEventListener("change", () => {
    let v = parseInt(cdbLineDepthInput.value, 10);
    if (!Number.isFinite(v)) v = 12;
    v = Math.max(1, Math.min(30, v));
    cdbLineDepthInput.value = v;
    savePreference("cdbLineDepth", v);
  });
}
const cdbLineThrottleInput = $("#cdbLineThrottleInput");
if (cdbLineThrottleInput) {
  cdbLineThrottleInput.addEventListener("change", () => {
    let v = parseInt(cdbLineThrottleInput.value, 10);
    if (!Number.isFinite(v)) v = 250;
    v = Math.max(100, Math.min(2000, v));
    cdbLineThrottleInput.value = v;
    savePreference("cdbLineThrottleMs", v);
  });
}
const aiDiffThreshInput = $("#aiDiffThreshInput");
if (aiDiffThreshInput) {
  aiDiffThreshInput.addEventListener("change", () => {
    let v = parseInt(aiDiffThreshInput.value, 10);
    if (!Number.isFinite(v)) v = 200;
    v = Math.max(0, Math.min(2000, v));
    aiDiffThreshInput.value = v;
    savePreference("aiDiffThreshold", v);
    // Re-flag the already-analysed line against the new threshold.
    if (EDITOR.aiAnalysis.points.length) renderAiView();
  });
}
const aiBlunderThreshInput = $("#aiBlunderThreshInput");
if (aiBlunderThreshInput) {
  aiBlunderThreshInput.addEventListener("change", () => {
    let v = parseInt(aiBlunderThreshInput.value, 10);
    if (!Number.isFinite(v)) v = 200;
    v = Math.max(0, Math.min(2000, v));
    aiBlunderThreshInput.value = v;
    savePreference("aiBlunderThreshold", v);
    // Re-flag the line + translate any newly-qualifying 漏著 best alternatives.
    if (EDITOR.aiAnalysis.points.length) { renderAiView(); fillAiBlunderBest(); }
  });
}
const gifDelayInput = $("#gifDelayInput");
if (gifDelayInput) {
  gifDelayInput.addEventListener("change", () => {
    let v = parseFloat(gifDelayInput.value);
    if (!Number.isFinite(v)) v = 0.65;
    v = Math.max(0.2, Math.min(5, v));
    v = Math.round(v * 100) / 100;
    gifDelayInput.value = v;
    savePreference("gifFrameDelaySec", v);
  });
}
const aiDualChk = $("#aiDualChk");
if (aiDualChk) {
  aiDualChk.addEventListener("change", () => savePreference("aiDualDepth", aiDualChk.checked));
}
// 棋盤動效 — persist + update the board.js dataset hook live (no reload needed).
const boardAnimChk = $("#boardAnimChk");
if (boardAnimChk) boardAnimChk.addEventListener("change", () => {
  savePreference("boardAnim", boardAnimChk.checked);
  document.documentElement.dataset.boardAnim = boardAnimChk.checked ? "on" : "off";
});
const boardSoundChk = $("#boardSoundChk");
if (boardSoundChk) boardSoundChk.addEventListener("change", () => {
  savePreference("boardSound", boardSoundChk.checked);
  document.documentElement.dataset.boardSound = boardSoundChk.checked ? "on" : "off";
});
// AI 自動走棋 settings — persisted to prefs; read live by the auto-play loop.
const autoAiRedChk = $("#autoAiRedChk");
if (autoAiRedChk) autoAiRedChk.addEventListener("change", () => savePreference("autoAiRed", autoAiRedChk.checked));
const autoAiBlackChk = $("#autoAiBlackChk");
if (autoAiBlackChk) autoAiBlackChk.addEventListener("change", () => savePreference("autoAiBlack", autoAiBlackChk.checked));
const autoRedSecsInput = $("#autoRedSecsInput");
if (autoRedSecsInput) {
  autoRedSecsInput.addEventListener("change", () => {
    let v = parseInt(autoRedSecsInput.value, 10);
    if (!Number.isFinite(v)) v = 3;
    v = Math.max(1, Math.min(120, v));
    autoRedSecsInput.value = v;
    savePreference("autoRedSecs", v);
  });
}
const autoBlackSecsInput = $("#autoBlackSecsInput");
if (autoBlackSecsInput) {
  autoBlackSecsInput.addEventListener("change", () => {
    let v = parseInt(autoBlackSecsInput.value, 10);
    if (!Number.isFinite(v)) v = 3;
    v = Math.max(1, Math.min(120, v));
    autoBlackSecsInput.value = v;
    savePreference("autoBlackSecs", v);
  });
}
const autoMaxPliesInput = $("#autoMaxPliesInput");
if (autoMaxPliesInput) {
  autoMaxPliesInput.addEventListener("change", () => {
    let v = parseInt(autoMaxPliesInput.value, 10);
    if (!Number.isFinite(v)) v = 200;
    v = Math.max(2, Math.min(600, v));
    autoMaxPliesInput.value = v;
    savePreference("autoMaxPlies", v);
  });
}
// 前一步/本步 are a segmented mode toggle (text-only, like 雲庫 當前步/下一步);
// the active analysed mode is shown via the .active highlight, not an icon.
$("#engineToggleBtn").textContent = "前一步";
$("#engineCurBtn").textContent = "本步";
$("#engineClearBtn").innerHTML = iconLabel("trash", "清除");
$("#engineExportBtn").innerHTML = iconLabel("clipboard", "導出");
$("#rpTabVars").innerHTML = iconLabel("branch", "走法");
$("#rpTabCdb").innerHTML = iconLabel("cloud", "雲庫");
if ($("#rpTabCdbLine")) $("#rpTabCdbLine").innerHTML = iconLabel("cloud", "雲庫演繹");
$("#rpTabEngine").innerHTML = iconLabel("fish", "引擎分析");
$("#rpTabAuto").innerHTML = iconLabel("bot", "AI走棋");
if ($("#autoClearBtn")) $("#autoClearBtn").innerHTML = iconLabel("trash", "清除");
// 雲庫 / 雲庫演繹 control bars — unify the stray Unicode glyphs (⟳▶▷⎘) on SVG.
if ($("#cdbRefreshBtn")) $("#cdbRefreshBtn").innerHTML = iconLabel("refresh", "重查");
if ($("#cdbLineRunBtn")) $("#cdbLineRunBtn").innerHTML = iconLabel("play", "演繹");
if ($("#cdbLineDemoBtn")) $("#cdbLineDemoBtn").innerHTML = iconLabel("demo", "演示");
if ($("#cdbLineAddBtn")) $("#cdbLineAddBtn").innerHTML = iconLabel("plus", "加入");
if ($("#exportGifBtn")) $("#exportGifBtn").innerHTML = ICON.film;   // 🎬 emoji → Lucide film
// 雲庫 tab: 重查 forces a fresh chessdb.cn query (skips both caches) of the
// position the tab is currently showing (當前步/下一步), matching the list.
$("#cdbRefreshBtn").onclick = () => { const f = cdbTabFen(); if (f) fetchCdbLive(f, true); };
// 當前步 / 下一步 toggle — switch which position the 雲庫 tab queries.
function updateCdbScopeBtns() {
  const prev = $("#cdbScopePrev"), next = $("#cdbScopeNext");
  if (prev) prev.classList.toggle("active", EDITOR.cdbScope !== "next");
  if (next) next.classList.toggle("active", EDITOR.cdbScope === "next");
}
function setCdbScope(scope) {
  scope = scope === "next" ? "next" : "prev";
  if (EDITOR.cdbScope === scope) return;
  EDITOR.cdbScope = scope;
  savePreference("cdbScope", scope);
  updateCdbScopeBtns();
  const f = cdbTabFen();
  if (f) ensureCdbLive(f); else renderCdbTab();
}
if ($("#cdbScopePrev")) $("#cdbScopePrev").onclick = () => setCdbScope("prev");
if ($("#cdbScopeNext")) $("#cdbScopeNext").onclick = () => setCdbScope("next");
$("#anTabAnnote").innerHTML = iconLabel("note", "注解");
$("#anTabAi").innerHTML = iconLabel("chart", "AI分析");
// Unify the rest of the system's buttons on the same icon set.
$("#metaBtn").innerHTML = ICON.trophy;   // compact icon-only in the title row
$("#saveBtn").innerHTML = iconLabel("save", "儲存");
$("#newXqfBtn").innerHTML = iconLabel("plus", "新增");
$("#rescanBtn").innerHTML = iconLabel("refresh", "重掃");
$("#settingsBtn").innerHTML = ICON.settings;
$("#navDelete").innerHTML = ICON.trash;
$("#navFirst").innerHTML = ICON.skipBack;
$("#navPrev").innerHTML = ICON.chevL;
$("#navBranch").innerHTML = ICON.branch;  // icon-only; hint lives in the title attr
$("#navNext").innerHTML = ICON.chevR;
$("#navLast").innerHTML = ICON.skipFwd;
updateAutoPlayBtn();   // sets #autoStartBtn icon+label (play/開始 ↔ stop/停止)
$("#rootPickBtn").innerHTML = ICON.folder;
$("#evalDbPickBtn").innerHTML = ICON.folder;
$("#enginePickBtn").innerHTML = ICON.folder;
$("#demoFirst").innerHTML = ICON.skipBack;
$("#demoPrev").innerHTML = ICON.chevL;
$("#demoNext").innerHTML = ICON.chevR;
$("#demoLast").innerHTML = ICON.skipFwd;
$("#demoExtendBtn").innerHTML = iconLabel("fish", "延伸");
$("#demoAddBtn").innerHTML = iconLabel("branch", "加入");
// Per-line 演示 / 加入 (event-delegated; the history list re-renders often).
$("#engineHistory").addEventListener("click", (e) => {
  const entryEl = e.target.closest(".engEntry");
  if (!entryEl) return;
  const entry = EDITOR.engineAnalysis.history.find((x) => x.depth === Number(entryEl.dataset.depth));
  if (!entry) return;
  if (e.target.closest(".engDemo")) openDemo(entry);
  else if (e.target.closest(".engAdd")) addPvLine(entry);
});
// 演示 dialog controls.
$("#demoFirst").onclick = () => demoGo(0);
$("#demoPrev").onclick = () => demoGo(EDITOR.demo.idx - 1);
$("#demoNext").onclick = () => demoGo(EDITOR.demo.idx + 1);
$("#demoLast").onclick = () => demoGo(EDITOR.demo.fens.length - 1);
$("#demoPlay").onclick = demoTogglePlay;
$("#demoExtendBtn").onclick = demoExtend;
$("#demoAddBtn").onclick = demoAdd;
const demoExtendDepthInput = $("#demoExtendDepth");
if (demoExtendDepthInput) {
  // Value is hydrated from PREFS in boot() (after loadPreferences); here we only
  // wire the change handler that persists edits.
  demoExtendDepthInput.addEventListener("change", () => {
    let v = parseInt(demoExtendDepthInput.value, 10);
    if (!Number.isFinite(v)) v = 16;
    v = Math.max(6, Math.min(40, v));
    demoExtendDepthInput.value = v;
    savePreference("demoExtendDepth", v);
  });
}
$("#demoClose").onclick = closeDemo;
$("#demoModal").addEventListener("click", (e) => { if (e.target.id === "demoModal") closeDemo(); });
reorderEvalRows();

// Board theme picker. Initial value applied in boot() after PREFS load.
ensureBoardThemeOptions();
const themeSel = $("#boardThemeSel");
themeSel.addEventListener("change", () => applyBoardTheme(themeSel.value));
if ($("#perspectiveBtn")) $("#perspectiveBtn").onclick = togglePerspective;
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
      const startPos = isRow ? e.clientY : e.clientX;

      splitter.classList.add("dragging");
      document.body.classList.add("dragging");
      if (isRow) document.body.classList.add("dragging-row");

      const onMove = (ev) => {
        const cur = isRow ? ev.clientY : ev.clientX;
        const delta = cur - startPos;
        const next = Math.max(80, startSize + delta);
        target.style.flexBasis = next + "px";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        splitter.classList.remove("dragging");
        document.body.classList.remove("dragging", "dragging-row");
        if (prefKey) {
          const size = isRow ? target.offsetHeight : target.offsetWidth;
          savePreference(prefKey, size);
        }
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}

// Expand every ancestor folder down to `rel`, scroll it into view, and either
// LOAD it (doLoad=true — boot's auto-reopen) or just HIGHLIGHT it without
// loading (doLoad=false — used after a rescan, so the open game isn't disturbed).
// Returns whether the file's <li> was found in the (possibly just-rebuilt) tree.
async function revealFileInTree(rel, doLoad) {
  if (!rel) return false;
  // CBL 盤（rel 形如 lib.cbl#3）的盤目是懶載入的，DOM 中尚未渲染——先展開該庫。
  const hash = rel.lastIndexOf("#");
  if (hash !== -1 && rel.slice(0, hash).toLowerCase().endsWith(".cbl")) {
    const baseRel = rel.slice(0, hash);
    const cblLi = Array.from(document.querySelectorAll("#fileTree li.dir.cbl"))
      .find((li) => li.dataset.rel === baseRel);
    if (cblLi) {
      let p = cblLi.parentElement;
      const tRoot = document.getElementById("fileTree");
      while (p && p !== tRoot) { if (p.tagName === "UL") p.style.display = ""; p = p.parentElement; }
      // 未載過才展開（toggleCblDir 對已展開的庫是 toggle，會收合）。
      const sub = cblLi.querySelector("ul");
      if (sub && sub.dataset.loaded !== "1") {
        await toggleCblDir(cblLi.querySelector(".dirname"), sub, baseRel);
      }
    }
  }
  // data-rel uniquely identifies each file li. Linear scan is fine for any
  // realistic library size.
  const fileLi = Array.from(document.querySelectorAll("#fileTree li.file"))
    .find((li) => li.dataset.rel === rel);
  if (!fileLi) return false;
  // Expand every ancestor <ul> (collapsed by default).
  let el = fileLi.parentElement;
  const treeRoot = document.getElementById("fileTree");
  while (el && el !== treeRoot) {
    if (el.tagName === "UL") el.style.display = "";
    el = el.parentElement;
  }
  if (doLoad) {
    await selectFile(rel, fileLi);
  } else {
    document.querySelectorAll("#fileTree li.file.active").forEach((e) => e.classList.remove("active"));
    fileLi.classList.add("active");
  }
  fileLi.scrollIntoView({ block: "nearest" });
  return true;
}

// Restore the last opened file: expand down to it, highlight, and load it
// (same flow as a click).
async function tryAutoLoadLastFile() {
  if (PREFS.lastFile) await revealFileInTree(PREFS.lastFile, true);
}

// Re-scan the library root: re-fetch /api/xqf/list and repaint the tree so
// files added/removed on disk (outside the editor) show up. Does NOT touch the
// currently-open game — no reload, no unsaved-edit guard — it only repaints the
// tree, then re-expands+highlights the open file so the user keeps their place.
async function rescanTree() {
  if (!EDITOR.rootOk) return;
  const btn = $("#rescanBtn");
  if (btn) btn.disabled = true;
  const keepRel = EDITOR.currentPath || null;
  setStatus("重新掃描中…");
  try {
    await loadFileTree();
    if (keepRel) await revealFileInTree(keepRel, false);   // 還原定位，不重新載入
    setStatus("已重新掃描目錄", "ok");
  } catch (e) {
    setStatus("重新掃描失敗：" + (e.message || e), "err");
  } finally {
    if (btn) btn.disabled = !EDITOR.rootOk;
  }
}

// Auto-detect files added/removed on disk when the tab regains focus (the
// natural moment after dropping a file in Explorer and switching back). Probes
// /api/xqf/list and ONLY repaints when the structure signature changed — so an
// unchanged tree keeps the user's expand state and doesn't flash status. Does
// not touch the open game; throttled so rapid focus flips fire one probe.
let lastAutoRescanAt = 0;
const AUTO_RESCAN_MIN_GAP_MS = 4000;
async function autoRescanIfChanged() {
  if (document.visibilityState !== "visible" || !EDITOR.rootOk) return;
  const now = Date.now();
  if (now - lastAutoRescanAt < AUTO_RESCAN_MIN_GAP_MS) return;
  lastAutoRescanAt = now;
  let tree;
  try {
    const r = await fetch("/api/xqf/list");
    tree = await r.json();
  } catch { return; }                            // 網路抖動：靜默略過，下次切回再試
  if (!tree || tree.needsRoot || tree.error) return;
  if (JSON.stringify(tree) === EDITOR.treeSig) return;   // 結構沒變→不重繪、不收合、不閃 status
  const keepRel = EDITOR.currentPath || null;
  await loadFileTree(tree);                       // 用已抓到的 tree 重繪（更新 treeSig）
  if (keepRel) await revealFileInTree(keepRel, false);
  setStatus("已偵測到檔案變更，更新清單", "ok");
}

// When a configured path is missing/invalid but localStorage remembers a
// different last-good one, offer to restore it (and persist it server-side).
// This is the safety net for a wiped/relocated preferences.json: the browser
// still knows the path that worked last time. Runs after the boot info fetches
// so EDITOR.*Info reflect the server's current (possibly broken) state.
async function recoverSettingsFromLocalStorage() {
  // Library root (directory).
  if (EDITOR.rootOk === false) {
    const r = lsGet(LS_KEYS.root);
    if (r && r !== EDITOR.rootPath
      && await showConfirmDialog(`棋譜根目錄無法使用，要套用上次記住的位置「${r}」嗎？`, "回復設定")) {
      await applyRoot(r);
    }
  }
  // Eval DB (file).
  const ei = EDITOR.evalDbInfo || {};
  if (!ei.exists) {
    const r = lsGet(LS_KEYS.evalDb);
    if (r && r !== ei.path
      && await showConfirmDialog(`評估資料庫無法使用，要套用上次記住的位置「${r}」嗎？`, "回復設定")) {
      await applyEvalDbPath(r);
    }
  }
  // Pikafish engine (file).
  const gi = EDITOR.engineInfo || {};
  if (!(gi.exists && gi.ok)) {
    const r = lsGet(LS_KEYS.engine);
    if (r && r !== gi.path
      && await showConfirmDialog(`皮卡魚引擎無法使用，要套用上次記住的位置「${r}」嗎？`, "回復設定")) {
      await applyEnginePath(r);
    }
  }
}

// ---------- async boot ----------
// Order: PREFS -> theme -> splitters -> file tree -> auto-open last file.
(async function boot() {
  await loadPreferences();
  applyBoardFxPrefs();   // sync data-board-anim / data-board-sound hooks for board.js
  const savedTheme = PREFS.boardTheme;
  if (savedTheme && ["traditional", "stone", "gilded", "copperwood", "celadon"].includes(savedTheme)) {
    themeSel.value = savedTheme;
    document.documentElement.dataset.board = savedTheme;
  }
  const savedBoardPerspective = PREFS.boardPerspective === "black" ? "black" : "red";
  applyBoardPerspective(savedBoardPerspective);   // also syncs #perspectiveBtn
  const savedUiTheme = PREFS.uiTheme;
  const initialUiTheme = UI_THEMES[savedUiTheme] ? savedUiTheme : "pineash";
  if (uiThemeSel) uiThemeSel.value = initialUiTheme;
  document.documentElement.dataset.uiTheme = initialUiTheme;
  const aiDepthEl = $("#aiDepthInput");
  if (aiDepthEl) aiDepthEl.value = aiDepth();
  const aiDepth2El = $("#aiDepth2Input");
  if (aiDepth2El) aiDepth2El.value = aiDepth2();
  const aiDiffThreshEl = $("#aiDiffThreshInput");
  if (aiDiffThreshEl) aiDiffThreshEl.value = aiDiffThreshold();
  const aiBlunderThreshEl = $("#aiBlunderThreshInput");
  if (aiBlunderThreshEl) aiBlunderThreshEl.value = aiBlunderThreshold();
  const aiDualEl = $("#aiDualChk");
  if (aiDualEl) aiDualEl.checked = aiDualEnabled();
  const cdbLineDepthEl = $("#cdbLineDepthInput");
  if (cdbLineDepthEl) cdbLineDepthEl.value = cdbLineDepth();
  const cdbLineThrottleEl = $("#cdbLineThrottleInput");
  if (cdbLineThrottleEl) cdbLineThrottleEl.value = cdbLineThrottle();
  EDITOR.cdbScope = PREFS.cdbScope === "next" ? "next" : "prev";
  updateCdbScopeBtns();
  const gifDelayEl = $("#gifDelayInput");
  if (gifDelayEl) gifDelayEl.value = gifFrameDelaySec();
  if ($("#boardAnimChk")) $("#boardAnimChk").checked = PREFS.boardAnim !== false;   // default ON
  if ($("#boardSoundChk")) $("#boardSoundChk").checked = PREFS.boardSound !== false; // default ON
  // AI 自動走棋 settings reflect persisted prefs on open.
  if ($("#autoAiRedChk")) $("#autoAiRedChk").checked = autoAiRed();
  if ($("#autoAiBlackChk")) $("#autoAiBlackChk").checked = autoAiBlack();
  if ($("#autoRedSecsInput")) $("#autoRedSecsInput").value = autoRedSecs();
  if ($("#autoBlackSecsInput")) $("#autoBlackSecsInput").value = autoBlackSecs();
  if ($("#autoMaxPliesInput")) $("#autoMaxPliesInput").value = autoMaxPlies();
  if ($("#demoExtendDepth")) $("#demoExtendDepth").value = demoExtendDepth();   // 演示「延伸」搜尋層數, persisted
  renderAnnotePresets();   // static chips, read from PREFS (defaults until managed)
  setupSplitters();
  // Pulsing badge on the empty board while the tree + last file load, so the
  // UI doesn't open on a blank board. Themes are already applied above, so the
  // accent colour is correct.
  drawBoardLoading("棋譜載入中…");
  // Parallelisable on boot — eval info is independent of the XQF tree fetch
  // and we want it ready before tryAutoLoadLastFile triggers fetchEvalsForFile.
  await Promise.all([fetchEvalDbInfo(), fetchEngineInfo(), fetchThresholds(), loadFileTree()]);
  // Offer to restore any path the server lost but the browser still remembers,
  // before auto-loading (root recovery reloads the tree autoload depends on).
  await recoverSettingsFromLocalStorage();
  await tryAutoLoadLastFile();
  // No last file (or it vanished) → tryAutoLoadLastFile never drew a position;
  // settle the pulse into a static idle prompt instead of spinning forever.
  if (!EDITOR.data) drawBoardLoading("尚未載入棋譜 · 從左側選擇", false);
})();
