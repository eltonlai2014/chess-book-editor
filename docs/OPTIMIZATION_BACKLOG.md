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
| `backend/app.py` | ~1064 | Flask 路由 + 路徑解析 + picker + 兩支引擎 SSE |
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
| T1-2 | **抽共用 SSE helper** | 三處幾乎相同的 EventSource：`startAnalysis`、`requestBestMove`、`requestDemoPv`（[editor.js:3662](../frontend/assets/editor.js#L3662)） | 改一處錯誤要改三份；合成 `openAnalyze(url,{onInfo,onDone,onError})` | TODO（**先補 T3-1 再動**） |
| T1-3 | **集中 FEN 解析** | 多處 `fen.trim().split(/\s+/)[1]` 取走子方、無驗證；前端 [board.js:44](../frontend/assets/board.js#L44) **已有 `parseFen`**、[board.js:107](../frontend/assets/board.js#L107) 只吐 2 欄 | **收斂到既有 `parseFen` + 加 side normalize**（別另寫新 helper）；杜絕 `<board> <side>` 漂移時 eval/cdb 命中率靜默歸零。**FEN 是載重耦合，無測試前不裸改** | TODO（**先補 T3-1 再動**） |

## Tier 2｜結構債、值得排程（工程大但有感）

| ID | 項目 | 證據 | 修法方向 / 取捨 | 狀態 |
|---|---|---|---|---|
| T2-1 | **拆 `editor.js` god-file** | ~4372 行單檔 + `EDITOR` 48 欄全域物件（[editor.js:15](../frontend/assets/editor.js#L15)） | 切 demo / engine / chessdb / auto-play / tree-ops 模組。**取捨**：純 vanilla、無打包工具，拆 ES module 要先定載入方式 | TODO |
| T2-2 | **拆 `app.py` god-module** | ~1064 行混路由 + 路徑解析 + picker + 兩支 SSE | 抽 `engine_service`（兩支 SSE 合一）、`picker_service`、`config`（frozen/source 路徑） | TODO |
| T2-3 | **DB 連線 per-request churn** | `eval_service`（read-only positions.db）、`chessdb_service` 每次查詢開新連線 | 改 process-level singleton；read-only 庫無寫鎖問題、最划算 | TODO |
| T2-4 | **導覽時全樹走訪 + 全盤重繪** | `refreshActive`（[editor.js:1895](../frontend/assets/editor.js#L1895)）每次重畫整個 SVG + 重裝 overlay | `path→fen` 快取 + 箭頭層增量更新。**取捨**：小檔無感、無 profiling 證據前不提前優化（codex 亦持此見）；只有大棋譜/深樹才值得 | TODO |
| T2-5 | **`deriveCdbLine` 與 `fetchCdbLive` 各自解析 `/api/chessdb`** | `fetchCdbLive`（[editor.js:1405](../frontend/assets/editor.js#L1405)）cache-first＋寫回 `evalsByFen`＋stale 保護；`deriveCdbLine`（[editor.js:1621](../frontend/assets/editor.js#L1621)）自組 fetch 迴圈、**不讀不寫**快取 | 抽共用 `fetchCdb()/parseCdbResponse()`、並讓演繹**回填 `evalsByFen` 快取**（演繹過的局面導覽時免重查）。**注意**：那條獨立節流迴圈是 CLAUDE.md 授權的「唯一多次查詢」，**刻意分流、非 bug**——只收斂 response 解析與快取共用，別合併迴圈 | TODO（codex NEW-1，已查證降級） |

## Tier 3｜風險缺口（不是效能，是安全網）

| ID | 項目 | 證據 | 修法方向 | 狀態 |
|---|---|---|---|---|
| T3-1 | **零前端 / 零 route 測試** | 唯一安全網是 persistence round-trip（`tests/test_roundtrip.py`、`test_cb_roundtrip.py`）；SSE 解析、chessdb 三層快取、cdbScope、UI 同步全裸奔 | 鋪最小骨架：`/api/chessdb`（mock）+ `/api/eval/batch` + 一條 `/api/xqf/move-info` route test，一條 Playwright 煙霧測試（開檔→導覽→改 annote→存→重載）。**Playwright 已在 `.venv`**（基建半就位）。**最大隱性風險、其他重構的前置** | **NEXT** |
| T3-2 | **trap 門檻常數與 chess-book-ai 手抄同步** | editor.js 的 `SKIP_OPENING_PLIES`/`TRAP_*`/`BRILLIANT_*` 必須與 `chess-book-ai/site_builder/render_site.py` 一致 | 後端 `/api/eval/thresholds` 吐單一來源，前端 fetch；杜絕對方一改就靜默漂移 | TODO |
| T3-3 | **board.js ↔ editor.js 全域耦合** | board.js 讀 `window.POSITIONS` 等全域（[board.js:111](../frontend/assets/board.js#L111)） | **主要成本是測試/抽模組的前置阻力**（要測 board.js 得先 mock 全域），其次才是與兄弟 repo 漂移（codex 重定性）。擋住 `xiangqi-board-lib` 抽取 TODO；非急 | TODO |
| T3-4 | **monkeypatch `is_checking` 全域窗口** | 見上「查證後的修正」 | 改 `contextvars` / 傳旗標，而非全域 patch class method；機率低、可延後 | TODO |
| T3-5 | **引擎 SSE 無 per-request 逾時** | `finally: proc.kill()` 已有；缺的是上限 | 加 watchdog：最後一次 yield 後 N 秒未進展即 kill | TODO |

---

## 建議下手順序（codex 亦背書此序）

1. ~~刪 style.css 死碼~~ ✅ **T1-1 已做**（零行為改變，先清掉的小 commit）。
2. **鋪 T3-1 最小測試骨架（= NEXT）**——目前所有結構債之所以「能忍」，正是因為改動沒
   東西接得住。先 Flask route test（`/api/chessdb` mock、`/api/eval/batch`、一條
   `/api/xqf/move-info`）+ 一條 Playwright 煙霧測試。**這是 T1-2/T1-3 與所有拆檔的前置**。
3. **有測試後**再做 T1-2（SSE helper）、T1-3（FEN normalize，收斂到 `parseFen`）。
4. T2 拆檔（editor.js / app.py）、其餘 T3 視時間排程。

> **不裸改原則**：T1-3 動的是載重 FEN 耦合（一漂移 eval 命中率歸零），T1-2 動三條 live
> SSE 路徑——兩者都等 T3-1 安全網落地後再動，不在無測試下硬改。
