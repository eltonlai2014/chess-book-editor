# 設計系統（梅友弈鑑）

樣式／配色／字型／icon 的**單一事實來源**。改任何視覺前先讀這裡，並維持「單一來源」
原則——不要在元件裡寫死顏色。此檔聚焦設計規範；功能 → `file:line` 對照在
[../ARCHITECTURE.md](../ARCHITECTURE.md)。

> 為什麼獨立成檔：避免 ARCHITECTURE.md 過大；設計規範與功能地圖是兩件事。

## 1. 配色：兩個下拉、一套 token

UI **介面主題**與**棋盤風格**是兩個獨立下拉，可自由配對（主人慣用：松煙灰＋傳統手繪）。

- **介面主題**（6 種）定義在 [frontend/assets/editor.css](../frontend/assets/editor.css)
  `:root` ＋ 每個 `html[data-ui-theme="…"]` 區塊，純 CSS 變數切換。
  - 配色**取自真實參考色票**（非自配）：媒體博物館級 palette（media.io）＋ 中國傳統色
    （zhongguose.com）。對映：松煙灰←Gallery Stone、琥珀夜←Bronze Artifact、
    赤銅棕←Terracotta Exhibit、梅影紫←Velvet Rope、青玉霧←Patina Frame、
    墨夜藍←黛/群青深藍底＋精煉 azure accent（名字是「藍」→ accent 就是藍，非金）。
  - 新增主題＝複製一個 `html[data-ui-theme]` 區塊改值；別在元件 CSS 寫死顏色。
- **棋盤風格**（5 種）定義在 [frontend/assets/board.js](../frontend/assets/board.js)
  `BOARD_STYLES`（JS 物件，驅動 SVG 程序化背景／棋子）。

### 語意 token（紅黑＝單一來源）

`--side-red` / `--side-red-strong`（紅方，硃砂/胭脂）、`--side-black` /
`--side-black-strong`（黑方，**永遠冷色**：黛→群青）定義在 `:root`，個別主題可覆寫
（如 ink/jade）。**膠囊與分析圖都吃這組 token**，所以「紅方／黑方」在任何主題、任何控件
都同色——這是當初修掉「黑方在膠囊是藍、在分析圖是米白」三色矛盾的根因。

分析圖另有 `--eval-line / --eval-red / --eval-black / --eval-query / --eval-flag`
（多數 derive 自 `--side-*`）。CSS 接點在 `.aiChart .ai*`；面積漸層在
[editor.js](../frontend/assets/editor.js) `renderAiChart`，用 `cssVar()`＋`hexToRgba()`
讀**葉子** token `--side-red-strong/--side-black-strong`（`getComputedStyle` 不會展開
巢狀 `var()`，故不能讀 `--eval-*`）。

棋盤箭頭（`ARROW_THEMES`）與選取框（`EDITOR_THEME_COLORS`）仍**隨棋盤**走（非介面主題），
因為它們疊在棋盤上、要對棋盤底色。

## 2. 字型：等寬對齊

- 介面正文用系統黑體（JhengHei…）；**資料區用 `--mono`** = `Sarasa Fixed TC`
  （更紗等寬，SIL OFL）。設計上 1 中文＝剛好 2 半形英數，棋譜編號／深N分數／引擎 PV／
  座標逐字成格，解決英數與中文不對齊。
- 字型**本地打包**（離線，比照 vendored cchess wheel）：`frontend/assets/fonts/`，
  以 fonttools 子集化成象棋記譜字集，每檔約 17KB。`@font-face` 在 editor.css 頂端，
  缺檔則 fallback 到 SF Mono/Consolas（數字仍對齊，CJK 退化）。
- 要加 mono 區塊：用 `font-family: var(--mono)`，別再寫 `"SF Mono",…`。
- 重建子集：`pip install fonttools brotli py7zr`，下載 Sarasa Fixed TC release 的
  `SarasaFixedTC-TTF-Unhinted` 7z，取 Regular/SemiBold，`Subsetter.populate(text=…)`
  → woff2。若資料區出現未涵蓋的 CJK（fallback 導致歪），把該字加進子集 charset 重建。

## 3. icon：單色線性 SVG

工具列／分頁／按鈕／資料來源 chip（根目錄📂・評估庫📊・引擎🐟）統一用
[editor.js](../frontend/assets/editor.js) 的 `ICON` 註冊表（Lucide 風、
`stroke="currentColor"` 隨主題變色）。

**例外：檔案樹保留彩色 emoji 📁/📚**——目錄/棋庫用顏色一眼分辨，比單色 SVG 清楚
（主人實測偏好）。只有樹狀目錄是這個例外，其餘一律 SVG、不用 emoji。

- 注入：靜態按鈕在開機區塊用 `iconLabel(key,label)` / `el.innerHTML = ICON[key]`；
  動態文字（檔案樹、路徑/引擎 chip）用 `setIconText(el,key,text)`（text 以 text node
  附加，路徑含 `<`/`&` 也安全）。
- 新 icon＝在 `ICON` 加一筆 24×24 stroke SVG。已備 `fish`(引擎)/`library`(棋庫)/
  `trophy`(賽事)。

## 4. 品牌

名稱 **梅友弈鑑**（扣《梅花譜》古譜＋「鑑」＝鑑賞；正字「弈」）。
favicon／左上 logo＝**朱文篆刻方印**：硃砂圓角方框＋篆/楷「梅」字（16px 仍清晰，扣名稱首字）。
SVG 在 [frontend/assets/favicon.svg](../frontend/assets/favicon.svg)；header 內嵌同款
（`.appSeal`，硃砂固定色，不隨主題——印就是紅的）。改名要同步 `<title>`、header、README、
本檔。

## 5. 預留接口（本輪未建 UI）

- **更換棋子類型**：`PIECE_FONTS` 是註冊表；`drawBoard` 以
  `document.documentElement.dataset.pieceFont || S.font` 解析字體。日後加 picker 設
  `html[data-piece-font]`＋`PREFS.pieceFont` 即可，棋盤碼不動。
- **上傳棋盤背景圖**：`drawBoard` 開頭若 `html[data-board-bg]` 有圖 URL/data-URI 就畫
  `<image>` 蓋過程序化背景（inert until set）。日後加 `PREFS.boardBgUrl`＋
  `POST /api/upload/background`＋picker。
