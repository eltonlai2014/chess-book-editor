# Agents for chess-book-editor

此檔列出可在專案中執行的「agents」（小型自動化角色），每個 agent 的職責與快速執行指令。

- **Repo Explorer**: 掃描專案檔案、產生檔案清單。
  - 主要參考: [README.md](README.md), [CLAUDE.md](CLAUDE.md)
  - 執行: 手動或用 `dir` / `ls`。

- **XQF Writer Agent**: 驗證與使用 `PatchedXQFWriter` 進行 XQF 儲存/round-trip 測試。
  - 主要參考: [vendor/io_xqf_patched.py](vendor/io_xqf_patched.py), [tests/test_roundtrip.py](tests/test_roundtrip.py)
  - 執行: 在 venv 中執行 `.\.venv\Scripts\python.exe tests\test_roundtrip.py`。

- **Sample Emitter**: 產生 XQStudio-驗證的範例輸出。
  - 主要參考: [tools/emit_sample.py](tools/emit_sample.py), [samples/](samples/)
  - 執行: `.\.venv\Scripts\python.exe tools\emit_sample.py`

- **Frontend Agent**: 準備前端資產與未來的編輯介面。
  - 主要參考: [frontend/assets/board.js](frontend/assets/board.js), [frontend/style.css](frontend/style.css)
  - 任務：從 `chess-book-ai` 複製 `assets/board.js` 與 `applyIccs` 實作進來。

- **Backend/Save API Agent**: 實作後端 API（Flask 或 FastAPI），提供 `POST /xqf/save`。
  - 設計參考: README 中的架構說明（`backend/` 計畫）
  - 任務：建立 `backend/`，新增簡單 `POST /xqf/save` 路由，使用 `PatchedXQFWriter` 寫入檔案。

- **Test Runner**: 自動化執行測試、檢查 round-trip 回歸。
  - 主要參考: [tests/test_roundtrip.py](tests/test_roundtrip.py)
  - 執行: `.\.venv\Scripts\python.exe -m pytest -q`（若安裝 pytest）或直接執行測試檔。

- **Dev Env Agent**: 建立虛擬環境並安裝 `cchess` 依賴。
  - 執行:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install "git+https://github.com/walker8088/cchess.git@master"
```

---

下一步建議：
- 如果要我幫忙，選一個 agent（例如 `XQF Writer Agent` 或 `Backend/Save API Agent`），我可進行實作或建立範例程式碼。