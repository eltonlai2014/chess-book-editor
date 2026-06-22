# 系統優化盤點（Optimization Backlog）

> 盤點日：2026-06-22。本檔是 **living backlog**，不是一次性快照——做掉一項就把
> 狀態改掉、留 commit 連結；新發現就往對應 Tier 追加。
> **行號／行數為盤點當下參考，動手前一律以實際檔案為準**（這份 repo 變動快）。
> 對照導覽請讀 [ARCHITECTURE.md](../ARCHITECTURE.md)；陷阱與「為什麼」讀
> [../CLAUDE.md](../CLAUDE.md)。

## 規模現況（god-file 一覽）

| 檔案 | 行數(盤點日) | 角色 |
|---|---|---|
| `frontend/assets/editor.js` | ~2950 | 編輯器核心（T2-1 已拆出 cdb/engine/autoplay/aichart/demo 為同層 classic script） |
| `frontend/assets/editor.css` | ~3048 | UI 樣式（唯一被 index.html 載入的） |
| `backend/app.py` | ~564 | Flask **薄路由**（T2-2 已拆出 `config.py`/`picker_service.py`/`engine_service.py`） |
| `frontend/assets/board.js` | ~1722 | 盤面繪製（自 chess-book-ai 複製，接受漂移） |
| ~~`frontend/assets/style.css`~~ | ~~1589~~ | **已刪除**（死碼，T1-1，2026-06-22） |
| `backend/xqf_service.py` | ~574 | XQF 讀寫、`fast_parse_book` monkeypatch |
| `backend/cb_service.py` | ~410 | CBL/CBR 讀寫、byte-splice 存檔 |

---

## 查證後的修正（把被誇大的 agent 判斷降級，避免當事實）

- **引擎 SSE「殭屍子行程」→ 誇大 → per-request 逾時已補（T3-5）。** 兩支串流
  （T2-2 後在 `engine_service.analyze_stream`/`analyze_line_stream`）都有
  `finally: _shutdown`，client 斷線（GeneratorExit）會收掉 pikafish。原缺的
  **per-request 逾時**已由 stall watchdog 補上（見 T3-5）。
- **annote 每鍵 commit「100 次 mutation」→ 正確但無感**；debounce 只是清爽，非效能
  問題。不排程。
- **monkeypatch race → 真實但機率低 → ✅ 已修（T3-4，2026-06-22）。** 舊版 `is_checking`
  是**全域** patch，A 執行緒 parse 的 ~3 秒內 B 分頁走子驗證會看到被改成 `False` 的版本
  （`threaded=True`）。已改 thread-local 旗標 `_suppress_check` 閘控——只在當前執行緒
  解析時回 False，跨執行緒不再洩漏；可重入、免 lock。詳見 T3-4。

---

## Tier 1｜立即可做、低風險高回報（建議先清）

| ID | 項目 | 證據 | 為何值得 | 狀態 |
|---|---|---|---|---|
| T1-1 | **刪 `style.css` 死碼** | index.html 只 link `editor.css`（[index.html:8](../frontend/index.html#L8)）；全 repo 無人引用 | 純倉庫衛生，零行為改變 | **DONE**（2026-06-22，`git rm`） |
| T1-2 | **抽共用 SSE helper** | 三處幾乎相同的 EventSource：`startAnalysis`、`requestBestMove`、`requestDemoPv` | ✅ `openAnalyzeStream(url,{onInfo,onDone,onError})`（editor.js）：集中建立/解析/分派/close，三處改用、逐一等價改寫。**註**：引擎/auto-play/demo SSE 自動測試未覆蓋（沙盒無引擎），靠等價改寫＋boot 測試把關 | **DONE**（2026-06-22） |
| T1-3 | **集中 FEN side 解析** | 8 處散落的 `split()[1]` 取走子方（格式不一、部分無 null guard） | ✅ `fenSide(fen)`（editor.js:59，board.js `parseFen` 的輕量版，免拆 90 格盤面）：8 處全收斂、語意等價（順帶補上 null guard）。杜絕 `<board> <side>` 漂移時各處不一致 | **DONE**（2026-06-22） |

## Tier 2｜結構債、值得排程（工程大但有感）

| ID | 項目 | 證據 | 修法方向 / 取捨 | 狀態 |
|---|---|---|---|---|
| T2-1 | **拆 `editor.js` god-file** | ~4400 行單檔 + `EDITOR` 全域物件 | ✅ 主人裁示「多 `<script>` 漸進抽出」。逐一抽出 5 模組（cdb/engine/autoplay/aichart/demo）為**同層 classic script**（共享全域 scope、依序載入），每步跑 smoke。editor.js ~4400→~2950。**教訓**：一次抽多個用過時行號會壞切→改逐一抽＋每步重新定界＋smoke 把關。智慧化過程中發現並修掉 smoke 對「同 server 第二次整頁載入」的 dev-server 卡死（reload 改 fresh server）。`EDITOR` 全域物件仍未拆（與 T3-3 一起再議） | **DONE**（2026-06-22） |
| T2-2 | **拆 `app.py` god-module** | ~1064 行混路由 + 路徑解析 + picker + 兩支 SSE | ✅ 抽 `config.py`（路徑/prefs/DEFAULT_*）、`picker_service.py`（tkinter 對話框）、`engine_service.py`（Pikafish 子行程＋UCI 解析＋兩支串流，共用 `_spawn`/`_engine_fen`/`_shutdown`）。app.py 1064→564，只剩薄路由。route+SSE+smoke 全綠（smoke isolation seam 改 patch `config`） | **DONE**（2026-06-22） |
| T2-3 | **DB 連線 per-request churn** | `eval_service`（read-only positions.db）、`chessdb_service` 每次查詢開新連線 | ✅ `backend/db_pool.py`：程序級連線池（`get_ro`/`get_rw`，path-keyed、序列化、不 close）。`lookup_batch`＋雲庫 `_read_positions_db`/`_ensure_cache` 改用池；`db_info` 仍短命（要驗證任意候選檔）。route + eval-integration + trap-spotcheck 全綠 | **DONE**（2026-06-22） |
| T2-4 | **導覽時全樹走訪 + 全盤重繪** | `refreshActive`（[editor.js:1895](../frontend/assets/editor.js#L1895)）每次重畫整個 SVG + 重裝 overlay | `path→fen` 快取 + 箭頭層增量更新。**取捨**：小檔無感、無 profiling 證據前不提前優化（codex 亦持此見）；只有大棋譜/深樹才值得 | TODO |
| T2-5 | **`deriveCdbLine` 與 `fetchCdbLive` 各自解析 `/api/chessdb`** | 兩處各自 fetch+parse；`deriveCdbLine` 原本不讀不寫快取 | ✅ 抽 `fetchCdb`/`parseCdbResponse`/`cacheCdb`（editor.js）；兩處共用 fetch+parse；`deriveCdbLine` **回填** `evalsByFen[fen].cdb`（含 unknown）→ 導覽到演繹過的局面免重查。**獨立節流迴圈未合併**（CLAUDE.md 授權的唯一多次查詢，刻意分流）。smoke 全綠 | **DONE**（2026-06-22，codex NEW-1） |

## Tier 3｜風險缺口（不是效能，是安全網）

| ID | 項目 | 證據 | 修法方向 | 狀態 |
|---|---|---|---|---|
| T3-1a | **route 契約測試** | 原本唯一安全網是 persistence round-trip；SSE/chessdb/route 全裸奔 | ✅ `tests/test_routes.py`：Flask `test_client`，25 checks 覆蓋 `/api/xqf/move-info`、`/api/eval/batch`、`/api/chessdb`（含 400/500/降級契約）。網路 seam `query_chessdb` + DB seam monkeypatch，**不碰 chessdb.cn、不依賴 positions.db** | **DONE**（2026-06-22） |
| T3-1b | **瀏覽器煙霧測試** | route 已覆蓋，但前端 state machine / UI 流程仍無測試 | ✅ `tests/test_smoke_ui.py`（+ `tests/_smoke_server.py` 隔離 launcher）：Chromium 跑「boot→開檔→盤面→導覽→改 annote→存→**重載驗證落地**」。隔離沙盒（暫存 prefs/庫/cache，stub `query_chessdb`），**不碰真實設定、不打網路**；缺 Playwright/Chromium/sample 則 SKIP（CI 安全）。零生產碼改動（launcher 覆寫模組全域） | **DONE**（2026-06-22） |
| T3-2 | **trap 門檻常數與 chess-book-ai 手抄同步** | editor.js 的 `SKIP_OPENING_PLIES`/`TRAP_*`/`BRILLIANT_*` 必須與 `chess-book-ai/site_builder/render_site.py` 一致 | ✅ `eval_service.TRAP_THRESHOLDS` 為唯一來源；`GET /api/eval/thresholds` 吐值，前端 `fetchThresholds`（boot batch，consts 降級為 fallback mirror），`test_trap_spotcheck` 改 import。repo 內 3 份手抄→1 份（仍需對 render_site.py，但只剩一處）。route 測試＋trap spotcheck（同結果）全綠 | **DONE**（2026-06-22） |
| T3-3 | **board.js ↔ editor.js 全域耦合** | board.js 讀 `window.POSITIONS` 等全域（[board.js:111](../frontend/assets/board.js#L111)） | **主要成本是測試/抽模組的前置阻力**（要測 board.js 得先 mock 全域），其次才是與兄弟 repo 漂移（codex 重定性）。擋住 `xiangqi-board-lib` 抽取 TODO；非急 | TODO |
| T3-4 | **monkeypatch `is_checking` 全域窗口** | 見上「查證後的修正」 | ✅ 改 thread-local 旗標 `_suppress_check`：`is_checking` 永久包一層閘，只在「當前執行緒正在 `fast_parse_book`」時回 False。跨執行緒不洩漏、可重入、免 lock（移除 `_parse_lock`）。round-trip 逐字節仍相同 | **DONE**（2026-06-22） |
| T3-5 | **引擎 SSE 無 per-request 逾時** | `finally: proc.kill()` 已有；缺的是上限 | ✅ `engine_service._start_stall_watchdog`：守護執行緒，引擎 `_STALL_TIMEOUT`(30s) 無輸出即 kill（解開 reader 的阻塞 readline）。是「無進展」而非時長上限——`go infinite`/長搜尋持續吐 info 不誤殺；兩支串流都接。`test_engine_sse` happy path 不受影響 | **DONE**（2026-06-22） |

---

## 建議下手順序（codex 亦背書此序）

1. ~~刪 style.css 死碼~~ ✅ **T1-1 已做**。
2. ~~鋪 route 契約測試~~ ✅ **T3-1a 已做**（`tests/test_routes.py`，25 checks 全綠）。
3. ~~Playwright 煙霧測試~~ ✅ **T3-1b 已做**（`tests/test_smoke_ui.py`，8 checks 全綠）。
4. ~~T1-2 SSE helper~~ ✅、~~T1-3 FEN side 收斂~~ ✅（安全網就位後做，smoke+routes 全綠）。
5. ~~T2-3 連線池~~ ✅、~~T2-2 拆 app.py~~ ✅、~~引擎 SSE 自動測試（取代手動驗證）~~ ✅（2026-06-22）。
6. ~~T3-2 門檻單一來源~~ ✅、~~T3-5 SSE watchdog~~ ✅、~~T3-4 monkeypatch thread-local~~ ✅、
   ~~T2-5 fetchCdb 共用~~ ✅、~~T2-1 拆 editor.js（多 script）~~ ✅（2026-06-22）。
7. **剩餘：T3-3 board.js `window.POSITIONS` 解耦（＋`EDITOR` 全域物件，與此一起想）；
   T2-4 `refreshActive` 全盤重繪（無 profiling 證據前不動）。editor.js 續拆核心模組為選配。**

> **觀察（非 bug，已定案）**：`compute_move_info` 不強制輪次——紅方該走時丟黑子著法仍回
> `ok:true side:black`（輪次由 UI 控管）。**主人裁示（2026-06-22）：後端先不擋**，維持現狀；
> 契約如實記錄於 `tests/test_routes.py`（`black-piece move accepted, side==black`）。日後若改
> 要後端擋，該測試會反轉、並升為新項目。

> **不裸改原則**：T1-3 動的是載重 FEN 耦合（一漂移 eval 命中率歸零），T1-2 動三條 live
> SSE 路徑——兩者都等 T3-1 安全網落地後再動，不在無測試下硬改。

---

## 未完成事項（需另開 session 執行）

> **進度線（2026-06-22）**：✅ Tier 1 全完（T1-1/T1-2/T1-3）、✅ T3-1 安全網（route 25 +
> smoke 8）。以下為剩餘工作，附 resume context，新 session 照此接手即可。
> **動手前先跑基準**：`tests\test_routes.py` + `tests\test_smoke_ui.py`（都應全綠）；每改一步
> 重跑，當回歸網。

### 0. ~~先做：手動驗證（非程式碼）~~ ✅ 已用自動測試取代（2026-06-22）
- **引擎 / auto-play / demo 的 SSE 串流**：原本只能手動驗（smoke 沙盒無引擎）。改成
  `tests/test_engine_sse.py`——用**真引擎**端到端驗 `/api/engine/analyze`（SSE：逐層 info
  ＋末 `done.bestmove`）與 `/api/engine/analyze-line`（NDJSON：逐局面 cp/best，含 depth2→cp2）。
  三條前端串流（引擎分頁、🤖AI走棋走 `movetime`、演示→延伸走 depth）都經這兩支端點，故此測
  涵蓋。無引擎則 SKIP（CI 安全，同 smoke）。動 SSE 程式前先跑它當基準。

### T2 — 結構債（大工程，一次一個邊界，每步跑測試）
- ~~**T2-1 拆 `editor.js`（~4400 行）**~~ ✅ **DONE**（2026-06-22）：多 `<script>` 漸進抽出
  （主人裁示）。5 模組 editor-cdb/-engine/-autoplay/-aichart/-demo.js，同層 classic script、
  依序載入、共享全域 scope。editor.js ~4400→~2950。**逐一抽＋每步 smoke**（批次壞切教訓）。
  `EDITOR` 全域物件未拆（留與 T3-3 一起想）。剩餘可抽：tree-ops / eval-line / file-tree（核心，
  耦合較深，需更細心）——若續拆，沿用「逐一抽、每步重新定界、跑 smoke」。
- ~~**T2-2 拆 `app.py`（~1064 行）**~~ ✅ **DONE**（2026-06-22）：抽 `config.py`／`picker_service.py`／
  `engine_service.py`（兩支串流共用 `_spawn`/`_engine_fen`/`_shutdown`）。app.py 1064→564 薄路由。
  route+`test_engine_sse`+smoke 全綠。
- ~~**T2-3 DB 連線 singleton**~~ ✅ **DONE**（2026-06-22）：`backend/db_pool.py` 程序級連線池；
  `lookup_batch`／雲庫讀寫改用池，`db_info` 維持短命（驗證任意候選檔）。
- **T2-4 `refreshActive` 全盤重繪**：**無 profiling 證據前不提前優化**（保留觀察，非待辦）。
- ~~**T2-5 `fetchCdb` 共用 + 回填快取**~~ ✅ **DONE**（2026-06-22）：抽
  `fetchCdb`/`parseCdbResponse`/`cacheCdb`；`deriveCdbLine` 回填 `evalsByFen`（迴圈未合併）。

### T3 — 其餘風險缺口
- ~~**T3-2 trap 門檻單一來源**~~ ✅ **DONE**（2026-06-22）：`eval_service.TRAP_THRESHOLDS`
  唯一來源，`GET /api/eval/thresholds` 吐值、前端 `fetchThresholds`，`test_trap_spotcheck`
  改 import。（仍需與 `render_site.py` 對齊，但 repo 內只剩這一份。）
- **T3-3 `board.js` `window.POSITIONS` 解耦**：測試/抽模組前置阻力，與 T2-1 一起想。
- ~~**T3-4 monkeypatch `is_checking` 全域窗口**~~ ✅ **DONE**（2026-06-22）：thread-local 旗標
  `_suppress_check` 閘控，跨執行緒不洩漏；移除 `_parse_lock`。round-trip 逐字節相同。
- ~~**T3-5 引擎 SSE per-request 逾時**~~ ✅ **DONE**（2026-06-22）：`engine_service._start_stall_watchdog`
  守護執行緒，30s 無輸出即 kill（stall 而非時長上限，`go infinite` 不誤殺）。

### 收尾後的清理（週期結束才做）
- 整個優化做完後，刪掉本次的協作鷹架：`docs/CODEX_REVIEW_HANDOFF.md`、
  `docs/CODEX_REVIEW_FEEDBACK.md`，並視情況決定本 backlog 去留（見記憶 cleanup 原則）。
