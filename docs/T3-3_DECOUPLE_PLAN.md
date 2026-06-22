# T3-3 解耦計畫：`window.POSITIONS` + `EDITOR` 全域

> 本檔是給**另開 session 執行**的計畫書。單一事實來源仍是
> `docs/OPTIMIZATION_BACKLOG.md`；此檔是其 T3-3 條目的展開。**收尾後刪本檔**（見
> backlog「收尾後的清理」與記憶 cleanup 原則）。
>
> **二次實證修正（2026-06-22，前提：解耦只在「對 AI 有幫助」時才做）**：fork 又從
> 1615 漲到 **1722 行**；重掃 board.js 全符號後，原計畫 live/dead 邊界**畫錯兩處**，已就地
> 訂正（見 §A.1 訂正欄）。B 子題經實證**高估了**，B2 縮編、B3 砍掉（見 §B）。
>
> 動手前先跑基準：`tests\test_routes.py`、`tests\test_engine_sse.py`、`tests\test_smoke_ui.py`
> 三支應全綠（非 ASCII 輸出設 `$env:PYTHONUTF8=1`）。每改一步重跑 smoke 當回歸網。

> **✅ 執行完成（2026-06-22）—— A1 + B2 已做、B3 不做。**
> - **A1**：board.js 整套靜態站死碼移除，**1722 → 762 行**（純 renderer）。`getEntry`/
>   `window.POSITIONS`/`STATE`/`drawChart`/demo/`injectBoardPicker` 全消失；保留渲染原語＋FEN/ICCS
>   helper＋`deltaSignClass`（雲庫著色）。`isRedPerspective` 改直讀 index.html 隱藏 `#redPerspective`
>   （`REDP_BOX` 拔除）。`index.html` `board.js?v=35→36`。
> - **驗證**：`node --check` 綠；routes/engine_sse 全綠；smoke **8/8 全綠**（順手查清並修掉一個與本案
>   無關、`3c7893b` 起的 smoke 競態偽陰性「reload: annote 持久化」——實證存檔有落盤，詳見 backlog）；
>   真瀏覽器確認 `deltaSignClass` 全域可達且著色正確、`getEntry`/`initGamePage` 已 undefined。
> - **B2**：`EDITOR` 宣告逐欄補 `[owner: …]`；ARCHITECTURE.md 新增「跨模組全域函式 API」清單（自動
>   算出）。**未做 295 行快照表**（會 rot）。
> - **B3 不做**（重寫狀態機、回歸面 > 收益，定案）。docs 已同步（ARCHITECTURE board.js 段＋
>   editor.js 檔頭）。**本計畫檔任務完成、可刪**（見 backlog「收尾後的清理」）。

---

## 0. 一句話結論

T3-3 其實是**兩個無關的問題**被 backlog 綁在一起，難度天差地遠。**判準是「對 AI
有幫助」**——不是行數，是「AI 改一處要同時推理幾處、會不會被誤導」：

| 子題 | 真相 | 對 AI 的實益 | 建議 |
|---|---|---|---|
| **A. `window.POSITIONS`** | 編輯器**從未寫入**它；唯一讀取點永遠回 `null`。連帶 board.js 夾帶整套**靜態站狀態機死碼**（~半個檔），且該死碼**偽裝成 live**（自洽的 getEntry/chart/demo） | **高**：移除一台「看似 live 的平行狀態機」。AI 被要求「調 eval 著色」時最自然會落到死的 `redPerspectiveScore`/`deltaCp`/`drawChart`，而編輯器真正的著色在 editor-cdb.js＋活的 `deltaSignClass` | **做**：board.js 切成純 renderer，`POSITIONS` 自然消失 |
| **B. `EDITOR` 全域物件** | 全域 singleton，295 處引用、7 檔——但 `EDITOR` 宣告（[editor.js:15](../frontend/assets/editor.js#L15)）**本身已是註解完整的 ownership map**，22 欄逐一有註解；真正的耦合面是**跨模組全域函式呼叫**，不是 state 物件 | **B2 中**（耐久才有益）／**B3 低**（重寫狀態機，AI 非急需） | **B2 縮編**：補欄位 owner 註解＋列跨模組函式 API（非 295 行快照表）；**B3 砍**（測試網不夠厚，回歸面 > 收益） |

---

## A. `window.POSITIONS` / board.js 解耦

### A.1 調查實證（2026-06-22，二次掃描）

- `window.POSITIONS` **全 repo 唯一讀取點** = `getEntry()`（[board.js:111](../frontend/assets/board.js#L111)）。
- **從未被賦值**：`index.html` 不載 `positions_view.js`（只載 board.js → 5 個 editor 模組 → editor.js → gif），全 repo grep `POSITIONS\s*=` 無命中。⇒ 編輯器裡 `getEntry()` 恆回 `null`。
- board.js 是 chess-book-ai 靜態站 renderer 的 **fork**（CLAUDE.md「copy board.js + applyIccs, accept drift」）。它夾帶整套**靜態站自有狀態機**，編輯器一個都不呼叫（編輯器自有 `EDITOR` 狀態機）：
  - 狀態/導航：`STATE{vi,pi}`、`hydrateGame`、`buildTreeLookups`、`activatePly`、`selectVariation`、`navigateToAlternative`、`scrollRowIntoView`、`findNearestBranchPly`、`initGamePage`、`redrawCurrentBoard`
  - eval 著色（全靠 `getEntry`）：`getEntry`、`redPerspectiveScore`、`deepEntry`、`redPerspectiveDeepScore`、`deltaCp`/`deepDeltaCp`、`deltaClass`、`fmtDelta`/`fmtScore`、`redDelta`/`deepRedDelta`
  - 圖表/列表/演示：`drawChart`(+`CHART_*`)、`renderAlts`、`annotateTable`、`renderAnnote`、`escapeHtml`、`updateStepInfo`、`updateNavStatus`、`updateBranchButton`、`updateDemoButtons`、`stopDemo`、`setDemoMode`、`startDemo`、`VAR_PICKER`、`ALTS_BY_FEN`、`MOVE_LOOKUP`、`injectBoardPicker`
- 編輯器**實際依賴的 board.js 介面**（純渲染/FEN 原語＋一個著色 helper）：
  - `drawBoard(svg, fen, bookMove, engineMove, liftIccs)`、`parseFen`、`applyIccs`、`iccsToCoord`、`ensurePieceFontLoaded`、`makeFloatingPiece`、`el`/`screenX`/`screenY`
  - perspective：`isRedPerspective` / 模組級 `CURRENT_REDP`（drawBoard 落鎖、editor 箭頭讀它）
  - 主題：`BOARD_STYLES` / `currentBoardStyle` / `PIECE_FONTS`（+ `mixHex`/`drawMeanderFrame`/`drawPieceAt`/`PIECE_CHAR`/`PIECE_CHARS_SUBSET`/`_loadedFonts`/`SVG_NS`）
  - **`deltaSignClass`**（cp→delta CSS class，editor-cdb.js 雲庫分數著色用）

#### ★ 二次掃描的訂正（原計畫畫錯，照舊執行會壞東西）

| 符號 | 原計畫 | 實證 | 後果 |
|---|---|---|---|
| `deltaSignClass` | 列為死碼（eval 著色族） | **活的** — [editor-cdb.js:182](../frontend/assets/editor-cdb.js#L182) 雲庫分數著色在用；函式體只看符號、不碰 `getEntry` | **必留**；照舊計畫刪 → 雲庫表配色壞 |
| `injectBoardPicker` | 列為 live 介面 | **死的** — 編輯器主題選單是 [index.html:27](../frontend/index.html#L27) 的**靜態 `<select id="boardThemeSel">`**，editor.js 自己接線（:145／:2692），從不呼叫 `injectBoardPicker`（它只被死的 `initGamePage` 呼叫） | 不影響刪除，但介面清單要訂正 |

- **關鍵安全事實（已重驗）**：`drawBoard` 渲染路徑（**510–839 行**）**乾淨**——不呼叫 `getEntry`/`STATE`。510–897 區間唯一出現 `STATE`/`getEntry` 的是 `redrawCurrentBoard`(848–861)，**它本身是死碼**（編輯器自己用 `drawBoard` 重繪）。`escapeHtml` 只被死的 `annotateTable`/`renderAlts` 呼叫 ⇒ 一併死。⇒ 移除 `POSITIONS`/`getEntry` 整組，drawBoard 完整無損。

### A.2 選項

- **A1（建議）— 切死碼，board.js 縮成純 renderer。** 移除上列整套靜態站狀態機 + eval 著色 + 圖表/演示；`window.POSITIONS`/`getEntry` 連根拔除（**但保留 `deltaSignClass`**）。board.js **1722 行 → 估 ~750–800 行**純渲染。`window.POSITIONS` 因「再無讀取點」自然消失，**不需要新接線**。
- A2 — 保留死碼，把 `getEntry` 改讀 `EDITOR.evalsByFen`。**不建議**：等於把靜態站 chart 接進編輯器，但編輯器已有自己的 `editor-aichart.js` + eval-line，會變兩套並行、徒增耦合（與「對 AI 有幫助」相反）。
- A3 — 抽跨 repo 共用 `xiangqi-board-lib`（CLAUDE.md 長期目標）。**最大、跨兩 repo**，不在本次 scope；但 A1 把純渲染原語清出來，正好替 A3 鋪邊界。

### A.3 執行步驟（A1）

1. 跑三支基準測試（綠）。
2. 對每個「待刪」函式 grep 全 `frontend/`：確認**只被 board.js 內部互相呼叫**、無 `editor*.js` / `index.html`(inline `onclick`) / `gifexport.js` 引用。有引用的不在死碼集（**已知例外＝`deltaSignClass`，必留**）。
3. **live/dead 在 848–897 是交錯的**（makeFloatingPiece 活、redrawCurrentBoard 死、injectBoardPicker 死、後面 escapeHtml/annotate 族死）——**不能整段切**，要逐函式判。自底向上分塊刪（先 `drawChart`/eval-delta 族（**留 deltaSignClass**）→ `renderAlts`/`annotateTable`/`escapeHtml`/`updateStepInfo` → `STATE`/`activatePly`/`selectVariation`/`startDemo`/`initGamePage`/`injectBoardPicker`/`redrawCurrentBoard` → 最後 `getEntry`/`POSITIONS`）。**每刪一塊跑 `tests\test_smoke_ui.py`**（真 Chromium 驗 board renders pieces / navigate / 棋盤主題切換）。
4. board.js 結尾 `window.*` 匯出清單（目前 6 個：drawBoard/parseFen/applyIccs/iccsToCoord/ensurePieceFontLoaded/**initGamePage**）同步收斂——`initGamePage` 死了，匯出可一併移除（先 grep `window.initGamePage` 全 repo 確認無人讀）。
5. `index.html` 把 `board.js?v=…` 版本號 bump（VSCode webview 會吃舊 JS 快取，見記憶 `reference_vscode_webview_css_cache`）。
6. docs 同 commit：ARCHITECTURE.md board.js 區塊 + 本檔 A 段標 DONE + backlog T3-3 狀態。

### A.4 風險與驗證

- 風險：board.js 是 fork，刪錯壞渲染。**逐塊刪 + 每塊 smoke** 是主要防線；smoke SKIP（無 Chromium）時務必手動 `python -m playwright install chromium` 後補跑，別在沒視覺驗證下合併。
- **最易踩的雷＝`deltaSignClass`**（坐落 eval-delta 死碼簇中間，但是活的）：刪該簇時把它跳過。smoke 目前**未必覆蓋雲庫分數著色**——刪完務必手動開一個有雲庫資料的局面，確認分數仍有紅/綠濃淡。
- 副作用：刪死碼會讓編輯器的 board.js 與 chess-book-ai 上游**漂移更大**——這是已接受的代價（CLAUDE.md），且 A3 才是收斂漂移的正解。
- 工作量：中（~1 session）。機械刪除為主，但 1700 行要逐塊判 live/dead，謹慎。

---

## B. `EDITOR` 全域物件解耦

### B.1 調查實證（二次）

- `EDITOR` = 單一可變 singleton，**295 處引用、跨 7 檔**：editor.js 180、editor-cdb 37、editor-autoplay 25、editor-aichart 15、editor-demo 16、editor-engine 13、gifexport 2。
- **但「295 處很亂」被實證打臉**：`EDITOR` 宣告（[editor.js:15–48](../frontend/assets/editor.js#L15)）本身**已是註解完整的 ownership map**——22 個頂層欄位逐一有註解（`currentPath`/`data`/`activePath`/`evalsByFen`/`cdbLive`/`autoPlay`…），多數引用只是讀取良名欄位。寫入點更集中（`cdbScope`×7、`dirty`/`activePath`/`rootOk`×4…）。
- 真正的耦合面**不是 state 物件，是跨模組全域函式呼叫**（editor-cdb/autoplay/aichart/… 直接呼叫 editor.js 的全域函式，classic script 共享 scope）。這才是「改一處要推理幾處」的來源，也是 T2-1「機械拆檔但沒解耦」的根。

### B.2 選項（已縮編）

- B1 — 現狀（隱式全域 singleton）。
- **B2（建議起步，純分析、零回歸風險，~半小時）— 但不做 295 行快照表。** 快照表會 rot（違反記憶 `feedback_avoid_snapshot_docs`）。改產**兩件耐久物**：
  1. 在 `EDITOR` 宣告的欄位註解上**標 owner 模組**（哪個檔「擁有/負責寫」該欄；如 `cdbLive`/`cdbScope`→editor-cdb、`autoPlay`→editor-autoplay、`demo`→editor-demo、`aiAnalysis`→editor-aichart、`engineAnalysis`→editor-engine）。
  2. 在 ARCHITECTURE.md 列出**跨檔被呼叫的全域函式清單**（真正的模組 API 線）——這條才是 AI「改這函式、誰跨檔呼叫」要查的東西。
- B3 — 真模組化（拆 `EDITOR` 成子物件 + getter/setter 或顯式 import-export）。**砍**：等於重寫狀態機，現有 smoke 只覆蓋開檔／導航／註解／存檔，回歸面遠大於網；且已定案維持 classic script。**對 AI 的實益來自依賴清晰度（B2 已給），不是改寫結構**——B3 不做。

### B.3 為何 B2 縮編、B3 砍

- 對 AI 的實益來自**依賴清晰度**，不是檔案結構。`EDITOR` 宣告已自我說明 state；缺的只是「owner 標註 + 跨模組函式 API」這兩條——B2 縮編版**零回歸風險**就補齊。
- B3 的回歸面遠大於現有安全網。在更厚的前端測試網出現前，**預設不做**；除非日後 smoke 變厚、且某條邊界被證明「低成本、高收益」。

---

## 建議執行順序（給新 session）

1. 跑 `tests\test_routes.py` + `tests\test_engine_sse.py` + `tests\test_smoke_ui.py` 建基準（全綠）。
2. **A1**：board.js 切死碼 → 純 renderer，`window.POSITIONS` 消失。**逐函式判（`deltaSignClass` 必留）**、每塊 smoke、刪完手動驗雲庫著色、bump `?v=`、docs 同 commit。← **本次主要可交付**
3. **B2（縮編版）**：`EDITOR` 欄位標 owner 註解 + ARCHITECTURE 列跨模組全域函式 API（純分析）。
4. **B3 不做**（已定案）；除非日後 smoke 變厚且圖指出低成本高收益切點。
5. 全週期收尾：刪本計畫檔 + codex 鷹架（`docs/CODEX_REVIEW_HANDOFF.md`、`docs/CODEX_REVIEW_FEEDBACK.md`），見記憶 `feedback_cleanup_transient_docs`。

**工作量總評**：A1 ~1 session（低風險、即時 AI 收益）；B2 縮編 ~半小時（純分析、耐久）；B3 不做。
