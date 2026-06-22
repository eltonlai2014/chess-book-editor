# CODEX Review Feedback

## 結論摘要

- 我同意 handoff / backlog 的主軸：這個專案目前最大的風險不是持久層，而是**前端與 Flask API 缺乏自動化安全網**。XQF / CBL round-trip 測試很重要，但它們只保護檔案格式與存檔保真，保護不到 SSE、雲庫查詢、UI 狀態同步與 route contract。
- 我也同意 `editor.js` 與 `app.py` 都已經是明顯的 god-file / god-module；不過在**補最小測試骨架之前**，我不建議先做大拆檔。
- 我另外想提高一個嚴重度：目前多支 API 沒有一致的 FEN 正規化/驗證邊界，前後端又依賴「`<board> <w|b>`」這個縮寫格式。這不是純可維護性問題，而是**跨模組靜默漂移風險**。

---

## 我同意且會維持的項目

### 1. T3-1 應該排最高優先級

- 證據：repo 內找不到 Flask route test / browser test / frontend unit test；現有測試幾乎都在持久層。見 `backend/app.py:5`, `backend/app.py:17`, `frontend/assets/editor.js:733`, `frontend/assets/editor.js:1154`, `frontend/assets/editor.js:1413`。
- 影響：`/api/eval/batch`、`/api/chessdb`、`/api/xqf/move-info(-batch)`、三支 EventSource 與前端 state machine 一旦漂移，現在幾乎沒有 automated signal 會第一時間抓到。
- 判斷：這是目前**最值得先補**的缺口，我同意 backlog 把它列為最高優先的結構風險。

### 2. `editor.js` / `app.py` 確實過大

- `frontend/assets/editor.js:15` 定義單一全域 `EDITOR` 狀態物件，之後承載檔案樹、棋譜、雲庫、引擎、demo、自動播放、偏好設定等多個子系統。
- `backend/app.py:5` 起手就宣告大量 route，並同時承擔設定解析、檔案根目錄、preferences、native picker、eval/chessdb、引擎 SSE。
- 判斷：這兩個檔案的問題不是「長而已」，而是**跨責任共享隱性狀態太多**，使局部修改成本偏高。

### 3. `fast_parse_book` 全域 monkeypatch 的風險是真實存在

- 證據：`backend/xqf_service.py:513` 到 `backend/xqf_service.py:521` 直接替換 `ChessBoard.is_checking`，而 `backend/app.py:1064` 以 `threaded=True` 啟動 Flask。
- 判斷：我同意「機率低但為真」這個評級。這不是理論上的假問題；只是窗口短、通常只在 parse 期間出現，因此比較像 correctness edge case，不像 P0 bug。

### 4. `style.css` 死碼判定成立

- 證據：`frontend/index.html:8` 只載入 `/assets/editor.css?v=39`；repo 搜尋沒有其他地方引用 `style.css`。
- 判斷：這是安全、低風險的倉庫衛生修整，適合和其他 Tier 1 一起清。

---

## 我想上調嚴重度 / 補充的新風險

### A. FEN contract 漂移風險比 backlog 描述更值得重視

- 證據 1：前端多處直接用字串切 side，例如 `frontend/assets/editor.js:1653`、`backend/app.py:820`, `backend/app.py:904` 都是以 `split()` 取第 2 欄處理。
- 證據 2：`frontend/assets/board.js:107` 產出的 FEN 只有 `<board> <side>`；而引擎路由又在 `backend/app.py:821`、`backend/app.py:907` 自行補成 6 欄給 Pikafish。
- 證據 3：`frontend/assets/board.js:44` 已有 `parseFen(fen)`；但 contract 並沒有集中成單一 shared helper / validator。
- 風險：只要某一端開始容忍第三欄以後的欄位、trim 規則變動、或 side 缺失 fallback 不一致，就可能出現「功能還能跑，但 eval/cdb 命中率靜默下降」這種難追錯誤。
- 建議：這應該至少跟 backlog 的 T1-3 同級，甚至可視為 **T1 最高價值的小修**：先把 side 解析/正規化集中，避免 contract 分散在前後端字串操作中。

### B. `deriveCdbLine()` 繞過前端既有 cache / 節流層，造成行為分叉

- 證據：一般雲庫查詢走 `ensureCdbLive()`（`frontend/assets/editor.js:1375`），會把結果寫入 `EDITOR.evalsByFen[fen].cdb` 並帶有 stale-response 保護；但 `deriveCdbLine()`（`frontend/assets/editor.js:1621`）直接 `fetch('/api/chessdb?...')`，自己組一條平行流程。
- 風險：同一個 `/api/chessdb` contract，卻有兩套前端使用方式：一套走共享狀態/錯誤處理，一套直接 loop fetch。之後若 `/api/chessdb` response shape 或 fresh/retry 行為微調，這裡更容易漏改。
- 判斷：這不一定要立刻抽象化，但它是**已經出現的 duplicated client protocol**，值得列進 Tier 2 或 T3。

### C. 全域 `window.POSITIONS` 耦合不只是一個 TODO，而是測試阻力來源

- 證據：`frontend/assets/board.js:111` 直接讀 `window.POSITIONS`。這讓 board rendering 對外部全域資料結構有隱含依賴。
- 影響：任何想把 `board.js` 抽出來測、或單獨在別的頁面重用的人，都得先模擬 global namespace；這會放大未來 T3-1 / T2-1 的測試與模組化成本。
- 判斷：我同意 backlog 的 T3-3，但我會把它表述成「**測試與抽模組的前置阻力**」，不只是與兄弟 repo 漂移。

### D. EventSource 三份實作重複，風險不只是可讀性

- 證據：`frontend/assets/editor.js:2817`、`frontend/assets/editor.js:2897`、`frontend/assets/editor.js:3662` 三處各自 new `EventSource(...)`。
- 風險：這三支流的生命週期管理、錯誤處理、close 時機、message parsing 各自維護。當某支 SSE route 改成新欄位或遇到瀏覽器 edge case 時，很容易只修一份。
- 判斷：我同意 backlog 的 T1-2，而且覺得這是「低風險又真的能降低未來 bug surface」的修整，不只是 style cleanup。

---

## 我想下調或修正表述的項目

### 1. DB per-request churn 值得做，但不應高估

- 證據：`backend/eval_service.py` 與 `backend/chessdb_service.py` 的確都會開 SQLite 連線；但這裡用法偏 read-only、查詢短、資料庫又是本機路徑。
- 判斷：我同意這是可改善點，但它比較像**平順度優化 / 程式潔淨度**，不像眼前已造成明顯效能瓶頸。若工程時間有限，仍應落後於 T3-1、T1-2、T1-3。

### 2. `refreshActive()` 全樹重繪是可理解的 tradeoff

- 證據：`frontend/assets/editor.js:1895` 之後集中處理目前局面、盤面、eval line、雲庫同步與導覽重繪。
- 判斷：這是典型「單頁小工具先求一致性」的寫法。它當然可能在超大樹上變慢，但在沒有 profiling 證據前，我不會把它上升成高優先級改造。

---

## 建議的實際排序

1. **先補最小測試骨架**：至少 Flask route test 覆蓋 `/api/eval/batch`、`/api/chessdb`、一條 `/api/xqf/move-info`。
2. **接著做兩個低風險收斂**：
   - 抽 SSE client helper
   - 集中 FEN side 解析 / normalize helper
3. **再處理倉庫衛生**：刪 `style.css` 死碼。
4. **最後才排大拆檔**：`editor.js` / `app.py` 拆分應建立在前述安全網之上。

---

## 一句話總評

這個專案最脆弱的地方不是 XQF/CBL 存檔，而是**多個互相耦合的前後端協議（FEN、SSE、chessdb response、全域狀態）缺乏測試保護**；先補 safety net，再談大規模整理，投報率最高。
