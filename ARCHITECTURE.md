# ARCHITECTURE.md

本檔是「重開 session 不失憶」的單一事實來源：**系統有哪些功能、為什麼這樣設計、每個功能的程式碼在哪**。
擴充／修改前先讀這裡定位，再跳到對應 `file:line`。行號會漂移 —— 以函式名為準，行號只是起點。

設計原則／陷阱的「為什麼」散在 [CLAUDE.md](CLAUDE.md)；本檔聚焦「在哪裡、做什麼」並彙整原則速查。

---

## 1. 系統總覽

產品名 **「棋鑑」**（h1 logo＋title）。純本機工具（非公開部署）。三層：

```
瀏覽器 (vanilla JS, 無框架)
  ├─ board.js   棋盤渲染器 + FEN/ICCS helper（與 chess-book-ai 同源，會漂移）
  └─ editor.js  編輯器全部邏輯（狀態機 EDITOR + 走子樹 + 即時分析 + 演示）
        │  fetch / EventSource(SSE)
        ▼
Flask (backend/app.py, threaded=True) —— 同時 serve 前端靜態檔 + JSON/SSE API
  ├─ xqf_service.py   XQF book ⇄ JSON、中文著法、PV 轉譜、合法著點
  ├─ vendor/io_xqf_patched.py  PatchedXQFWriter（XQF 寫檔，修上游 3 bug）
  ├─ eval_service.py  唯讀讀取 chess-book-ai 的 positions.db（評估/雲庫勝率）
  ├─ chessdb_service.py  即時查 chessdb.cn 雲庫（cache-first；寫 editor 自有快取）
  └─ (subprocess) pikafish  即時分析，execs 既有 binary，逐層 stream，不落地
        ▲
        └─ 唯讀共享資料：../chess-book-ai/output/positions.db、D:\Elton\TestArea\chess-book\
```

**狀態流**：`EDITOR`（editor.js:15）持有整份棋譜 JSON（`data`）＋目前路徑（`activePath`，index 路徑陣列）。
所有導航＝改 `activePath` 後呼叫 `refreshActive()`（重畫盤面/棋譜/注解/走法/評估列）。
走子樹節點用「index path」定位（`nodeAt`、`siblingsAt`、`fenAndLastIccsFor`）。

---

## 2. 設計原則速查（違反就會壞）

| 原則 | 細節 | 強制點 |
|---|---|---|
| **廣度 vs 深度分工** | 批量掃庫找問題＝chess-book-ai；鑽研單一盤面（輸入＋深算＋註解）＝本 repo。別在此重建批量管線。 | CLAUDE.md |
| **即時分析純暫態** | SSE execs pikafish，逐層 stream，斷線即 kill，**任何結果都不落地**（對比 positions.db）。 | app.py `engine_analyze` |
| **AI 走勢圖掃描** | `analyze_line` 重用單一引擎進程跑整條線，**逐局面不送 `ucinewgame`**（TT 累積→低層數即準，但各點非嚴格獨立）。層數＝pref `aiAnalysisDepth`(預設12)。 | app.py `analyze_line`；memory `project-ai-line-depth` |
| **App shell 用 flex** | body flex column＋header 自動高＋main `flex:1`＋`overflow:hidden`；**勿寫死 header 高度**（曾因 `calc(100vh-52px)` 比實際矮而溢出產生捲軸）。 | editor.css `body`/`header`/`main` |
| **positions.db 唯讀** | `?mode=ro` 開啟，永不 INSERT/UPDATE，檔案歸 AI repo 管。 | eval_service.py `_open_ro` |
| **雲庫 cache-first＋自有快取** | 即時查 chessdb.cn 前先讀唯讀 positions.db→再讀 editor 自有 `output/editor_chessdb_cache.db`（**唯一可寫**的雲庫快取）→miss 才打網路並寫回。**禁寫 positions.db、禁碰 AI repo 的 chessdb_cache.json**。逐局面查（非整檔 batch）以守 chessdb 速率禮貌。 | chessdb_service.py `lookup`；CHESSDB_CLOUD_QUERY.md |
| **著法字形** | 紅方：馬→傌 士→仕 象→相 車→俥 將→帥；**砲不換**（保留砲）。黑方：砲→包。 | xqf_service.py `_apply_side_glyphs` / board.js `PIECE_CHAR`(紅 C=砲) |
| **FEN 兩段式** | 編輯器用 `<board> <w\|b>`，無回合計數。餵 pikafish 才補 ` - - 0 1` 成六段。漂移會讓 DB 命中率掉到 ~0%。 | xqf_service / app.py 分析前拼接 |
| **分數＝紅方 POV cp** | cp 是行棋方 POV；紅方分＝cp×flip（黑行棋 flip=-1）。WDL 黑行棋時 W/L 互換。cp **不乘 100**（已驗證）。 | app.py `_parse_info_line` |
| **UI 不顯示 ICCS** | 評估列、走法選擇器、導航列著法資訊都只給中文著法，不露代碼。 | editor.js `renderEvalLine`/`renderVarPicker`/`moveInfo` |
| **icon 統一** | 全系統按鈕用 Lucide 線性 SVG（本機字串、`currentColor`、跟主題同色）。新增按鈕一律走 `ICON` map + `iconLabel()`，**禁用 emoji**。 | editor.js `ICON`(1512)/`iconLabel`(1532) |
| **版面所有權** | 區塊標題一律 `.panelHead`；面板寬高用 splitter 拖 `flex-basis`（非 width/height），尺寸存 PREFS。靠左對齊優先，別過度設計格線。 | editor.js `setupSplitters`(1925) |
| **偏好 key-value** | 一切設定（路徑、主題、splitter 尺寸）存 `preferences.json`，前端 `savePreference(key,value)`。 | app.py `_read_prefs`/`_write_prefs` |
| **原生路徑選擇** | 本機工具用 tkinter subprocess 開系統檔案/資料夾對話框，不用網頁文字框。 | app.py `pick_*_dialog` |
| **cchess 逐 venv** | 別全域 `pip install --upgrade cchess`；AI repo 用舊版（read_xqf.py），本 repo 用新版（io_xqf）＋patched writer。 | CLAUDE.md |
| **cchess 走 vendored wheel** | 安裝來源是 `vendor/wheels/` 的內附 wheel（非 `git+@master`），離線可裝、不怕上游消失。`requirements.txt` 用直接路徑引用。升級＝重建 wheel→`test_roundtrip` 全綠才換。GPLv3。 | CLAUDE.md *Distribution* |
| **散布版 debug 預設關** | `app.run` 的 debug 由 `FLASK_DEBUG` 控制，預設 False（Werkzeug debugger＝互動式 RCE，不可隨散布版開著）。 | app.py `__main__` |
| **首開優雅降級** | root 不存在時 `/api/xqf/list` 回 200＋`needsRoot`（前端給 📂 picker），不 500 硬崩。引擎／評估 DB 缺件亦各自 gated。 | app.py `list_xqf`；editor.js |
| **變化深度 walk** | 深層變化用 `move.next_move.variations_all`，別信 `variation_next`。 | io_xqf_patched.py docstring |

---

## 3. 功能 → 程式碼對照

### 後端 API（backend/app.py，Flask `@app.get/post`）

| 路由 | 函式:行 | 作用 |
|---|---|---|
| `GET /` | `index`:100 | 出 index.html |
| `GET /assets/<f>` | `assets`:105 | 靜態檔 |
| `GET/POST /api/preferences` | `get_preferences`:131 / `set_preferences`:136 | preferences.json 讀寫 |
| `GET /api/xqf/list` | `list_xqf` | 棋譜檔案樹（`_tree`）；root 不存在回 200＋`needsRoot`（不 500）；子樹無 `.xqf` 的目錄（如 png/）剪掉不顯示 |
| `GET /api/xqf/root` | `get_root`:204 | 目前根目錄（`get_xqf_root`:82） |
| `POST /api/xqf/pick-root` | `pick_root_dialog`:209 | tkinter 資料夾對話框 |
| `POST /api/xqf/root` | `set_root`:254 | 設根目錄 |
| `GET /api/xqf/load` | `load`:278 | 載入 XQF→JSON（`load_xqf`/`book_to_json`） |
| `POST /api/xqf/legal-targets` | `legal_targets`:295 | 某子合法著點（`compute_legal_targets`） |
| `POST /api/xqf/move-info` | `move_info`:312 | 單步中文著法（`compute_move_info`） |
| `POST /api/xqf/new` | `new_xqf`:332 | 新建空棋譜（`create_xqf`） |
| `GET /api/eval/info` | `eval_info`:385 | DB 狀態（`db_info`） |
| `POST /api/eval/pick-db` `/db` | `pick_eval_db_dialog`:395 / `set_eval_db`:440 | 選/設評估 DB |
| `POST /api/eval/batch` | `eval_batch`:740 | 批量查 FEN 評估（`lookup_batch`） |
| `GET /api/chessdb?fen=` | `chessdb_query` | 即時雲庫查（cache-first；`fresh=1` 跳快取重查）。回傳同 `cdb` 形狀＋`source` |
| `GET /api/engine/info` | `engine_info`:517 | pikafish 設定 chip（`_get_pikafish`/`_pikafish_info`） |
| `POST /api/engine/pick` `/path` | `pick_engine_dialog`:523 / `set_engine_path`:567 | 選/設引擎執行檔 |
| `GET /api/engine/analyze` **(SSE)** | `engine_analyze`:733 | 單局面即時分析串流；逐行解析 `_parse_info_line` |
| `POST /api/engine/analyze-line` | `analyze_line`:661 | 整條線逐局面掃描，NDJSON 串流（走勢圖）；`_parse_score`:648。**共用 TT 不清空** |
| `POST /api/xqf/save` | `save`:~850 | 存 XQF（`save_xqf`→PatchedXQFWriter） |

### XQF 譜處理（backend/xqf_service.py）

| 功能 | 函式:行 |
|---|---|
| book→JSON 樹 / 單節點 | `book_to_json`:306 / `_node_to_json`:273 |
| JSON→book（存檔用） | `json_to_book`:359 / `_apply_node`:322 |
| 著法字形（紅/黑替換） | `_apply_side_glyphs`:267 |
| 單步中文著法 | `compute_move_info`:392 |
| PV(UCI)→中文著法列（limit 64） | `pv_to_chinese`:419 |
| 合法著點 | `compute_legal_targets`:455 |
| 載入/存檔 wrapper | `load_xqf`:475 / `save_xqf`:492 / `create_xqf`:506 |
| 編碼/檔名修復（GB18030/Big5/PUA） | `recover_book_strings`:235、`_maybe_recover_big5`:162、`sanitise_filename`:45 |

### 評估 DB（backend/eval_service.py，唯讀）

| 功能 | 函式:行 |
|---|---|
| 唯讀連線 | `_open_ro`:37 |
| DB 狀態 | `db_info`:46 |
| 批量 FEN 查詢 | `lookup_batch`:66（`_chunks`:114 分批） |

### 雲庫即時查（backend/chessdb_service.py）

| 功能 | 函式 |
|---|---|
| cache-first 解析（positions.db→自有快取→live；`fresh` 跳快取） | `lookup` |
| 即時打 chessdb.cn（NUL guard／trim／錯誤狀態） | `query_chessdb` |
| FEN 修剪成 `<position> <side>` | `trim_fen` |
| 讀唯讀 positions.db chessdb 表 | `_read_positions_db` |
| editor 自有可寫快取（建表/讀/寫） | `_ensure_cache`/`_read_cache`/`_write_cache` |

### 前端 — 棋盤渲染器（frontend/assets/board.js，共用、可漂移）

| 功能 | 函式:行 |
|---|---|
| 渲染整盤（任意 SVG、用全域主題/視角） | `drawBoard`:484 |
| FEN 解析 / 走一步並翻邊 | `parseFen`:44 / `applyIccs`:70 |
| ICCS↔座標、螢幕座標 | `iccsToCoord`:35 / `screenX`:25 / `screenY`:29 |
| 棋子字形（紅 C=砲） | `PIECE_CHAR`:7 / `PIECE_CHARS_SUBSET`:237 |
| 主題樣式表 / 回紋邊框 | `BOARD_STYLES`:272 / `drawMeanderFrame`:405 |
| 字型載入 | `ensurePieceFontLoaded`:262 |

> board.js 也含一套獨立的 game-page bootstrap（STATE:896 起、`initGamePage` 等）——
> 那是 chess-book-ai 的瀏覽 UI，editor **不呼叫**，只借渲染器與 helper。改 editor 別動那段。

### 前端 — 編輯器邏輯（frontend/assets/editor.js）

**狀態 / 樹導航**
| 功能 | 函式:行 |
|---|---|
| 全域狀態 | `EDITOR`:15（含 `engineAnalysis` / `aiAnalysis`:28 / `demo`） |
| 主題色盤 | `EDITOR_THEME_COLORS`:40 / `UI_THEMES`:48 |
| 節點定位 | `nodeAt`:173 / `siblingsAt`:185 / `fenAndLastIccsFor`:192 |
| 目前 FEN / 主線收集 | `currentFen`:226 / `currentLine`:973 / `collectAllFens`:667 |
| 導航 + 全畫面刷新 | `navigateTo`:1131 / `refreshActive`:1139 |
| 導航鍵 | `navFirst`:1547 / `navPrev`:1548 / `navNext`:1552 / `navLast`:1562 / `navToNearestBranch`:1585 |

**走子輸入（點選盤面）**
| 功能 | 函式:行 |
|---|---|
| 透明 overlay + 點擊路由 | `installBoardOverlay`:244 / `onSquareClick`:326 |
| 選子/清選/嘗試走子 | `selectSquare`:361 / `clearSelection`:353 / `tryAddMove`:383 |
| 插入/刪除 | `insertMoveAt`:512 / `deleteCurrentMove`:429 |
| 分支重排（splice 任意排序，非對調；index 0=主線）+ 索引重映射 | `moveVariation`:466 / `remapAfterMove`:487 / `moveActiveVariation`:495（Alt+↑/↓）|

**棋譜列 / 注解 / 走法分支**
| 功能 | 函式:行 |
|---|---|
| 棋譜列 + 單步列（含 trap/brilliant 判定） | `renderMoveList`:1064 / `renderPlyRow`:1075 / `plyVerdict`:1038 / `plyLossAt`:1024 |
| 走法選擇器（同層分支，無 ICCS；每列 ▲▼ 重排） | `renderVarPicker`:1375 |
| 注解編輯（即時同步 data） | `commitAnnoteEdit`:1444 |
| 常用註解 chip（讀 `PREFS.annotePresets`，點擊 replace 結論；紅/黑字首→紅藍立體 chip） | `renderAnnotePresets`:1491 / `applyAnnotePreset`:1511 / `presetTone`:1483 |
| 棋譜載入脈動藥丸（開 UI / 換檔；`drawBoard` 重畫即覆蓋） | `drawBoardLoading`:2191 |

**棋盤箭頭提示（畫在 `<g class="arrowLayer">`，獨立刷新）**
| 功能 | 函式:行 |
|---|---|
| 主控：分支(綠,編號) + 引擎雙箭頭(藍最佳/橙回應) | `updateBoardArrows`:1306 |
| 畫單支箭頭（描邊+本體） / 編號徽章（最後畫=最上層） | `boardArrow`:1204 / `boardArrowBadge`:1247 |
| 每主題箭頭色盤 / 取目前主題色 | `ARROW_THEMES`:1293 / `arrowPalette`:1302 |

**評估列（深度分數來自唯讀 positions.db；「雲」格獨立於 DB，可即時查）**
| 功能 | 函式:行 |
|---|---|
| 取本檔評估 / 畫評估列（深度格 gated on DB；雲格＋建議格獨立） | `fetchEvalsForFile`:845 / `renderEvalLine`:908 |
| 分數格式 / 著法查詢 | `fmtEvalScore`:866 / `notationFor`:889 |

**☁ 雲庫即時查（chessdb.cn）—— 雲庫 tab + 評估列「雲」格**
| 功能 | 函式 |
|---|---|
| **查哪個局面**：分支點＝前一步（非走完本步之後）。同引擎「前一步」用的 `analysisFen` | `cdbFen` |
| 導航時 lazy 查 `cdbFen()`（debounce 220ms；已有 cdb 即跳過） | `ensureCdbLive` |
| 實際抓取（merge 進 `evalsByFen[cdbFen].cdb`；`fresh` 跳快取；失敗不快取以利重試） | `fetchCdbLive` |
| 畫雲庫 tab（全部著法：中文/勝率/紅POV分/★最佳；標出目前所在變化 `.current`） | `renderCdbTab`（狀態標籤 `CDB_STATUS_LABEL`） |
| 點列＝在**分支點**加同層變化（非當前著的子著）；已存在則切換過去 | `addCdbMove`→`insertMoveAt(branchPath,…)` |
| 「重查」按鈕（`fresh=1` 跳快取重打 `cdbFen()`） | boot 段綁 `#cdbRefreshBtn` |

> **為何查前一步**：雲庫列要呈現「該分支點上紅/黑可以怎麼走」（兵五進一及其替代著），而不是「走完本步後對手如何因應」。所以 cloud 一律 key 在 `cdbFen()`（前一步）；評估列的深度分數格仍 key 在 `currentFen()`（本局面靜態評估），兩者刻意不同 FEN。
> 雲庫資料形狀＝後端 `cdb`（`{status,moves,best,source}`），與 `/api/eval/batch` 一致，故 batch 命中與即時查可共用 `renderEvalLine`/`renderCdbTab`。分數是行棋方 POV cp，顯示時 ×flip 轉紅方視角（同 `_parse_info_line` 慣例）。

**即時引擎分析（SSE）—— 引擎分析 tab**
| 功能 | 函式:行 |
|---|---|
| 起/停分析（開 EventSource） | `startAnalysis`:1891 / `stopAnalysis`:1875 / `toggleAnalysis`:1921 |
| 分析「前一步」局面 / 「本步」局面 | `analysisFen`:1869 / `analyzeCurrentStep`:1926 |
| 收事件→歷程（最新在上，並更新藍箭頭） | `recordEngineEvent`:1796 / `renderEngineHistory`:1811 |
| 清除 / 導出歷程 | `clearAnalysisHistory`:1836 / `exportAnalysisHistory`:1843 |
| 分數/WDL 格式 | `fmtEngineScore`:1768 / `fmtWdl`:1778 / `fmtWdlHtml`:1785 |

**AI 分析 —— 整條線走勢圖（AI分析 tab）**
| 功能 | 函式:行 |
|---|---|
| 後端逐局面掃描（NDJSON 串流，**共用 TT 不清空**）；給 `depth2` 時單次深算同時擷取兩層分數 | `analyze_line`(app.py):661 / `_parse_score`:648 ｜ `POST /api/engine/analyze-line {fens,depth,depth2?}` |
| 取層數(預設12)/組局面清單 | `aiDepth`:2027（pref `aiAnalysisDepth`）/ `aiLinePositions`:2068 |
| **雙深度比對**：第二層數(預設20)/開關/門檻(預設200)/深淺差值+旗標 | `aiDepth2`:2035 / `aiDualEnabled`:2039 / `aiDiffThreshold`:2042 / `aiPointDiff`:2055（pref `aiAnalysisDepth2`/`aiDualDepth`/`aiDiffThreshold`）|
| 主流程（串流接收→填點→完成移游標到終局；雙深度時帶 cp2/mate2） | `analyzeCurrentLine`:2081 / `clearAiAnalysis`:2152 |
| 游標索引（hover 或目前盤面） / hit-test | `aiCursorIdx`:2167 / `aiActiveIdx`:2159 / `aiIndexFromEvent`:2196 |
| 繪圖：動態 Y 量程 + **紅藍漲跌面積圖**（0 線硬切換漸層）+ 中性壓頂線 + 小分色點 + Δ旗標 + 橙環 | `drawAiChart`:2264（量程 `aiRange`:2190/`aiNiceCeil`:2179、`AI_PAD`:2175） |
| 分析中圓角提示 / 單筆讀數（雙深度顯示 d1/d2/Δ） | `drawAiBusy`:2223 / `renderAiView`:2207 / `renderAiReadout`:2357 |

> 為何 d12 走勢圖就抓到即時分析 d21 才證出的殺：名目深度≠步數（seldepth/延伸/quiescence）＋掃描共用置換表。詳見 memory `project-ai-line-depth`，內含「是否每點 `ucinewgame` 嚴格獨立」的待決定。

**變化例演示 dialog（單行 PV 重播）**
| 功能 | 函式:行 |
|---|---|
| 開/關 dialog（用 applyIccs 串 fens） | `openDemo`:2217 / `closeDemo`:2228 |
| 畫 / 跳步 / 自動播放 | `renderDemo`:2177 / `demoGo`:2197 / `demoTogglePlay`:2204 / `demoStopPlay`:2190 |
| **把 PV 加進走子樹** | `addPvLine`:2234 |

**設定 / 路徑 / 偏好**
| 功能 | 函式:行 |
|---|---|
| 偏好讀寫（伺服器 preferences.json） | `loadPreferences`:64 / `savePreference`:71 |
| localStorage「最後可用」備份 + 開機回復提示 | `LS_KEYS`/`lsGet`/`lsSet`:87–89 / `recoverSettingsFromLocalStorage`:2515 |
| 設定 dialog（標題列 ✕＋完成） | `openSettingsModal`:2282 / `closeSettingsModal`:2283 |
| 根目錄 chip / 選擇 / 套用 | `updateRootDisplay`:543 / `pickRoot`:555 / `applyRoot`:572 |
| 評估 DB chip / 選擇 / 套用(共用) | `fetchEvalDbInfo`:688 / `renderEvalDbRow`:702 / `pickEvalDb`:733 / `applyEvalDbPath`:753 |
| 引擎 chip / 選擇 / 套用(共用) | `fetchEngineInfo`:772 / `renderEngineRow`:784 / `pickEngine`:811 / `applyEnginePath`:831 |
| 賽事資訊 / 新增棋譜 dialog | `openMetaModal`:1441 / `applyMetaEdits`:1459 ／ `openNewModal`:1482 / `submitNewXqf`:1499 |
| 自訂確認 dialog（回 Promise<bool>） | `showConfirmDialog`:130 |

> chip 渲染在路徑**驗證有效**時 `lsSet` 鏡射到 localStorage；切換 XQF 檔（`selectFile`:626）或切目錄（`applyRoot`:572）會 `stopAnalysis`+`clearAnalysisHistory`+`clearAiAnalysis` 清掉引擎歷程與走勢圖。

**頁籤 / 主題 / 版面 / icon / 啟動**
| 功能 | 函式:行 |
|---|---|
| 頁籤切換（依容器，兩組 tab 不互相干擾） | `switchTabsIn`:1753 / `switchRpTab`:1758（走法/引擎）/ `switchAnnoteTab`:1759（注解/AI，切 AI 時重畫圖） |
| icon 字典 / 帶標籤 | `ICON`:1723 / `iconLabel`:1747 |
| 棋盤主題 / 視角 / UI 主題（換主題→refreshActive→重畫箭頭+走勢圖） | `applyBoardTheme`:1642 / `applyBoardPerspective`:1648 / `applyUiTheme`:1656 |
| splitter 拖曳（flex-basis） | `setupSplitters`:2438 |
| 開機自動載入上次檔案 | `tryAutoLoadLastFile`:2491 |
| **事件綁定 / icon 注入（boot）** | editor.js **2284–2437**（`.onclick`、`innerHTML=iconLabel…`、tab/demo/AI圖 hover、ResizeObserver 都在這） |

### HTML 結構（frontend/index.html）

| 區塊 | 位置 | 備註 |
|---|---|---|
| header（logo「棋鑑」/主題/視角/賽事/儲存） | h1 含 inline `.appLogo` SVG | metaBtn/saveBtn 在此 |
| 檔案樹 pane | settingsBtn / newXqfBtn | |
| 棋盤 pane + 導航列 + 評估列 | `#board`、`#navBar`、`#evalLine` | |
| 右欄：棋譜 ｜ (注解/AI分析) ｜ (走法/☁雲庫/引擎分析) | 兩組 `.rpTabs`：`#rpAnnote`＝注解+AI分析（`#aiBar` 在頁籤列、僅 AI 時顯示；`#aiChart`+`#aiReadout`）；`#rpVars`＝走法+雲庫(`#rpCdbBody`：`#cdbBar`+`#cdbList`)+引擎分析 |
| dialogs | confirm / meta / new / demo / settings；**demo/settings 標題列含 `.modalClose` ✕** |

### 持久層（已驗證全庫 round-trip）

| 元件 | 位置 |
|---|---|
| XQF 寫檔（修上游 3 bug） | `vendor/io_xqf_patched.py` `PatchedXQFWriter` |
| round-trip 測試（SRC 路徑硬編） | `tests/test_roundtrip.py`（`SRC_ROOT`） |
| XQStudio 驗證樣本 | `samples/`、`tools/emit_sample.py` |
| 門檻同步檢查 | `backend/test_trap_spotcheck.py` / `test_eval_integration.py` |
| cchess 內附 wheel（離線安裝來源） | `vendor/wheels/`、`requirements.txt`、`setup.ps1` |

---

## 4. 改功能時的起手式

- **加按鈕** → `ICON` map(1723) 加圖示 → boot 段(2284–2437) 綁 `.onclick` + `innerHTML=iconLabel(...)`。禁 emoji。
- **加 API** → app.py 加 `@app.get/post` → 邏輯放 xqf_service / eval_service，路由只做 IO+驗證。
- **改著法顯示** → 一律經 `_apply_side_glyphs`(xqf_service:267)；UI 端不要再拼字形。
- **改面板尺寸/版面** → splitter `data-pref` + `setupSplitters`；尺寸自動進 PREFS。
- **動分析串流** → 後端 `_parse_info_line` 解析、`engine_analyze` 串流；前端 `startAnalysis`/`renderEngineHistory` 消費。改欄位兩邊都要動。
- **動分數/WDL 約定** → 改 `_parse_info_line` 的 flip/WDL 互換，前端 `fmtEngineScore`/`fmtWdlHtml` 同步。
- **改棋盤箭頭（色/寬/編號位置）** → 全在 `updateBoardArrows`/`boardArrow`/`boardArrowBadge`；色盤 `ARROW_THEMES` 一主題一行。SVG 無 z-index，疊放靠文件順序——編號最後畫才壓得住線。
- **加棋盤主題** → board.js `BOARD_STYLES` 加一筆 + editor.js `ARROW_THEMES` 補對應箭頭色 + `EDITOR_THEME_COLORS` 補選取/落點色 + `ensureBoardThemeOptions` 加選項。
- **動 AI 走勢圖（量程/點線/查詢）** → 全在 `drawAiChart`/`drawAiBusy`/`renderAiReadout`/`aiRange`；後端逐局面在 `analyze_line`。Y 軸動態、點按走子方分色、共用 TT（要嚴格獨立才加 `ucinewgame`）。
- **加頁籤** → 同一 `.rpTabs`/`.rpTabBody` 結構 + 專屬 `switchXxxTab`（查詢限定容器）；隱藏靠 `.rpTabBody[hidden]{display:none !important}`，body 自己的 `display:flex` 不會蓋掉。
