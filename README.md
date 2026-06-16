# chess-book-editor（梅友弈鑑）

瀏覽器內運作的 XQF（中國象棋對局檔）編輯器：開啟 `.XQF` → 看盤／走法／變例／註解
→ 編輯 → 存回 `.XQF`，並可叫本機 Pikafish 引擎做即時深算、查 chessdb.cn 雲庫。

姊妹專案 [chess-book-ai](../chess-book-ai/)（引擎批量分析 + 靜態網站）負責**廣度**
——掃整個棋庫找問題點；本專案負責**深度**——鑽研單一盤面（輸入＋深算＋註解）。
本工具**純本機使用**，非公開部署。

## 現況

編輯器已端到端可用：瀏覽棋庫 → 開 XQF → 導航走法／變例 → 編輯註解（含譜首引言）
→ 存回 XQF。走子樹編輯（新增／刪除走法、變例升降、賽事資訊）已上線。即時引擎分析、
AI 整條線走勢圖、雲庫即時查皆已接好。CBL/CBR（象棋橋）亦可直接在 UI 列表／開啟／編輯／存回。
功能 → 程式碼 `file:line` 對照見 [ARCHITECTURE.md](ARCHITECTURE.md)。

已驗證的持久層／格式工作：

- `vendor/io_xqf_patched.py` — 修正版 `cchess.io_xqf.XQFWriter`，全庫完美 round-trip，
  `samples/xqf/` 經 XQStudio 開啟驗證。保留變例、譜首引言、繁體中文（GB18030）。
- `vendor/cchess_cbl.py` + `vendor/cbl_index_fix.py` — CCBridge3 `.cbl` 讀取，
  透明修掉 cchess 的 offset bug（原本害 1570 個 CBL 中 18 個讀不出）。
- `vendor/io_cb_writer.py` — `.cbr` / `.cbl` 寫入，CCBridge3 開得乾淨
  （binary-GUID 連結、init-annote gate flag、library metadata slots 全處理好）。
- 早期 XQF 的 Big5 mojibake 還原，見 [backend/xqf_service.py](backend/xqf_service.py)。

## 目錄結構

```
backend/      Flask app（/api/xqf/{list,load,save,new,…}、/api/{eval,engine,chessdb}、/api/preferences）
frontend/     board.js + editor.js + editor.css（單頁原生 JS，無框架、無 build step）
tools/        CLI：cbl_to_xqf.py / xqf_to_cbl.py / cwp_to_xqf.py / emit_sample.py / dump_annotes.py
vendor/       io_xqf_patched + cchess_cbl + io_cb_writer + io_cwp + cbl_index_fix
              wheels/ — vendored cchess wheel（離線、不受上游 GitHub 影響的安裝來源）
tests/        XQF / JSON / CBL / CWP / Big5 各種 round-trip 與整合測試
samples/      xqf/（XQStudio 驗證）+ cbl/（CCBridge3 驗證）
docs/         CHESSDB_CLOUD_QUERY.md（雲庫協定）、DESIGN_SYSTEM.md（配色／設計系統）
```

## 安裝

### 前置需求

- **Python 3.10+**（本 venv 建於 3.10.10；程式碼用 PEP-604 unions（`int | None`）+
  `from __future__ import annotations`，3.10 以下不行）。請用
  [python.org Windows 安裝程式](https://www.python.org/downloads/windows/)，
  勾選「Add python.exe to PATH」並保留預設的「tcl/tk and IDLE」元件——
  原生資料夾／檔案選擇器用 **tkinter**，python.org 版內建，但某些精簡版會缺。
- **Git**（選用）——只在你要**重建 cchess wheel** 時才需要；一般安裝走
  `vendor/wheels/` 的本地 wheel，不必連 GitHub。
- **瀏覽器**——Chrome／Edge 已測，任何近代瀏覽器皆可。

新機器健檢：

```powershell
python --version              # 3.10.x 或更新
python -c "import tkinter; print(tkinter.TkVersion)"   # 應印出數字，非報錯
```

### 建立 venv ＋裝相依

```powershell
# 在 repo 根目錄——一鍵：建 .venv、裝相依、由範本產生 preferences.json
.\setup.ps1
```

手動等效步驟：

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

`requirements.txt` 釘死每個相依。**cchess 從 `vendor/wheels/` 的內附 wheel 安裝、
不從 GitHub 拉**——所以全新安裝不需連 GitHub，也不怕上游 repo 被刪或 force-push。
cchess 為 GPLv3；升級 wheel 的協議見 [CLAUDE.md](CLAUDE.md) 的 *Distribution* 段。

### 首次驗證

```powershell
# 對棋庫做 round-trip——不需外部語料即可 smoke 測（看 samples/）
.\.venv\Scripts\python.exe tests\test_roundtrip.py
```

應看到全數完美 round-trip（檔案數量視 `SRC_ROOT` 下有什麼而定，見下方*測試語料路徑*）。

### 測試語料路徑（寫死）

數個測試引用主人放在 `D:\` 的真實語料：

| 測試 | 路徑 | 備註 |
|---|---|---|
| `tests/test_roundtrip.py` | `D:\Elton\TestArea\chess-book\`（`SRC_ROOT`） | XQF 棋庫 |
| `tests/test_cbl_smoke.py` | `D:\Elton\CCBridge3\CBL\` | ~1570 個 CBL |
| `tests/test_cb_xqf_integration.py` | 同上的 3 個指定檔 | round-trip fixtures |
| `tests/test_big5_recovery.py` | `D:\Elton\TestArea\chess-book\` | mojibake 語料 |

新機器若沒這些路徑，三選一：
1. 把語料複製過來；或
2. 改各測試檔頂端的路徑常數，指向你有資料的地方；或
3. 跳過這些測試——repo 內的 `samples/xqf/` 與 `samples/cbl/` 足夠 smoke 測。

## 跑編輯器

```powershell
# PowerShell 第一次擋 Activate.ps1 的話：
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
.\.venv\Scripts\Activate.ps1

# 啟動 Flask 後端（同時 serve 前端）
.\.venv\Scripts\python.exe backend\app.py
```

然後瀏覽器開 <http://127.0.0.1:5174/>。

**開發期間建議用 `run-dev.ps1`**——它會先砍掉殘留的舊 server、釋放埠 5174，再起一隻
帶 `FLASK_DEBUG=1`（後端改檔自動重載）的乾淨進程：

```powershell
.\run-dev.ps1            # 自動重載
.\run-dev.ps1 -NoDebug   # 不要 reloader（單進程）
```

> 為何需要它：debug 關著時 Werkzeug 不會自動重啟，而 Windows 的 `SO_REUSEADDR`
> 讓你重跑 `app.py` 能 bind 同一埠卻搶不到連線——舊進程會默默賴著、繼續回應舊碼
> （改了後端卻「怎麼還在」就是這個）。`run-dev.ps1` 先清乾淨就不會這樣。
> 直接 `python backend\app.py` 仍可，但記得先確認沒有舊 server 還活著。

## 選擇棋譜庫

棋譜庫根目錄**從 UI 設定**，不寫死。在檔案窗格標題列點路徑旁的**資料夾**按鈕，
會跳出原生資料夾對話框；選含 `.XQF` 的目錄，檔案樹立即刷新。

選定的路徑存到 repo 根的 `preferences.json`（連同 splitter 尺寸、棋盤主題、上次開的檔）。
若尚未設根目錄，後端 fallback 到 `D:\Elton\TestArea\chess-book\`；新機器上該路徑不存在時，
檔案窗格會顯示 **選擇棋譜根目錄** 提示（不會報錯），讓你當場挑一個。要改起始預設，
改 [backend/app.py](backend/app.py) 的 `DEFAULT_XQF_ROOT`。

## 格式轉換

XQF、CBL/CBR（CCBridge3 棋庫）、CWP（CCBridge 單局純文字）互轉的 CLI。
已對真實 CCBridge 語料端到端 round-trip 驗證（見
[tests/test_cb_xqf_integration.py](tests/test_cb_xqf_integration.py)）。

### CBL → XQF（把棋庫拆成單局檔）

```powershell
# 單一棋庫
.\.venv\Scripts\python.exe tools\cbl_to_xqf.py path\to\lib.cbl out_dir

# 或整個目錄樹——一個子資料夾對一個 .cbl
.\.venv\Scripts\python.exe tools\cbl_to_xqf.py D:\Elton\CCBridge3\CBL out_dir
```

輸出佈局：`<out_dir>/<cbl_stem>/<NNN>-<sanitised_title>.xqf`。
註解編碼從 CBR 的 UTF-16-LE 轉成 XQF 的 GB18030（罕見非 GB 字會靜默丟棄）。

### XQF → CBL（包成 CCBridge3 可開的棋庫）

```powershell
# 單一 .xqf 或一整個 .xqf 目錄 → 一個 .cbl
.\.venv\Scripts\python.exe tools\xqf_to_cbl.py input_dir out.cbl --name "棋庫名稱"
```

`--name` 控制 CCBridge3 屬性面板顯示的棋庫名（預設取輸入目錄／檔名）。
writer 蓋 `creator = chess-book-editor` 與 `created_at`/`modified_at`，
並自動處理 CCBridge 格式陷阱（binary GUID 連結、init-annote gate flag、metadata slots）。

### CWP → XQF

```powershell
.\.venv\Scripts\python.exe tools\cwp_to_xqf.py
```

路徑寫死在腳本頂端（`SRC_ROOT`、`OUT_ROOT`、`SKIP_DIRS`）——執行前先改。
非標準起始局面的排局會跳過（尚未實作完整 FEN replay）。

## 驗證 round-trip

```powershell
# XQF 棋庫：每個檔都 round-trip，不掉變例、不掉註解
.\.venv\Scripts\python.exe tests\test_roundtrip.py

# 與上游 XQFWriter 並排對照（看出為何要 patch）
.\.venv\Scripts\python.exe tests\test_roundtrip.py both

# 完整 XQF ↔ CBL pipeline：3 個真實 CCBridge3 語料
.\.venv\Scripts\python.exe tests\test_cb_xqf_integration.py

# Big5 mojibake 還原：legacy 語料
.\.venv\Scripts\python.exe tests\test_big5_recovery.py

# CBL offset 修正 smoke：線性公式 vs cchess 壞掉的查表，掃 1570 檔
.\.venv\Scripts\python.exe tests\test_cbl_smoke.py

# 重新產生 XQStudio sanity 樣本
.\.venv\Scripts\python.exe tools\emit_sample.py
```

> 主控台若印不出中文／✓（cp950），加 `$env:PYTHONIOENCODING="utf-8"` 再跑。

## 為何要 patched writer／vendored 堆疊

`cchess.io_xqf.XQFWriter.save()` 會把多分支樹塌成主線一條——它線性吐 move list，
不合 reader 遞迴 DFS 的預期；還會掉繁體中文字（GBK vs GB18030）與譜首引言。
完整拆解見 [vendor/io_xqf_patched.py](vendor/io_xqf_patched.py) docstring——可作為上游 PR。

CBL/CBR 那側是對主人的 CCBridge3 語料逆向得出（無公開規格）。cchess 附的 CBL reader
有個壞掉的 4-bucket `_get_cbl_data_offset` 查表，實際公式是線性的（`66624 + N*276`），
由 `vendor/cbl_index_fix.py` monkeypatch 修正。`vendor/io_cb_writer.py` 是第一個能產出
CCBridge3 乾淨開啟之檔案的開放 writer（binary-GUID 連結於 CBR +19..35、
init-annote gate flag 0/1/4/5、library metadata slots 於 832/896/960/1024）。

## 散布

本工具是單人本機工具，**不適合**雲端多人部署（引擎 exec、寫檔、共用 chessdb 速率
都是單人假設）。要分享的話：交付源碼，讓每個使用者在自己機器上跑、配自己的引擎與資料。
詳見 [CLAUDE.md](CLAUDE.md) 的 *Distribution* 段（vendored wheel、`FLASK_DEBUG`、
首開優雅降級、GPL 義務、`git archive` 打包）。
