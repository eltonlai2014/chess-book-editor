# 設計系統（梅友弈鑑）

樣式／配色／字型／icon 的**單一事實來源**。改任何視覺前先讀這裡，並維持「單一來源」
原則——不要在元件裡寫死顏色。此檔聚焦設計規範；功能 → `file:line` 對照在
[../ARCHITECTURE.md](../ARCHITECTURE.md)。

> 為什麼獨立成檔：避免 ARCHITECTURE.md 過大；設計規範與功能地圖是兩件事。

## 1. 配色：兩個下拉、一套 token

UI **介面主題**與**棋盤風格**是兩個獨立下拉，可自由配對（主人慣用：松煙灰＋傳統手繪）。

- **介面主題**（清單見 [editor.js](../frontend/assets/editor.js) `UI_THEMES`）定義在
  [frontend/assets/editor.css](../frontend/assets/editor.css) `:root` ＋ 每個
  `html[data-ui-theme="…"]` 區塊，純 CSS 變數切換。摩莎青(moxa)＝Moxa 品牌青綠
  accent 的深色主題（深青灰面）。
  - 配色**取自真實參考色票**（非自配）：媒體博物館級 palette（media.io）＋ 中國傳統色
    （zhongguose.com）。對映：松煙灰←Gallery Stone、琥珀夜←Bronze Artifact、
    赤銅棕←Terracotta Exhibit、梅影紫←Velvet Rope、青玉霧←Patina Frame、
    墨夜藍←黛/群青深藍底＋精煉 azure accent（名字是「藍」→ accent 就是藍，非金）。
  - 霜月白(light)＝**唯一的淺色主題**（冷白襯底＋灰面板＋摩莎青 accent，配青瓷盤）。淺色不是把暗色
    反過來改值就好，有三點結構差異：①elevation 反轉（raised 面板偏白 `--bg-2=#fff`、
    hover/header 反而偏灰）；②`*-strong` 取「更深」而非更亮（淺底上更亮＝更糊）；
    ③大量視覺值在 `:root` 是**暗色預設**（陰影、表面漸層、按鈕／晶片／狀態／走勢圖文字色、
    以及 bevel 邊緣高光…），淺底**必須一併覆寫**——整理成下方〈表面／控件 token 族〉與
    〈bevel／邊緣高光 token 族〉，淺色在那兩處翻轉即可。原本散落寫死的
    `rgba(255,255,255,.02~.24)` bevel 高光（暗底打白光假設、淺底近乎隱形）已全數收進
    `--bevel-*` 族，不再有元件級寫死白光。
  - 新增主題＝複製一個 `html[data-ui-theme]` 區塊改值；別在元件 CSS 寫死顏色。
    （淺色主題例外：照上述三點多覆寫繼承自 `:root` 的暗色 token。）
- **棋盤風格**（5 種）定義在 [frontend/assets/board.js](../frontend/assets/board.js)
  `BOARD_STYLES`（JS 物件，驅動 SVG 程序化背景／棋子）。

### 語意 token（紅黑＝單一來源）

`--side-red` / `--side-red-strong`（紅方，硃砂/胭脂）、`--side-black` /
`--side-black-strong`（黑方，**永遠冷色**：黛→群青）定義在 `:root`，個別主題可覆寫
（如 ink/jade）。**膠囊與分析圖都吃這組 token**，所以「紅方／黑方」在任何主題、任何控件
都同色——這是當初修掉「黑方在膠囊是藍、在分析圖是米白」三色矛盾的根因。

分析圖另有 `--eval-line / --eval-red / --eval-black / --eval-query / --eval-flag`
（多數 derive 自 `--side-*`）。CSS 接點在 `.aiChart .ai*`；面積漸層在
[editor.js](../frontend/assets/editor.js) `drawAiChart`，用 `cssVar()`＋`hexToRgba()`
讀**葉子** token `--side-red-strong/--side-black-strong`（`getComputedStyle` 不會展開
巢狀 `var()`，故不能讀 `--eval-*`）。面積**深度**另抽 `--chart-area-alpha`（`:root` 0.42；
霜月白調到 0.16 走素淨），讓淺色把優勢填色變淡而不動暗色。

棋盤箭頭（`ARROW_THEMES`）與選取框（`EDITOR_THEME_COLORS`）仍**隨棋盤**走（非介面主題），
因為它們疊在棋盤上、要對棋盤底色。

### 棋譜紅黑著手 ＋ 文字可讀性（淺色取捨）

- **棋譜清單著手字色走 `--ply-red`／`--ply-black` token**：`:root`＝`var(--text)`／
  `var(--text-muted)`（暗色 byte-identical），霜月白覆寫成 `--ply-red:var(--side-red-strong)`
  （＝#a92518 朱紅）、`--ply-black:var(--text)`（近黑）——白底紅黑是最通用譜式。
  **當前手保留紅/黑原色**：active 只靠青底＋左線＋粗體標示，**不把字染成 accent 青**
  （淺色限定 `html[data-ui-theme="light"] .plyLine.active{…}` 三條覆寫；暗色仍用
  `--text-active`/`--accent-strong`，深底才夠亮）。
- **對比度底線**（淺底最易踩，量過再改）：①承載資訊的文字（著手序號等）至少 `--text-muted`
  階，別用 `--text-faint`（淺底僅 ~3:1，faint 只留純裝飾）；②**小字不要拿 `--accent` 當文字色**
  （淺底 ~2.9:1）——要 accent 色感改用更深的 `--accent-strong`（霜月白＝#146f68，已給標題／
  文字對比餘裕）或 `--chip-text`，並確認 ≥ AA 4.5:1。驗證工具：`tools/ui_shot.py`（真 Chromium
  截圖＋量 computed style）。

### 表面／控件 token 族（淺色主題的覆寫面）

面板/卡片/輸入框的背景、按鈕文字、晶片字、狀態色等**原本散落寫死成暖棕暗色**（暗底假設，
正是讓霜月白第一版面板全黑、字暈/糊的根因）。已集中成下列族，**`:root` 值＝原暗色（暗主題
byte-identical）、`html[data-ui-theme="light"]` 一處覆寫成冷淺色**。新增淺色相關視覺一律
擴充這些 token，別在元件 CSS 開第二條路。CSS 定義都在
[editor.css](../frontend/assets/editor.css)：

- **`--surface-*`**（`panel`／`head`／`head-solid`／`scroll`／`input`／`input-focus`／
  `eval`／`raised`）＝面板/標題列/捲動區/輸入框/eval 行/卡片的背景漸層。`*-solid`＝
  sticky 標題用不透明底（捲動內容不可透出）。**只有這些 token 帶 surface 背景**，所以淺色
  在這一族就能整批翻成灰白。注意 `--surface-head` 只給 `#navBar`、`--surface-eval` 只給
  `#evalLine`（霜月白把這兩個調成淡青，與灰面板區隔），改它們不波及面板標題。
- **按鈕**：`--btn-primary-text`(/`-hover`)＝填色主鈕（儲存/建立/套用）文字（暗＝深字壓金/青；
  淺＝白字）；`--btn-ghost-text`＝ghost 鈕文字；`--btn-active-bg`(/`-text`)＝segmented 選中段；
  `--btn-glass-bg`＝ghost 鈕底（淺色＝白→淺灰藥丸，否則白底上隱形）。
- **`--chip-text` / `--chip-text-strong`**＝路徑/資料庫晶片（`.rootPath`／`.evalDbRow`）文字
  （淺色＝深青，否則青字壓青底看不清）。
- **`--wdl-win` / `--wdl-draw` / `--wdl-loss`**＝引擎勝率 勝/和/負（`.engMeta .wdl*`）；
  暗色淺綠/淡灰/紅，淺色一律調深。
- **`--readout-muted`**＝導航列走法字（`#moveInfo`）＋eval 行底字（`#evalLine`）的中性讀數色
  （原寫死暖米 `#c7bda9/#bfb5a2`，淺底糊）。
- **`--ok`**＝「● 已載入」狀態綠（`:root` 淡綠 dark-tuned，霜月白覆寫深綠）。

### bevel／邊緣高光 token 族（淺色主題的覆寫面）

面板/輸入框/晶片/彈窗的 **inset 頂緣高光、標題列 sheen 漸層、ghost 髮絲框、檔案列 hover**
原本散落寫死 `rgba(255,255,255,.02~.24)`——「光從上方打在**暗**面」的假設，到霜月白的近白
面板上整批隱形。已集中成 `--bevel-*` 族（CSS 定義在
[editor.css](../frontend/assets/editor.css) `:root` 與 `[data-ui-theme="light"]`）：
**`:root` 保留暗色值**（少數平面 inset 把 0.02/0.04 併到 0.03＝1px 線上不可辨差），與已
light-tuned 的 `--shadow-*` 搭配出底部深度；**淺色一處翻成可見的亮邊／深髮絲線／變暗 hover**。
新增 bevel 相關視覺一律擴充這族，別在元件 CSS 再寫死白光。

- **`--bevel-hi`**＝1px inset 頂緣高光（面板/輸入框/`#navBar`/`#evalLine`/晶片/彈窗）。
  暗＝白 3%（近乎隱形的微光）；淺＝白 72%（灰卡上一道清楚亮邊）。
- **`--bevel-sheen`**＝多像素 sheen 漸層起點＋小面積填色微光（標題列 `.panelHead`、走法
  `.plyMark`）。當 `linear-gradient(180deg, var(--bevel-sheen), transparent)` 用。暗＝白 2%、
  淺＝白 35%（比 `--bevel-hi` 柔，因為它鋪開不是 1px）。
- **`--bevel-pill` / `--bevel-pill-hover`**＝立體藥丸（`.annoteChip`）頂緣高光與 hover 較亮的
  圓頂。暗＝白 20%/24%（藥丸本身有色，故暗底也看得見）；淺＝白 55%/70%。
- **`--bevel-edge`**＝ghost 小鈕髮絲框（`.varOpt .varMoveBtn`）。暗＝**白** 10%；淺＝**黑** 12%
  （白框在淺卡上隱形，故翻成深髮絲線）——本族唯一暗白／淺黑對調的 token。
- **`--row-hover-bg`**＝檔案樹列 hover 底（`#fileTree li.file:hover`）。暗＝白漸層（打亮）；
  淺＝黑漸層（壓暗）——白上加白看不出 hover，故淺色改成變暗。

棋盤（`BOARD_STYLES`）是**獨立系統**、不吃上列 UI token。其中 `celadon`(青瓷素雅) 適配白底
UI：淺盤須 `engrave:false`（深盤的壓印字在淺盤上會雙影＝暈開），紅字取深濃紅、lastMove/
suggest 取對比強的藍/橘（灰綠環會融進綠灰盤）。

**棋子字加粗＝同色描邊（`red`/`black` 的 `textStroke` px），不是 `font-weight`。**
棋子楷書 LXGW WenKai 最粗的設計字重就是 700（見下 §2），再粗只能靠 `drawPieceAt` 給字描一道
同色 stroke（`paint-order:stroke`＝純加粗、邊緣補實）——拉高 `font-weight` 只會觸發瀏覽器
合成假粗體＝糊邊。celadon 紅字（深紅落在淺盤、28px 細筆易顯洗白）用 `textStroke:0.7`；其餘
主題不設＝不描邊。要更粗/更細調這個值即可。

## 2. 字型：等寬對齊

- 介面正文用系統黑體（JhengHei…）；**資料區用 `--mono`** = `Sarasa Fixed TC`
  （更紗等寬，SIL OFL）。設計上 1 中文＝剛好 2 半形英數，棋譜編號／深N分數／引擎 PV／
  座標逐字成格，解決英數與中文不對齊。
- 字型**本地打包**（離線，比照 vendored cchess wheel）：`frontend/assets/fonts/`，
  以 fonttools 子集化成象棋記譜字集，每檔約 17KB。`@font-face` 在 editor.css 頂端，
  缺檔則 fallback 到 SF Mono/Consolas（數字仍對齊，CJK 退化）。
- **棋子字 LXGW WenKai TC Bold 也本地打包**（`lxgw-wenkai-tc-bold.woff2`，子集＝16 棋子字＋
  楚河漢界，約 6KB），不再走 Google Fonts CDN（離線可用、不靠網路）。專屬 family
  `LXGW WenKai Piece`（board.js `PIECE_FONTS.wenkai` 起手）只給棋盤用，與 UI 文字共用的
  `LXGW WenKai TC` 隔離（後者仍 fallback JhengHei）。**700 是這套字最粗的設計字重**
  （Google Fonts 只供 300/400/700），淺盤要再粗靠 `textStroke`（見 §1 celadon 段）。
- **換主機免裝字型**：woff2 是字型檔本身、隨 git 入庫，瀏覽器以 `@font-face` 載入，與
  作業系統有無安裝該字型無關。兩套字皆 SIL OFL 1.1，授權＋版權聲明見
  [frontend/assets/fonts/LICENSE.md](../frontend/assets/fonts/LICENSE.md)（OFL 要求散布附帶）。
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

## 6. 右欄分頁控制列（雲庫／雲庫演繹／引擎分析／AI走棋）

四個分頁頂部的控制列**統一用 `.engineBar`**（[editor.css](../frontend/assets/editor.css)）：

- **版面**：動作按鈕靠左、狀態文字（`.engineState`，`margin-left:auto`）靠右；
  分頁本體 `display:flex;flex-direction:column;gap:8px`（控制列↔內容固定 8px）。
- **按鈕**：一律 `.iconBtn`，藥丸形（`border-radius:999px`）、高 30px、`min-width:86px`
  使整列等寬；圖示走 `iconLabel(key,label)`（見 §3）。
- **模式切換用共用元件 `.segToggle`／`.segBtn`**——**接合式 segmented control**
  （單一藥丸＋內部分隔線、選中半邊高亮 `.segBtn.active`、text-only），高度對齊
  `.engineBar .iconBtn`(30px) 但刻意有別於動作按鈕（這是「擇一模式」而非動作）。
  目前用在：雲庫「當前步／下一步」、引擎分析「前一步／本步」。**新增「擇一模式」
  一律複用 `.segToggle`**，別再寫獨立樣式。新增同類分頁沿用 `.engineBar`，別再造
  第二套 bar（舊 `.cdbBar`/`.cdbScopeToggle` 已併入）。
