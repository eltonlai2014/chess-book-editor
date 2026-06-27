# ARCHITECTURE.md

本檔是「重開 session 不失憶」的單一事實來源：**系統有哪些功能、為什麼這樣設計、每個功能的程式碼在哪**。
擴充／修改前先讀這裡定位，再跳到對應 `file:line`。行號會漂移 —— 以函式名為準，行號只是起點。

設計原則／陷阱的「為什麼」散在 [CLAUDE.md](CLAUDE.md)；本檔聚焦「在哪裡、做什麼」並彙整原則速查。
**視覺／配色／字型／icon 規範另立** [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md)（避免本檔過大）——
改主題 token、棋盤風格、等寬字型、icon、品牌前先讀那裡。

---

## 1. 系統總覽

產品名 **「梅友弈鑑」**（h1 朱文方印 logo＋title；扣《梅花譜》＋「鑑」＝鑑賞）。
純本機工具（非公開部署）。三層：

```
瀏覽器 (vanilla JS, 無框架)
  ├─ board.js   棋盤渲染器 + FEN/ICCS helper（與 chess-book-ai 同源，會漂移）
  └─ editor*.js  編輯器邏輯（T2-1 拆多檔 classic script，共享全域 scope，依序載入）
       editor.js（核心：狀態機 EDITOR/走子樹/檔案/評估列/棋譜/boot wiring）
       + editor-cdb.js（雲庫）/ -engine.js（引擎分頁＋SSE helper）
       / -autoplay.js（AI 走棋）/ -aichart.js（走勢圖）/ -demo.js（PV 演示）
        │  fetch / EventSource(SSE)
        ▼
Flask (backend/app.py, threaded=True) —— 只剩薄路由（parse/驗證/包 Response）
  ├─ config.py  路徑/偏好解析（frozen-vs-source、DEFAULT_*、prefs 讀寫、三個 path getter）
  ├─ picker_service.py  原生資料夾/檔案選取（tkinter 子行程；dev `-c` vs frozen `--pick`）
  ├─ engine_service.py  Pikafish 子行程＋UCI 解析＋兩支串流產生器（共用 _spawn/_engine_fen）
  ├─ xqf_service.py   XQF book ⇄ JSON、中文著法、PV 轉譜、合法著點
  ├─ vendor/io_xqf_patched.py  PatchedXQFWriter（XQF 寫檔，修上游 3 bug）
  ├─ eval_service.py  唯讀讀取 chess-book-ai 的 positions.db（評估/雲庫勝率）
  ├─ chessdb_service.py  即時查 chessdb.cn 雲庫（cache-first；寫 editor 自有快取）
  ├─ db_pool.py  程序級 SQLite 連線池（熱路徑 reuse，免每查 connect/close）
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
| **即時分析純暫態** | SSE execs pikafish，逐層 stream，斷線即 kill，**任何結果都不落地**（對比 positions.db）。另有 stall watchdog（T3-5）：引擎 `_STALL_TIMEOUT`(30s) 無輸出即 kill（防卡死進程釘住 worker thread）——是「無進展」而非時長上限，故 `go infinite`/長搜尋持續吐 info 不會誤殺。 | app.py `engine_analyze` → engine_service.py `analyze_stream`（`_shutdown`/`_start_stall_watchdog`） |
| **AI 走勢圖掃描** | `analyze_line` 重用單一引擎進程跑整條線，**逐局面不送 `ucinewgame`**（TT 累積→低層數即準，但各點非嚴格獨立）。層數＝pref `aiAnalysisDepth`(預設12)。 | app.py `analyze_line` → engine_service.py `analyze_line_stream`；memory `project-ai-line-depth` |
| **App shell 用 flex** | body flex column＋header 自動高＋main `flex:1`＋`overflow:hidden`；**勿寫死 header 高度**（曾因 `calc(100vh-52px)` 比實際矮而溢出產生捲軸）。 | editor.css `body`/`header`/`main` |
| **positions.db 唯讀** | `?mode=ro` 開啟，永不 INSERT/UPDATE，檔案歸 AI repo 管。 | eval_service.py `_open_ro`（驗證候選檔，短命）／`db_pool.get_ro`（熱路徑、池化、不 close） |
| **DB 連線池化** | 熱路徑（`lookup_batch`／雲庫查）reuse 程序級連線，**不逐查 connect/close、不 `.close()` 池內連線**；read-only 序列化、單人工具無寫鎖爭用；路徑變動（換評估庫）→新連線、舊的閒置到退出。`db_info` 驗證任意候選檔仍用短命連線。 | db_pool.py；eval_service.py `lookup_batch`／chessdb_service.py |
| **雲庫 cache-first＋自有快取** | 即時查 chessdb.cn 前先讀唯讀 positions.db→再讀 editor 自有 `output/editor_chessdb_cache.db`（**唯一可寫**的雲庫快取）→miss 才打網路並寫回。**禁寫 positions.db、禁碰 AI repo 的 chessdb_cache.json**。逐局面查（非整檔 batch）以守 chessdb 速率禮貌。 | chessdb_service.py `lookup`；CHESSDB_CLOUD_QUERY.md |
| **著法字形** | 紅方：馬→傌 士→仕 象→相 車→俥 將→帥；**砲不換**（保留砲）。黑方：砲→包。 | xqf_service.py `_apply_side_glyphs` / board.js `PIECE_CHAR`(紅 C=砲) |
| **FEN 兩段式** | 編輯器用 `<board> <w\|b>`，無回合計數。餵 pikafish 才補 ` - - 0 1` 成六段。漂移會讓 DB 命中率掉到 ~0%。 | engine_service.py `_engine_fen`（分析前拼六段＋flip）；前端 `fenSide` |
| **分數＝紅方 POV cp** | cp 是行棋方 POV；紅方分＝cp×flip（黑行棋 flip=-1）。WDL 黑行棋時 W/L 互換。cp **不乘 100**（已驗證）。 | engine_service.py `_parse_info_line` |
| **chessdb 必勝局＝±30000 編碼** | chessdb 對 forced mate/win 回 `score≈±30000`（**無 winrate 欄**），`30000−\|score\|＝步數`。前端 `mateFromCdbScore` 把它轉成皮卡魚式 `#+N`/`#-N`（紅 POV），雲格與雲庫 tab 都優先顯示 mate 而非數字/winrate。閾值 25000 遠高於任何真實 cp。 | editor.js `mateFromCdbScore` |
| **UI 不顯示 ICCS** | 評估列、走法選擇器、導航列著法資訊都只給中文著法，不露代碼。 | editor.js `renderEvalLine`/`renderVarPicker`/`moveInfo` |
| **icon 統一** | 全系統按鈕用 Lucide 線性 SVG（本機字串、`currentColor`、跟主題同色）。新增按鈕一律走 `ICON` map + `iconLabel()`，**禁用 emoji**。 | editor.js `ICON`(1512)/`iconLabel`(1532) |
| **版面所有權** | 區塊標題一律 `.panelHead`；面板寬高用 splitter 拖 `flex-basis`（非 width/height），尺寸存 PREFS。靠左對齊優先，別過度設計格線。 | editor.js `setupSplitters`(1925) |
| **偏好 key-value** | 一切設定（路徑、主題、splitter 尺寸）存 `preferences.json`，前端 `savePreference(key,value)`。 | config.py `_read_prefs`/`_write_prefs` |
| **原生路徑選擇** | 本機工具用 tkinter subprocess 開系統檔案/資料夾對話框，不用網頁文字框。 | app.py `pick_*_dialog` → picker_service.py |
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
| `GET /` | `index`:106 | 出 index.html（`_no_store` 包，前端不快取） |
| `GET /assets/<f>` | `assets`:111 | 靜態檔（`_no_store`：`Cache-Control: no-store`，改 CSS/JS 一般重整就生效；VSCode 內建 Simple Browser 仍會吃舊快取，UI 驗證用外部 Edge） |
| `GET/POST /api/preferences` | `get_preferences`:120 / `set_preferences`:125 | preferences.json 讀寫（儲存層 `config._read_prefs`/`_write_prefs`） |
| `GET /api/xqf/list` | `list_xqf`:203 | 棋譜檔案樹（`_tree`）；root 不存在回 200＋`needsRoot`（不 500）；子樹無 `.xqf`/`.cbr`/`.cbl` 的目錄（如 png/）剪掉不顯示。`.cbr` 當葉、`.cbl` 當可展開 dir（`cbl:true`、children 空＝懶載入） |
| `GET /api/xqf/cbl-children?path=` | `cbl_children`:268 | 懶載入：列某 `.cbl` 內每盤（`list_cbl_games`），回 `[{rel:"lib.cbl#i", name, type:file}]`。左樹首次展開才打 |
| `GET /api/xqf/root` | `get_root`:227 | 目前根目錄（`config.get_xqf_root`） |
| `POST /api/xqf/pick-root` | `pick_root_dialog`:232 | tkinter 資料夾對話框（`picker_service._pick_folder`） |
| `POST /api/xqf/root` | `set_root`:244 | 設根目錄 |
| `GET /api/xqf/load` | `load`:292 | 載入→JSON。依 `parse_cb_rel` 分派：`.cbl#N`/`.cbr` 走 `cb_service.load_cb`，否則 `load_xqf`；皆經 `book_to_json` |
| `POST /api/xqf/legal-targets` | `legal_targets`:314 | 某子合法著點（`compute_legal_targets`） |
| `POST /api/xqf/move-info` | `move_info`:331 | 單步中文著法（`compute_move_info`） |
| `POST /api/xqf/move-info-batch` | `move_info_batch`:351 | 同一 fen 多著法一次翻中文（`compute_move_infos_batch`）；雲庫清單用，把 N 發併 1 發 |
| `POST /api/xqf/new` | `new_xqf`:372 | 新建空棋譜（`create_xqf`） |
| `GET /api/eval/thresholds` | `eval_thresholds`:416 | trap/brilliant 門檻單一來源（`eval_service.TRAP_THRESHOLDS`）；前端 boot fetch（T3-2） |
| `GET /api/eval/info` | `eval_info`:424 | DB 狀態（`db_info`） |
| `POST /api/eval/pick-db` `/db` | `pick_eval_db_dialog`:434 / `set_eval_db`:453 | 選/設評估 DB（路徑解析 `config._get_eval_db`） |
| `POST /api/eval/batch` | `eval_batch`:589 | 批量查 FEN 評估（`eval_service.lookup_batch`） |
| `GET /api/chessdb?fen=` | `chessdb_query`:614 | 即時雲庫查（cache-first；`fresh=1` 跳快取重查）。回傳同 `cdb` 形狀＋`source` |
| `GET /api/engine/info` | `engine_info`:489 | pikafish 設定 chip（`config._get_pikafish`/`engine_service.pikafish_info`） |
| `POST /api/engine/pick` `/path` | `pick_engine_dialog`:495 / `set_engine_path`:514 | 選/設引擎執行檔 |
| `GET /api/engine/analyze` **(SSE)** | `engine_analyze`:564 | 單局面即時分析串流→`engine_service.analyze_stream`（逐行 `_parse_info_line`、共用 `_spawn`/`_engine_fen`） |
| `POST /api/engine/analyze-line` | `analyze_line`:540 | 整條線逐局面掃描，NDJSON 串流（走勢圖）→`engine_service.analyze_line_stream`（`_parse_score`）。**共用 TT 不清空** |
| `POST /api/xqf/save` | `save`:641 | 存檔。副檔名分派：`.cbl#N`→`save_cbl_game`、`.cbr`→`save_cbr`、`.xqf`→`save_xqf`（→PatchedXQFWriter） |

### CBL/CBR 編輯整合（backend/cb_service.py）

XQF 與 CBL/CBR 的每盤同為 `cchess.Book`，序列化（`book_to_json`/`json_to_book`）格式
無關直接複用；本模組只做格式邊界 + CBL 多盤的兩個額外負擔。

| 功能 | 函式 |
|---|---|
| rel `lib.cbl#3` 拆 (base, index) / 判 CB 檔 | `parse_cb_rel` / `is_cb_path` |
| CBL 資料區定位（固定 4096-byte 記錄；不解析走子樹） | `_cbl_record_starts` |
| 列舉 CBL 盤目（讀 CBR header 標題＋紅/黑/賽果固定 offset，**不解析走子樹**；有真棋手 name=「1. 布局名 — 紅 先勝 黑」，否則只布局名） | `list_cbl_games`／`_compose_cbl_label` |
| 載入 CBR/CBL 指定盤→JSON（CBL **只解析該盤** `read_from_cbr_buffer`；不跑 Big5 recovery） | `load_cb` |
| 存 CBR（保留原 record GUID） | `save_cbr` |
| **位元組級 splice 覆寫第 N 盤**：slot 數不變時只覆寫該盤 slot＋更新其索引＋modified_at，其餘 byte 不動；**先備份 `.bak`**。slot 數變才退 `_save_cbl_full` | `save_cbl_game` / `_save_cbl_full` |
| 讀 `read_cbl` 不回傳的欄位（raw offset） | `read_cbl_lib_meta`（creator/email/created_at/capacity）/ `read_cbl_guids` / `_read_cbr_guid` |
| 原子寫入（.tmp→os.replace） | `_atomic_write` |

> 讀寫器在 `vendor/cchess_cbl.py`（`read_cbl`/`read_cbr`）與 `vendor/io_cb_writer.py`
> （`write_cbr_bytes`/`write_cbl_bytes`）。保真關鍵：`write_cbl_bytes` 的 `guids` 參數
> 讓覆寫沿用原 GUID（未給則每次重新產生→未編輯盤身分會漂移）。
> 往返測：`tests/test_cb_roundtrip.py`（CBR 路徑全等＋CBL 改一盤後其餘盤/GUID/metadata 不變）。

### XQF 譜處理（backend/xqf_service.py）

| 功能 | 函式:行 |
|---|---|
| book→JSON 樹 / 單節點 | `book_to_json`:306 / `_node_to_json`:273 |
| JSON→book（存檔用） | `json_to_book`:359 / `_apply_node`:322 |
| 著法字形（紅/黑替換） | `_apply_side_glyphs`:267 |
| 單步中文著法 | `compute_move_info`:392 |
| PV(UCI)→中文著法列（limit 64） | `pv_to_chinese`:419 |
| 合法著點 | `compute_legal_targets`:455 |
| 載入/存檔 wrapper | `load_xqf`（包 `fast_parse_book`）/ `save_xqf` / `create_xqf` |
| **解析加速**：載入期間短路 `ChessBoard.is_checking`→False，省 cchess 每步重算攻擊矩陣＋將死（純 overhead、輸出不讀）。輸出逐字節相同、~3x（巨檔 9s→3s）。**T3-4**：改 thread-local 旗標 `_suppress_check` 閘控（`is_checking` 永久包一層，只在「當前執行緒正在 `fast_parse_book`」時回 False），故 A 執行緒解析不再讓 B 執行緒的走子驗證/引擎看到假將軍（舊全域 swap 在 `threaded=True` 會）。可重入、免 lock。XQF＋CBL 載入共用 | `fast_parse_book`（cm；`load_xqf`/`cb_service.load_cb` 都包） |
| 編碼/檔名修復（GB18030/Big5/PUA） | `recover_book_strings`:235、`_maybe_recover_big5`:162、`sanitise_filename`:45 |

### 評估 DB（backend/eval_service.py，唯讀）

| 功能 | 函式:行 |
|---|---|
| 唯讀連線（短命，驗證候選檔用） | `_open_ro` |
| DB 狀態 | `db_info`（用 `_open_ro`，會驗證任意候選檔） |
| 批量 FEN 查詢（熱路徑，池化連線） | `lookup_batch`（`db_pool.get_ro`；`_chunks` 分批） |

### 雲庫即時查（backend/chessdb_service.py）

| 功能 | 函式 |
|---|---|
| cache-first 解析（positions.db→自有快取→live；`fresh` 跳快取） | `lookup` |
| 即時打 chessdb.cn（NUL guard／trim／錯誤狀態） | `query_chessdb` |
| FEN 修剪成 `<position> <side>` | `trim_fen` |
| 讀唯讀 positions.db chessdb 表（池化 RO 連線） | `_read_positions_db`（`db_pool.get_ro`） |
| editor 自有可寫快取（池化 RW 連線，建表一次） | `_ensure_cache`（`db_pool.get_rw`，`_CACHE_INIT_SQL`）/`_read_cache`/`_write_cache` |

### 前端 — 棋盤渲染器（frontend/assets/board.js，共用、可漂移）

| 功能 | 函式:行 |
|---|---|
| 渲染整盤（任意 SVG、用全域主題/視角；SVG viewBox 540×600 固定，顯示尺寸由 CSS `#board{width:100%}` 控制→可縮放）。第 5 參 `liftIccs`＝把某格的子「拿起」不畫（編輯器拖子用） | `drawBoard`:415 |
| 畫單顆子（disk＋字）於絕對座標（從 drawBoard 迴圈抽出，供浮動子複用） | `drawPieceAt`:665 |
| 建浮動「拿起的子」`<g class="floatPiece">`（同盤外觀、local 原點、`pointer-events:none`、靠 transform 定位）；漸層/陰影 defs 來自同 svg 的 drawBoard | `makeFloatingPiece`:744 |
| **走子動畫（可選風格）**：`html[data-board-anim]` ∈ `off`／`fade`（淡入淡出，預設）／`pop`（彈入）／`slide`（微滑＝收斂的線性滑動）／`flash`（閃高亮：子即現＋目標格環脈動）。四種共用同一套：動畫期間操作 `makeFloatingPiece` 浮動複本，`finish(true)` 才 `drawPieceAt` 落真子（被接管＝`finish(false)` 只清不畫，防殘影）。用 SVG transform **屬性**(user-unit)＋手動 `requestAnimationFrame` 內插（避 CSS px 歧義）。**閘門統一在 editor `refreshActive`**：`willAnimate = 單步前進 && boardAnimEnabled() && !skipMoveAnim` 才 `liftIccs=dest`（目標子先不畫）→**不拿起就不會消失**。**手動落子不重播動畫**（棋子已隨游標到位）：`tryAddMove` 寫樹前設一次性 `EDITOR.skipMoveAnim`，refreshActive **只在「真有 move 要畫」(moveIccs 非空) 時才消費清旗標**——故中間 `clearSelection` 的無移動重畫不會提前吃掉它（音效仍播；navNext／點棋譜仍動畫）。**不**因 `prefers-reduced-motion` 自動停用（顯式選單才是真相，否則「Windows 顯示動畫關閉」會默默吃掉）。原大滑動（overshoot＋浮起）因「效果太大」被收掉，改為可選 `slide`（線性無過衝） | `animateBoardMove`（依 `boardAnimStyle` 分派）/ `boardAnimEnabled` |
| **走子/吃子音效**：WebAudio 合成木質敲擊（**無音檔**：三角波 thock＋高通雜訊 tick；落子單敲、吃子較低＋雙敲）。AudioContext 懶建、靠觸發走子的手勢 `resume`。**由 `refreshActive` 直接呼叫、獨立於動畫**（動畫關／音效開仍會響），不寫在 `animateBoardMove` 內。開關 `html[data-board-sound]` | `playPieceSound`（type 由 editor `isCaptureMove` 判定） |
| 河界「楚河漢界」置中（`text-anchor:middle`＋`letter-spacing` 在 Chromium 會多算末字距→x 右補半個 letter-spacing 才視覺置中） | `drawBoard` river text |
| FEN 解析 / 走一步並翻邊 | `parseFen`:55 / `applyIccs`:81 |
| ICCS↔座標、螢幕座標 | `iccsToCoord`:46 / `screenX`:36 / `screenY`:40 |
| 棋子字形（紅 C=砲） | `PIECE_CHAR`:18 / `PIECE_CHARS_SUBSET`:142 |
| 主題樣式表 / 回紋邊框 | `BOARD_STYLES`:189 / `drawMeanderFrame`:336 |
| 字型載入 / 視角鎖 | `ensurePieceFontLoaded`:179 / `isRedPerspective`:751（drawBoard latch `CURRENT_REDP`） |
| 雲庫分數著色 class（cp→`delta-pos/neg-strong/mild`；board.js 唯一倖存的 eval helper，editor-cdb 用） | `deltaSignClass`:124 |

> **T3-3 A1（2026-06-22）**：board.js 原本夾帶整套 chess-book-ai 靜態站 game-page 狀態機
> （`STATE`/`activatePly`/`selectVariation`、`getEntry`+`window.POSITIONS`、eval-delta 族、走勢圖
> `drawChart`、demo 播放、主題 picker 注入器 `injectBoardPicker`）。editor **從不呼叫**它、且它只
> 讀一個 editor 從不寫入的 `window.POSITIONS`（恆 null）——確認死碼後**整套移除**（1722→762 行，
> `node --check`＋smoke 零回歸）。board.js 現為純 renderer：上表的渲染原語＋FEN/ICCS helper＋一個
> `deltaSignClass`。**改 editor 的盤面/著色就改這裡**（不再有「editor 別動的死碼區」）。

### 前端 — 編輯器邏輯（frontend/assets/editor*.js）

> **T2-1 多檔拆分（2026-06-22）**：editor.js（~4400 行）拆成數個 **classic script**，
> 由 index.html **依序**載入（board.js → editor-cdb → -engine → -autoplay → -aichart →
> -demo → **editor.js**）。全部共享同一全域 lexical scope——函式體可自由互相參照
> （都在 boot 後 runtime 才呼叫）；唯一約束是「**頂層執行碼**不可前向參照尚未載入的
> 符號」，故 boot/wiring 留在最後的 editor.js。各模組只含宣告（函式＋字面 const）。
> **加新模組要逐一抽、每步跑 smoke**（曾因一次抽多個用過時行號壞切而回歸）。
> 模組：`-cdb`（雲庫 client/UI）、`-engine`（引擎分頁＋`openAnalyzeStream`）、
> `-autoplay`（AI 走棋沙盒）、`-aichart`（走勢圖）、`-demo`（PV 演示彈窗）。

> **T3-3 B2 — 跨模組全域函式 API（2026-06-22，自動算出）**：模組共享全域 scope，真正的耦合面
> 不是 `EDITOR` state（其 owner 已逐欄標在 editor.js `EDITOR` 宣告的 `[owner: …]` 註解），而是
> 「誰跨檔呼叫誰的函式」。**改某函式簽名前先查它在不在此清單**（在＝有別檔依賴、要同步）。
>
> - **editor.js core → 各模組共用 API**（最重的耦合方向）：`setStatus`(全模組)、
>   `fenSide`(cdb/engine/aichart/demo)、`currentFen`(cdb/engine/autoplay)、`currentLine`(aichart/gifexport)、
>   `navigateTo`/`clearSelection`(autoplay/demo)、`nodeAt`(cdb/demo)、`insertMoveAt`(cdb/autoplay)、
>   `iconLabel`(engine/autoplay/demo)、`switchRpTab`(engine/autoplay)、`refreshActive`/`installBoardOverlay`/
>   `boardFen`/`openSettingsModal`(autoplay)、`updateBoardArrows`/`fenAndLastIccsFor`(engine)、
>   `isEndgameFen`/`cdbTabFen`/`fillCdbNotations`/`mateFromCdbScore`/`renderEvalLine`/`notationFor`(cdb)、
>   `notationsForBatch`/`cssVar`/`hexToRgba`(aichart)、`setDemoStatus`/`showConfirmDialog`(demo)。
> - **各模組 → editor.js（boot/導覽回呼，wiring 在 editor.js 末）**：cdb `ensureCdbLive`/`fetchCdbLive`/
>   `renderCdbTab`/`renderCdbLineView`/`clearCdbLine`／engine `startAnalysis`/`stopAnalysis`/`engineModeClick`/
>   `analysisFen`／autoplay `stopAutoPlay`/`maybeResumeAutoPlay`/`updateAutoPlayBtn`/`auto*`／aichart
>   `renderAiView`/`clearAiAnalysis`/`ai*`／demo `openDemo`/`closeDemo`/`demoGo`/`addPvLine`。
> - **跨 feature（不經 editor.js）**：autoplay·demo → engine `openAnalyzeStream`/`startAnalysis`；
>   cdb·autoplay → engine `fmtEngineScore`、cdb → engine `fenSideName`；autoplay·demo → aichart `aiDepth`；
>   autoplay → cdb `cdbLineDepth`/`cdbLineEntry`；gifexport → cdb `gifFrameDelaySec` + editor.js `currentLine`/`setStatus`。

**狀態 / 樹導航**（以下函式名仍有效，行號為拆分前舊值、僅供概念定位——拆分後散落各 editor-*.js）
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
| 透明 overlay（含選取暈圈/合法落點/**拿起的浮動子**）+ 點擊路由 | `installBoardOverlay`:244 / `onSquareClick`:326 |
| 選子/清選/嘗試走子 | `selectSquare`:361 / `clearSelection`:353 / `tryAddMove`:383 |
| **拿起的子跟隨滑鼠**：選子後 `drawBoard(…,liftIccs)` 把原格子拿起、`installBoardOverlay` 在游標處畫浮動子（`makeFloatingPiece`），`#board` 的 `pointermove` 即時平移（不重畫）。座標換算 `boardPointFromEvent`（client→viewBox）、`floatTransform`（含 `FLOAT_SCALE`）。清選/換子/導航即移除（`clearSelection` 或下次重畫）。`EDITOR.floatEl`/`EDITOR.boardPtr` | `boardPointFromEvent` / `floatTransform` / `installBoardOverlay` 末段 / `#board pointermove`(boot) |
| 插入/刪除 | `insertMoveAt`:512 / `deleteCurrentMove`:429 |
| **逆向加對手變著（reviseMove）**：紅方待走時點**黑子**＝替黑方剛走的那一步改著。盤面**不動**（仍顯示走子後局面）；輸入驗證改吃「該步之前的決策點」`analysisFen`（`inputFen()` 把輸入 fen 從 `boardFen` 切走的唯一例外）。剛走的子顯示在 `lastTo`、實際從 `lastFrom` 起手→`reviseLogicalFrom` 映射（`selectedSquare`＝視覺格、`selectedFrom`＝邏輯起手格）。合法即經 `insertMoveAt(parentPath)` 加為**兄弟分支**（已有兄弟→自動跳「新增分支」確認視窗）。右鍵或點同格放下取消。導航/換檔即清。對紅黑對稱（對手＝盤面待走方的另一方） | `onSquareClick`/`enterReviseMove`/`grabReviseSquare`/`reviseLogicalFrom`/`canReviseLastMove`/`cancelInput`/`inputFen`（editor.js）；`EDITOR.reviseMove`/`selectedFrom`；右鍵 `#board contextmenu`(boot) |
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
| **評估列查哪個局面**：恆＝走完本步後（`currentFen`，與 AI 走勢圖同框架；2026-06-18 由前一步決策點改為此）。整條評估列鎖此局面（見下方原則） | `renderEvalLine`（`currentFen`） |
| **雲庫 tab 查哪個局面（可切換）**：`當前步`＝`analysisFen`（前一步決策點，預設）／`下一步`＝`currentFen`（走完本步後）。切換鈕 `#cdbScopePrev`/`#cdbScopeNext`（`setCdbScope`，存 pref `cdbScope`、`updateCdbScopeBtns` 上色）。**評估列永遠用 `currentFen`，只有 tab 吃 `EDITOR.cdbScope`**（自 2026-06-18 起評估列＝走完後，與 tab 預設 `當前步`＝決策點為不同 FEN） | `cdbTabFen`／`setCdbScope`／`EDITOR.cdbScope` |
| 導航時 lazy 查 **`currentFen()`**（對齊評估列；debounce 220ms；已有 cdb 即跳過；**殘局不查**→`cdbLive.endgame`）。雲庫 tab 自身 fen（`cdbTabFen`）在切到該 tab／切 scope 時才查 | `ensureCdbLive`／`isEndgameFen`／`switchRpTab('cdb')` |
| 殘局判定（雲庫只涵蓋開局＋中局）：雙方合計**無車** or **大子(車R/馬N/炮C)≤2** | `isEndgameFen`（near `cdbTabFen`） |
| 實際抓取（merge 進 `evalsByFen[fen].cdb`；`fresh` 跳快取；失敗不快取以利重試；finally 用 `cdbTabFen()` 比對） | `fetchCdbLive`（共用 `fetchCdb`/`parseCdbResponse`/`cacheCdb`，T2-5） |
| 畫雲庫 tab（全部著法：中文/勝率/紅POV分/★最佳）。標記：`當前步`→目前所在變化 ←／`下一步`→已在棋譜的後續 ✓（`markedSet`） | `renderCdbTab`（狀態標籤 `CDB_STATUS_LABEL`） |
| 雲庫著法翻中文：**僅在 tab 可見時翻 + 一次 batch**（避免落點時對隱藏 tab 狂打 move-info） | `fillCdbNotations`（gate on `#rpCdbBody.hidden`）/ `notationsForBatch`；`switchRpTab('cdb')` 切過去時補翻 |

**☁ 雲庫演繹（cdbline tab）—— 從本局面沿雲庫最佳著往前推一條主線**
| 功能 | 函式 |
|---|---|
| 推演迴圈：自 `currentFen()` 起，逐步查 `/api/chessdb` best→`applyIccs` 進到下一盤→再查，最多 `cdbLineDepth()` 步。**按鈕觸發、非自動**；cache 命中免費，**只有 `source==='live'` 才 sleep `cdbLineThrottle()`**（pref `cdbLineThrottleMs`，預設250，守 chessdb 禮貌）。終止＝到步數／雲庫無資料（出書）／殺棋／**演繹至殘局**（`isEndgameFen`）。T2-5：共用 `fetchCdb` 並**回填** `cacheCdb`（迴圈本身不合併、不讀快取） | `deriveCdbLine`（state `EDITOR.cdbLine`）|
| 進度/結果渲染（步序＋紅POV分/`#±N`；演示·加入按鈕 enable/disable） | `renderCdbLineView` |
| 演示／加入：組 `{fen,path,pvUci,pv}` entry **複用** `openDemo`／`addPvLine`（無新 demo/加入邏輯） | `cdbLineEntry` |
| 過期清除：導航離開起始局面（`refreshActive`）或換檔換目錄即 `clearCdbLine` | `clearCdbLine` |
| 設定 pref：`cdbLineDepth`（步數，預設12）、`cdbLineThrottleMs`（live 查詢間隔 ms，預設250） | `cdbLineDepth`/`cdbLineThrottle`；設定欄 `#cdbLineDepthInput`/`#cdbLineThrottleInput` |

> **為何這不違反「雲庫逐盤面、勿批掃」原則**：它是**按鈕觸發的單次連查**（非隨導航自動、非整檔掃），且 cache-first＋live 才節流 250ms，仍守 chessdb ~5 req/s。離開開局庫後很快 `status≠ok` 自動停，多半跑不滿 12 步。
| 點列加入棋譜（依 scope）：`當前步`＝在**分支點**加同層變化（前一步、`activePath.slice(0,-1)`）／`下一步`＝加**當前著的子著**（`activePath`）；已存在則切換過去 | `addCdbMove`→`insertMoveAt(branchPath,…)` |
| 「重查」按鈕（`fresh=1` 跳快取重打 `cdbTabFen()`，配合目前 scope） | boot 段綁 `#cdbRefreshBtn` |

> **整條評估列都看「走完本步後」(`currentFen`)**：深N分數、建議、雲全部 key 在 `currentFen()`，回答「走完這步後局面如何、最佳應手是什麼」，與 AI 走勢圖同框架（走勢圖每點也是走完後）。**末步終端局面已自源頭補分（chess-book-ai commit `86c4c16`，2026-06-23）**：每個 ply 存的是「走子前」FEN，故每條線「走完末手」的終端盤面曾是全庫唯一沒人評的，末步一度無深N（2026-06-18 改 post-move 框架的已知取捨，**現已失效**）。`build_data.py` 吐終端 FEN（→d12，含將死/困斃 `mate=0`→顯示 #0）、`enrich_decisive.py` 納入 d22 候選；positions.db 重產後 **d12 立即涵蓋末步、d22 隨夜間 sweep 滾動補完**——故末步先有深12，深22 待 sweep 跑到該終端 FEN 後出現。**editor 端零改 code**（唯讀 DB，`renderEvalLine` 自動撈新列）。深度分數來自 `fetchEvalsForFile` 的 batch（`collectAllFens` 已含每個節點走完後的 FEN），不需逐步打網路。
> **導航 live 查對齊評估列（`currentFen`）**：導航時 `ensureCdbLive(currentFen())`，所以評估列「雲」格在 positions.db 漏查時由即時 chessdb.cn 補上——而雲庫漏查很常見：positions.db 的 `chessdb` 表只收 AI 管線的第 10–25 手（`PLY_RANGE`），前段／後段多半無（深N 的 `evals` 表無此窗口，故不受影響）。雲庫 tab 自身的 `cdbTabFen`（預設 `當前步`＝`analysisFen`）則在**切到雲庫 tab／切 scope**時才 live 查（`cdbLive` 單槽，導航只能查一個局面，常駐的評估列優先）。`fetchCdbLive` 收尾按 `fen===currentFen()`／`fen===cdbTabFen()` 分別回繪評估列／tab，避免晚到的回應蓋掉新局面。
> 雲庫資料形狀＝後端 `cdb`（`{status,moves,best,source}`），與 `/api/eval/batch` 一致，故 batch 命中與即時查可共用 `renderEvalLine`/`renderCdbTab`。分數是行棋方 POV cp，顯示時 ×flip 轉紅方視角（同 `_parse_info_line` 慣例）。

**即時引擎分析（SSE）—— 引擎分析 tab**
| 功能 | 函式:行 |
|---|---|
| 起/停分析（開 EventSource） | `startAnalysis` / `stopAnalysis` |
| **前一步/本步 segmented 切換**（`.segToggle`，與雲庫當前步/下一步同元件）：點同模式＝停、點另一模式＝切換分析局面；正在分析的一邊 `.active` 高亮 | `engineModeClick` / `updateEngineToggleBtns`；`#engineToggleBtn`(prev)/`#engineCurBtn`(cur) |
| 分析「前一步」局面（`analysisFen`）/「本步」局面（`currentFen`） | `analysisFen` |
| 收事件→歷程（最新在上，並更新藍箭頭） | `recordEngineEvent`:1796 / `renderEngineHistory`:1811 |
| 清除 / 導出歷程 | `clearAnalysisHistory`:1836 / `exportAnalysisHistory`:1843 |
| 分數/WDL 格式 | `fmtEngineScore`:1768 / `fmtWdl`:1778 / `fmtWdlHtml`:1785 |

**AI 分析 —— 整條線走勢圖（AI分析 tab）**
| 功能 | 函式:行 |
|---|---|
| 後端逐局面掃描（NDJSON 串流，**共用 TT 不清空**）；給 `depth2` 時單次深算同時擷取兩層分數 | `analyze_line`(app.py):528 → `engine_service.analyze_line_stream` / `_parse_score` ｜ `POST /api/engine/analyze-line {fens,depth,depth2?}` |
| 取層數(預設12)/組局面清單 | `aiDepth`:2027（pref `aiAnalysisDepth`）/ `aiLinePositions`:2068 |
| **雙深度比對**：第二層數(預設20)/開關/門檻(預設200)/深淺差值+旗標 | `aiDepth2`:2035 / `aiDualEnabled`:2039 / `aiDiffThreshold`:2042 / `aiPointDiff`:2055（pref `aiAnalysisDepth2`/`aiDualDepth`/`aiDiffThreshold`）|
| **漏著偵測（即時、全盤適用、不靠 positions.db）**：相鄰兩點分數即時算「著法損失」（紅POV分換算成走子方POV的下降，mate 折成 ±(30000−\|m\|)）做門檻判定；損失 ≥ 門檻(預設200)即在走勢圖標**亮黃 `✖` 記號**（粗體重十字 U+2716，`--eval-blunder` token：暗 `#ffd60a`／淺 `#b8860b`，深色描邊 outline 跨紅藍區/明暗主題皆清晰；不用紅色/三角因與紅勢區同色不顯）。讀數**單行**（`.aiReadCard` flex row）且**左右分組**：左＝「步名＋該步紅方分」綁一組（走的＋結果），右＝「✖ 最佳著＋該決策點紅方分」（`margin-left:auto` 推到右；該走的＋結果），避免分數被推離步名又與漏著黏在一起。漏著段**全紅方 POV**。過窄時步名 ellipsis、裁切不換行——決策點分＝最佳走法能守住的紅方分，與主行的走子後紅方分一比即見此步讓出多少（刻意不顯示走子方 POV 的損失數，避免與紅方分混 POV）。最佳著＝該決策點引擎 best（UCI→中文，掃描後對少數漏著點批量翻譯） | `aiPlyLoss`／`aiCpRed`／`aiBlunderThreshold`（pref `aiBlunderThreshold`）／`fillAiBlunderBest`（drawAiChart 標記偵測＋renderAiReadout 紅POV 顯示共用） |
| 主流程（串流接收→填點→完成移游標到終局＋翻譯漏著最佳著；雙深度時帶 cp2/mate2） | `analyzeCurrentLine`:2081 / `clearAiAnalysis`:2152 |
| 游標索引（hover 或目前盤面） / hit-test | `aiCursorIdx`:2167 / `aiActiveIdx`:2159 / `aiIndexFromEvent`:2196 |
| 繪圖：動態 Y 量程 + **紅藍漲跌面積圖**（0 線硬切換漸層）+ 中性壓頂線 + 小分色點 + Δ旗標 + 橙環 | `drawAiChart`:2264（量程 `aiRange`:2190/`aiNiceCeil`:2179、`AI_PAD`:2175） |
| **終局將死 `mate 0` 正負號還原**：引擎對「行棋方已被將死」回 `score mate 0`，`0×flip` 把正負號吃掉→走勢圖會誤畫到最底。改由該局面 FEN 的行棋方（被將死者＝輸家）還原紅方視角正負（黑行棋＝紅勝→頂、紅行棋＝紅敗→底）。各點存 `fen` 供此用 | `mateSign`（`drawAiChart` val／`aiScoreNum`／`renderAiReadout` fmt 共用）|
| 分析中圓角提示 / 單筆讀數（雙深度顯示 d1/d2/Δ） | `drawAiBusy`:2223 / `renderAiView`:2207 / `renderAiReadout`:2357 |
| **逐手五級評價＋整局報告（掃描後才出現，全程重用掃描資料、零新後端／不查 positions.db）**：每手依 cp 失分（`aiPlyLoss`，與漏著同一份）分五級 优≤30／好≤80／中≤150／差≤350／劣>350（門檻可調，差/劣 ⊇ 漏著預設200）；`#aiReport`：頂列**分紅/黑各一列**（`aiSideHeadHtml`，紅暖黑冷用 `--side-*-strong` token；走子方由 `fenSide(points[i-1].fen)` 判、非 i%2，故非標準起手也對），每列＝該方 共N手＋**偏差率**（差/劣占該方手數，= 下方失準清單）＋該方五級 tally；下方 `.aiRepGrid`（label↔內容對齊）放**關鍵轉折**（單手最大失分，≥100 才標）＋**失準手數**（差/劣 清單，每筆＝步名＋**走後分**（`aiEvalRed`，該手後紅POV分，muted 灰）＋**虧損**（`aiLossTag`→「虧N」/「殺」），點擊經 `navigateTo` 跳手）；**面板夠高（`#anBodyAi` clientHeight ≥480，即展開/全畫面）時報告顯示更詳盡**：①轉折/失準步加上**建議走法**（`aiSuggestHtml`，該步決策點 `points[idx-1].bestZh` 引擎 best；金色 `--accent-gold`；翻譯重用 `fillAiBlunderBest`，其範圍已從漏著門檻放寬到也涵蓋差/劣步）；②追加**五級評級門檻說明**（`aiThresholdLegendHtml`，由 `AI_GRADE_BANDS` 推導：优≤30／好31–80／中81–150／差151–350／劣>350 + 「每手失分 cp」）。矮則只剩摘要——靠 chart 的 ResizeObserver 重跑 `renderAiView` 響應（面板高由 splitter 決定、穩定，不會回授成迴圈）。走勢圖 hover readout 另綴一顆評級 chip（**膠囊在分數前**）surface 逐手評價（不動左側乾淨棋譜清單）。**殺著去假分**：折算 mate 的損失是 ~30000 級假 cp（會印成「約失 29358 分」），偵測 `point.mate!=null`／`|loss|≥9000` 改印「走入殺局／殺」（`aiMateLoss`/`aiLossPhrase`/`aiLossTag`）。配色重用主題感知 `--delta` ramp（优綠…劣紅，無寫死 hex，dark/light 皆驗）。對標 xqpoint 報告但跑**本地引擎**＝無配額/免登入 | `AI_GRADE_BANDS`/`aiGrade`(editor-aichart.js:43/50) ／ `renderAiReport`＋`aiSideHeadHtml`/`aiEvalRed`/`aiMateLoss`/`aiLossPhrase`/`aiLossTag`(editor-aichart.js，`renderAiView` 末呼叫) ／ readout chip 在 `renderAiReadout`；CSS `.aiGradeChip`/`.aiReport`/`.aiRepGrid`/`.aiRepSide`/`.aiFlawEval`/`.g-*`(editor.css) |

> 為何 d12 走勢圖就抓到即時分析 d21 才證出的殺：名目深度≠步數（seldepth/延伸/quiescence）＋掃描共用置換表。詳見 memory `project-ai-line-depth`，內含「是否每點 `ucinewgame` 嚴格獨立」的待決定。

**變化例演示 dialog（單行 PV 重播）**
| 功能 | 函式 |
|---|---|
| 開/關 dialog（用 applyIccs 串 fens；存 `startFen`/`startPath` 供延伸＋加入） | `openDemo` / `closeDemo`（關閉時 abort 進行中的延伸 SSE） |
| 畫 / 跳步 / 自動播放 | `renderDemo` / `demoGo` / `demoTogglePlay` / `demoStopPlay` |
| **延伸**：從**目前所在步**（`d.idx`）用引擎重算一段 PV（headless SSE，`go movetime`，取最深 PV），**捨棄此步之後的演示尾段**（尾段可信度低）再接上，續播。走在末步＝單純加長。計算用**固定層數**（非秒數——層數可量化、可重現）＝pref `demoExtendDepth`（存取子 `demoExtendDepth()`，預設16，夾6–40；`#demoExtendDepth` change 即存、boot 回填）；後端 `go depth N` | `demoExtend`（取線 `requestDemoPv`，自己的 `EDITOR.demo.es`，**不複用** `startAnalysis`/`requestBestMove`） |
| **把演示線「到目前所在步為止」（`lastIccs[0..d.idx)`）加進走子樹**：只取已導覽到、信得過的前段，**捨棄 `d.idx` 之後飄移的尾段**（淺算/雲庫尾未必可信）；原線複用既有節點、新段在分歧點新增。`d.idx===0`（起始局面）擋下提示前進。**先 `closeDemo` 再 `addPvLine`**——演示窗與 `#confirmModal` 同 `.modal z-index:10` 但 DOM 在後，不關會疊在確認 dialog 上擋住按鈕 | `demoAdd` → `addPvLine` |

**🤖 AI 自動走棋（pikafish 自動走子；後端零改動，複用 `/api/engine/analyze` 的 `movetime`）**
| 功能 | 函式 |
|---|---|
| 主迴圈：取行棋方→該方 AI？否則暫停等人（人機輪替）→ 取最佳著→套用→下一手 | `autoPlayStep` |
| 起/停（停止時若沙盒則 `navigateTo(startPath)` 還原；`restore=false` 給換檔用） | `startAutoPlay` / `stopAutoPlay` / `toggleAutoPlay` |
| 取最佳著（headless SSE，`go movetime`；`done.bestmove` 為準，`(none)`＝終局）。**不複用 `startAnalysis`**（那支綁引擎 tab UI） | `requestBestMove` |
| 套用一步：**固定走 sandbox**→`sandboxPush`（`ap.recording` 釘死 false；record→`insertMoveAt` 分支保留但不走） | `autoApplyMove` |
| 沙盒：暫態線（不碰 `EDITOR.data`）push＋畫盤；輸入路徑用 `boardFen()`（沙盒回末筆 fen，否則 `currentFen`） | `sandboxPush` / `renderSandbox` / `boardFen`:235 / `redrawBoardView` |
| 人落子後若輪 AI 則接手（掛在 `tryAddMove` 末） | `maybeResumeAutoPlay` |
| **走子歷程（`autoPlay.history`，逐步記 cp/mate；最新在上）；只有最新一步有 演示/加入；每筆著法依走子方 `.moveRed`/`.moveBlk` 上色** | `renderAutoHistory` / `autoEntryUpTo`（組 `{fen,path,pvUci,pv}` 複用 `openDemo`/`addPvLine`）/ `clearAutoHistory` / `setAutoState` |
| 起/停 toggle 鈕（在 🤖AI走棋 **分頁控制列內**，非 tab 列；`iconLabel` play/開始 ↔ stop/停止） | `updateAutoPlayBtn`；`#autoStartBtn` |
| 🤖AI走棋 分頁（控制列：清除＋狀態 `#autoState`；歷程 `#autoHistory`）；start 時 `switchRpTab('auto')`。**無「加入棋譜」開關 → 一律沙盒；要落地按歷程最新步的 加入** | `#rpTabAuto`/`#rpAutoBody`；`#autoClearBtn` |
| pref 存取子 | `autoAiRed`/`autoAiBlack`/`autoRedSecs`/`autoBlackSecs`/`autoMaxPlies` |

> **步時語意**：`movetime` 滿即吐 `bestmove`＝當前最高分著（需求 3）。**自動走棋一律沙盒不落地**（`ap.recording` 釘死
> false，UI 開關已移除）：moves 在 `autoPlay.sandboxLine`，停止 `navigateTo(startPath)` 還原；要保留就按歷程最新步的
> 加入（`addPvLine`）。換檔/換目錄走 `stopAutoPlay(null,false)` 只清狀態不還原（`EDITOR.data` 已換）。`boardFen()` 是
> `currentFen()`/沙盒末筆的唯一分流點。

**🎬 GIF 匯出（整條主線 → 動畫 GIF；純前端、後端零改動）**
| 功能 | 函式（frontend/assets/gifexport.js，除非另註） |
|---|---|
| 主流程：`currentLine()` 逐手 → `drawBoard()`(board.js) 畫離屏 SVG → 光柵化進 `<canvas>`（底部字幕條：檔名＋第N步/共M步）→ `gifenc` 編碼 → 下載 | `exportGif` |
| 影格清單（起始局面＋每手 post-move FEN＋last-move 高亮） | `buildFrames` |
| **字型內嵌**（離屏光柵化時頁面 `<link>` webfont 不生效）：讀 `PIECE_FONTS[style].localUrl`（本地子集化 woff2）→ base64 組成 `@font-face`（family=`localFamily`）→ 注入每格 SVG `<defs><style>`；無 localUrl 才退回舊 `googleUrl` CDN 路徑；抓失敗退回系統 CJK 字型，不擋匯出。抓一次快取 | `loadEmbeddedFontCss` / `injectFontStyle` |
| SVG→canvas 走 Blob URL（字型 base64 太大，免每格 encodeURIComponent）／字幕條／每手停留 ms（末格 ×2.5） | `svgToImage` / `paintCaption` / `frameDelayMs` |
| 編碼器：vendored `gifenc`（無相依、無 worker、不走 runtime CDN），IIFE 包成 `window.gifenc`（GIFEncoder/quantize/applyPalette） | frontend/assets/gifenc.global.js |
| 觸發鈕在棋譜列標頭 `#exportGifBtn`（Lucide `ICON.download`，editor.js boot 注入取代 HTML 的 🎬 fallback；純圖示）；進度寫 header `#status`（圖示鈕不可塞文字會撐爆） | index.html 棋譜 panelHead；綁定在 gifexport.js 末 `DOMContentLoaded` |

**設定 / 路徑 / 偏好**
| 功能 | 函式:行 |
|---|---|
| 偏好讀寫（伺服器 preferences.json） | `loadPreferences`:64 / `savePreference`:71 |
| AI 自動走棋偏好（`autoAiRed`/`autoAiBlack`/`autoRedSecs`/`autoBlackSecs`/`autoRecordToTree`/`autoMaxPlies`） | 同 `loadPreferences`/`savePreference`；boot 段回填、change 即存 |
| GIF 影格間隔（秒，預設 0.65；設定欄 `#gifDelayInput`） | `gifFrameDelaySec`（pref `gifFrameDelaySec`；gifexport.js `frameDelayMs` 讀它） |
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
| splitter 拖曳（flex-basis）＋**收合/復原**：橫向 splitter 中央兩顆 ▴▾ 鈕（收合上方／下方面板到只剩 tab 列；再按同顆＝復原；雙擊整條＝回預設高度）。收合＝給對側 `.rp-collapsed`（隱 `.rpTabBody`）＋本側 `.rp-fill`(flex:1)；拖曳會自動解除收合；**點收合區的 tab 也會自動展開**（`SPLIT_CONTROLLERS` 註冊表＋`expandIfCollapsed`，在 `switchRpTab`/`switchAnnoteTab` 呼叫）| `setupSplitters`:2438（`applyCollapse`/`restoreSplit`/`resetSplit`/`expandIfCollapsed`；CSS `.splitterHandle`/`.splitterBtn`/`.rp-collapsed`/`.rp-fill`） |
| 檔案樹渲染 / 檔案 li 工廠 | `renderDir`（`.cbl` 節點＝📚 可展開、懶載入）/ `makeFileLi` |
| CBL 資料夾懶展開（首次展開打 `cbl-children`，塞盤目；失敗可重試；尚未開棋譜時盤面顯示「棋庫載入中」膠囊） | `toggleCblDir` |
| **未存檔守門**（換盤/換檔/換目錄前提示存/棄；存檔失敗則留原棋譜） | `maybeSaveBeforeLeaving`（`EDITOR.dirty` 旗標、`markDirty`；`save` 成功清旗標） |
| **復原／重做**（快照法）：每個改 `EDITOR.data` 的編輯在「改動前」`pushUndo()` 壓入整樹 `structuredClone`＋`activePath`（封頂 `UNDO_CAP`=60）。掛點都貼著 `markDirty`：`insertMoveAt`/`deleteCurrentMove`/`moveVariation`(含 `moveActiveVariation`＋走法▲▼)/`commitAnnoteEdit`(含 `applyAnnotePreset`)/`applyMetaEdits`。`undo`/`redo` 換回 `data`+`path`→`refreshActive`，還原即 `dirty=true`。**新編輯清 redo；換檔/換盤（`EDITOR.data` 抽換的載入＋reset）`clearUndo` 清兩堆——不可跨檔復原**；堆疊只在記憶體、不持久化。UI＝棋譜面板頭 `#undoBtn`/`#redoBtn`（緊鄰刪除）＋鍵盤 `Ctrl+Z`／`Ctrl+Shift+Z`／`Ctrl+Y`（**註解框 focus 時不攔，走原生文字 undo**）。空堆疊 `updateUndoButtons` disable | `pushUndo`/`undo`/`redo`/`clearUndo`/`snapshotState`（editor.js，`markDirty` 旁）|
| 展開祖先→定位某檔（`doLoad`：true=載入／false=只高亮不載入） | `revealFileInTree` |
| 開機自動載入上次檔案（`revealFileInTree(…,true)`；CBL 盤先展開該庫再載盤） | `tryAutoLoadLastFile` |
| **重新掃描目錄**（`🔄 重掃`：重拉 `/api/xqf/list` 重繪樹→偵測磁碟上新增/刪除的檔；**不動目前棋譜**，重繪後 `revealFileInTree(currentPath,false)` 還原定位） | `rescanTree`（`#rescanBtn`） |
| **切回分頁自動偵測**（`visibilitychange`/`focus`→探測 list，**僅結構簽章 `EDITOR.treeSig` 改變才重繪**：沒變則不收合展開、不閃 status；節流 `AUTO_RESCAN_MIN_GAP_MS`=4s；`loadFileTree(prefetched)` 復用已抓 tree 免二次 fetch） | `autoRescanIfChanged` |
| **事件綁定 / icon 注入（boot）** | editor.js **2284–2437**（`.onclick`、`innerHTML=iconLabel…`、tab/demo/AI圖 hover、ResizeObserver 都在這） |

### HTML 結構（frontend/index.html）

| 區塊 | 位置 | 備註 |
|---|---|---|
| header（logo「梅友弈鑑」朱文方印/棋盤主題/介面主題/儲存） | h1 含 inline `.appLogo.appSeal` SVG（硃砂「梅」印，固定色不隨主題；同款 favicon.svg） | **只剩外觀下拉（棋盤/介面）＋ `.actionsDivider` ＋儲存**。賽事資訊(`#metaBtn`)已移到棋譜名稱列；紅黑視角已移到導航列 |
| 棋譜名稱列（`#fileTitleBar`） | `#fileTitle`（h2）＋`#metaBtn`(賽事資訊，icon-only) | 名稱**靠左固定**（`flex:1;text-align:left;ellipsis`，名稱長短不飄）；賽事資訊鈕靠右；**無底線/底色**（純標題列） |
| 檔案樹 pane | settingsBtn / rescanBtn / newXqfBtn | 🔄 重掃＝重新掃描目錄 |
| 棋盤 pane + 導航列 + 評估列 | `#board`、`#navBar`、`#evalLine` | **可拖縮放**：boardPane 右側 splitter（`data-pref="splitBoardW"`）拖 flex-basis，`#board{width:100%}`＋viewBox 不變→整盤含點擊層等比縮放；`#boardPane` min/max-width 夾住。導航列隨欄寬自適應：`#navBranch` 純圖示（`ICON.branch`，提示在 title）、按鈕 `flex:1 1 0`＋max-width 封頂、`#moveInfo` 高 flex 權重吃剩餘寬＋ellipsis；走法無前綴符號，窄時 `@container navbar` 隱藏 `.miPly`（「第N步：」前綴）只留著法（如 傌二進三）。**紅黑視角＝`#perspectiveBtn` 在此列末端**（一顆按鈕，顯示目前視角＋flip 圖示、點擊翻面；`togglePerspective`/`updatePerspectiveBtn`，真實來源仍是隱藏 `#redPerspective`；`#moveInfo` flex:3 把它頂到最右） |
| 右欄：棋譜 ｜ (注解/AI分析) ｜ (走法/☁雲庫/☁雲庫演繹/引擎分析) | 兩組 `.rpTabs`：`#rpAnnote`＝注解+AI分析（`#aiBar` 在頁籤列、僅 AI 時顯示；`#aiChart`+`#aiReadout`）；`#rpVars`＝走法+雲庫(`#rpCdbBody`)+雲庫演繹(`#rpCdbLineBody`：`#cdbLineRunBtn`/`#cdbLineDemoBtn`/`#cdbLineAddBtn`+`#cdbLineList`)+引擎分析+🤖AI走棋(`#rpAutoBody`：控制列 `#autoStartBtn`(start/stop)/`#autoClearBtn`/`#autoState`+歷程 `#autoHistory`) |
| dialogs | confirm / meta / new / demo / settings；**demo/settings 標題列含 `.modalClose` ✕** |
| settings 分區（兩欄瀑布流 `.settingsForm{column-count:2}`，`break-inside:avoid`） | 資料來源 / 引擎分析 / 雲庫演繹 / **AI 自動走棋**（`#autoAiRedChk`/`#autoAiBlackChk`/`#autoRedSecsInput`/`#autoBlackSecsInput`/`#autoMaxPliesInput`；**加入棋譜 `#autoRecordChk` 已移到 🤖AI走棋 分頁**）/ **棋盤動效**（`#boardAnimSel` 走子動畫風格下拉 fade/pop/slide/flash/off／`#boardSoundChk` 走子音效；change 即存 pref＋更新 `html[data-board-anim]`/`[data-board-sound]`，boot `applyBoardFxPrefs`／`boardAnimPref` 同步、legacy 布林 true→fade）/ 匯出動畫 |

### 持久層（已驗證全庫 round-trip）

| 元件 | 位置 |
|---|---|
| XQF 寫檔（修上游 3 bug） | `vendor/io_xqf_patched.py` `PatchedXQFWriter` |
| round-trip 測試（SRC 路徑硬編） | `tests/test_roundtrip.py`（`SRC_ROOT`） |
| XQStudio 驗證樣本 | `samples/`、`tools/emit_sample.py` |
| 格式轉檔 CLI | `tools/cwp_to_xqf.py` / `cbl_to_xqf.py` / `xqf_to_cbl.py`（讀寫器：`vendor/io_cwp.py`、`vendor/cchess_cbl.py`、`vendor/io_cb_writer.py`）|
| CWP 造字區還原（`FB7A`=車）/ CB 往返測 | `vendor/io_cwp.py` `cwp_eudc` error handler、`_CWP_EUDC`；`tests/test_cb_roundtrip.py` |
| 一次性修已轉檔的「車」亂碼（`�z`→車，原地改 .cbl/.xqf 標題、先備份） | `tools/fix_che_title.py`（`--dry-run` 可預覽）|
| 門檻同步檢查 | `backend/test_trap_spotcheck.py` / `test_eval_integration.py` |
| cchess 內附 wheel（離線安裝來源） | `vendor/wheels/`、`requirements.txt`、`setup.ps1` |
| 免裝 Python 打包（server exe：起 Flask＋印 URL，使用者自開瀏覽器） | 入口 `server.py`（`--pick`＝picker 自我重入分支）、`server.spec`（onedir）、`package.ps1`（建置＋staging `engine\Windows\`＋`samples\`＋`positions.db` 到 exe 旁）、`requirements-build.txt`；凍結路徑分流 `backend/app.py` `_resource_base`（唯讀→`_MEIPASS`）/`_data_base`（可寫→exe 旁）＋frozen-aware `DEFAULT_*`；picker `_subprocess_pick`（frozen→`--pick`／dev→`python -c`→`backend/tk_picker.py`） |

---

## 4. 改功能時的起手式

- **加按鈕** → `ICON` map(1723) 加圖示 → boot 段(2284–2437) 綁 `.onclick` + `innerHTML=iconLabel(...)`。禁 emoji。
- **加 API** → app.py 加 `@app.get/post`（薄路由，只做 IO+驗證）→ 邏輯放對應 service：資料 `xqf_service`/`eval_service`，引擎 `engine_service`，路徑/偏好 `config`，原生對話框 `picker_service`。
- **改著法顯示** → 一律經 `_apply_side_glyphs`(xqf_service:267)；UI 端不要再拼字形。
- **加會改 `EDITOR.data` 的編輯** → 函式開頭、**改動之前**呼叫 `pushUndo()`（快照法 undo/redo 才涵蓋；條件式突變如賽事用 `snapshotState()` 先存、確認有變才 `pushUndoSnapshot`）。換掉 `EDITOR.data` 的新路徑要 `clearUndo()`。
- **改面板尺寸/版面** → splitter `data-pref` + `setupSplitters`；尺寸自動進 PREFS。
- **動分析串流** → 後端 `engine_service._parse_info_line` 解析、`analyze_stream` 串流（route `engine_analyze`）；前端 `startAnalysis`/`renderEngineHistory` 消費。改欄位兩邊都要動。
- **動分數/WDL 約定** → 改 `engine_service._parse_info_line` 的 flip/WDL 互換，前端 `fmtEngineScore`/`fmtWdlHtml` 同步。
- **改棋盤箭頭（色/寬/編號位置）** → 全在 `updateBoardArrows`/`boardArrow`/`boardArrowBadge`；色盤 `ARROW_THEMES` 一主題一行。SVG 無 z-index，疊放靠文件順序——編號最後畫才壓得住線。
- **加棋盤主題** → board.js `BOARD_STYLES` 加一筆 + editor.js `ARROW_THEMES` 補對應箭頭色 + `EDITOR_THEME_COLORS` 補選取/落點色 + `ensureBoardThemeOptions` 加選項。
- **改走子動畫/音效** → 全在 board.js `animateBoardMove`（依 `boardAnimStyle` 分派四風格，加風格＝多一個 `else if` 分支＋index.html `#boardAnimSel` 多一 option）/`playPieceSound`；觸發判定（只單步前進）在 editor.js `animatableMove`，掛在 `refreshActive`（動畫時 `liftIccs=dest` 先不畫目標子）。開關走 `html[data-board-anim]`(風格字串)/`[data-board-sound]` dataset hook（boot `applyBoardFxPrefs`/`boardAnimPref` 從 PREFS 同步、選單 change 即更新）。動畫用 SVG transform **屬性** user-unit，別改成 CSS px transform（單位歧義）。
- **動 AI 走勢圖（量程/點線/查詢）** → 全在 `drawAiChart`/`drawAiBusy`/`renderAiReadout`/`aiRange`；後端逐局面在 `analyze_line`。Y 軸動態、點按走子方分色、共用 TT（要嚴格獨立才加 `ucinewgame`）。
- **加頁籤** → 同一 `.rpTabs`/`.rpTabBody` 結構 + 專屬 `switchXxxTab`（查詢限定容器）；隱藏靠 `.rpTabBody[hidden]{display:none !important}`，body 自己的 `display:flex` 不會蓋掉。
