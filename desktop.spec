# -*- mode: python ; coding: utf-8 -*-
# PyInstaller build spec for the standalone desktop editor (desktop.py).
#
# Produces a ONEDIR bundle (a folder with ChessBookEditor.exe + _internal/).
# Onedir over onefile for the POC: faster startup (no per-launch temp extract),
# easier to inspect, and friendlier to the WebView2/pythonnet native DLLs.
#
# Build:   .\.venv\Scripts\pyinstaller.exe desktop.spec --noconfirm
# Output:  dist\ChessBookEditor\ChessBookEditor.exe
#
# What is bundled here vs. what stays external:
#   bundled   -> Python runtime, Flask, pywebview, pythonnet, cchess, frontend/
#   NOT bundled (set via the in-app UI pickers, graceful when absent):
#     - Pikafish engine (GPL, CPU-microarch specific)
#     - positions.db eval cache (the AI repo's data)
#     - the XQF library itself
#   external & writable (live NEXT TO the exe, created on first run):
#     - preferences.json, output/   (see _data_base() in backend/app.py)
from PyInstaller.utils.hooks import collect_all, collect_submodules

datas = [('frontend', 'frontend')]
binaries = []
hiddenimports = ['clr']  # pythonnet's runtime import name

# Pull in package data + native binaries + submodules that PyInstaller's static
# import graph can miss for these (webview's JS api shim, pythonnet's CLR glue,
# cchess data tables).
for pkg in ('webview', 'cchess', 'clr_loader'):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# Our own packages are namespace packages (no __init__) — make sure every
# submodule is collected even if reached only via a string import.
for pkg in ('backend', 'vendor'):
    try:
        hiddenimports += collect_submodules(pkg)
    except Exception:
        pass

a = Analysis(
    ['desktop.py'],
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
    console=True,  # POC: keep the Flask log/console visible. Flip to False for a clean app.
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
