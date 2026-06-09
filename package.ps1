# Build the standalone SERVER exe and stage the runtime data next to it, so a
# fresh machine runs with zero configuration.
#
#   .\package.ps1
#
# Output: dist\ChessBookEditor\
#   ChessBookEditor.exe   - start server, print URL (open in your own browser)
#   _internal\            - Python runtime + Flask + frontend + tkinter
#   engine\Windows\       - Pikafish (Windows builds + pikafish.nnue) [GPLv3]
#   samples\              - bundled sample library (xqf\ + cbl\)
#   positions.db          - engine eval cache from chess-book-ai (read-only use)
#
# NOTE (GPLv3): Pikafish is GPL. Shipping its binary obligates us to accompany
# it with the license + a way to get its source. We copy the engine's Copying.txt
# and NNUE-License.md in; keep them with any redistribution.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host '[1/6] Stopping any running ChessBookEditor.exe ...'
Get-Process ChessBookEditor -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 400

Write-Host '[2/6] Building with PyInstaller (server.spec) ...'
# PyInstaller logs INFO to stderr; under $ErrorActionPreference='Stop' PowerShell
# turns each stderr line into a terminating NativeCommandError. Drop to Continue
# just for the native call and gate on the real exit code.
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& .\.venv\Scripts\pyinstaller.exe server.spec --noconfirm
$code = $LASTEXITCODE
$ErrorActionPreference = $prev
if ($code -ne 0) { throw "PyInstaller failed (exit $code)" }

$dist = Join-Path $root 'dist\ChessBookEditor'
if (-not (Test-Path $dist)) { throw "dist folder not found: $dist" }

Write-Host '[3/6] Staging engine (Windows builds + nnue, other platforms dropped) ...'
$engSrc = Join-Path $root '..\chess-book-ai\engine\Windows'
$engDst = Join-Path $dist 'engine\Windows'
if (-not (Test-Path $engSrc)) { throw "engine source not found: $engSrc" }
New-Item -ItemType Directory -Force $engDst | Out-Null
Copy-Item (Join-Path $engSrc '*') $engDst -Force -Recurse
# GPL license files alongside the binaries.
$engRoot = Join-Path $root '..\chess-book-ai\engine'
foreach ($lic in @('Copying.txt', 'NNUE-License.md', 'AUTHORS', 'README.md')) {
    $src = Join-Path $engRoot $lic
    if (Test-Path $src) { Copy-Item $src (Join-Path $dist 'engine') -Force }
}

Write-Host '[4/6] Staging sample library ...'
$smpDst = Join-Path $dist 'samples'
if (Test-Path $smpDst) { Remove-Item $smpDst -Recurse -Force }
Copy-Item (Join-Path $root 'samples') $smpDst -Recurse -Force

Write-Host '[5/6] Staging eval database (positions.db) ...'
# Opened read-only at runtime (eval_service ?mode=ro); the frozen DEFAULT_EVAL_DB
# points at this exe-adjacent copy. Absent = graceful (eval/info exists:false).
$dbSrc = Join-Path $root '..\chess-book-ai\output\positions.db'
if (Test-Path $dbSrc) {
    Copy-Item $dbSrc (Join-Path $dist 'positions.db') -Force
    Write-Host '  copied positions.db'
} else {
    Write-Host "  SKIP: positions.db not found at $dbSrc (eval degrades gracefully)"
}

Write-Host '[6/6] Staging example preferences ...'
$prefEx = Join-Path $root 'preferences.example.json'
if (Test-Path $prefEx) { Copy-Item $prefEx (Join-Path $dist 'preferences.example.json') -Force }

$sizeMB = [math]::Round((Get-ChildItem $dist -Recurse | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host ''
Write-Host "DONE -> $dist  ($sizeMB MB)"
Write-Host 'Run: double-click ChessBookEditor.exe, then open the printed URL in your browser.'
