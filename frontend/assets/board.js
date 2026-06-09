// Static-site renderer for the per-game page.
// Single source of truth = STATE { vi, pi }. Every UI update routes through activatePly
// or selectVariation, both of which always stop any running demo first.

const SVG_NS = "http://www.w3.org/2000/svg";

const PIECE_CHAR = {
  K: "帥", A: "仕", B: "相", N: "傌", R: "俥", C: "砲", P: "兵",
  k: "將", a: "士", b: "象", n: "馬", r: "車", c: "包", p: "卒",
};

// ---------- generic helpers ----------

function el(tag, attrs, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(node);
  return node;
}

// Module-level flag so screenY can flip without threading a parameter through
// every call site. Set by drawBoard at the start of each redraw.
let CURRENT_REDP = true;

function screenX(col) {
  // Perspective switch is a true 180° rotation, so X also flips.
  return CURRENT_REDP ? (30 + col * 60) : (30 + (8 - col) * 60);
}
function screenY(row) {
  // Red perspective: row 0 (red back rank) at bottom of SVG, row 9 at top.
  // Black perspective: row 0 at top, row 9 at bottom.
  return CURRENT_REDP ? (30 + (9 - row) * 60) : (30 + row * 60);
}

function iccsToCoord(iccs) {
  if (!iccs || iccs.length < 4) return null;
  const a = "a".charCodeAt(0);
  return {
    from: { col: iccs.charCodeAt(0) - a, row: parseInt(iccs[1], 10) },
    to:   { col: iccs.charCodeAt(2) - a, row: parseInt(iccs[3], 10) },
  };
}

function parseFen(fen) {
  const parts = fen.split(/\s+/);
  const boardStr = parts[0];
  const side = parts[1] || "w";
  const rows = [];
  for (const rs of boardStr.split("/")) {
    const row = [];
    for (const ch of rs) {
      if (/\d/.test(ch)) {
        for (let i = 0; i < parseInt(ch, 10); i++) row.push(null);
      } else {
        row.push(ch);
      }
    }
    while (row.length < 9) row.push(null);
    rows.push(row);
  }
  const byIccsRow = [];
  for (let r = 0; r <= 9; r++) byIccsRow[r] = rows[9 - r];
  return { rows: byIccsRow, side };
}

// Apply one ICCS move to a FEN, returning the resulting FEN. Used to derive
// PV step positions on the fly so we don't have to ship a fen_after per step
// (saves tens of MB on positions_view.js). Xiangqi has no castling / en-passant
// / promotion, so a piece overwrite + side flip is the complete update.
function applyIccs(fen, iccs) {
  if (!fen || !iccs || iccs.length < 4) return fen;
  const sp = fen.indexOf(" ");
  const pos = sp >= 0 ? fen.slice(0, sp) : fen;
  const side = sp >= 0 ? fen.slice(sp + 1).trim().charAt(0) : "w";
  const rows = pos.split("/").map((row) => {
    const arr = [];
    for (const ch of row) {
      if (ch >= "1" && ch <= "9") {
        for (let i = 0; i < +ch; i++) arr.push(".");
      } else {
        arr.push(ch);
      }
    }
    while (arr.length < 9) arr.push(".");
    return arr;
  });
  const a = "a".charCodeAt(0);
  const ff = iccs.charCodeAt(0) - a;
  const fr = parseInt(iccs[1], 10);
  const tf = iccs.charCodeAt(2) - a;
  const tr = parseInt(iccs[3], 10);
  // FEN row 0 = rank 9 (top), row 9 = rank 0 (bottom).
  const fromRow = 9 - fr, toRow = 9 - tr;
  const piece = rows[fromRow][ff];
  rows[toRow][tf] = piece;
  rows[fromRow][ff] = ".";
  const newPos = rows.map((row) => {
    let out = "", run = 0;
    for (const ch of row) {
      if (ch === ".") { run++; continue; }
      if (run > 0) { out += run; run = 0; }
      out += ch;
    }
    if (run > 0) out += run;
    return out;
  }).join("/");
  return `${newPos} ${side === "w" ? "b" : "w"}`;
}

function getEntry(fen) {
  return (window.POSITIONS && window.POSITIONS[fen]) || null;
}

// Always returns score in RED perspective (positive = red advantage). Used by chart.
function redPerspectiveScore(entry, sideToMove) {
  if (!entry) return null;
  if (entry.mate != null) {
    let s = entry.mate > 0 ? 1000 : -1000;
    if (sideToMove === "black") s = -s;
    return s;
  }
  if (entry.score == null) return null;
  return sideToMove === "black" ? -entry.score : entry.score;
}

// Build a synthetic entry that uses the deep_* fields so existing
// red-perspective and delta helpers can be reused unchanged.
function deepEntry(entry) {
  if (!entry || (entry.deep_score == null && entry.deep_mate == null)) return null;
  return { score: entry.deep_score, mate: entry.deep_mate };
}

function redPerspectiveDeepScore(fen, sideToMove) {
  return redPerspectiveScore(deepEntry(getEntry(fen)), sideToMove);
}

// Loss computed from deep eval (depth 22) instead of shallow (depth 12).
function deepDeltaCp(plies, i) {
  if (i < 0 || i >= plies.length - 1) return null;
  const p = plies[i];
  const pn = plies[i + 1];
  if (!p.fen || !pn.fen) return null;
  const r  = redPerspectiveDeepScore(p.fen,  p.side);
  const rn = redPerspectiveDeepScore(pn.fen, pn.side);
  if (r == null || rn == null) return null;
  return p.side === "red" ? r - rn : rn - r;
}

// "Loss" = how much cp the side-to-move at step i gave up by playing the book move.
// Computed as: red_persp(i) - red_persp(i+1) for red-to-move, negated for black.
// Positive = the moving side lost cp (their move was suboptimal).
function deltaCp(plies, i) {
  if (i < 0 || i >= plies.length - 1) return null;
  const p = plies[i];
  const pn = plies[i + 1];
  if (!p.fen || !pn.fen) return null;
  const r  = redPerspectiveScore(getEntry(p.fen),  p.side);
  const rn = redPerspectiveScore(getEntry(pn.fen), pn.side);
  if (r == null || rn == null) return null;
  return p.side === "red" ? r - rn : rn - r;
}

function deltaClass(loss) {
  if (loss == null) return "";
  if (loss > 200) return "delta-blunder";
  if (loss > 100) return "delta-mistake";
  if (loss > 50) return "delta-inaccuracy";
  return "delta-neutral";
}

function fmtDelta(v) {
  if (v == null) return "";
  const sign = v > 0 ? "+" : "";
  return sign + Math.round(v);
}

// All numeric columns use red perspective unconditionally: positive = red is
// favored, negative = black is favored. The 紅方視角 checkbox now only affects
// the board orientation (not the table numbers).
function fmtScore(entry, sideToMove) {
  if (!entry) return { text: "?", cls: "" };
  if (entry.mate != null) {
    let m = entry.mate;
    if (sideToMove === "black") m = -m;
    return { text: m > 0 ? `M${m}` : `-M${-m}`, cls: m > 0 ? "score-positive" : "score-negative" };
  }
  let s = entry.score;
  if (s == null) return { text: "?", cls: "" };
  if (sideToMove === "black") s = -s;
  return {
    text: (s >= 0 ? "+" : "") + s,
    cls: s >= 0 ? "score-positive" : "score-negative",
  };
}

// Red-perspective signed delta. Positive = red gained cp between i and i+1;
// negative = red lost cp. Magnitude regardless of which side moved.
function redDelta(plies, i) {
  if (i < 0 || i >= plies.length - 1) return null;
  const p = plies[i], pn = plies[i + 1];
  if (!p.fen || !pn.fen) return null;
  const r  = redPerspectiveScore(getEntry(p.fen),  p.side);
  const rn = redPerspectiveScore(getEntry(pn.fen), pn.side);
  if (r == null || rn == null) return null;
  return rn - r;
}

function deepRedDelta(plies, i) {
  if (i < 0 || i >= plies.length - 1) return null;
  const p = plies[i], pn = plies[i + 1];
  if (!p.fen || !pn.fen) return null;
  const r  = redPerspectiveDeepScore(p.fen,  p.side);
  const rn = redPerspectiveDeepScore(pn.fen, pn.side);
  if (r == null || rn == null) return null;
  return rn - r;
}

// Color class for any red-POV signed value (used by 分, Δ, 深Δ, 雲庫 columns).
function deltaSignClass(v) {
  if (v == null) return "";
  const a = Math.abs(v);
  if (a <= 50) return "delta-neutral";
  const sign = v > 0 ? "pos" : "neg";
  const mag = a > 100 ? "strong" : "mild";
  return `delta-${sign}-${mag}`;
}

// ---------- board styles ----------
// Independent of page theme. Read from <html data-board="...">; persisted in
// localStorage as "chessbookBoard". Switching is via a picker injected into
// the game header by initGamePage. Adding a new style: add an entry below
// and a font key; the picker re-reads BOARD_STYLES automatically.

// Piece-character fonts. The `text=` URL parameter restricts the Google Fonts
// subset to the 14 piece glyphs + 楚河漢界, keeping the load <10KB even for
// huge fonts like Ma Shan Zheng.
const PIECE_CHARS_SUBSET = "帥仕相傌俥砲兵將士象馬車包卒楚河漢界";

// Piece-character font registry. Each entry is lazy-loaded via the `text=`
// Google Fonts URL trick: only the 16 piece glyphs + 楚河漢界 ship, keeping
// the font payload <10KB. dy is the vertical text offset that centers the
// glyph inside a 52-px piece disc.
const PIECE_FONTS = {
  classic: {
    family: "serif",
    weight: "bold",
    dy: 10,
    googleUrl: null,
  },
  // LXGW WenKai TC — free Traditional-Chinese textbook kaishu (楷書). Cleaner
  // than brush fonts, warmer than Songti, well-balanced strokes at 28px.
  wenkai: {
    family: '"LXGW WenKai TC", "Noto Serif TC", "Songti TC", serif',
    weight: "700",
    dy: 11,
    googleUrl: "https://fonts.googleapis.com/css2?family=LXGW+WenKai+TC:wght@700&text=" +
               encodeURIComponent(PIECE_CHARS_SUBSET) + "&display=swap",
  },
};

const _loadedFonts = new Set();
function ensurePieceFontLoaded(key) {
  const f = PIECE_FONTS[key];
  if (!f || !f.googleUrl || _loadedFonts.has(key)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = f.googleUrl;
  document.head.appendChild(link);
  _loadedFonts.add(key);
}

const BOARD_STYLES = {
  traditional: {
    label: "傳統手繪",
    font: "wenkai",
    background: { kind: "wood" },
    grid:   { stroke: "#4a3010", width: 1, outer: 3 },
    coord:  { color: "#5a3a1a", font: "serif" },
    river:  { color: "#5a3a1a", style: "italic" },
    // Classic flat-ish wooden pieces — subtle gradient + drop shadow + inner
    // ring, but NO glossy specular dot and NO engraved character (those made
    // the discs look like glass beads instead of wood).
    red:    { fill: "#fff5db", border: "#8b1a0e", innerRing: "#c0392b", text: "#c0392b",
              grad: { from: "#fff5db", to: "#e8c889" } },
    black:  { fill: "#222",    border: "#000",    innerRing: "#888",    text: "#f5f5f5",
              grad: { from: "#3a3a3a", to: "#101010" } },
    piece:  { shadow: "soft", innerRing: true, gradient: true,
              specular: false, engrave: false, rim: false },
    lastMove: { kind: "box",  color: "#2980b9" },
    suggest:  { kind: "ring", color: "#e67e22" },
  },
  // 雅石回紋: stone-cream board with a Chinese 回紋 meander border in sepia and
  // pieces that share the same cream disk + sepia border. Inspired by the
  // "空城計" reference — feels archaeological / textbook-classical.
  stone: {
    label: "雅石回紋",
    font: "wenkai",
    background: { kind: "stone", color: "#e9dbb4", grain: "#7a5a2a" },
    // The meander now also carries band + bevel info so it reads as a raised
    // ornament instead of a flat printed line.
    grid: {
      stroke: "#5a3a1a", width: 0.9, outer: 1.5,
      meander: {
        ink: "#3a2510",            // meander stroke colour
        band: "#cfa46b",           // raised frame face colour
        highlight: "#f4dba6",      // outer-edge highlight
        shadow: "#5e3a14",         // inner-edge shadow
        bandWidth: 18,
      },
    },
    coord:  { color: "#7a5a2a", font: "serif" },
    river:  { color: "#5a3a1a", style: "normal" },
    // Both sides are coloured wooden discs with cream characters (matches the
    // "空城計"-style reference: red side a dark cherry-wood, black side a deep
    // slate, neither washed out against the stone ground).
    red:    { fill: "#9a2818", border: "#4a0c08", innerRing: null, text: "#fbe7c2",
              grad: { from: "#c0392b", to: "#5a0c0a" } },
    black:  { fill: "#2a2a2a", border: "#0c0c0c", innerRing: null, text: "#fbe7c2",
              grad: { from: "#5a5a5a", to: "#0c0c0c" } },
    piece:  { shadow: "strong", innerRing: false, gradient: true,
              specular: true, engrave: true, rim: true },
    lastMove: { kind: "ring", color: "#d4a043" },
    suggest:  { kind: "ring", color: "#c0392b" },
  },
  // 鎏金歲月: premium dark slate with gold grid lines and a gold-rule outer
  // frame; deep crimson lacquer for red pieces and gunmetal silver for black.
  // The most striking option — feels like a high-end set.
  gilded: {
    label: "鎏金歲月",
    font: "wenkai",
    background: { kind: "darkmetal", color: "#1a1612" },
    grid:   { stroke: "#c89244", width: 0.9, outer: 1.5, doubleFrame: true, frameColor: "#d4a043" },
    coord:  { color: "#c89244", font: "serif" },
    river:  { color: "#d4a043", style: "normal" },
    red:    { fill: "#7a1818", border: "#3a0c0c", innerRing: null, text: "#fbeed1",
              grad: { from: "#c0392b", to: "#5a0c0c" } },
    black:  { fill: "#2a2a2a", border: "#0c0c0c", innerRing: null, text: "#fbeed1",
              grad: { from: "#7a7a7a", to: "#1a1a1a" } },
    piece:  { shadow: "strong", innerRing: false, gradient: true,
              specular: true, engrave: true, rim: true },
    lastMove: { kind: "ring", color: "#d4a043" },
    suggest:  { kind: "ring", color: "#e26054" },
  },
  copperwood: {
    label: "copperwood",
    font: "wenkai",
    background: { kind: "wood" },
    grid:   { stroke: "#5a3318", width: 1, outer: 3 },
    coord:  { color: "#6a4325", font: "serif" },
    river:  { color: "#714323", style: "italic" },
    red:    { fill: "#f6e2cb", border: "#8e3d20", innerRing: "#b85b33", text: "#b14b29",
              grad: { from: "#fff2df", to: "#deb187" } },
    black:  { fill: "#2d221c", border: "#120d0a", innerRing: "#8b776a", text: "#f4eadf",
              grad: { from: "#4a3a31", to: "#17110d" } },
    piece:  { shadow: "soft", innerRing: true, gradient: true,
              specular: false, engrave: false, rim: false },
    lastMove: { kind: "box", color: "#a95a2a" },
    suggest:  { kind: "ring", color: "#cf6a32" },
  },
  celadon: {
    label: "celadon",
    font: "wenkai",
    background: { kind: "stone", color: "#c8d2ca", grain: "#6f8177" },
    grid:   { stroke: "#55685f", width: 1.0, outer: 1.8 },
    coord:  { color: "#61756c", font: "serif" },
    river:  { color: "#5c7068", style: "normal" },
    red:    { fill: "#efe4d7", border: "#87534d", innerRing: null, text: "#b0554a",
              grad: { from: "#f9f1e8", to: "#d8c7b8" } },
    black:  { fill: "#2f3a36", border: "#141917", innerRing: null, text: "#eef2ef",
              grad: { from: "#4d5c56", to: "#1f2623" } },
    piece:  { shadow: "strong", innerRing: false, gradient: true,
              specular: false, engrave: true, rim: true },
    lastMove: { kind: "ring", color: "#6b8a7e" },
    suggest:  { kind: "ring", color: "#bf6253" },
  },
};

function currentBoardStyle() {
  const name = document.documentElement.dataset.board || "traditional";
  return BOARD_STYLES[name] || BOARD_STYLES.traditional;
}

// Mix two #rrggbb colours; t=0 returns a, t=1 returns b. Used to derive
// shaded variants (darker band-bottom, etc.) without hand-tuning every theme.
function mixHex(a, b, t) {
  const pa = a.replace("#", ""), pb = b.replace("#", "");
  const ar = parseInt(pa.slice(0, 2), 16), ag = parseInt(pa.slice(2, 4), 16), ab = parseInt(pa.slice(4, 6), 16);
  const br = parseInt(pb.slice(0, 2), 16), bg = parseInt(pb.slice(2, 4), 16), bb = parseInt(pb.slice(4, 6), 16);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return "#" + [r, g, bl].map((v) => v.toString(16).padStart(2, "0")).join("");
}

// Draws a classical 回紋 (meander / key fret) frame as a raised ornament
// around the play area. Composed of:
//   1) a band ring filled with a vertical gradient (top lighter, bottom darker
//      → reads as raised, lit from above)
//   2) outer perimeter chamfer (2 highlight lines, tight + soft)
//   3) inner perimeter chamfer (2 shadow lines, tight + soft) plus a thin
//      reflected-light line just inside the play area
//   4) the meander units themselves, drawn in two passes (engraved highlight
//      underneath + dark ink on top)
// `opts` shape: { ink, band, highlight, shadow, bandDark, bandWidth }.
function drawMeanderFrame(svg, opts) {
  if (typeof opts === "string") opts = { ink: opts };
  const ink = opts.ink || "#3a2510";
  const band = opts.band;
  const bandDark = opts.bandDark || mixHex(opts.band || "#cfa46b", "#000000", 0.45);
  const highlight = opts.highlight;
  const shadow = opts.shadow;
  const B = opts.bandWidth || 18;
  const W = 540, H = 600;

  if (band) {
    // 1) Band ring (hollow rect via evenodd) filled with a vertical gradient
    //    that simulates the raised face catching light from above.
    let defs = svg.querySelector("defs");
    if (!defs) defs = el("defs", {}, svg);
    if (!svg.querySelector("#bandgrad")) {
      const bg = el("linearGradient", { id: "bandgrad", x1: "0", y1: "0", x2: "0", y2: "1" }, defs);
      el("stop", { offset: "0%",   "stop-color": highlight || band }, bg);
      el("stop", { offset: "45%",  "stop-color": band }, bg);
      el("stop", { offset: "100%", "stop-color": bandDark }, bg);
    }
    const ringPath = `M 0 0 H ${W} V ${H} H 0 Z M ${B} ${B} V ${H - B} H ${W - B} V ${B} Z`;
    el("path", { d: ringPath, fill: "url(#bandgrad)", "fill-rule": "evenodd" }, svg);

    // 2) Outer-edge double highlight (chamfered raised lip)
    if (highlight) {
      el("rect", { x: 0.6, y: 0.6, width: W - 1.2, height: H - 1.2,
                   fill: "none", stroke: highlight, "stroke-width": 1.4, "stroke-opacity": 0.95 }, svg);
      el("rect", { x: 2.5, y: 2.5, width: W - 5, height: H - 5,
                   fill: "none", stroke: highlight, "stroke-width": 0.7, "stroke-opacity": 0.45 }, svg);
    }
    // 3) Inner-edge double shadow (recessed lip) + reflected highlight inside
    if (shadow) {
      el("rect", { x: B - 0.5, y: B - 0.5, width: W - 2 * B + 1, height: H - 2 * B + 1,
                   fill: "none", stroke: shadow, "stroke-width": 1.6, "stroke-opacity": 0.85 }, svg);
      el("rect", { x: B - 2, y: B - 2, width: W - 2 * B + 4, height: H - 2 * B + 4,
                   fill: "none", stroke: shadow, "stroke-width": 0.7, "stroke-opacity": 0.45 }, svg);
      if (highlight) {
        el("rect", { x: B + 0.8, y: B + 0.8, width: W - 2 * B - 1.6, height: H - 2 * B - 1.6,
                     fill: "none", stroke: highlight, "stroke-width": 0.4, "stroke-opacity": 0.45 }, svg);
      }
    }
  }

  // 2) Meander unit (18 × 9): two parallel rules + an inner spiral hook.
  const unitPath = "M 0 0 H 18 M 0 9 H 18 M 4 1 V 7 H 14 V 3 H 8 V 5";
  const yTop = (B - 9) / 2;             // centre meander vertically in top band
  const yBot = H - B + (B - 9) / 2;     // ... and bottom band
  // rotate(90) around origin maps local (a,b) -> screen (-b, a). After
  // translate(lx, y), the unit spans screen x ∈ [lx - 9, lx]. To centre it
  // in the left band [0, B], lx must be (B + 9) / 2 — NOT (B - 9) / 2.
  // (The original was off by 9px, pushing half the meander off the board.)
  const lx = (B + 9) / 2;               // left band: unit screen x ∈ [lx-9, lx] centred in [0, B]
  const rx = W - (B + 9) / 2;           // right band: unit screen x ∈ [rx, rx+9] centred in [W-B, W]
  const stroke = { stroke: ink, "stroke-width": 0.9, fill: "none", "stroke-opacity": 0.92 };
  const engrave = highlight ? { stroke: highlight, "stroke-width": 0.9, fill: "none", "stroke-opacity": 0.55 } : null;

  // Top + bottom bands: tile units edge-to-edge across the play width.
  for (let x = B; x + 18 <= W - B; x += 18) {
    if (engrave) {
      el("path", { d: unitPath, ...engrave, transform: `translate(${x}, ${yTop + 1})` }, svg);
      el("path", { d: unitPath, ...engrave, transform: `translate(${x}, ${yBot + 1})` }, svg);
    }
    el("path", { d: unitPath, ...stroke, transform: `translate(${x}, ${yTop})` }, svg);
    el("path", { d: unitPath, ...stroke, transform: `translate(${x}, ${yBot})` }, svg);
  }
  // Left + right bands: rotated units, tiled edge-to-edge down the play height.
  for (let y = B + 18; y <= H - B; y += 18) {
    if (engrave) {
      el("path", { d: unitPath, ...engrave, transform: `translate(${lx + 1}, ${y}) rotate(90)` }, svg);
      el("path", { d: unitPath, ...engrave, transform: `translate(${rx + 1}, ${y - 18}) rotate(-90)` }, svg);
    }
    el("path", { d: unitPath, ...stroke, transform: `translate(${lx}, ${y}) rotate(90)` }, svg);
    el("path", { d: unitPath, ...stroke, transform: `translate(${rx}, ${y - 18}) rotate(-90)` }, svg);
  }
}

// ---------- board drawing (SVG) ----------

function drawBoard(svg, fen, bookMove, engineMove) {
  // Latch perspective for this redraw so screenY (called many times below)
  // doesn't re-poll the checkbox each call.
  CURRENT_REDP = isRedPerspective();
  const S = currentBoardStyle();
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  // Always create a single defs block — backgrounds, pieces and shadows all
  // share it. Per-style addons (gradients, patterns) get appended below.
  const defs = el("defs", {}, svg);

  // Piece radial-gradient registration (used by both red and black where
  // `red.grad` / `black.grad` are defined). The hot-spot sits upper-left and
  // is extended with an explicit white-tinted mid-stop so the highlight pops
  // before the colour falls into shadow.
  if (S.piece.gradient) {
    for (const side of ["red", "black"]) {
      const g = S[side].grad;
      if (!g) continue;
      const rg = el("radialGradient", {
        id: `pg-${side}`,
        cx: "30%", cy: "25%", r: "85%",
      }, defs);
      // Bright tint of the "from" colour to make the highlight read clearly
      const hot = mixHex(g.from, "#ffffff", 0.35);
      el("stop", { offset: "0%",   "stop-color": hot }, rg);
      el("stop", { offset: "28%",  "stop-color": g.from }, rg);
      el("stop", { offset: "100%", "stop-color": g.to   }, rg);
    }
  }

  // Soft elliptical drop-shadow for pieces (radial, fades to transparent).
  if (S.piece.shadow) {
    const sg = el("radialGradient", { id: "pshadow", cx: "50%", cy: "50%", r: "50%" }, defs);
    el("stop", { offset: "0%",   "stop-color": "rgba(0,0,0,0.55)" }, sg);
    el("stop", { offset: "65%",  "stop-color": "rgba(0,0,0,0.22)" }, sg);
    el("stop", { offset: "100%", "stop-color": "rgba(0,0,0,0)"    }, sg);
  }

  // Specular highlight — small white radial used as an overlay dot at the
  // upper-left of each piece. Sells the "glossy bead" feel. Only registered
  // when the style explicitly opts in (traditional skips this for a more
  // matte / wood-disc look).
  if (S.piece.specular) {
    const spc = el("radialGradient", { id: "pspec", cx: "50%", cy: "50%", r: "50%" }, defs);
    el("stop", { offset: "0%",   "stop-color": "rgba(255,255,255,0.85)" }, spc);
    el("stop", { offset: "55%",  "stop-color": "rgba(255,255,255,0.15)" }, spc);
    el("stop", { offset: "100%", "stop-color": "rgba(255,255,255,0)" }, spc);
  }

  // Background
  if (S.background.kind === "wood") {
    // 1) Vertical gradient — base wood colour with subtle top/bottom darkening
    const grad = el("linearGradient", { id: "wood", x1: "0", y1: "0", x2: "0", y2: "1" }, defs);
    el("stop", { offset: "0%",   "stop-color": "#bb8f5a" }, grad);
    el("stop", { offset: "50%",  "stop-color": "#e2c089" }, grad);
    el("stop", { offset: "100%", "stop-color": "#bb8f5a" }, grad);
    // 2) Real wood grain: feTurbulence (long horizontal stretch via
    //    asymmetric baseFrequency) creates organic streaks. We pipe it
    //    through feColorMatrix to recolour the grey-scale noise into warm
    //    brown ink, then composite at low alpha over the gradient.
    const fl = el("filter", { id: "woodgrain", x: "0", y: "0", width: "100%", height: "100%" }, defs);
    el("feTurbulence", { type: "fractalNoise", baseFrequency: "0.035 0.55",
                         numOctaves: "3", seed: "7", result: "noise" }, fl);
    el("feColorMatrix", { in: "noise", values:
      "0 0 0 0 0.35 " +     // R = 0.35
      "0 0 0 0 0.20 " +     // G = 0.20
      "0 0 0 0 0.08 " +     // B = 0.08
      "0 0 0 0.35 0",       // A driven by noise alpha
      result: "tinted" }, fl);
    // 3) A second, lower-frequency knotty noise for darker wood ribbons
    const fl2 = el("filter", { id: "woodgrain2", x: "0", y: "0", width: "100%", height: "100%" }, defs);
    el("feTurbulence", { type: "fractalNoise", baseFrequency: "0.012 0.18",
                         numOctaves: "2", seed: "13", result: "noise2" }, fl2);
    el("feColorMatrix", { in: "noise2", values:
      "0 0 0 0 0.25 " +
      "0 0 0 0 0.13 " +
      "0 0 0 0 0.04 " +
      "0 0 0 0.20 0" }, fl2);
    el("rect", { x: 0, y: 0, width: 540, height: 600, fill: "url(#wood)" }, svg);
    el("rect", { x: 0, y: 0, width: 540, height: 600, fill: "#bb8f5a", filter: "url(#woodgrain2)" }, svg);
    el("rect", { x: 0, y: 0, width: 540, height: 600, fill: "#bb8f5a", filter: "url(#woodgrain)" }, svg);
  } else if (S.background.kind === "paper") {
    const pat = el("pattern", { id: "papergrain", x: "0", y: "0", width: "14", height: "14", patternUnits: "userSpaceOnUse" }, defs);
    el("circle", { cx: 3, cy: 3, r: 0.5, fill: S.background.noise, "fill-opacity": 0.18 }, pat);
    el("circle", { cx: 9, cy: 8, r: 0.4, fill: S.background.noise, "fill-opacity": 0.12 }, pat);
    el("circle", { cx: 12, cy: 12, r: 0.35, fill: S.background.noise, "fill-opacity": 0.15 }, pat);
    el("rect", { x: 0, y: 0, width: 540, height: 600, fill: S.background.color }, svg);
    el("rect", { x: 0, y: 0, width: 540, height: 600, fill: "url(#papergrain)" }, svg);
  } else if (S.background.kind === "stone") {
    // Mottled stone: a coarse dot pattern over a cream base, plus a vignette
    // gradient to add depth at the corners.
    const pat = el("pattern", { id: "stonegrain", x: "0", y: "0", width: "9", height: "9", patternUnits: "userSpaceOnUse" }, defs);
    el("circle", { cx: 2, cy: 2, r: 0.6, fill: S.background.grain, "fill-opacity": 0.20 }, pat);
    el("circle", { cx: 6, cy: 5, r: 0.4, fill: S.background.grain, "fill-opacity": 0.14 }, pat);
    el("circle", { cx: 4, cy: 7, r: 0.5, fill: S.background.grain, "fill-opacity": 0.10 }, pat);
    const vg = el("radialGradient", { id: "stonevg", cx: "50%", cy: "50%", r: "70%" }, defs);
    el("stop", { offset: "55%", "stop-color": "rgba(0,0,0,0)" }, vg);
    el("stop", { offset: "100%", "stop-color": "rgba(70,40,10,0.18)" }, vg);
    el("rect", { x: 0, y: 0, width: 540, height: 600, fill: S.background.color }, svg);
    el("rect", { x: 0, y: 0, width: 540, height: 600, fill: "url(#stonegrain)" }, svg);
    el("rect", { x: 0, y: 0, width: 540, height: 600, fill: "url(#stonevg)" }, svg);
  } else if (S.background.kind === "darkmetal") {
    // Deep slate ground with a subtle metallic sheen + soft top/bottom shadow.
    const grad = el("linearGradient", { id: "darkmetal", x1: "0", y1: "0", x2: "0", y2: "1" }, defs);
    el("stop", { offset: "0%",   "stop-color": "#241d16" }, grad);
    el("stop", { offset: "45%",  "stop-color": "#1a1612" }, grad);
    el("stop", { offset: "100%", "stop-color": "#0e0b08" }, grad);
    el("rect", { x: 0, y: 0, width: 540, height: 600, fill: "url(#darkmetal)" }, svg);
    // Brushed-metal hatching
    const pat = el("pattern", { id: "hatch", x: "0", y: "0", width: "60", height: "3", patternUnits: "userSpaceOnUse" }, defs);
    el("line", { x1: 0, y1: 1.5, x2: 60, y2: 1.5, stroke: "rgba(212,160,67,0.05)", "stroke-width": 0.5 }, pat);
    el("rect", { x: 0, y: 0, width: 540, height: 600, fill: "url(#hatch)" }, svg);
  } else {
    el("rect", { x: 0, y: 0, width: 540, height: 600, fill: S.background.color }, svg);
  }

  // Last-move highlight: from/to indicators in the per-style shape.
  if (bookMove) {
    const c = iccsToCoord(bookMove);
    if (c) {
      const fx = screenX(c.from.col), fy = screenY(c.from.row);
      const tx = screenX(c.to.col),   ty = screenY(c.to.row);
      if (S.lastMove.kind === "box") {
        el("rect", {
          x: fx - 26, y: fy - 26, width: 52, height: 52,
          rx: 4, ry: 4, fill: "none", stroke: S.lastMove.color, "stroke-width": 1.5, "stroke-opacity": 0.4,
          "stroke-dasharray": "4 3",
        }, svg);
        el("rect", {
          x: tx - 28, y: ty - 28, width: 56, height: 56,
          rx: 4, ry: 4, fill: "none", stroke: S.lastMove.color, "stroke-width": 2.5,
        }, svg);
      } else if (S.lastMove.kind === "ring") {
        el("circle", {
          cx: fx, cy: fy, r: 28,
          fill: "none", stroke: S.lastMove.color, "stroke-width": 1.5, "stroke-opacity": 0.4,
          "stroke-dasharray": "4 3",
        }, svg);
        el("circle", {
          cx: tx, cy: ty, r: 30,
          fill: "none", stroke: S.lastMove.color, "stroke-width": 2,
        }, svg);
      } else if (S.lastMove.kind === "dot") {
        el("circle", { cx: fx, cy: fy, r: 6, fill: S.lastMove.color, opacity: 0.35 }, svg);
        el("circle", { cx: tx, cy: ty, r: 9, fill: S.lastMove.color }, svg);
      }
    }
  }
  // Engine suggestion: dashed ring at destination (kept consistent across styles)
  if (engineMove && engineMove !== bookMove) {
    const c = iccsToCoord(engineMove);
    if (c) {
      el("circle", {
        cx: screenX(c.to.col), cy: screenY(c.to.row), r: 28,
        fill: "none", stroke: S.suggest.color, "stroke-width": 2, "stroke-dasharray": "5 4",
      }, svg);
    }
  }

  // Grid lines
  const gw = S.grid.width;
  for (let r = 0; r <= 9; r++) {
    el("line", { x1: 30, y1: 30 + r * 60, x2: 510, y2: 30 + r * 60, stroke: S.grid.stroke, "stroke-width": gw }, svg);
  }
  for (let c = 0; c <= 8; c++) {
    if (c === 0 || c === 8) {
      el("line", { x1: 30 + c * 60, y1: 30, x2: 30 + c * 60, y2: 570, stroke: S.grid.stroke, "stroke-width": gw }, svg);
    } else {
      el("line", { x1: 30 + c * 60, y1: 30,  x2: 30 + c * 60, y2: 270, stroke: S.grid.stroke, "stroke-width": gw }, svg);
      el("line", { x1: 30 + c * 60, y1: 330, x2: 30 + c * 60, y2: 570, stroke: S.grid.stroke, "stroke-width": gw }, svg);
    }
  }
  const frameColor = S.grid.frameColor || S.grid.stroke;
  el("rect", { x: 30, y: 30, width: 480, height: 540, fill: "none", stroke: frameColor, "stroke-width": S.grid.outer }, svg);
  // Optional second rule outside the play area (vintage / metallic look).
  if (S.grid.doubleFrame) {
    el("rect", { x: 21, y: 21, width: 498, height: 558, fill: "none", stroke: frameColor, "stroke-width": 1, "stroke-opacity": 0.85 }, svg);
    el("rect", { x: 17, y: 17, width: 506, height: 566, fill: "none", stroke: frameColor, "stroke-width": 0.5, "stroke-opacity": 0.55 }, svg);
  }
  // Optional 回紋 meander key-pattern along the outer band.
  if (S.grid.meander) {
    drawMeanderFrame(svg, S.grid.meander);
  }

  // Palace diagonals
  const palace = [
    [screenX(3), screenY(2), screenX(5), screenY(0)],
    [screenX(5), screenY(2), screenX(3), screenY(0)],
    [screenX(3), screenY(9), screenX(5), screenY(7)],
    [screenX(5), screenY(9), screenX(3), screenY(7)],
  ];
  for (const [x1, y1, x2, y2] of palace) {
    el("line", { x1, y1, x2, y2, stroke: S.grid.stroke, "stroke-width": gw }, svg);
  }

  // River text. text-anchor:middle centres on the text's advance width, but
  // Chromium adds letter-spacing AFTER the last glyph too, so the measured
  // advance is one letter-spacing wider than the visible glyphs — pulling the
  // string left by letter-spacing/2. Nudge x right by half the letter-spacing
  // (38/2 = 19) so the visible characters sit centred on the board midline 270.
  const river = el("text", {
    x: 289, y: 308, "text-anchor": "middle", "font-size": 24,
    fill: S.river.color, "font-family": "serif", "letter-spacing": 38,
    "font-style": S.river.style,
  }, svg);
  river.textContent = "楚河      漢界";

  // Coordinate labels (col 1..9 from red's left perspective = ICCS col a..i)
  for (let c = 0; c <= 8; c++) {
    const x = screenX(c);
    const labelTop = el("text", { x, y: 18, "text-anchor": "middle", "font-size": 11, fill: S.coord.color, "font-family": S.coord.font }, svg);
    labelTop.textContent = c + 1;
    const labelBot = el("text", { x, y: 590, "text-anchor": "middle", "font-size": 11, fill: S.coord.color, "font-family": S.coord.font }, svg);
    labelBot.textContent = c + 1;
  }

  // Pieces — style-driven disk + character
  const parsed = fen ? parseFen(fen) : null;
  if (parsed) {
    for (let r = 0; r <= 9; r++) {
      for (let c = 0; c <= 8; c++) {
        const p = parsed.rows[r][c];
        if (!p) continue;
        const isRed = p === p.toUpperCase();
        const cx = screenX(c), cy = screenY(r);
        const PS = isRed ? S.red : S.black;
        // Drop shadow.
        //   "strong" → wide ambient + tight contact (glossy/premium pieces)
        //   "soft"   → just the ambient ellipse (matte / wooden disc feel)
        //   true     → legacy hard 1.5px offset shadow (kept for back-compat)
        if (S.piece.shadow === "strong") {
          el("ellipse", { cx, cy: cy + 5, rx: 28, ry: 10, fill: "url(#pshadow)" }, svg);
          el("ellipse", { cx, cy: cy + 1.5, rx: 25, ry: 25, fill: "rgba(0,0,0,0.18)" }, svg);
        } else if (S.piece.shadow === "soft") {
          el("ellipse", { cx, cy: cy + 4, rx: 26, ry: 7, fill: "url(#pshadow)" }, svg);
        } else if (S.piece.shadow) {
          el("circle", { cx: cx + 1.5, cy: cy + 1.5, r: 26, fill: "rgba(0,0,0,0.22)" }, svg);
        }
        // Outer disk — gradient fill when style enables it
        el("circle", {
          cx, cy, r: 26,
          fill: (S.piece.gradient && PS.grad) ? `url(#pg-${isRed ? "red" : "black"})` : PS.fill,
          stroke: PS.border,
          "stroke-width": 1.5,
        }, svg);
        // Optional inner-rim shadow (dome bevel)
        if (S.piece.rim) {
          el("circle", { cx, cy, r: 24.5, fill: "none",
                         stroke: "rgba(0,0,0,0.35)", "stroke-width": 1 }, svg);
        }
        // Optional inner ring (traditional style)
        if (S.piece.innerRing && PS.innerRing) {
          el("circle", {
            cx, cy, r: 22, fill: "none",
            stroke: PS.innerRing, "stroke-width": 1,
          }, svg);
        }
        // Optional specular highlight — glossy bead spot at upper-left
        if (S.piece.specular) {
          el("ellipse", { cx: cx - 7, cy: cy - 9, rx: 10, ry: 7, fill: "url(#pspec)" }, svg);
        }
        // Character — optional engraved shadow under main glyph (looks like
        // the character is pressed into the disc face).
        const PF = PIECE_FONTS[S.font] || PIECE_FONTS.classic;
        if (S.piece.engrave) {
          const ts = el("text", {
            x: cx, y: cy + PF.dy + 1.2, "text-anchor": "middle",
            "font-size": 28, "font-family": PF.family, "font-weight": PF.weight,
            fill: "rgba(0,0,0,0.45)",
          }, svg);
          ts.textContent = PIECE_CHAR[p] || p;
        }
        const t = el("text", {
          x: cx, y: cy + PF.dy, "text-anchor": "middle",
          "font-size": 28, "font-family": PF.family, "font-weight": PF.weight,
          fill: PS.text,
        }, svg);
        t.textContent = PIECE_CHAR[p] || p;
      }
    }
  }
}

// Re-draw the board at the current STATE using whatever board style is now
// active. Called when the board-style picker changes.
function redrawCurrentBoard() {
  if (!STATE.GAME || !SVG_BOARD) return;
  if (STATE.pi >= 0) {
    const ply = STATE.GAME.variations[STATE.vi][STATE.pi];
    const entry = getEntry(ply.fen);
    drawBoard(SVG_BOARD, ply.fen_after || ply.fen, ply.iccs, entry ? entry.best_iccs : null);
  } else {
    drawBoard(SVG_BOARD, STATE.GAME.init_fen, null, null);
  }
}

// Injects a "棋盤" picker next to the existing theme picker in the game header.
// Done in JS (not in the rendered HTML) so adding/changing styles only requires
// editing this file — no need to re-render the 41 game pages.
function injectBoardPicker() {
  const themePicker = document.querySelector("header.game-header .theme-picker");
  if (!themePicker || document.getElementById("boardPicker")) return;

  const label = document.createElement("label");
  label.className = "theme-picker board-picker";
  const opts = Object.entries(BOARD_STYLES)
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
    .join("");
  label.innerHTML = `棋盤<select id="boardPicker">${opts}</select>`;
  themePicker.parentNode.insertBefore(label, themePicker);

  const sel = label.querySelector("select");
  const stored = localStorage.getItem("chessbookBoard") || "traditional";
  const initial = BOARD_STYLES[stored] ? stored : "traditional";
  document.documentElement.dataset.board = initial;
  sel.value = initial;
  // Load the font for the currently chosen style up front, so the very first
  // drawBoard render in selectVariation gets the correct glyphs.
  ensurePieceFontLoaded(BOARD_STYLES[initial].font);
  sel.addEventListener("change", () => {
    const v = sel.value;
    document.documentElement.dataset.board = v;
    localStorage.setItem("chessbookBoard", v);
    ensurePieceFontLoaded(BOARD_STYLES[v].font);
    redrawCurrentBoard();
    // The Google Font may resolve asynchronously — re-draw shortly after to
    // pick up the swap once it loads.
    if (BOARD_STYLES[v].font !== "classic") {
      setTimeout(redrawCurrentBoard, 600);
    }
  });
}

// ---------- score chart ----------

const CHART_W = 540, CHART_H = 140;
const CHART_PAD_L = 28, CHART_PAD_R = 8, CHART_PAD_T = 10, CHART_PAD_B = 16;
const CHART_RANGE = 500; // cp clamp range; M scores rendered as +/-1000 then clamped

function drawChart(svg, plies, activePly) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const innerW = CHART_W - CHART_PAD_L - CHART_PAD_R;
  const innerH = CHART_H - CHART_PAD_T - CHART_PAD_B;
  const cy0 = CHART_PAD_T + innerH / 2;

  el("rect", { x: 0, y: 0, width: CHART_W, height: CHART_H, fill: "#faf3df" }, svg);

  const yOf = (s) => cy0 - (s / CHART_RANGE) * (innerH / 2);
  const xOf = (i) => {
    if (plies.length <= 1) return CHART_PAD_L + innerW / 2;
    return CHART_PAD_L + (i / (plies.length - 1)) * innerW;
  };

  // Grid lines + labels
  [-500, -250, 0, 250, 500].forEach((s) => {
    const y = yOf(s);
    el("line", {
      x1: CHART_PAD_L, y1: y, x2: CHART_W - CHART_PAD_R, y2: y,
      stroke: s === 0 ? "#888" : "#e8d8a8",
      "stroke-width": 1,
      "stroke-dasharray": s === 0 ? "0" : "3 3",
    }, svg);
    const t = el("text", { x: 2, y: y + 3, "font-size": 9, fill: "#888" }, svg);
    t.textContent = s;
  });

  // Collect data points (red perspective so the line is a continuous trend)
  const data = [];
  for (let i = 0; i < plies.length; i++) {
    const p = plies[i];
    if (!p.fen) continue;
    const e = getEntry(p.fen);
    if (!e) continue;
    const s = redPerspectiveScore(e, p.side);
    if (s == null) continue;
    const clamped = Math.max(-CHART_RANGE, Math.min(CHART_RANGE, s));
    data.push({ i, s, clamped, side: p.side });
  }
  if (!data.length) return;

  let d = "";
  data.forEach((pt, idx) => {
    d += (idx === 0 ? "M" : "L") + xOf(pt.i).toFixed(1) + " " + yOf(pt.clamped).toFixed(1);
  });
  el("path", { d, fill: "none", stroke: "#3498db", "stroke-width": 1.5 }, svg);

  // Points (clickable). Big-loss steps get a red halo; active step gets an orange ring.
  data.forEach((pt) => {
    const x = xOf(pt.i), y = yOf(pt.clamped);
    const loss = deltaCp(plies, pt.i);
    if (loss != null && loss > 100) {
      el("circle", {
        cx: x, cy: y, r: 5,
        fill: "none",
        stroke: loss > 200 ? "#c0392b" : "#d68910",
        "stroke-width": 2,
      }, svg);
    }
    if (pt.i === activePly) {
      el("circle", { cx: x, cy: y, r: 8, fill: "none", stroke: "#f39c12", "stroke-width": 2 }, svg);
    }
    const c = el("circle", {
      cx: x, cy: y, r: 3,
      fill: pt.side === "red" ? "#c0392b" : "#1a1a1a",
      "data-ply": pt.i,
      style: "cursor:pointer",
    }, svg);
    const lossText = loss != null ? ` (失分 ${fmtDelta(loss)})` : "";
    const title = el("title", {}, c);
    title.textContent = `第 ${pt.i + 1} 步 · ${pt.s >= 0 ? "+" : ""}${pt.s}${lossText}`;
  });
}

// ---------- state ----------

const STATE = { vi: 0, pi: -1, GAME: null, demoTimer: null, demoMode: null };
let SVG_BOARD, SVG_CHART, STEP_INFO, ANNOTE_BOX, ALTS_BOX, NAV_STATUS, DEMO_BTN_S, DEMO_BTN_D, DEMO_BTN_VD, BRANCH_BTN, REDP_BOX;

// Custom variation picker — replaces the native <select> so we can render
// multi-level groups (HTML5 forbids nested <optgroup>). Trigger button +
// hidden panel of nested <details>. State: STATE.vi is the source of truth;
// this object only handles UI sync.
const VAR_PICKER = {
  root: null,
  trigger: null,
  panel: null,
  currentLabel: null,
  init() {
    this.root = document.getElementById("varpicker");
    if (!this.root) return;
    this.trigger = document.getElementById("varpickerTrigger");
    this.panel = document.getElementById("varpickerPanel");
    this.currentLabel = document.getElementById("varpickerCurrent");
    this.trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggle();
    });
    this.panel.querySelectorAll(".varpicker-option").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const vi = parseInt(btn.dataset.vi, 10);
        const pi = parseInt(btn.dataset.pi, 10);
        if (!Number.isNaN(vi)) {
          selectVariation(vi);
          // data-pi is the deepest ancestor group's divergence ply — jump
          // there so master lands at the step that makes this variation
          // unique, not at the start of a long shared opening prefix.
          if (!Number.isNaN(pi) && pi >= 0) activatePly(pi);
        }
        this.close();
      });
    });
    // Clicking a group <summary> navigates to the first variation under
    // that branch AND seeks to the branch step — but the picker stays
    // open so master can keep exploring siblings without re-opening.
    // Native <details> toggle still fires alongside (chevron rotates).
    this.panel.querySelectorAll(".vp-group > summary").forEach((sm) => {
      sm.addEventListener("click", (e) => {
        e.stopPropagation();
        const pi = parseInt(sm.dataset.pi, 10);
        const firstVi = parseInt(sm.dataset.firstVi, 10);
        if (!Number.isNaN(firstVi) && firstVi >= 0) {
          if (firstVi !== STATE.vi) selectVariation(firstVi);
          if (!Number.isNaN(pi) && pi >= 0) activatePly(pi);
        }
      });
    });
    // Close panel when clicking outside.
    document.addEventListener("click", (e) => {
      if (!this.panel || this.panel.hidden) return;
      if (this.root.contains(e.target)) return;
      this.close();
    });
    // ESC closes panel.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.panel && !this.panel.hidden) this.close();
    });
  },
  open() {
    if (!this.panel) return;
    this.panel.hidden = false;
    this.trigger.setAttribute("aria-expanded", "true");
    this.root.classList.add("open");
  },
  close() {
    if (!this.panel) return;
    this.panel.hidden = true;
    this.trigger.setAttribute("aria-expanded", "false");
    this.root.classList.remove("open");
  },
  toggle() {
    if (this.panel && this.panel.hidden) this.open(); else this.close();
  },
  setSelected(vi, plyCount) {
    if (!this.currentLabel) return;
    this.currentLabel.textContent = `變例 ${vi + 1} (${plyCount} 步)`;
    this.panel.querySelectorAll(".varpicker-option").forEach((b) => {
      b.classList.toggle("selected", parseInt(b.dataset.vi, 10) === vi);
    });
    // Auto-open every <details> ancestor of the selected option, so when
    // master next pops the panel the highlighted item is already visible.
    const selBtn = this.panel.querySelector(`.varpicker-option[data-vi="${vi}"]`);
    if (selBtn) {
      let p = selBtn.parentElement;
      while (p && p !== this.panel) {
        if (p.tagName === "DETAILS") p.open = true;
        p = p.parentElement;
      }
    }
  },
  setDisabled(disabled) {
    if (this.trigger) this.trigger.disabled = disabled;
    if (disabled) this.close();
  },
};

// Move-tree lookups, built once at initGamePage time from GAME.tree + GAME.variations.
// ALTS_BY_FEN: position-before-move -> list of alternative moves played from that
// position across all variations (deduped via tree merge in build_data.py).
// MOVE_LOOKUP: "fen|iccs" -> [variation_idx, ply_idx] for "click an alternative
// to jump to the variation that played it" navigation.
const ALTS_BY_FEN = {};
const MOVE_LOOKUP = {};

function isRedPerspective() {
  const box = REDP_BOX || document.getElementById("redPerspective");
  return box ? box.checked : true;
}

function stopDemo() {
  if (STATE.demoTimer) {
    clearTimeout(STATE.demoTimer);
    STATE.demoTimer = null;
  }
  STATE.demoMode = null;
  setDemoMode(false, null);
  updateDemoButtons();
}

function setDemoMode(active, mode) {
  document.querySelectorAll(".control-bar .nav-first, .control-bar .nav-prev, .control-bar .nav-next, .control-bar .nav-last, .control-bar .nav-branch").forEach((b) => {
    b.disabled = active;
  });
  VAR_PICKER.setDisabled(active);
  const allBtns = [DEMO_BTN_S, DEMO_BTN_D, DEMO_BTN_VD];
  if (active) {
    const activeBtn = mode === 'verydeep' ? DEMO_BTN_VD
                    : mode === 'deep'     ? DEMO_BTN_D
                    : DEMO_BTN_S;
    activeBtn.textContent = "■ 停止演示";
    activeBtn.classList.add("stop");
    activeBtn.disabled = false;
    allBtns.filter((b) => b && b !== activeBtn).forEach((b) => b.disabled = true);
  } else {
    DEMO_BTN_S.textContent = "▶ 演示 淺12";
    DEMO_BTN_S.classList.remove("stop");
    DEMO_BTN_D.textContent = "▶ 演示 深22";
    DEMO_BTN_D.classList.remove("stop");
    if (DEMO_BTN_VD) {
      DEMO_BTN_VD.textContent = "▶ 演示 深28";
      DEMO_BTN_VD.classList.remove("stop");
    }
  }
}

// Enable/disable demo buttons based on whether the current ply has shallow/deep/very-deep PV.
function updateDemoButtons() {
  if (STATE.demoTimer) return; // managed by setDemoMode during active demo
  let shallowOk = false, deepOk = false, vdeepOk = false;
  if (STATE.pi >= 0) {
    const ply = STATE.GAME.variations[STATE.vi][STATE.pi];
    const entry = getEntry(ply.fen);
    if (entry) {
      shallowOk = !!(entry.pv_detail && entry.pv_detail.length);
      deepOk    = !!(entry.deep_pv_detail && entry.deep_pv_detail.length);
      vdeepOk   = !!(entry.very_deep_pv_detail && entry.very_deep_pv_detail.length);
    }
  }
  DEMO_BTN_S.disabled = !shallowOk;
  DEMO_BTN_D.disabled = !deepOk;
  if (DEMO_BTN_VD) DEMO_BTN_VD.disabled = !vdeepOk;
  updateBranchButton();
}

// Walk BACKWARD from the current ply and stop at the FIRST upstream
// branching point — the immediately previous fork, regardless of width.
// Master prefers the closest divergence over the widest: at 車二進五,
// rewind to 包2平3 (a 2-way fork) rather than 馬三進四 (a wider 3-way
// fork one ply earlier).
function findNearestBranchPly() {
  if (!STATE.GAME) return -1;
  const plies = STATE.GAME.variations[STATE.vi];
  if (plies.length === 0) return -1;
  const from = STATE.pi >= 0 ? STATE.pi - 1 : plies.length - 2;
  for (let pi = from; pi >= 0; pi--) {
    const ply = plies[pi];
    const alts = ALTS_BY_FEN[ply.fen] || [];
    if (alts.length <= 1) continue;
    if (!alts.some(a => a.iccs !== ply.iccs)) continue;
    return pi;
  }
  return -1;
}

function updateBranchButton() {
  if (!BRANCH_BTN) return;
  BRANCH_BTN.disabled = (findNearestBranchPly() < 0);
}

function updateNavStatus() {
  const total = STATE.GAME.variations[STATE.vi].length;
  const cur = STATE.pi >= 0 ? STATE.pi + 1 : 0;
  NAV_STATUS.textContent = `第 ${cur} / ${total} 步`;
}

function updateStepInfo(ply, entry) {
  if (!ply) {
    STEP_INFO.innerHTML = '<span class="placeholder">點選表格任一步，或變例選單切換變例</span>';
    return;
  }
  if (!entry) {
    STEP_INFO.innerHTML = `<span class="item"><span class="label">書譜</span> ${ply.chinese} <code>${ply.iccs}</code></span><span class="placeholder">此局面未經分析</span>`;
    return;
  }
  const sc = fmtScore(entry, ply.side);
  const bestCn = entry.best_chinese || entry.best_iccs || "?";
  const same = entry.best_iccs === ply.iccs;
  const sideLabel = ply.side === "red" ? "紅" : "黑";
  const d = redDelta(STATE.GAME.variations[STATE.vi], STATE.pi);
  const lossSpan = d == null
    ? ''
    : `<span class="item"><span class="label">Δ</span> <span class="${deltaSignClass(d)}">${fmtDelta(d)}</span></span>`;
  STEP_INFO.innerHTML = `
    <span class="item"><span class="label">${sideLabel}方走子</span></span>
    <span class="item"><span class="label">書譜</span> ${ply.chinese} <code>${ply.iccs}</code></span>
    <span class="item"><span class="label">引擎</span> ${bestCn} <code>${entry.best_iccs || "?"}</code></span>
    <span class="item"><span class="label">分</span> <span class="${sc.cls}">${sc.text}</span></span>
    ${lossSpan}
    <span class="item ${same ? "" : "diff-tag"}">${same ? "相同" : "不同"}</span>
  `;
}

function annotateTable(vi) {
  // Fill engine columns + annote indicator in the now-visible variation's table.
  // ALL numeric columns use red-POV signed cp (positive = red favored).
  const plies = STATE.GAME.variations[vi];
  document.querySelectorAll(`.plies-wrap[data-var="${vi}"] tbody tr[data-fen]`).forEach((tr) => {
    const pi = parseInt(tr.dataset.ply, 10);
    const ply = plies[pi];

    // Annote indicator: XQStudio-style "*" marker + 💬 tooltip on the book cell.
    const bookCell = tr.querySelector(".book-cn");
    if (ply.annote) {
      if (!bookCell.querySelector(".annote-marker")) {
        const star = document.createElement("span");
        star.className = "annote-marker";
        star.title = ply.annote;
        star.textContent = " *";
        bookCell.appendChild(star);
      }
      tr.classList.add("has-annote");
    }

    const entry = getEntry(tr.dataset.fen);
    if (!entry) return;
    const bestCn = entry.best_chinese || entry.best_iccs || "?";
    tr.querySelector(".eng-best").innerHTML = `${bestCn} <code class="tiny">${entry.best_iccs || ""}</code>`;
    const sc = fmtScore(entry, ply.side);
    const scCell = tr.querySelector(".score");
    scCell.textContent = sc.text;
    scCell.className = "score " + sc.cls;

    const dShallow = redDelta(plies, pi);
    const dCell = tr.querySelector(".delta");
    dCell.textContent = fmtDelta(dShallow);
    dCell.className = "delta " + deltaSignClass(dShallow);

    // Deep-eval overlay (depth-22). Plies 1..15 hidden — opening theory comparison
    // is misframed (avoiding every engine-preferred move = different opening).
    const SKIP_OPENING = 15;
    const dDeep = deepRedDelta(plies, pi);
    const pastOpening = pi >= SKIP_OPENING;
    const ddCell = tr.querySelector(".deep-delta");
    if (ddCell) {
      if (!pastOpening || dDeep == null) {
        ddCell.textContent = "";
        ddCell.className = "deep-delta";
      } else {
        ddCell.textContent = fmtDelta(dDeep);
        ddCell.className = "deep-delta " + deltaSignClass(dDeep);
      }
    }

    // Trap detection still uses mover-POV magnitude (positive = mover lost cp):
    // a red ply is trapped when red lost lots; a black ply when black lost lots.
    // In red-POV signed terms: red lost = dDeep << 0 on red row, black lost = dDeep >> 0 on black row.
    const moverDeep = ply.side === "red" ? -dDeep : dDeep;
    const moverShallow = ply.side === "red" ? -dShallow : dShallow;
    const shallowOk = moverShallow != null && moverShallow < 50;
    const deepBad   = moverDeep != null && moverDeep > 100;
    tr.classList.toggle("ply-trap", shallowOk && deepBad && pastOpening);

    // Branch indicator — this position has more than one move tried across
    // variations (i.e. it's a decision point in the book tree). Inject a
    // small badge into the 書譜 cell so the user can scan the table for
    // decision points without clicking through.
    const altsHere = ALTS_BY_FEN[ply.fen];
    const branchCount = altsHere ? altsHere.length : 0;
    tr.classList.toggle("ply-branch", branchCount > 1);
    const existingBadge = bookCell.querySelector(".branch-badge");
    if (existingBadge) existingBadge.remove();
    if (branchCount > 1) {
      const badge = document.createElement("span");
      badge.className = "branch-badge";
      badge.textContent = branchCount;
      badge.title = `此局面共有 ${branchCount} 種走法（見右側「本步可選」）`;
      bookCell.appendChild(badge);
    }

    // chessdb cloud-database overlay — score in red POV (chessdb returns mover-POV,
    // so flip for black plies). Hover shows full book vs cloud-best comparison.
    const cdbCell = tr.querySelector(".cdb");
    if (cdbCell) {
      const cdbMoves = entry.cdb_moves;
      if (!cdbMoves || cdbMoves.length === 0) {
        cdbCell.textContent = "";
        cdbCell.className = "cdb";
        cdbCell.removeAttribute("title");
      } else {
        const flipSign = ply.side === "black" ? -1 : 1;
        const bookEntry = cdbMoves.find((m) => m.iccs === ply.iccs);
        const best = cdbMoves[0];
        const matchesBest = best.iccs === ply.iccs;
        const fmtScoreLocal = (s) => s == null ? "?" : (s >= 0 ? "+" : "") + s;
        const fmtWr = (w) => w == null ? "?" : Math.round(w) + "%";
        const bestCn = entry.cdb_best_chinese || best.iccs;
        const bestRedScore = best.score == null ? null : best.score * flipSign;
        if (bookEntry && bookEntry.score != null) {
          const sRed = bookEntry.score * flipSign;
          cdbCell.textContent = fmtScoreLocal(sRed);
          cdbCell.className = "cdb " + deltaSignClass(sRed);
          cdbCell.title = matchesBest
            ? `雲庫推薦同步：${bestCn} ${fmtScoreLocal(bestRedScore)} (勝率 ${fmtWr(best.winrate)})`
            : `書譜：${ply.iccs} ${fmtScoreLocal(sRed)} (勝率 ${fmtWr(bookEntry.winrate)})\n雲庫最佳：${bestCn} ${fmtScoreLocal(bestRedScore)} (勝率 ${fmtWr(best.winrate)})\n差距：${(best.score - bookEntry.score) * flipSign} cp（紅方視角）`;
        } else {
          cdbCell.textContent = "—";
          cdbCell.className = "cdb cdb-missing";
          cdbCell.title = `書譜步雲庫無資料\n雲庫最佳：${bestCn} ${fmtScoreLocal(bestRedScore)} (勝率 ${fmtWr(best.winrate)})`;
        }
      }
    }

    const same = entry.best_iccs === ply.iccs;
    tr.querySelector(".same").textContent = same ? "同" : "異";
    tr.classList.toggle("diff", !same);
  });
}

function renderAnnote(ply) {
  if (!ANNOTE_BOX) return;
  ANNOTE_BOX.innerHTML = '';
  if (!ply) {
    const ph = document.createElement("div");
    ph.className = "annote-placeholder";
    ph.textContent = "（點選任一步顯示註解）";
    ANNOTE_BOX.appendChild(ph);
    return;
  }
  const head = document.createElement("div");
  head.className = "annote-head";
  head.textContent = "💬 棋譜註解";
  ANNOTE_BOX.appendChild(head);
  if (!ply.annote) {
    const ph = document.createElement("div");
    ph.className = "annote-placeholder";
    ph.textContent = "（此步無註解）";
    ANNOTE_BOX.appendChild(ph);
    return;
  }
  const body = document.createElement("div");
  body.className = "annote-body";
  body.textContent = ply.annote;
  ANNOTE_BOX.appendChild(body);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Populate ply.fen_after and tree-node.fen_after by walking from each
// starting FEN with applyIccs. We don't ship fen_after in games.json
// anymore — that field used to add ~25 MB. The rest of the UI assumes
// fen_after exists, so we fill it in once here at page load.
function hydrateGame(GAME) {
  const initFen = GAME.init_fen;
  for (const plies of GAME.variations || []) {
    for (const p of plies) {
      if (p && p.fen && p.iccs && p.fen_after == null) {
        p.fen_after = applyIccs(p.fen, p.iccs);
      }
    }
  }
  if (GAME.tree) {
    const walk = (node, parentFen) => {
      for (const c of node.children || []) {
        if (c.iccs && parentFen && c.fen_after == null) {
          c.fen_after = applyIccs(parentFen, c.iccs);
        }
        walk(c, c.fen_after || parentFen);
      }
    };
    walk(GAME.tree, initFen);
  }
}

function buildTreeLookups(GAME) {
  if (GAME.tree) {
    ALTS_BY_FEN[GAME.init_fen] = GAME.tree.children || [];
    const walk = (node) => {
      for (const c of node.children || []) {
        if (c.fen_after) ALTS_BY_FEN[c.fen_after] = c.children || [];
        walk(c);
      }
    };
    walk(GAME.tree);
  }
  for (let vi = 0; vi < GAME.variations.length; vi++) {
    const plies = GAME.variations[vi];
    for (let pi = 0; pi < plies.length; pi++) {
      const p = plies[pi];
      if (!p.fen || !p.iccs) continue;
      const key = p.fen + '|' + p.iccs;
      if (!(key in MOVE_LOOKUP)) MOVE_LOOKUP[key] = [vi, pi];
    }
  }
}

// Render the "本步可選" panel for the position the user is currently inspecting.
// `currentFen` is the position BEFORE the move (or init_fen if no ply active).
// `currentIccs` is the move actually played at this row (or null) — used to
// highlight which alternative is the book's choice in this variation.
function renderAlts(currentFen, currentIccs) {
  if (!ALTS_BOX) return;
  const body = ALTS_BOX.querySelector('.alts-body');
  body.innerHTML = '';
  const alts = ALTS_BY_FEN[currentFen] || [];
  // A list with only the currently-played move isn't useful — that's just the
  // table cell repeated. Treat as "no alternatives" so the box stays present
  // (stable layout) but doesn't pretend to offer a choice.
  const realAlts = alts.length > 1
    || (alts.length === 1 && alts[0].iccs !== currentIccs);
  if (!realAlts) {
    const ph = document.createElement('div');
    ph.className = 'alts-placeholder';
    ph.textContent = alts.length === 0
      ? '（此局面已是末端）'
      : '（此局面僅一種走法）';
    body.appendChild(ph);
    return;
  }
  for (const a of alts) {
    const div = document.createElement('div');
    div.className = 'alts-item' + (a.iccs === currentIccs ? ' current' : '');
    const sideCls = a.side === 'red' ? 'red' : 'black';
    const sideLabel = a.side === 'red' ? '紅' : '黑';
    const ann = a.annote
      ? ` <span class="annote-marker" title="${escapeHtml(a.annote)}">*</span>`
      : '';
    // Engine score AFTER playing this alternative — the mover at fen_after is
    // the OPPOSITE side. Use fmtScore (always red-POV) for consistency with
    // the table's 分(cp) column.
    let scoreHtml = '';
    if (a.fen_after) {
      const entry = getEntry(a.fen_after);
      if (entry) {
        const newMover = a.side === 'red' ? 'black' : 'red';
        const sc = fmtScore(entry, newMover);
        scoreHtml = `<span class="alts-score ${sc.cls}">${sc.text}</span>`;
      }
    }
    div.innerHTML = `
      <span class="alts-side ${sideCls}">${sideLabel}</span>
      <span class="alts-cn">${escapeHtml(a.chinese || a.iccs)}${ann}</span>
      <code class="alts-iccs">${a.iccs}</code>
      ${scoreHtml}
    `;
    div.addEventListener('click', () => navigateToAlternative(currentFen, a.iccs));
    body.appendChild(div);
  }
}

function navigateToAlternative(fen, iccs) {
  const key = fen + '|' + iccs;
  const found = MOVE_LOOKUP[key];
  if (!found) return;
  const [vi, pi] = found;
  if (vi !== STATE.vi) selectVariation(vi);
  activatePly(pi);
}

function scrollRowIntoView(tr) {
  const wrap = tr.closest(".plies-wrap");
  if (!wrap) return;
  const wrapH = wrap.clientHeight;
  const trTop = tr.offsetTop;
  const trH = tr.offsetHeight;
  const top = wrap.scrollTop;
  if (trTop < top || trTop + trH > top + wrapH) {
    wrap.scrollTop = trTop - wrapH / 2 + trH / 2;
  }
}

function selectVariation(vi) {
  stopDemo();
  STATE.vi = vi;
  STATE.pi = -1;
  document.querySelectorAll(".plies-wrap").forEach((w) => {
    const isCurrent = parseInt(w.dataset.var, 10) === vi;
    w.style.display = isCurrent ? "" : "none";
    if (isCurrent) w.scrollTop = 0;
  });
  VAR_PICKER.setSelected(vi, STATE.GAME.variations[vi].length);
  annotateTable(vi);
  drawBoard(SVG_BOARD, STATE.GAME.init_fen, null, null);
  drawChart(SVG_CHART, STATE.GAME.variations[vi], -1);
  updateNavStatus();
  updateStepInfo(null, null);
  renderAnnote(null);
  renderAlts(STATE.GAME.init_fen, null);
  document.querySelectorAll("table.plies tr.active").forEach((r) => r.classList.remove("active"));
}

function activatePly(pi) {
  stopDemo();
  const vi = STATE.vi;
  const plies = STATE.GAME.variations[vi];
  if (pi < 0 || pi >= plies.length) return;
  STATE.pi = pi;
  const tr = document.querySelector(`.plies-wrap[data-var="${vi}"] tr[data-ply="${pi}"]`);
  document.querySelectorAll("table.plies tr.active").forEach((r) => r.classList.remove("active"));
  if (tr) {
    tr.classList.add("active");
    scrollRowIntoView(tr);
  }
  const ply = plies[pi];
  const entry = getEntry(ply.fen);  // engine eval keyed on fen-before
  // Show the position AFTER the move was played (XQStudio convention).
  // Blue boxes mark the from/to of the move that was just played.
  const fenToDraw = ply.fen_after || ply.fen;
  drawBoard(SVG_BOARD, fenToDraw, ply.iccs, entry ? entry.best_iccs : null);
  drawChart(SVG_CHART, plies, pi);
  updateStepInfo(ply, entry);
  renderAnnote(ply);
  renderAlts(ply.fen, ply.iccs);
  updateNavStatus();
  updateDemoButtons();
}

// ---------- demo ----------

function startDemo(mode) {
  if (STATE.pi < 0) return;
  const ply = STATE.GAME.variations[STATE.vi][STATE.pi];
  const entry = getEntry(ply.fen);
  if (!entry) return;
  const pv = mode === 'verydeep' ? entry.very_deep_pv_detail
           : mode === 'deep'     ? entry.deep_pv_detail
           : entry.pv_detail;
  if (!pv || !pv.length) return;
  STATE.demoMode = mode;
  setDemoMode(true, mode);

  const depthLabel = mode === 'verydeep' ? '深28'
                   : mode === 'deep'     ? '深22'
                   : '淺12';
  let idx = 0;
  // Engine PV is relative to the position BEFORE the book's played move
  // (ply.fen), not after — that's the position the engine analyzed. Seed
  // from ply.fen and snap the board there immediately so the played move
  // isn't visually un-moved as part of the animation.
  let demoFen = ply.fen;
  drawBoard(SVG_BOARD, demoFen, null, null);

  const step = () => {
    if (idx >= pv.length) {
      // Finished — leave board on last frame, restore controls.
      // Inline restore button lets the user jump back to the original ply view.
      setDemoMode(false, null);
      STATE.demoTimer = null;
      STATE.demoMode = null;
      STEP_INFO.innerHTML = `
        <span class="item demo-tag">演示結束（${depthLabel}）</span>
        <span class="item">已播放 ${pv.length} 步</span>
        <span class="item"><span class="label">起始</span> ${ply.chinese} <code>${ply.iccs}</code></span>
        <button class="restore-btn" id="restoreBtn" title="回到原本局面">← 回到局面</button>
      `;
      const rb = document.getElementById("restoreBtn");
      if (rb) rb.addEventListener("click", () => activatePly(STATE.pi));
      updateDemoButtons();
      return;
    }
    const s = pv[idx];
    demoFen = applyIccs(demoFen, s.iccs);
    drawBoard(SVG_BOARD, demoFen, s.iccs, null);
    STEP_INFO.innerHTML = `
      <span class="item demo-tag">▶ ${depthLabel} ${idx + 1} / ${pv.length}</span>
      <span class="item"><span class="label">本步</span> ${s.chinese} <code>${s.iccs}</code></span>
      <span class="item"><span class="label">起始</span> ${ply.chinese} <code>${ply.iccs}</code></span>
    `;
    idx += 1;
    STATE.demoTimer = setTimeout(step, 1200);
  };
  step();
}

// ---------- init ----------

function initGamePage(GAME) {
  STATE.GAME = GAME;
  SVG_BOARD = document.getElementById("board");
  SVG_CHART = document.getElementById("chart");
  STEP_INFO = document.getElementById("stepInfo");
  ANNOTE_BOX = document.getElementById("annoteBox");
  NAV_STATUS = document.getElementById("navStatus");
  DEMO_BTN_S = document.getElementById("demoBtnShallow");
  DEMO_BTN_D = document.getElementById("demoBtnDeep");
  DEMO_BTN_VD = document.getElementById("demoBtnVeryDeep");
  BRANCH_BTN = document.getElementById("navBranchBtn");
  REDP_BOX = document.getElementById("redPerspective");
  ALTS_BOX = document.getElementById("altsBox");

  hydrateGame(GAME);
  buildTreeLookups(GAME);
  // Inject the board-style picker (and apply persisted board style) BEFORE
  // selectVariation triggers the first drawBoard call — that way the initial
  // render already uses the saved style instead of flashing the default.
  injectBoardPicker();
  // Initial alts panel: show first-move alternatives at the init position.
  renderAlts(GAME.init_fen, null);
  VAR_PICKER.init();

  // Annotate every table once (the hidden ones too, so future variation switches don't need redoing).
  // We do this lazily per-variation in selectVariation; but for the initial visible one, do it now.
  for (let vi = 0; vi < GAME.variations.length; vi++) annotateTable(vi);

  document.querySelectorAll(".nav-first").forEach((b) => b.addEventListener("click", () => {
    activatePly(0);
  }));
  document.querySelectorAll(".nav-prev").forEach((b) => b.addEventListener("click", () => {
    activatePly(Math.max(0, (STATE.pi < 0 ? 0 : STATE.pi - 1)));
  }));
  document.querySelectorAll(".nav-next").forEach((b) => b.addEventListener("click", () => {
    const total = STATE.GAME.variations[STATE.vi].length;
    activatePly(Math.min(total - 1, STATE.pi + 1));
  }));
  document.querySelectorAll(".nav-last").forEach((b) => b.addEventListener("click", () => {
    const total = STATE.GAME.variations[STATE.vi].length;
    activatePly(total - 1);
  }));

  const onDemoClick = (mode) => {
    if (STATE.demoTimer) {
      // If the running demo is the same mode, stop. Otherwise (shouldn't happen
      // since other button is disabled during play) treat as restart.
      stopDemo();
      if (STATE.pi >= 0) activatePly(STATE.pi);
    } else {
      startDemo(mode);
    }
  };
  DEMO_BTN_S.addEventListener("click", () => onDemoClick("shallow"));
  DEMO_BTN_D.addEventListener("click", () => onDemoClick("deep"));
  if (DEMO_BTN_VD) DEMO_BTN_VD.addEventListener("click", () => onDemoClick("verydeep"));
  if (BRANCH_BTN) BRANCH_BTN.addEventListener("click", () => {
    const pi = findNearestBranchPly();
    if (pi >= 0) activatePly(pi);
  });
  updateDemoButtons();

  // Row clicks (all variations — only visible ones reachable, but bind all)
  document.querySelectorAll(".plies-wrap").forEach((wrap) => {
    const vi = parseInt(wrap.dataset.var, 10);
    wrap.querySelectorAll("tbody tr[data-ply]").forEach((tr) => {
      tr.addEventListener("click", () => {
        if (vi !== STATE.vi) selectVariation(vi);
        activatePly(parseInt(tr.dataset.ply, 10));
      });
    });
  });

  // Chart click anywhere → jump to nearest ply (not just on the small data dots)
  SVG_CHART.style.cursor = "pointer";
  SVG_CHART.addEventListener("click", (ev) => {
    if (!STATE.GAME) return;
    const plies = STATE.GAME.variations[STATE.vi];
    if (!plies || plies.length === 0) return;
    const rect = SVG_CHART.getBoundingClientRect();
    const xPx = ev.clientX - rect.left;
    const xSvg = xPx * (CHART_W / rect.width);
    const innerW = CHART_W - CHART_PAD_L - CHART_PAD_R;
    let pi;
    if (plies.length <= 1) {
      pi = 0;
    } else {
      pi = Math.round(((xSvg - CHART_PAD_L) / innerW) * (plies.length - 1));
    }
    pi = Math.max(0, Math.min(plies.length - 1, pi));
    activatePly(pi);
  });

  document.addEventListener("keydown", (e) => {
    if (STATE.demoTimer) return; // ignore during demo
    if (STATE.pi < 0 && e.key !== "ArrowRight") return;
    const total = STATE.GAME.variations[STATE.vi].length;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      activatePly(Math.max(0, STATE.pi - 1));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      activatePly(Math.min(total - 1, STATE.pi + 1));
    }
  });

  REDP_BOX.addEventListener("change", () => {
    // Checkbox only flips the board orientation. All numeric columns are
    // permanently in red-POV; they don't change when this toggles.
    if (STATE.pi >= 0) {
      const ply = STATE.GAME.variations[STATE.vi][STATE.pi];
      const entry = getEntry(ply.fen);
      drawBoard(SVG_BOARD, ply.fen_after || ply.fen, ply.iccs, entry ? entry.best_iccs : null);
    } else {
      drawBoard(SVG_BOARD, STATE.GAME.init_fen, null, null);
    }
  });

  // Initial render: variation 0, no ply selected — unless the URL deep-links
  // to a specific variation/ply (used by traps.html). Query params: ?v=&p=
  // (0-indexed). Out-of-range values fall back to the safe default.
  const params = new URLSearchParams(window.location.search);
  const wantVi = parseInt(params.get('v'), 10);
  const wantPi = parseInt(params.get('p'), 10);
  if (Number.isInteger(wantVi) && wantVi >= 0 && wantVi < GAME.variations.length) {
    selectVariation(wantVi);
    if (Number.isInteger(wantPi) && wantPi >= 0 && wantPi < GAME.variations[wantVi].length) {
      activatePly(wantPi);
    }
  } else {
    selectVariation(0);
  }
}

window.drawBoard = drawBoard;
window.parseFen = parseFen;
window.applyIccs = applyIccs;
window.iccsToCoord = iccsToCoord;
window.ensurePieceFontLoaded = ensurePieceFontLoaded;
window.initGamePage = initGamePage;
