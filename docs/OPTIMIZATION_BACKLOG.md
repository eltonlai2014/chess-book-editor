# 系統優化盤點（Optimization Backlog）

> 盤點日：2026-06-22。本檔是 **living backlog**，不是一次性快照——做掉一項就把
> 狀態改掉、留 commit 連結；新發現就往對應 Tier 追加。
> **行號／行數為盤點當下參考，動手前一律以實際檔案為準**（這份 repo 變動快）。
> 對照導覽請讀 [ARCHITECTURE.md](../ARCHITECTURE.md)；陷阱與「為什麼」讀
> [../CLAUDE.md](../CLAUDE.md)。

## 規模現況（god-file 一覽）

| 檔案 | 行數(盤點日) | 角色 |
|---|---|---|
| `frontend/assets/editor.js` | ~4372 | 整個編輯器前端（單檔） |
| `frontend/assets/editor.css` | ~3048 | UI 樣式（唯一被 index.html 載入的） |
| `backend/app.py` | ~564 | Flask **薄路由**（T2-2 已拆出 `config.py`/`picker_service.py`/`engine_service.py`） |
| `frontend/assets/board.js` | ~1722 | 盤面繪製（自 chess-book-ai 複製，接受漂移） |
| ~~`frontend/assets/style.css`~~ | ~~1589~~ | **已刪除**（死碼，T1-1，2026-06-22） |
| `backend/xqf_service.py` | ~574 | XQF 讀寫、`fast_parse_book` monkeypatch |
| `backend/cb_service.py` | ~410 | CBL/CBR 讀寫、byte-splice 存檔 |

---

## 查證後的修正（把被誇大的 agent 判斷降級，避免當事實）

- **引擎 SSE「殭屍子行程」→ 誇大。** [app.py:868-876](../backend/app.py#L868)、
  [app.py:959-965](../backend/app.py#L959) 都有 `finally: proc.kill()`，client
  斷線（GeneratorExit）會收掉 pikafish。真正缺的只是 **per-request 逾時**（卡住的
  搜尋會跑到 depth 完才停）；影響小，列 T3 末。
- **annote 每鍵 commit「100 次 mutation」→ 正確但無感**；debounce 只是清爽，非效能
  問題。不排程。
- **monkeypatch race → 真實但機率低。** `fast_parse_book` 的鎖確實涵蓋整個 parse
  （[xqf_service.py:515](../backend/xqf_service.py#L515)），併發 parse 不交錯；但
  `is_checking` 是**全域** patch，A 執行緒 parse 的那 ~3 秒內，B 分頁的走子合法性
  檢查會看到被改成 `False` 的版本（`threaded=True`，
  [app.py:1064](../backend/app.py#L1064)）。窗口窄、難重現，列 T3。

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
| T2-1 | **拆 `editor.js` god-file** | ~4372 行單檔 + `EDITOR` 48 欄全域物件（[editor.js:15](../frontend/assets/editor.js#L15)） | 切 demo / engine / chessdb / auto-play / tree-ops 模組。**取捨**：純 vanilla、無打包工具，拆 ES module 要先定載入方式 | TODO |
| T2-2 | **拆 `app.py` god-module** | ~1064 行混路由 + 路徑解析 + picker + 兩支 SSE | ✅ 抽 `config.py`（路徑/prefs/DEFAULT_*）、`picker_service.py`（tkinter 對話框）、`engine_service.py`（Pikafish 子行程＋UCI 解析＋兩支串流，共用 `_spawn`/`_engine_fen`/`_shutdown`）。app.py 1064→564，只剩薄路由。route+SSE+smoke 全綠（smoke isolation seam 改 patch `config`） | **DONE**（2026-06-22） |
| T2-3 | **DB 連線 per-request churn** | `eval_service`（read-only positions.db）、`chessdb_service` 每次查詢開新連線 | ✅ `backend/db_pool.py`：程序級連線池（`get_ro`/`get_rw`，path-keyed、序列化、不 close）。`lookup_batch`＋雲庫 `_read_positions_db`/`_ensure_cache` 改用池；`db_info` 仍短命（要驗證任意候選檔）。route + eval-integration + trap-spotcheck 全綠 | **DONE**（2026-06-22） |
| T2-4 | **導覽時全樹走訪 + 全盤重繪** | `refreshActive`（[editor.js:1895](../frontend/assets/editor.js#L1895)）每次重畫整個 SVG + 重裝 overlay | `path→fen` 快取 + 箭頭層增量更新。**取捨**：小檔無感、無 profiling 證據前不提前優化（codex 亦持此見）；只有大棋譜/深樹才值得 | TODO |
| T2-5 | **`deriveCdbLine` 與 `fetchCdbLive` 各自解析 `/api/chessdb`** | `fetchCdbLive`（[editor.js:1405](../frontend/assets/editor.js#L1405)）cache-first＋寫回 `evalsByFen`＋stale 保護；`deriveCdbLine`（[editor.js:1621](../frontend/assets/editor.js#L1621)）自組 fetch 迴圈、**不讀不寫**快取 | 抽共用 `fetchCdb()/parseCdbResponse()`、並讓演繹**回填 `evalsByFen` 快取**（演繹過的局面導覽時免重查）。**注意**：那條獨立節流迴圈是 CLAUDE.md 授權的「唯一多次查詢」，**刻意分流、非 bug**——只收斂 response 解析與快取共用，別合併迴圈 | TODO（codex NEW-1，已查證降級） |

## Tier 3｜風險缺口（不是效能，是安全網）

| ID | 項目 | 證據 | 修法方向 | 狀態 |
|---|---|---|---|---|
| T3-1a | **route 契約測試** | 原本唯一安全網是 persistence round-trip；SSE/chessdb/route 全裸奔 | ✅ `tests/test_routes.py`：Flask `test_client`，25 checks 覆蓋 `/api/xqf/move-info`、`/api/eval/batch`、`/api/chessdb`（含 400/500/降級契約）。網路 seam `query_chessdb` + DB seam monkeypatch，**不碰 chessdb.cn、不依賴 positions.db** | **DONE**（2026-06-22） |
| T3-1b | **瀏覽器煙霧測試** | route 已覆蓋，但前端 state machine / UI 流程仍無測試 | ✅ `tests/test_smoke_ui.py`（+ `tests/_smoke_server.py` 隔離 launcher）：Chromium 跑「boot→開檔→盤面→導覽→改 annote→存→**重載驗證落地**」。隔離沙盒（暫存 prefs/庫/cache，stub `query_chessdb`），**不碰真實設定、不打網路**；缺 Playwright/Chromium/sample 則 SKIP（CI 安全）。零生產碼改動（launcher 覆寫模組全域） | **DONE**（2026-06-22） |
| T3-2 | **trap 門檻常數與 chess-book-ai 手抄同步** | editor.js 的 `SKIP_OPENING_PLIES`/`TRAP_*`/`BRILLIANT_*` 必須與 `chess-book-ai/site_builder/render_site.py` 一致 | ✅ `eval_service.TRAP_THRESHOLDS` 為唯一來源；`GET /api/eval/thresholds` 吐值，前端 `fetchThresholds`（boot batch，consts 降級為 fallback mirror），`test_trap_spotcheck` 改 import。repo 內 3 份手抄→1 份（仍需對 render_site.py，但只剩一處）。route 測試＋trap spotcheck（同結果）全綠 | **DONE**（2026-06-22） |
| T3-3 | **board.js ↔ editor.js 全域耦合** | board.js 讀 `window.POSITIONS` 等全域（[board.js:111](../frontend/assets/board.js#L111)） | **主要成本是測試/抽模組的前置阻力**（要測 board.js 得先 mock 全域），其次才是與兄弟 repo 漂移（codex 重定性）。擋住 `xiangqi-board-lib` 抽取 TODO；非急 | TODO |
| T3-4 | **monkeypatch `is_checking` 全域窗口** | 見上「查證後的修正」 | 改 `contextvars` / 傳旗標，而非全域 patch class method；機率低、可延後 | TODO |
| T3-5 | **引擎 SSE 無 per-request 逾時** | `finally: proc.kill()` 已有；缺的是上限 | 加 watchdog：最後一次 yield 後 N 秒未進展即 kill | TODO |

---

## 建議下手順序（codex 亦背書此序）

1. ~~刪 style.css 死碼~~ ✅ **T1-1 已做**。
2. ~~鋪 route 契約測試~~ ✅ **T3-1a 已做**（`tests/test_routes.py`，25 checks 全綠）。
3. ~~Playwright 煙霧測試~~ ✅ **T3-1b 已做**（`tests/test_smoke_ui.py`，8 checks 全綠）。
4. ~~T1-2 SSE helper~~ ✅、~~T1-3 FEN side 收斂~~ ✅（安全網就位後做，smoke+routes 全綠）。
5. ~~T2-3 連線池~~ ✅、~~T2-2 拆 app.py~~ ✅、~~引擎 SSE 自動測試（取代手動驗證）~~ ✅（2026-06-22）。
6. **NEXT → T2-1 拆 editor.js（需先定載入方式）、T2-5（fetchCdb 共用＋回填）、其餘 T3。**

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
- **T2-1 拆 `editor.js`（~4400 行單檔 + `EDITOR` 48 欄全域）**：建議模組邊界——
  board-render / tree-ops / engine-SSE（`openAnalyzeStream`+`startAnalysis`…）/ chessdb
  （`ensureCdbLive`/`deriveCdbLine`）/ auto-play / demo / eval-line。**先決定載入方式**：多
  `<script>` 依序載入（沿用現狀、零建置）vs 改 `type=module` ESM。取捨：純 vanilla、無打包工具。
- ~~**T2-2 拆 `app.py`（~1064 行）**~~ ✅ **DONE**（2026-06-22）：抽 `config.py`／`picker_service.py`／
  `engine_service.py`（兩支串流共用 `_spawn`/`_engine_fen`/`_shutdown`）。app.py 1064→564 薄路由。
  route+`test_engine_sse`+smoke 全綠。
- ~~**T2-3 DB 連線 singleton**~~ ✅ **DONE**（2026-06-22）：`backend/db_pool.py` 程序級連線池；
  `lookup_batch`／雲庫讀寫改用池，`db_info` 維持短命（驗證任意候選檔）。
- **T2-4 `refreshActive` 全盤重繪**：**無 profiling 證據前不提前優化**（保留觀察，非待辦）。
- **T2-5 `fetchCdb` 共用 + 回填快取**：`deriveCdbLine` 與 `fetchCdbLive` 各自解析
  `/api/chessdb`；抽共用 `fetchCdb()/parseCdbResponse()` 並讓演繹**回填 `evalsByFen`**。
  **注意**：那條獨立節流迴圈是 CLAUDE.md 授權的「唯一多次查詢」，刻意分流——只收斂 response
  解析與快取共用，**別合併迴圈**。

### T3 — 其餘風險缺口
- ~~**T3-2 trap 門檻單一來源**~~ ✅ **DONE**（2026-06-22）：`eval_service.TRAP_THRESHOLDS`
  唯一來源，`GET /api/eval/thresholds` 吐值、前端 `fetchThresholds`，`test_trap_spotcheck`
  改 import。（仍需與 `render_site.py` 對齊，但 repo 內只剩這一份。）
- **T3-3 `board.js` `window.POSITIONS` 解耦**：測試/抽模組前置阻力，與 T2-1 一起想。
- **T3-4 monkeypatch `is_checking` 全域窗口**：改 `contextvars`/傳旗標。機率低、可最後。
- **T3-5 引擎 SSE per-request 逾時**：`finally:proc.kill()` 已有，加 watchdog（末次 yield 後 N
  秒無進展即 kill）。

### 收尾後的清理（週期結束才做）
- 整個優化做完後，刪掉本次的協作鷹架：`docs/CODEX_REVIEW_HANDOFF.md`、
  `docs/CODEX_REVIEW_FEEDBACK.md`，並視情況決定本 backlog 去留（見記憶 cleanup 原則）。
