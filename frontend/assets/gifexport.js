/* 把目前主線匯出成動畫 GIF。
 *
 * 純前端：重用 board.js 的 drawBoard() 逐手畫到一個「離屏」SVG → 內嵌棋子字型 →
 * 光柵化進 <canvas> → 用 gifenc 編碼成 GIF → 下載。後端零改動。
 *
 * 字型內嵌（loadEmbeddedFontCss）：離屏光柵化時頁面的 <link> webfont 不會生效，
 * 所以抓 PIECE_FONTS[style].googleUrl 那份已子集化(&text=)的 Google Fonts CSS，
 * 把 url(...woff2) 換成 base64 data URI，注入每格 SVG 的 <defs><style> → 像素一致。
 * 抓失敗（離線等）則退回系統 CJK 字型，不擋匯出。
 *
 * 尚未做：節流/取消鈕；~100 影格編碼會略卡（已 setTimeout(0) 讓出主執行緒）。
 *
 * 依賴的全域（皆為先載入 script 的 top-level 宣告）：
 *  currentLine, EDITOR, drawBoard, applyIccs, currentBoardStyle, PIECE_FONTS,
 *  gifFrameDelaySec, SVG_NS, $ ；以及 window.gifenc（GIFEncoder / quantize / applyPalette）。
 */
(function () {
  const BOARD_W = 540;
  const BOARD_H = 600;
  const CAPTION_H = 44;         // 底部字幕條高度
  const OUT_W = BOARD_W;
  const OUT_H = BOARD_H + CAPTION_H;

  // 每手停留 ms：讀 ⚙ 設定的「影格間隔（秒）」（gifFrameDelaySec getter，預設 0.65s）。
  // 最後一格停久一點＝該間隔 ×2.5，讓 GIF loop 回頭前看得清終局。
  function frameDelayMs() {
    const sec = (typeof gifFrameDelaySec === "function") ? gifFrameDelaySec() : 0.65;
    return Math.round(sec * 1000);
  }

  // 離屏 SVG（重用一個，每格 drawBoard 會先清空再重畫）
  function makeOffscreenSvg() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("xmlns", SVG_NS);
    svg.setAttribute("viewBox", `0 0 ${BOARD_W} ${BOARD_H}`);
    svg.setAttribute("width", BOARD_W);
    svg.setAttribute("height", BOARD_H);
    return svg;
  }

  function svgToImage(svg) {
    // 用 Blob URL（不是 data: + encodeURIComponent）——SVG 內嵌了 base64 字型後
    // 字串很大，每格再 encodeURIComponent 會白白吃 CPU。
    const str = new XMLSerializer().serializeToString(svg);
    const url = URL.createObjectURL(new Blob([str], { type: "image/svg+xml;charset=utf-8" }));
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("SVG 光柵化失敗")); };
      img.src = url;
    });
  }

  // ---- 字型內嵌 ----
  // 棋子是唯一用 webfont(wenkai) 的元素（座標/楚河漢界走 serif）。離屏光柵化時
  // webfont 不會被當前頁面的 <link> 帶進去，所以這裡把那份 Google Fonts CSS 抓下來、
  // 把其中的 url(...woff2) 換成 base64 data URI，注入每格 SVG 的 <defs><style>，
  // 讓 SVG 自帶字型 → 光柵化出來與螢幕像素一致。抓一次就快取。
  const _fontCache = { key: null, css: "" };

  function abToB64(buf) {
    let bin = "";
    const bytes = new Uint8Array(buf);
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  async function loadEmbeddedFontCss() {
    const key = (typeof currentBoardStyle === "function") ? currentBoardStyle().font : null;
    const f = (typeof PIECE_FONTS !== "undefined" && key) ? PIECE_FONTS[key] : null;
    if (!f || (!f.localUrl && !f.googleUrl)) return "";   // 系統字型（如 classic=serif），免內嵌
    if (_fontCache.key === key) return _fontCache.css;
    try {
      let css;
      if (f.localUrl) {
        // 本地子集化 woff2 → 直接組 @font-face base64（離線、匯出不靠網路）。
        const buf = await (await fetch(f.localUrl)).arrayBuffer();
        const fam = f.localFamily || "LXGW WenKai Piece";
        css = `@font-face{font-family:'${fam}';font-weight:${f.weight || "700"};`
            + `font-style:normal;src:url(data:font/woff2;base64,${abToB64(buf)}) format('woff2');}`;
      } else {
        // 舊路徑：抓 Google Fonts CSS，把其中 url(...woff2) 換成 base64 data URI。
        css = await (await fetch(f.googleUrl)).text();
        const urls = [...new Set(
          [...css.matchAll(/url\(\s*['"]?(https:\/\/[^)'"]+)['"]?\s*\)/g)].map((m) => m[1])
        )];
        for (const u of urls) {
          const buf = await (await fetch(u)).arrayBuffer();
          css = css.split(u).join("data:font/woff2;base64," + abToB64(buf));
        }
      }
      _fontCache.key = key;
      _fontCache.css = css;
      return css;
    } catch (e) {
      console.warn("字型內嵌失敗，退回系統字型：", e);
      return "";    // 失敗就退回 PoC 行為，不擋匯出
    }
  }

  // drawBoard 每格會清空 svg 並建自己的 <defs>，所以字型 <style> 要在 drawBoard 之後注入
  function injectFontStyle(svg, css) {
    if (!css) return;
    let defs = svg.querySelector("defs");
    if (!defs) {
      defs = document.createElementNS(SVG_NS, "defs");
      svg.insertBefore(defs, svg.firstChild);
    }
    const style = document.createElementNS(SVG_NS, "style");
    style.textContent = css;
    defs.appendChild(style);
  }

  // 把每一格畫到 ctx：上方棋盤 + 底部字幕條
  function paintCaption(ctx, title, stepText) {
    ctx.fillStyle = "#1c1c1c";
    ctx.fillRect(0, BOARD_H, OUT_W, CAPTION_H);
    ctx.fillStyle = "#f5f5f5";
    ctx.textBaseline = "middle";
    ctx.font = "16px 'Microsoft JhengHei','PingFang TC',sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(title, 12, BOARD_H + CAPTION_H / 2);
    ctx.textAlign = "right";
    ctx.fillText(stepText, OUT_W - 12, BOARD_H + CAPTION_H / 2);
  }

  // 組出影格描述：起始局面 + 每一手（post-move FEN + last-move 高亮）
  function buildFrames() {
    const line = currentLine();
    const total = line.length;
    const frames = [];
    if (!EDITOR.data) return frames;
    frames.push({ fen: EDITOR.data.init_fen, hi: null, label: `起始局面　共 ${total} 步` });
    for (let i = 0; i < total; i++) {
      const item = line[i];
      frames.push({
        fen: applyIccs(item.fen, item.node.iccs),
        hi: item.node.iccs,
        label: `第 ${i + 1} 步　共 ${total} 步`,
      });
    }
    return frames;
  }

  async function exportGif(btn) {
    if (!window.gifenc) { alert("gifenc 未載入"); return; }
    const frames = buildFrames();
    if (frames.length <= 1) { alert("目前沒有可匯出的著法。"); return; }

    const title = ($("#fileTitle")?.textContent || "棋局").trim();
    const { GIFEncoder, quantize, applyPalette } = window.gifenc;

    const svg = makeOffscreenSvg();
    const canvas = document.createElement("canvas");
    canvas.width = OUT_W;
    canvas.height = OUT_H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const gif = GIFEncoder();
    // 按鈕是純圖示，進度寫到 header 的 #status，別動 textContent（會撐爆版面）
    const statusEl = document.getElementById("status");
    const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };
    btn.disabled = true;

    try {
      setStatus("🎬 準備字型…");
      const fontCss = await loadEmbeddedFontCss();   // 抓一次、快取
      const delay = frameDelayMs();
      const lastDelay = Math.round(delay * 2.5);

      for (let f = 0; f < frames.length; f++) {
        const fr = frames[f];
        drawBoard(svg, fr.fen, fr.hi, null);           // 重用螢幕上同一套畫盤
        injectFontStyle(svg, fontCss);                 // 內嵌字型 → 像素一致
        const img = await svgToImage(svg);

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, OUT_W, OUT_H);
        ctx.drawImage(img, 0, 0, BOARD_W, BOARD_H);
        paintCaption(ctx, title, fr.label);

        const { data } = ctx.getImageData(0, 0, OUT_W, OUT_H);
        const palette = quantize(data, 256);
        const index = applyPalette(data, palette);
        gif.writeFrame(index, OUT_W, OUT_H, {
          palette,
          delay: f === frames.length - 1 ? lastDelay : delay,
        });

        setStatus(`🎬 匯出中 ${f + 1}/${frames.length}`);
        // 讓出主執行緒，避免整個 UI 卡死
        await new Promise((r) => setTimeout(r, 0));
      }

      gif.finish();
      const blob = new Blob([gif.bytes()], { type: "image/gif" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const safeTitle = title.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 40) || "棋局";
      a.href = url;
      a.download = `${safeTitle}.gif`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      // 完成訊息不 echo 檔名：下載本身已帶檔名，header #status 複述整串（含
      // .XQF/「- 複製」等雜訊）即使省略號截斷仍佔掉一大塊、推擠標題列。短確認即可。
      setStatus("🎬 已匯出 GIF");
    } catch (e) {
      console.error(e);
      setStatus("");
      alert("匯出失敗：" + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("exportGifBtn");
    if (btn) btn.addEventListener("click", () => exportGif(btn));
  });
})();
