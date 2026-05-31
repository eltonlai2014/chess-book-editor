# ARCHITECTURE.md

本檔是「重開 session 不失憶」的單一事實來源：**系統有哪些功能、為什麼這樣設計、每個功能的程式碼在哪**。
擴充／修改前先讀這裡定位，再跳到對應 `file:line`。行號會漂移 —— 以函式名為準，行號只是起點。

設計原則／陷阱的「為什麼」散在 [CLAUDE.md](CLAUDE.md)；本檔聚焦「在哪裡、做什麼」並彙整原則速查。

---

## 1. 系統總覽

純本機工具（非公開部署）。三層：

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
| **positions.db 唯讀** | `?mode=ro` 開啟，永不 INSERT/UPDATE，檔案歸 AI repo 管。 | eval_service.py `_open_ro` |
| **著法字形** | 紅方：馬→傌 士→仕 象→相 車→俥 將→帥；**砲不換**（保留砲）。黑方：砲→包。 | xqf_service.py `_apply_side_glyphs` / board.js `PIECE_CHAR`(紅 C=砲) |
| **FEN 兩段式** | 編輯器用 `<board> <w\|b>`，無回合計數。餵 pikafish 才補 ` - - 0 1` 成六段。漂移會讓 DB 命中率掉到 ~0%。 | xqf_service / app.py 分析前拼接 |
| **分數＝紅方 POV cp** | cp 是行棋方 POV；紅方分＝cp×flip（黑行棋 flip=-1）。WDL 黑行棋時 W/L 互換。cp **不乘 100**（已驗證）。 | app.py `_parse_info_line` |
| **UI 不顯示 ICCS** | 評估列、走法選擇器、導航列著法資訊都只給中文著法，不露代碼。 | editor.js `renderEvalLine`/`renderVarPicker`/`moveInfo` |
| **icon 統一** | 全系統按鈕用 Lucide 線性 SVG（本機字串、`currentColor`、跟主題同色）。新增按鈕一律走 `ICON` map + `iconLabel()`，**禁用 emoji**。 | editor.js `ICON`(1512)/`iconLabel`(1532) |
| **版面所有權** | 區塊標題一律 `.panelHead`；面板寬高用 splitter 拖 `flex-basis`（非 width/height），尺寸存 PREFS。靠左對齊優先，別過度設計格線。 | editor.js `setupSplitters`(1925) |
| **偏好 key-value** | 一切設定（路徑、主題、splitter 尺寸）存 `preferences.json`，前端 `savePreference(key,value)`。 | app.py `_read_prefs`/`_write_prefs` |
| **原生路徑選擇** | 本機工具用 tkinter subprocess 開系統檔案/資料夾對話框，不用網頁文字框。 | app.py `pick_*_dialog` |
| **cchess 逐 venv** | 別全域 `pip install --upgrade cchess`；AI repo 用舊版（read_xqf.py），本 repo 用新版＋patched writer。 | CLAUDE.md |
| **變化深度 walk** | 深層變化用 `move.next_move.variations_all`，別信 `variation_next`。 | io_xqf_patched.py docstring |

---

## 3. 功能 → 程式碼對照

### 後端 API（backend/app.py，Flask `@app.get/post`）

| 路由 | 函式:行 | 作用 |
|---|---|---|
| `GET /` | `index`:100 | 出 index.html |
| `GET /assets/<f>` | `assets`:105 | 靜態檔 |
| `GET/POST /api/preferences` | `get_preferences`:131 / `set_preferences`:136 | preferences.json 讀寫 |
| `GET /api/xqf/list` | `list_xqf`:193 | 棋譜檔案樹（`_tree`:167） |
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
| `GET /api/engine/info` | `engine_info`:517 | pikafish 設定 chip（`_get_pikafish`/`_pikafish_info`） |
| `POST /api/engine/pick` `/path` | `pick_engine_dialog`:523 / `set_engine_path`:567 | 選/設引擎執行檔 |
| `GET /api/engine/analyze` **(SSE)** | `engine_analyze`:649 | 即時分析串流；逐行解析 `_parse_info_line`:599 |
| `POST /api/xqf/save` | `save`:765 | 存 XQF（`save_xqf`→PatchedXQFWriter） |

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
| 全域狀態 | `EDITOR`:15 |
| 主題色盤 | `EDITOR_THEME_COLORS`:37 / `UI_THEMES`:45 |
| 節點定位 | `nodeAt`:161 / `siblingsAt`:173 / `fenAndLastIccsFor`:180 |
| 目前 FEN / 主線收集 | `currentFen`:214 / `currentLine`:932 / `collectAllFens`:644 |
| 導航 + 全畫面刷新 | `navigateTo`:1090 / `refreshActive`:1098 |
| 導航鍵 | `navFirst`:1336 / `navPrev`:1337 / `navNext`:1341 / `navLast`:1351 / `navToNearestBranch`:1374 |

**走子輸入（點選盤面）**
| 功能 | 函式:行 |
|---|---|
| 透明 overlay + 點擊路由 | `installBoardOverlay`:232 / `onSquareClick`:314 |
| 選子/清選/嘗試走子 | `selectSquare`:349 / `clearSelection`:341 / `tryAddMove`:371 |
| 插入/刪除/升主線 | `insertMoveAt`:483 / `deleteCurrentMove`:417 / `promoteToMain`:448 |

**棋譜列 / 注解 / 走法分支**
| 功能 | 函式:行 |
|---|---|
| 棋譜列 + 單步列（含 trap/brilliant 判定） | `renderMoveList`:1023 / `renderPlyRow`:1034 / `plyVerdict`:997 / `plyLossAt`:983 |
| 走法選擇器（同層分支，無 ICCS） | `renderVarPicker`:1145 |
| 注解編輯（即時同步 data） | `commitAnnoteEdit`:1205 |

**評估列（唯讀，來自 positions.db）**
| 功能 | 函式:行 |
|---|---|
| 取本檔評估 / 畫評估列 | `fetchEvalsForFile`:804 / `renderEvalLine`:867 |
| 分數格式 / 著法查詢 | `fmtEvalScore`:825 / `notationFor`:848 |

**即時引擎分析（SSE）—— 引擎分析 tab**
| 功能 | 函式:行 |
|---|---|
| tab 切換 | `switchRpTab`:1536 |
| 起/停分析（開 EventSource） | `startAnalysis`:1666 / `stopAnalysis`:1651 / `toggleAnalysis`:1696 |
| 分析「前一步」局面 / 「本步」局面 | `analysisFen`:1645 / `analyzeCurrentStep`:1701 |
| 收事件→歷程（最新在上） | `recordEngineEvent`:1573 / `renderEngineHistory`:1587 |
| 清除 / 導出歷程 | `clearAnalysisHistory`:1612 / `exportAnalysisHistory`:1619 |
| 分數/WDL 格式 | `fmtEngineScore`:1545 / `fmtWdl`:1555 / `fmtWdlHtml`:1562 |

**變化例演示 dialog（單行 PV 重播）**
| 功能 | 函式:行 |
|---|---|
| 開/關 dialog（用 applyIccs 串 fens） | `openDemo`:1746 / `closeDemo`:1757 |
| 畫 / 跳步 / 自動播放 | `renderDemo`:1706 / `demoGo`:1726 / `demoTogglePlay`:1733 / `demoStopPlay`:1719 |
| **把 PV 加進走子樹** | `addPvLine`:1763 |

**設定 / 路徑 / 偏好**
| 功能 | 函式:行 |
|---|---|
| 偏好讀寫 | `loadPreferences`:61 / `savePreference`:68 |
| 設定 dialog | `openSettingsModal`:1811 / `closeSettingsModal`:1812 |
| 根目錄 chip / 選擇 | `updateRootDisplay`:529 / `pickRoot`:540 / `applyRoot`:557 |
| 評估 DB chip / 選擇 | `fetchEvalDbInfo`:665 / `renderEvalDbRow`:679 / `pickEvalDb`:709 |
| 引擎 chip / 選擇 | `fetchEngineInfo`:740 / `renderEngineRow`:752 / `pickEngine`:778 |
| 賽事資訊 / 新增棋譜 dialog | `openMetaModal`:1230 / `applyMetaEdits`:1248 ／ `openNewModal`:1271 / `submitNewXqf`:1288 |
| 自訂確認 dialog | `showConfirmDialog`:118 |

**主題 / 版面 / icon / 啟動**
| 功能 | 函式:行 |
|---|---|
| icon 字典 / 帶標籤 | `ICON`:1512 / `iconLabel`:1532 |
| 棋盤主題 / 視角 / UI 主題 | `applyBoardTheme`:1431 / `applyBoardPerspective`:1437 / `applyUiTheme`:1445 |
| splitter 拖曳（flex-basis） | `setupSplitters`:1925 |
| 開機自動載入上次檔案 | `tryAutoLoadLastFile`:1978 |
| **事件綁定 / icon 注入（boot）** | editor.js **1813–1914**（所有 `.onclick`、`innerHTML=ICON…`、tab/demo 綁定都在這） |

### HTML 結構（frontend/index.html）

| 區塊 | 位置 | 備註 |
|---|---|---|
| header（主題/視角/賽事/儲存） | 9–32 | metaBtn/saveBtn 在此 |
| 檔案樹 pane | 34–41 | settingsBtn ⚙ / newXqfBtn |
| 棋盤 pane + 導航列 + 評估列 | 43–55 | `#board`、`#navBar`、`#evalLine` |
| 右欄：棋譜 / 注解 / 走法 tab | 56–91 | `.rpTabs`＝走法+引擎分析 tab；engineBar 在 80–86 |
| dialogs | 96–206 | confirm / meta / new / **demo**(153) / **settings**(176) |

### 持久層（已驗證 46/46 round-trip）

| 元件 | 位置 |
|---|---|
| XQF 寫檔（修上游 3 bug） | `vendor/io_xqf_patched.py` `PatchedXQFWriter` |
| round-trip 測試（SRC 路徑硬編） | `tests/test_roundtrip.py`（`SRC_ROOT`） |
| XQStudio 驗證樣本 | `samples/`、`tools/emit_sample.py` |
| 門檻同步檢查 | `backend/test_trap_spotcheck.py` / `test_eval_integration.py` |

---

## 4. 改功能時的起手式

- **加按鈕** → `ICON` map(1512) 加圖示 → boot 段(1813–1888) 綁 `.onclick` + `innerHTML=iconLabel(...)`。禁 emoji。
- **加 API** → app.py 加 `@app.get/post` → 邏輯放 xqf_service / eval_service，路由只做 IO+驗證。
- **改著法顯示** → 一律經 `_apply_side_glyphs`(xqf_service:267)；UI 端不要再拼字形。
- **改面板尺寸/版面** → splitter `data-pref` + `setupSplitters`；尺寸自動進 PREFS。
- **動分析串流** → 後端 `_parse_info_line` 解析、`engine_analyze` 串流；前端 `startAnalysis`/`renderEngineHistory` 消費。改欄位兩邊都要動。
- **動分數/WDL 約定** → 改 `_parse_info_line` 的 flip/WDL 互換，前端 `fmtEngineScore`/`fmtWdlHtml` 同步。
