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
};

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

// ---------- file tree ----------

async function loadFileTree() {
  const r = await fetch("/api/xqf/list");
  const tree = await r.json();
  if (tree.error) { $("#fileTree").textContent = "錯誤：" + tree.error; return; }
  $("#fileTree").innerHTML = "";
  $("#fileTree").appendChild(renderDir(tree));
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
    const fileName = rel.split("/").pop();
    $("#fileTitle").textContent = fileName;
    $("#fileTitle").title = rel;  // full path on hover
    $("#saveBtn").disabled = false;
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
    m.textContent = "★";
    m.title = "本步有其他走法";
    row.appendChild(m);
  }
  if (node.annote) {
    const a = document.createElement("span");
    a.className = "plyMark";
    a.title = node.annote;
    a.textContent = "✎";
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
  refreshActive();
}

function refreshActive() {
  const path = EDITOR.activePath;
  const { fen, lastIccs } = fenAndLastIccsFor(path);
  // board.js drawBoard signature: drawBoard(svg, fen, bookMove, engineMove)
  drawBoard($("#board"), fen, lastIccs, null);

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
  annoteBox.value = node ? (node.annote || "") : "";
  annoteBox.disabled = (node === null);

  renderVarPicker();

  if (node) {
    $("#moveInfo").textContent = `第 ${node.ply} 步：${node.notation}（${node.iccs}）`;
  } else {
    $("#moveInfo").textContent = "初始局面";
  }

  $("#navFirst").disabled  = path.length === 0;
  $("#navPrev").disabled   = path.length === 0;
  $("#navBranch").disabled = path.length === 0;
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
  opts.forEach((opt, i) => {
    const row = document.createElement("div");
    row.className = "varOpt" + (i === activeIdx ? " active" : "");
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
  const node = nodeAt(EDITOR.activePath);
  if (!node) return;
  const newVal = $("#annoteBox").value;
  if (node.annote !== newVal) node.annote = newVal;
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
    setStatus(`已儲存（備份：${resp.bak}）`, "ok");
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
  // Don't intercept keys while typing in textarea (esp. arrow keys for cursor).
  if (document.activeElement && document.activeElement.tagName === "TEXTAREA") return;
  if (!EDITOR.data) return;
  switch (e.key) {
    case "ArrowLeft":  navPrev();    e.preventDefault(); break;
    case "ArrowRight": navNext();    e.preventDefault(); break;
    case "ArrowUp":    navVarUp();   e.preventDefault(); break;
    case "ArrowDown":  navVarDown(); e.preventDefault(); break;
    case "Home":       navFirst();          e.preventDefault(); break;
    case "End":        navLast();           e.preventDefault(); break;
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
$("#navFirst").onclick = navFirst;
$("#navPrev").onclick = navPrev;
$("#navBranch").onclick = navToNearestBranch;
$("#navNext").onclick = navNext;
$("#navLast").onclick = navLast;

// Annote textarea: commit on every keystroke so EDITOR.data stays in sync.
$("#annoteBox").addEventListener("input", commitAnnoteEdit);

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
