# One-shot setup for the XQF editor on a fresh machine.
#
#   1. Install Python 3.10+ from python.org (tick "Add to PATH"; the default
#      installer includes tkinter, which the folder/file pickers need).
#   2. Open PowerShell in this folder and run:  .\setup.ps1
#   3. Start the app:  .\.venv\Scripts\python.exe backend\app.py
#      then open http://127.0.0.1:5174/ in a browser.
#
# The engine (Pikafish) and the optional eval database (positions.db) are NOT
# bundled — set them from the UI's 📂 pickers. The app runs fine without them
# (no engine = no live analysis; no DB = cloud scores via chessdb.cn only).

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# Locate a Python launcher.
$py = if (Get-Command py -ErrorAction SilentlyContinue) { "py" }
      elseif (Get-Command python -ErrorAction SilentlyContinue) { "python" }
      else { $null }
if (-not $py) {
  Write-Host "找不到 Python。請先安裝 Python 3.10+ (python.org，勾選 Add to PATH)。" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path ".venv")) {
  Write-Host "建立虛擬環境 .venv ..." -ForegroundColor Cyan
  & $py -m venv .venv
}

Write-Host "安裝相依套件 (cchess 從 vendor/wheels 本地 wheel，不依賴上游 GitHub) ..." -ForegroundColor Cyan
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt

if (-not (Test-Path "preferences.json") -and (Test-Path "preferences.example.json")) {
  Copy-Item "preferences.example.json" "preferences.json"
  Write-Host "已從範本建立 preferences.json" -ForegroundColor Green
}

Write-Host ""
Write-Host "完成。啟動：" -ForegroundColor Green
Write-Host "    .\.venv\Scripts\python.exe backend\app.py" -ForegroundColor Yellow
Write-Host "再開瀏覽器： http://127.0.0.1:5174/" -ForegroundColor Yellow
