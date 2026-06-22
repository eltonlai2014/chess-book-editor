# Handoff：請 Codex 協助系統 Review

> 收件者：Codex（對本 repo 不熟悉的 reviewer）。
> 目的：獨立 review 這個編輯器的架構與程式碼，找出值得優化／有風險的地方。
> **你的產出只准寫進一個檔案**：[CODEX_REVIEW_FEEDBACK.md](CODEX_REVIEW_FEEDBACK.md)
> （格式見該檔骨架）。**不要改動任何程式碼**，這是 review-only 任務。

---

## 0. 鐵律（先讀，違反會出事）

1. **Review-only。** 除了 `docs/CODEX_REVIEW_FEEDBACK.md`，不要新增/修改/刪除任何
   檔案。不要跑會寫檔的指令。
2. **`positions.db` 與兄弟 repo 的資料是唯讀的。** 本 repo 以 `?mode=ro` 開
   `positions.db`，永不寫入；也不要碰 `../chess-book-ai/` 的任何檔案。
3. **不要 `pip install --upgrade cchess`。** cchess 版本是 per-venv 釘死的（vendored
   wheel），升級會弄壞兄弟 repo。
4. **chessdb.cn 有禮貌規則（~5 req/s）。** 不要寫任何會對 chessdb.cn 連發請求的
   驗證程式。純讀碼即可。

---

## 1. 這是什麼系統（一句話）

瀏覽器版象棋打譜編輯器：讀寫 XQF 與象棋橋 CBL/CBR 棋譜，做深度引擎分析、評估、註解。
後端 Flask（檔案存取 + 即時引擎 SSE），前端純 vanilla JS（無打包工具）。本機單人工具，
非雲端多人。

與兄弟 repo `../chess-book-ai/` 的分工：那邊是**廣度**（批次掃整個棋庫找問題點，產靜態
網站），這邊是**深度**（鑽一個局面：輸入 + 深析 + 註解）。兩邊共用唯讀資料
`positions.db`（評估快取）。

## 2. 怎麼跑、怎麼驗證（不需要你跑，但要知道）

```powershell
.\setup.ps1                 # 一次性：建 .venv、裝 requirements（cchess 用 vendored wheel）
.\run-dev.ps1               # 跑編輯器，開 http://127.0.0.1:5174/
.\.venv\Scripts\python.exe tests\test_roundtrip.py     # 持久層正確性錨點
.\.venv\Scripts\python.exe tests\test_cb_roundtrip.py  # CBL/CBR 存檔身分保真
```

唯一的自動化安全網就是這兩個 round-trip 測試（持久層）。**沒有任何前端測試、沒有任何
Flask route 測試**——這本身就是一個風險點（已記在 backlog T3-1，請你獨立評估嚴重度）。

## 3. 必讀文件（依序）

1. [ARCHITECTURE.md](../ARCHITECTURE.md) — 系統功能 → 程式碼 `file:line` 對照表，先在這
   定位。
2. [../CLAUDE.md](../CLAUDE.md) — 「為什麼」與陷阱（read-only DB、FEN 格式耦合、CBL
   byte-splice、monkeypatch、threshold 同步…）。**陷阱幾乎都寫在這**。
3. [docs/DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) — 配色/字型/設計 token（若你看 CSS）。
4. [docs/CHESSDB_CLOUD_QUERY.md](CHESSDB_CLOUD_QUERY.md) — chessdb 雲庫查詢設計。
5. [docs/OPTIMIZATION_BACKLOG.md](OPTIMIZATION_BACKLOG.md) — **我（Claude）已做的盤點**。
   請對照它：哪些你同意、哪些你認為被高估/低估、哪些我漏了。

## 4. 程式碼地圖（從哪看起）

| 檔案 | 行數 | 看什麼 |
|---|---|---|
| `frontend/assets/editor.js` | ~4372 | 整個前端。全域 `EDITOR` 物件（檔頭附近）、`refreshActive`（導覽/重繪）、三支 SSE（`startAnalysis`/`requestBestMove`/`requestDemoPv`）、demo（`openDemo`/`demoAdd`/`addPvLine`）、chessdb（`ensureCdbLive`/`deriveCdbLine`）、auto-play |
| `backend/app.py` | ~1064 | Flask 路由 + 路徑解析（frozen/source 分流）+ tkinter picker subprocess + 兩支引擎 SSE generator |
| `backend/xqf_service.py` | ~574 | XQF 讀寫；`fast_parse_book` 全域 monkeypatch（檔尾附近） |
| `backend/cb_service.py` | ~410 | CBL/CBR；`save_cbl_game` 的 4096-byte slot byte-splice 存檔 |
| `backend/chessdb_service.py` | ~191 | 雲庫三層快取（positions.db → 自家寫快取 → live chessdb.cn） |
| `backend/eval_service.py` | ~116 | 唯讀 positions.db 評估查詢 |
| `vendor/io_xqf_patched.py` | ~185 | `PatchedXQFWriter`：修 upstream cchess writer 三個 bug（docstring 有說明） |
| `frontend/assets/board.js` | ~1722 | 盤面繪製，自 chess-book-ai 複製、刻意接受漂移 |

## 5. 已知的耦合 / 脆弱點（你 review 時請特別查證或反駁）

- **FEN 格式必須是 `<board> <w|b>`**（無 move counter）。前後端多處 serialiser 一漂移，
  eval 命中率就掉到 ~0%。
- **trap/brilliant 門檻常數**在 editor.js 與 `chess-book-ai/site_builder/render_site.py`
  兩邊手抄，必須一致。
- **`fast_parse_book`** 用全域 monkeypatch 關掉 cchess 的 per-move 將軍/將死計算來加速
  parse；用鎖序列化。在 `threaded=True` 下，patch 生效的窗口內其他執行緒的真實
  `is_checking` 會被影響——請評估這個跨執行緒窗口的實際風險。
- **CBL 存檔走 byte-splice**（只覆寫被改那局的 4096-byte slot），保 GUID + 其他局
  byte-identical；只有撐破 slot 才 fallback 全寫。

## 6. 我要你做什麼

1. 讀完上面文件 + 程式碼地圖。
2. **獨立**找出值得優化／有風險的點（架構、效能、健壯性、可維護性、正確性）。不要只
   附和我的 backlog——我更想要你找到我漏的，或對我高估/低估的判斷提出反證。
3. 每個發現給：**檔案:行號證據 + 嚴重度 + 為何重要(1 行) + 修法方向(1 行，不要實作)**。
4. 對 backlog（OPTIMIZATION_BACKLOG.md）逐項表態：同意 / 不同意 + 理由。
5. **把以上全部寫進** [CODEX_REVIEW_FEEDBACK.md](CODEX_REVIEW_FEEDBACK.md)，照該檔骨架
   的格式。不要寫到別的檔案、不要改程式碼。

## 7. 風格

- 繁體中文為主、技術詞英文即可（對齊本 repo 既有文件）。
- 終結要 file:line 證據，不要泛論。寧可少而準。
- 對引擎輸出 / 效能宣稱要嚴謹：別把「有 `finally` 收尾的子行程」說成洩漏。先看碼再下
  結論。
