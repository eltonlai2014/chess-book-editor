// Xiangqi board renderer — pure SVG drawing + FEN/ICCS primitives.
//
// Forked from chess-book-ai's static-site renderer; the editor (editor*.js,
// gifexport.js) reuses ONLY the rendering surface below. The whole static-site
// UI state machine — STATE/activatePly/selectVariation, getEntry + window.POSITIONS,
// the eval-delta helpers, the score chart, the demo player, and the board-style
// PICKER injector — was removed (T3-3 A1, 2026-06-22): it was dead code in the
// editor (it only ever read a window.POSITIONS the editor never populates). What
// remains, all consumed by editor*.js / gifexport.js:
//   • primitives  — el, screenX/Y, iccsToCoord, parseFen, applyIccs
//   • board draw  — drawBoard, drawPieceAt, makeFloatingPiece, drawMeanderFrame, mixHex
//   • theme       — BOARD_STYLES, currentBoardStyle, PIECE_FONTS, ensurePieceFontLoaded
//   • move fx     — animateBoardMove (fade/pop/slide/flash styles), playPieceSound
//                   (WebAudio wood clack); editor polish, via data-board-anim / -sound
//   • one eval helper — deltaSignClass (cp→colour class), used by editor-cdb.js
// Perspective is latched per-redraw into the module-level CURRENT_REDP by drawBoard.

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

// Color class for a red-POV signed cp value. The only eval helper that survived
// the T3-3 dead-code cut: editor-cdb.js uses it for 雲庫 score colouring. (The
// static-site 分/Δ/深Δ columns that also used it are gone.)
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
// localStorage as "chessbookBoard". The editor switches styles via the static
// <select id="boardThemeSel"> in index.html (wired in editor.js). Adding a new
// style: add an entry below + a font key; the picker re-reads BOARD_STYLES.

// Piece-character fonts. The `text=` URL parameter restricts the Google Fonts
// subset to the 14 piece glyphs + 楚河漢界, keeping the load <10KB even for
// huge fonts like Ma Shan Zheng.
const PIECE_CHARS_SUBSET = "帥仕相傌俥砲兵將士象馬車包卒楚河漢界";

// Piece-character font registry. Each entry is lazy-loaded via the `text=`
// Google Fonts URL trick: only the 16 piece glyphs + 楚河漢界 ship, keeping
// the font payload <10KB. dy is the vertical text offset that centers the
// glyph inside a 52-px piece disc.
// EXTENSION POINT (future「更換棋子類型」): add new piece sets here, then let a
// picker set html[data-piece-font] to one of these keys (see the font-resolution
// hook in drawBoard). No other code needs to change.
const PIECE_FONTS = {
  classic: {
    family: "serif",
    weight: "bold",
    dy: 10,
    googleUrl: null,
  },
  // LXGW WenKai TC — free Traditional-Chinese textbook kaishu (楷書). Cleaner
  // than brush fonts, warmer than Songti, well-balanced strokes at 28px.
  // "LXGW WenKai Piece" is the locally-bundled Bold (700) subset (@font-face in
  // editor.css) — preferred so the board renders offline without the Google
  // Fonts CDN. 700 is the family's heaviest real weight; extra heft on light
  // discs is added via per-side textStroke, not a bolder face. googleUrl is null
  // now that the face ships locally (no runtime CDN fetch).
  wenkai: {
    family: '"LXGW WenKai Piece", "LXGW WenKai TC", "Noto Serif TC", "Songti TC", serif',
    weight: "700",
    dy: 11,
    googleUrl: null,
    // Bundled subset (editor.css @font-face). localFamily/localUrl let the GIF
    // exporter embed the SAME face as a base64 @font-face (gifexport.js
    // loadEmbeddedFontCss) so offscreen frames match the screen — offline, no CDN.
    localFamily: "LXGW WenKai Piece",
    localUrl: "/assets/fonts/lxgw-wenkai-tc-bold.woff2",
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
    // Classic flat-ish wooden pieces — subtle gradient + tight contact shadow.
    // A+B (收圈+縮投影): the bright inner ring is OFF (it printed a double-circle
    // 靶心 on the cream disc — the red side's worst offender) and the border is
    // thinned to 0.8 + recoloured to a low-contrast warm tone so the disc edge
    // stops reading as a hard ring; the red glyph carries 紅方 identity instead.
    // Still NO glossy specular dot, NO engraved character.
    red:    { fill: "#fff5db", border: "#c79a6e", borderWidth: 0.8, innerRing: "#c0392b", text: "#c0392b",
              textStroke: 0.6,
              grad: { from: "#fff5db", to: "#e8c889" } },
    black:  { fill: "#222",    border: "#181818", borderWidth: 0.8, innerRing: "#888",    text: "#f5f5f5",
              grad: { from: "#3a3a3a", to: "#101010" } },
    piece:  { shadow: "contact", innerRing: false, gradient: true,
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
    // slate, neither washed out against the stone ground). A+B (收圈+縮投影):
    // thin border (0.8) + softened gradient so the disc edge / specular bead stop
    // reading as a glossy plastic button; ring/halo killed via contact shadow.
    red:    { fill: "#9a2818", border: "#6a1a10", borderWidth: 0.8, innerRing: null, text: "#fbe7c2",
              grad: { from: "#b5362a", to: "#5e0e0b" } },
    black:  { fill: "#2a2a2a", border: "#1a1410", borderWidth: 0.8, innerRing: null, text: "#fbe7c2",
              grad: { from: "#4e4e4e", to: "#141414" } },
    // shadow contact + specular/rim OFF: matte wood disc instead of glossy bead;
    // engrave kept (cream chars on dark discs still read as pressed-in).
    piece:  { shadow: "contact", innerRing: false, gradient: true,
              specular: false, engrave: true, rim: false },
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
    // A+B (收圈+縮投影): thin borders + specular/rim OFF + contact shadow → matte
    // lacquer disc instead of a glossy plastic bead; engrave kept (cream chars on
    // dark discs read as pressed-in).
    red:    { fill: "#7a1818", border: "#3a0c0c", borderWidth: 0.8, innerRing: null, text: "#fbeed1",
              grad: { from: "#c0392b", to: "#5a0c0c" } },
    black:  { fill: "#2a2a2a", border: "#141414", borderWidth: 0.8, innerRing: null, text: "#fbeed1",
              grad: { from: "#7a7a7a", to: "#1a1a1a" } },
    piece:  { shadow: "contact", innerRing: false, gradient: true,
              specular: false, engrave: true, rim: false },
    lastMove: { kind: "ring", color: "#d4a043" },
    suggest:  { kind: "ring", color: "#e26054" },
  },
  copperwood: {
    label: "赤銅古木",
    font: "wenkai",
    background: { kind: "wood" },
    grid:   { stroke: "#5a3318", width: 1, outer: 3 },
    coord:  { color: "#6a4325", font: "serif" },
    river:  { color: "#714323", style: "italic" },
    // A+B (收圈+縮投影): inner ring OFF, thin low-contrast warm border, contact shadow.
    red:    { fill: "#f6e2cb", border: "#cda079", borderWidth: 0.8, innerRing: "#b85b33", text: "#b14b29",
              textStroke: 0.6,
              grad: { from: "#fff2df", to: "#deb187" } },
    black:  { fill: "#2d221c", border: "#1c150f", borderWidth: 0.8, innerRing: "#8b776a", text: "#f4eadf",
              grad: { from: "#4a3a31", to: "#17110d" } },
    piece:  { shadow: "contact", innerRing: false, gradient: true,
              specular: false, engrave: false, rim: false },
    lastMove: { kind: "box", color: "#a95a2a" },
    suggest:  { kind: "ring", color: "#cf6a32" },
  },
  celadon: {
    label: "青瓷素雅",
    font: "wenkai",
    background: { kind: "stone", color: "#c8d2ca", grain: "#6f8177" },
    grid:   { stroke: "#55685f", width: 1.0, outer: 1.8 },
    coord:  { color: "#61756c", font: "serif" },
    river:  { color: "#5c7068", style: "normal" },
    // red text: deep saturated red (#9e2414) for a clear, strong glyph on the
    // light cream disc (the earlier #9c3a2c still read washed). textStroke 0.7
    // gives a TRUE bold + fills the antialiased rim so the thin kaishu strokes
    // stop reading washed/blurry (see drawPieceAt — wenkai ships @700 only, so a
    // higher font-weight would only faux-bold/smear).
    // A+B (收圈+縮投影), red side keeps the LIGHT disc (文房 feel — option A+B, not
    // the saturated-red flip): border thinned to 0.8 and recoloured to a low-
    // contrast warm tone (#bda393, between disc and ground) so the rose ring stops
    // shouting; the dark-rose text + textStroke carry the "red piece" read instead.
    red:    { fill: "#efe4d7", border: "#bda393", borderWidth: 0.8, innerRing: null, text: "#9e2414",
              textStroke: 0.7,
              grad: { from: "#f9f1e8", to: "#dcccbd" } },
    black:  { fill: "#2f3a36", border: "#283531", borderWidth: 0.8, innerRing: null, text: "#eef2ef",
              grad: { from: "#46544e", to: "#1c231f" } },
    // engrave OFF: light red disc + dark-rose text → an engraved dark under-glyph
    // would double the edge (字暈開). rim OFF + shadow contact (was rim/strong):
    // kills the inner-edge circle and the floating grey halo — the two rings the
    // master flagged. Matches the other light-disc themes (傳統/赤銅古木).
    piece:  { shadow: "contact", innerRing: false, gradient: true,
              specular: false, engrave: false, rim: false },
    // last-move/suggest: vivid blue + clear orange so they pop off the green-grey
    // 青瓷 ground (the muted grey-green/terracotta were near-invisible on it).
    lastMove: { kind: "ring", color: "#1565c0" },
    suggest:  { kind: "ring", color: "#e2651a" },
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

function drawBoard(svg, fen, bookMove, engineMove, liftIccs) {
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
    // Tight CONTACT shadow (shadow:"contact"): lighter + hugs the disc base so it
    // reads as "the piece sits on the board", NOT a wide floating halo. The old
    // strong/soft shadows extended past r=26 and printed a grey ring around every
    // piece — most visible under light/red discs (dark discs hid it). See the
    // shadow branch in drawPieceAt.
    const scg = el("radialGradient", { id: "pshadowc", cx: "50%", cy: "50%", r: "50%" }, defs);
    el("stop", { offset: "0%",   "stop-color": "rgba(0,0,0,0.34)" }, scg);
    el("stop", { offset: "70%",  "stop-color": "rgba(0,0,0,0.14)" }, scg);
    el("stop", { offset: "100%", "stop-color": "rgba(0,0,0,0)"    }, scg);
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
  // 用戶自訂背景 hook (future「上傳棋盤背景圖」): if html[data-board-bg] holds an
  // image URL / data-URI (set from PREFS.boardBgUrl), paint it under everything
  // and skip the procedural background. Inert until that attr exists.
  const userBg = document.documentElement.dataset.boardBg;
  if (userBg) {
    el("image", { x: 0, y: 0, width: 540, height: 600, href: userBg,
      preserveAspectRatio: "xMidYMid slice" }, svg);
  } else if (S.background.kind === "wood") {
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

  // Pieces — style-driven disk + character. `liftIccs` (a 2-char square like
  // "h2") skips that one piece: the editor "lifts" the selected piece off the
  // board and draws a floating copy under the cursor (makeFloatingPiece).
  let liftCol = -1, liftRow = -1;
  if (liftIccs && liftIccs.length >= 2) {
    liftCol = liftIccs.charCodeAt(0) - 97;
    liftRow = parseInt(liftIccs[1], 10);
  }
  const parsed = fen ? parseFen(fen) : null;
  if (parsed) {
    for (let r = 0; r <= 9; r++) {
      for (let c = 0; c <= 8; c++) {
        const p = parsed.rows[r][c];
        if (!p) continue;
        if (c === liftCol && r === liftRow) continue;   // lifted → drawn floating
        drawPieceAt(svg, p, screenX(c), screenY(r), S);
      }
    }
  }
}

// Draw a single piece (disk + character) at absolute (cx, cy) into `parent`.
// Factored out of drawBoard's loop so the editor can reuse the exact same look
// for the floating "carried" piece (makeFloatingPiece). `S` defaults to the
// active board style. Gradient/shadow fills reference defs (#pg-*, #pshadow,
// #pspec) created by drawBoard, so `parent` must live in a freshly-drawn board.
function drawPieceAt(parent, p, cx, cy, S) {
  S = S || currentBoardStyle();
  const isRed = p === p.toUpperCase();
  const PS = isRed ? S.red : S.black;
  // Drop shadow.
  //   "strong" → wide ambient + tight contact (glossy/premium pieces)
  //   "soft"   → just the ambient ellipse (matte / wooden disc feel)
  //   true     → legacy hard 1.5px offset shadow (kept for back-compat)
  if (S.piece.shadow === "strong") {
    el("ellipse", { cx, cy: cy + 5, rx: 28, ry: 10, fill: "url(#pshadow)" }, parent);
    el("ellipse", { cx, cy: cy + 1.5, rx: 25, ry: 25, fill: "rgba(0,0,0,0.18)" }, parent);
  } else if (S.piece.shadow === "soft") {
    el("ellipse", { cx, cy: cy + 4, rx: 26, ry: 7, fill: "url(#pshadow)" }, parent);
  } else if (S.piece.shadow === "contact") {
    // Tight contact shadow (B 縮投影): smaller than the disc (rx 23 < r 26) so it
    // stays UNDER the piece and never prints a ring on the board.
    el("ellipse", { cx, cy: cy + 4, rx: 23, ry: 5.5, fill: "url(#pshadowc)" }, parent);
  } else if (S.piece.shadow) {
    el("circle", { cx: cx + 1.5, cy: cy + 1.5, r: 26, fill: "rgba(0,0,0,0.22)" }, parent);
  }
  // Outer disk — gradient fill when style enables it. Border width is a per-side
  // knob (PS.borderWidth, default 1.5): A 收圈 thins it to ~0.8 so the disc edge
  // stops reading as a hard contrasting ring around the piece.
  el("circle", {
    cx, cy, r: 26,
    fill: (S.piece.gradient && PS.grad) ? `url(#pg-${isRed ? "red" : "black"})` : PS.fill,
    stroke: PS.border,
    "stroke-width": PS.borderWidth == null ? 1.5 : PS.borderWidth,
  }, parent);
  // Optional inner-rim shadow (dome bevel)
  if (S.piece.rim) {
    el("circle", { cx, cy, r: 24.5, fill: "none",
                   stroke: "rgba(0,0,0,0.35)", "stroke-width": 1 }, parent);
  }
  // Optional inner ring (traditional style)
  if (S.piece.innerRing && PS.innerRing) {
    el("circle", {
      cx, cy, r: 22, fill: "none",
      stroke: PS.innerRing, "stroke-width": 1,
    }, parent);
  }
  // Optional specular highlight — glossy bead spot at upper-left
  if (S.piece.specular) {
    el("ellipse", { cx: cx - 7, cy: cy - 9, rx: 10, ry: 7, fill: "url(#pspec)" }, parent);
  }
  // Character — optional engraved shadow under main glyph (looks like
  // the character is pressed into the disc face).
  // Piece-font resolution hook (future「更換棋子類型」): a picker can set
  // html[data-piece-font] (from PREFS.pieceFont) to override the per-board
  // font WITHOUT touching board styles. Inert until that attr exists.
  const fontKey = document.documentElement.dataset.pieceFont || S.font;
  const PF = PIECE_FONTS[fontKey] || PIECE_FONTS.classic;
  if (S.piece.engrave) {
    const ts = el("text", {
      x: cx, y: cy + PF.dy + 1.2, "text-anchor": "middle",
      "font-size": 28, "font-family": PF.family, "font-weight": PF.weight,
      fill: "rgba(0,0,0,0.45)",
    }, parent);
    ts.textContent = PIECE_CHAR[p] || p;
  }
  const t = el("text", {
    x: cx, y: cy + PF.dy, "text-anchor": "middle",
    "font-size": 28, "font-family": PF.family, "font-weight": PF.weight,
    fill: PS.text,
  }, parent);
  // Optional same-colour glyph stroke → a TRUE bold (fattens the outline) without
  // faux-bolding: the piece fonts ship a single web weight (wenkai @700), so
  // bumping font-weight would only trigger the browser's synthesised bold, which
  // smears the antialiased edges. A thin stroke in the text colour thickens the
  // strokes AND fills in the half-transparent antialiased rim → crisper glyph.
  // Used by celadon's red (deep red on a light disc read thin/washed at 28px).
  if (PS.textStroke) {
    t.setAttribute("stroke", PS.text);
    t.setAttribute("stroke-width", PS.textStroke);
    t.setAttribute("stroke-linejoin", "round");
    t.setAttribute("paint-order", "stroke");  // stroke under fill — pure thickening
  }
  t.textContent = PIECE_CHAR[p] || p;
}

// Build a detached piece (same look as on-board) at the local origin, wrapped in
// a <g class="floatPiece"> that the caller positions with a transform. Powers
// the editor's "carry the piece under the cursor" interaction. The gradient /
// shadow defs come from the last drawBoard() of the same `svg`, so this must be
// appended to that svg. pointer-events:none so clicks pass through to the cells.
function makeFloatingPiece(svg, p) {
  const g = el("g", { class: "floatPiece" }, svg);
  g.style.pointerEvents = "none";
  drawPieceAt(g, p, 0, 0);
  return g;
}

function isRedPerspective() {
  // Editor ships a hidden, permanently-checked #redPerspective (index.html);
  // the static-site REDP_BOX module var is gone, so read the element directly.
  const box = document.getElementById("redPerspective");
  return box ? box.checked : true;
}

// ---------- move animation + sound (editor polish) ----------
// Opt-in via dataset hooks the editor sets from PREFS (same pattern as the
// data-board-bg / data-piece-font extension hooks in drawBoard):
//   html[data-board-anim]  = "off" | "fade" | "pop" | "slide" | "flash"
//   html[data-board-sound] = "off"  → disable the move / capture sound
// Absent / unknown anim attr = "fade". We do NOT auto-disable on
// prefers-reduced-motion: the explicit picker is the single source of truth (some
// OS setups, e.g. Windows "show animations" off, report reduce-motion and would
// silently defeat the feature the master chose).
//
// animateBoardMove() is called by editor.js refreshActive() AFTER drawBoard()
// has redrawn the board at the NEW fen with the destination square LIFTED
// (liftIccs = dest) — so the moved piece is not yet painted there. Each style
// shares the SAME contract: animate floating copies, then finish(true) drops the
// real piece at dest on completion (finish(false) when superseded). Styles:
//   fade  — moved piece dissolves out at source + in at dest (no travel/scale)
//   pop   — piece appears at dest with a quick scale-in bounce (no travel)
//   slide — short LINEAR glide source→dest (no overshoot/lift; the toned-down slide)
//   flash — piece appears at once + a ring pulses at the dest square

let BOARD_ANIM_CLEANUP = null;   // settle() of the in-flight #board animation

function boardAnimStyle() {
  const v = document.documentElement.dataset.boardAnim;
  if (v === "off") return null;
  return (v === "fade" || v === "pop" || v === "slide" || v === "flash") ? v : "fade";
}
function boardAnimEnabled() { return boardAnimStyle() !== null; }

function animateBoardMove(svg, newFen, prevFen, iccs, duration) {
  const style = boardAnimStyle();
  if (!svg || !style) return false;
  const c = iccsToCoord(iccs);
  if (!c) return false;
  // Retire any in-flight animation first (fast navigation). The caller already
  // ran drawBoard() for the NEW position, which wiped the old floats, so retire
  // WITHOUT drawing — drawing the prior move's piece now would stamp a stale one.
  if (BOARD_ANIM_CLEANUP) { const f = BOARD_ANIM_CLEANUP; BOARD_ANIM_CLEANUP = null; f(false); }

  CURRENT_REDP = isRedPerspective();
  const S = currentBoardStyle();
  const fromX = screenX(c.from.col), fromY = screenY(c.from.row);
  const toX = screenX(c.to.col), toY = screenY(c.to.row);

  const after = parseFen(newFen);
  const movedPiece = after && after.rows[c.to.row] ? after.rows[c.to.row][c.to.col] : null;
  if (!movedPiece) return false;
  const before = prevFen ? parseFen(prevFen) : null;
  const captured = before && before.rows[c.to.row] ? before.rows[c.to.row][c.to.col] : null;

  // Floating helpers, all removed on finish(). mk = a piece copy positioned at a
  // square; ring = a stroked pulse circle (flash style).
  const els = [];
  const mk = (p, x, y) => {
    const g = makeFloatingPiece(svg, p);
    g.setAttribute("transform", `translate(${x},${y})`);
    els.push(g); return g;
  };
  const ring = (x, y) => {
    const r = el("circle", { cx: x, cy: y, r: 24, fill: "none",
      stroke: (S.suggest && S.suggest.color) || "#3a8", "stroke-width": 3 }, svg);
    r.style.pointerEvents = "none"; els.push(r); return r;
  };

  // Per-style: pick a duration and a step(t) that drives the floating helpers.
  let dur, step;
  if (style === "pop") {
    dur = duration || 130;
    const dstG = mk(movedPiece, toX, toY);
    const capG = captured ? mk(captured, toX, toY) : null;
    const back = (t) => { const s = 1.7, p = t - 1; return 1 + (s + 1) * p * p * p + s * p * p; };
    step = (t) => {
      dstG.setAttribute("opacity", String(Math.min(1, t * 2)));
      dstG.setAttribute("transform", `translate(${toX},${toY}) scale(${0.85 + 0.15 * back(t)})`);
      if (capG) { capG.setAttribute("opacity", String(1 - t)); capG.setAttribute("transform", `translate(${toX},${toY}) scale(${1 - 0.3 * t})`); }
    };
  } else if (style === "slide") {
    dur = duration || 110;
    const g = mk(movedPiece, fromX, fromY);
    const capG = captured ? mk(captured, toX, toY) : null;
    step = (t) => {   // LINEAR glide, no overshoot / no lift — the toned-down slide
      g.setAttribute("transform", `translate(${fromX + (toX - fromX) * t},${fromY + (toY - fromY) * t})`);
      if (capG) capG.setAttribute("opacity", String(1 - t));
    };
  } else if (style === "flash") {
    dur = duration || 260;
    mk(movedPiece, toX, toY);                              // piece appears at once
    const capG = captured ? mk(captured, toX, toY) : null;
    const rg = ring(toX, toY);
    step = (t) => {
      rg.setAttribute("r", String(20 + 16 * t));
      rg.setAttribute("opacity", String(1 - t));
      rg.setAttribute("stroke-width", String(3 * (1 - t) + 0.5));
      if (capG) capG.setAttribute("opacity", String(Math.max(0, 1 - t * 2)));
    };
  } else {   // "fade" (default): cross-dissolve out at source, in at dest
    dur = duration || 150;
    const srcG = mk(movedPiece, fromX, fromY);
    const dstG = mk(movedPiece, toX, toY); dstG.setAttribute("opacity", "0");
    const capG = captured ? mk(captured, toX, toY) : null;
    step = (t) => {
      srcG.setAttribute("opacity", String(1 - t));
      dstG.setAttribute("opacity", String(t));
      if (capG) capG.setAttribute("opacity", String(1 - t));
    };
  }
  dur = Math.max(60, dur);

  let done = false;
  const finish = (draw) => {
    if (done) return; done = true;
    if (BOARD_ANIM_CLEANUP === finish) BOARD_ANIM_CLEANUP = null;
    for (const g of els) if (g && g.parentNode) g.parentNode.removeChild(g);
    // Drop the real piece ONLY on a true completion. When superseded, drawBoard()
    // has already repainted the board, so drawing here would stamp a stale piece.
    if (draw) drawPieceAt(svg, movedPiece, toX, toY, S);   // board was drawn with dest lifted
  };
  BOARD_ANIM_CLEANUP = finish;

  const start = performance.now();
  const frame = (now) => {
    if (done) return;
    let t = (now - start) / dur; if (t > 1) t = 1;
    step(t);
    if (t < 1) requestAnimationFrame(frame); else finish(true);
  };
  requestAnimationFrame(frame);
  // Fallback for when rAF is paused (tab hidden mid-slide): force completion so
  // the destination hole never lingers. No-op if already finished/superseded.
  setTimeout(() => finish(true), dur + 250);
  // NB: the move/capture SOUND is played by the caller (editor refreshActive),
  // independently of this animation, so it still chimes when animation is off but
  // sound is on. Don't play it here too or it would double up.
  return true;
}

// Synthesised wood "clack" via WebAudio — no asset files. Move = a single soft
// knock; capture = louder + lower with a second tap. Lazy AudioContext, resumed
// on the user gesture that triggered the move (click / key).
let _boardAudioCtx = null;
function playPieceSound(type) {
  if (document.documentElement.dataset.boardSound === "off") return;
  let ac = _boardAudioCtx;
  if (!ac) {
    try { ac = _boardAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (_) { return; }
  }
  if (!ac) return;
  if (ac.state === "suspended") { try { ac.resume(); } catch (_) { } }
  const t0 = ac.currentTime;
  // Low triangle "thock" with a fast pitch drop + percussive decay.
  const knock = (t, freq, gain, dur) => {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = "triangle";
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.6, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(ac.destination);
    o.start(t); o.stop(t + dur + 0.02);
  };
  // Short high-passed noise burst — the wood-on-wood "click".
  const tick = (t, gain, dur) => {
    const n = Math.max(1, Math.floor(ac.sampleRate * dur));
    const buf = ac.createBuffer(1, n, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
    const src = ac.createBufferSource(); src.buffer = buf;
    const hp = ac.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 1600;
    const g = ac.createGain(); g.gain.value = gain;
    src.connect(hp); hp.connect(g); g.connect(ac.destination); src.start(t);
  };
  if (type === "capture") {
    knock(t0, 210, 0.16, 0.13); tick(t0, 0.09, 0.05);
    knock(t0 + 0.05, 170, 0.11, 0.12);
  } else {
    knock(t0, 300, 0.12, 0.10); tick(t0, 0.06, 0.035);
  }
}

window.drawBoard = drawBoard;
window.animateBoardMove = animateBoardMove;
window.parseFen = parseFen;
window.applyIccs = applyIccs;
window.iccsToCoord = iccsToCoord;
window.ensurePieceFontLoaded = ensurePieceFontLoaded;
