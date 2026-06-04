# Dev launcher for the XQF editor backend.
#
# Why this exists: with the Werkzeug reloader OFF (debug defaults off), running
# backend\app.py again while an old instance is still alive does NOT error —
# Windows SO_REUSEADDR lets the new process bind 5174 while the OLD one keeps
# answering. Stale servers pile up and serve old code ("怎麼還在?"). This script
# kills every existing server first, frees the port, then starts ONE fresh
# instance with FLASK_DEBUG=1 so backend edits hot-reload.
#
# Usage:
#   .\run-dev.ps1            # fresh start, auto-reload on backend edits
#   .\run-dev.ps1 -NoDebug   # fresh start, no reloader (single process)

param([switch]$NoDebug)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$port = 5174

# 1) Kill any python running backend\app.py (covers a reloader's parent+child).
#    Match both slash styles — the path may be backend\app.py or backend/app.py
#    depending on how it was launched.
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -like '*backend\app.py*' -or $_.CommandLine -like '*backend/app.py*' } |
  ForEach-Object {
    Write-Host ("停掉舊 server PID {0}" -f $_.ProcessId) -ForegroundColor DarkYellow
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

# 2) Belt-and-braces: kill whatever still holds the port (any leftover binder).
$holders = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($h in $holders) {
  Write-Host ("釋放埠 {0}（PID {1}）" -f $port, $h.OwningProcess) -ForegroundColor DarkYellow
  Stop-Process -Id $h.OwningProcess -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 500

# 3) Start one fresh instance.
if ($NoDebug) {
  $env:FLASK_DEBUG = ""
  Write-Host "啟動 server（debug 關）…" -ForegroundColor Cyan
} else {
  $env:FLASK_DEBUG = "1"
  Write-Host "啟動 server（FLASK_DEBUG=1，後端改檔自動重載）…" -ForegroundColor Cyan
}
Write-Host ("→ http://127.0.0.1:{0}/" -f $port) -ForegroundColor Yellow
& .\.venv\Scripts\python.exe backend\app.py
