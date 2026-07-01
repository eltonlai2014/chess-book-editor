# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the standalone SERVER exe (server.py) — primary distro.
#
# Produces a ONEDIR bundle: dist\ChessBookEditor\ChessBookEditor.exe + _internal\.
# The exe just starts Flask and prints a URL; the user opens it in their own
# browser. No pywebview / pythonnet — that keeps the bundle small and sidesteps
# the .NET assembly-load + MOTW issues an embedded WebView2 shell hit on other
# machines (a pywebview shell was tried first and removed; see CLAUDE.md).
#
# Build:   .\.venv\Scripts\pyinstaller.exe server.spec --noconfirm
# Better:  .\package.ps1   (builds, then stages engine\Windows\ + samples\ next
#          to the exe so a fresh machine runs with zero config)
#
# Bundled here:   Python runtime, Flask, cchess, frontend/, tkinter (for the
#                 native file/folder pickers via the exe's `--pick` branch), and
#                 data\practice_seed.db (中局練習題庫 seed → first-run loads it
#                 into output\practice.db).
# Staged by package.ps1 next to the exe (NOT in this spec): engine\Windows\,
#                 samples\.  Set via the in-app UI pickers if moved.
# NOT shipped:    positions.db eval cache (AI repo's data; absent = graceful).
import os
from PyInstaller.utils.hooks import collect_all, collect_submodules

datas = [('frontend', 'frontend')]
# 版控的中局練習題庫 seed（唯讀）。frozen 解到 _MEIPASS/data/；practice_service
# 的 PRACTICE_SEED_PATH 用 _resource_base()/data/practice_seed.db，首次啟動灌進
# exe-adjacent 的可寫 output/practice.db（見 backend/practice_service.py）。
if os.path.isfile(os.path.join('data', 'practice_seed.db')):
    datas += [(os.path.join('data', 'practice_seed.db'), 'data')]
binaries = []
# tkinter powers the native pickers (server.py --pick). Listing it pulls in the
# PyInstaller tkinter hook (tcl/tk data + _tkinter.pyd) which the static import
# graph misses (tk_picker imports it lazily inside the function).
hiddenimports = ['tkinter', '_tkinter', 'tkinter.filedialog']

# cchess ships data tables / submodules the static graph can miss.
for pkg in ('cchess',):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# Our namespace packages (no __init__) — collect every submodule reachable only
# via string imports.
for pkg in ('backend', 'vendor'):
    try:
        hiddenimports += collect_submodules(pkg)
    except Exception:
        pass

a = Analysis(
    ['server.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='ChessBookEditor',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,  # the whole point: console shows the URL to open.
    icon=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name='ChessBookEditor',
)
