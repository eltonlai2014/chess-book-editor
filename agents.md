# Agent setup brief — chess-book-editor

新機器上的 AI agent（Codex / Claude / 任何 LLM coding tool）讀這份文件就能把這個專案跑起來。
全文以執行步驟為主，先環境後驗證後說明。深入背景請看 [README.md](README.md) 與
[CLAUDE.md](CLAUDE.md)；功能 → 程式碼 `file:line` 對照見 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 專案是什麼

瀏覽器內運作的 XQF（中國象棋對局檔）編輯器：點開 `.XQF` → 看盤 / 走法 / 變例 / 註解 → 改 → 存回 `.XQF`。
姊妹專案是 [chess-book-ai](../chess-book-ai/)（分析引擎 + 靜態網站），本專案專注**作者編輯端**。

- **後端**：Flask 127.0.0.1:5174，純本機工具，無 auth
- **前端**：原生 JS（無框架），`board.js` 從 chess-book-ai 移植
- **格式支援**：XQF 雙向 round-trip 已驗證；CBR/CBL（CCBridge3）讀寫已接進編輯器 UI（列表／開啟／編輯／存回），另有批量轉換 CLI；CWP 可單向轉入

## 前置需求

| 項目 | 版本 | 為什麼 |
|---|---|---|
| **Python** | 3.10+ | 程式碼用 PEP-604 unions（如 `int | None`）+ `from __future__ import annotations` |
| **Git** | 選用 | 只在重建 cchess wheel 時需要；一般安裝走 `vendor/wheels/` 本地 wheel |
| **tkinter** | Python 標配 | 原生資料夾選擇對話框（library root picker）|
| **瀏覽器** | Chrome / Edge | 已測試 |

新機器健檢：

```powershell
python --version       # 3.10.x 或更新
python -c "import tkinter; print(tkinter.TkVersion)"
```

## 安裝步驟

```powershell
# 在 repo 根目錄——一鍵：建 .venv、裝相依、由範本產生 preferences.json
.\setup.ps1
```

手動等效：

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

`requirements.txt` 釘死每個相依。**cchess 從 `vendor/wheels/` 的內附 wheel 安裝、
不從 GitHub 拉**——全新安裝免連網路、不怕上游 repo 消失。cchess 為 GPLv3。

> ⚠️ **不要 `pip install --upgrade cchess` 到全域 Python**。
> 姊妹專案 chess-book-ai 鎖在舊版 cchess（用 `from cchess import read_from_xqf`），
> 新版把這個 import 從 `__init__.py` 拿掉了；本 repo 用新版（`io_xqf`）＋patched
> writer。兩 repo 各用自己 `.venv`，模組路徑本身就不相容（`read_xqf` → `io_xqf`）。
> 升級本 repo 的 cchess＝重建 wheel 後跑 `test_roundtrip.py` 全綠才換（見 CLAUDE.md）。

## 驗證 / 跑測試

```powershell
# XQF round-trip：全庫每個 XQF 都不掉變例、不掉註解
.\.venv\Scripts\python.exe tests\test_roundtrip.py

# JSON round-trip：本 repo 的 JSON 中介格式無損
.\.venv\Scripts\python.exe tests\test_json_roundtrip.py

# Big5 recovery 啟發式（mojibake 還原）
.\.venv\Scripts\python.exe tests\test_big5_recovery.py

# XQF ↔ CBL 完整 pipeline，3 個真實 CCBridge3 corpora 共 376 局
.\.venv\Scripts\python.exe tests\test_cb_xqf_integration.py

# CBL offset bug fix smoke：對 1570 個 CBL 驗線性公式
.\.venv\Scripts\python.exe tests\test_cbl_smoke.py
```

測試裡寫死的路徑：

| 測試 | 路徑 |
|---|---|
| `test_roundtrip.py` | `D:\Elton\TestArea\chess-book\`（41 個 XQF）|
| `test_big5_recovery.py` | 同上 |
| `test_cbl_smoke.py` | `D:\Elton\CCBridge3\CBL\`（~1570 CBL）|
| `test_cb_xqf_integration.py` | 同上的 3 個指定 CBL |

新機器若沒這些 corpus，可以：
1. 從原機複製過來，或
2. 編輯各測試頂端的常數路徑，或
3. 只跑 `samples/xqf/` 與 `samples/cbl/` 內的小樣本（已 check-in）

## 跑編輯器

```powershell
# PowerShell 第一次擋 Activate.ps1 的話：
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
.\.venv\Scripts\Activate.ps1

# 啟動 Flask（同時 serve 前端）
.\.venv\Scripts\python.exe backend\app.py
```

瀏覽器開 <http://127.0.0.1:5174/>。

首次開啟會 fallback 到 `D:\Elton\TestArea\chess-book\`（hard-coded 在
[backend/app.py](backend/app.py) 的 `DEFAULT_XQF_ROOT`）。新機器上該路徑不存在時，
檔案窗格顯示 **📂 選擇棋譜根目錄** 提示（不報錯，`/api/xqf/list` 回 200 + `needsRoot`）。
UI 上 **📂** 按鈕可重新選資料夾，路徑存到 repo 根的 `preferences.json`。

> 除錯開 Werkzeug debugger：`$env:FLASK_DEBUG=1` 再啟動（預設關，避免互動式 RCE）。

## 目錄速查

```
backend/      Flask app（/api/xqf/{list,load,save,new,move-info,legal-targets,root,pick-root}, /api/preferences）
              + xqf_service.py 內含 Book ↔ JSON、Big5 recovery、create_xqf
frontend/     index.html + assets/{board.js, editor.js, editor.css}
              （原生 JS，無框架，無 build step）
tools/        CLI：cbl_to_xqf.py / xqf_to_cbl.py / cwp_to_xqf.py / emit_sample.py / dump_annotes.py
vendor/       io_xqf_patched.py（PatchedXQFWriter，三個 upstream bug 的修正）
              cchess_cbl.py + cbl_index_fix.py（CBR/CBL 讀取，補 cchess offset bug）
              io_cb_writer.py（CBR/CBL 寫入，CCBridge3 相容）
              io_cwp.py（CWP 讀取）
tests/        XQF / JSON / CBL / CWP / Big5 各種 round-trip + 單元測試
samples/      xqf/（XQStudio 開過 OK）+ cbl/（CCBridge3 開過 OK）
docs/         CHESSDB_CLOUD_QUERY.md（雲庫協定）+ DESIGN_SYSTEM.md（配色／設計系統）
```

## 常見操作

```powershell
# CBL → XQF（拆 library 成單檔）
.\.venv\Scripts\python.exe tools\cbl_to_xqf.py path\to\lib.cbl out_dir

# XQF → CBL（包成 CCBridge3 可開的 library）
.\.venv\Scripts\python.exe tools\xqf_to_cbl.py input_dir out.cbl --name "lib name"

# CWP → XQF（路徑寫死在 tools/cwp_to_xqf.py 頂端，要先改）
.\.venv\Scripts\python.exe tools\cwp_to_xqf.py
```

## 關鍵 gotchas（除錯時最常踩到）

1. **字串編碼**：
   - XQF 走 **GB18030**（cchess 預設讀 GB18030；upstream writer 用 GBK 會丟繁中字，PatchedXQFWriter 改成 GB18030）
   - CBL/CBR 走 **UTF-16-LE**（全 Unicode）
   - 主人手上的早期 XQF 是 **Big5** 寫入 → cchess 讀成 mojibake → `_maybe_recover_big5()` 用詞彙分數還原。詳見 [backend/xqf_service.py](backend/xqf_service.py)。

2. **`Move.variation_next` 不可靠**：cchess 的 `Move.append_next_move` 只更新 `variations_all`，不更新 `variation_next`。
   走子樹一律用 `move.next_move.variations_all`。詳見 PatchedXQFWriter docstring。

3. **`book.info['result']` 要顯式呼叫 `writer.set_result()`**：
   cchess writer `__init__` 把 result byte 寫死 0（未知），不會從 `book.info` 撿。
   [backend/xqf_service.py](backend/xqf_service.py) 的 `save_xqf` 已處理。

4. **author 欄位 = 14 GB18030 bytes max**：
   本 repo 寫的檔案蓋 `cb_editor` 標記（短得能塞進 15-byte 欄位），
   load 時看到此標記就跳過 Big5 recovery（已知是 GB18030）。

5. **CBR 的 GUID 連結**：寫 CBL 時 CBR header offset 19..35 的 binary GUID
   **必須**跟 index entry +0x14 的 UTF-16-LE GUID 字串對得上，否則 CCBridge 開不出。
   `vendor/io_cb_writer.py` 已封裝好，不要拆開呼叫。

## 給 agent 的第一動作建議

1. 跑健檢 + 安裝 + `test_roundtrip.py`，確認環境 OK
2. 啟動 `backend\app.py`，瀏覽器開 <http://127.0.0.1:5174/>，確認 UI 跑得起來
3. 想動程式碼前先讀 [ARCHITECTURE.md](ARCHITECTURE.md)（功能 → 程式碼 `file:line` 對照）與 [CLAUDE.md](CLAUDE.md)（陷阱與「為什麼」）
4. 主人偏好繁體中文、簡潔回答、最小改動。詳細風格見 [CLAUDE.md](CLAUDE.md) 末段。
