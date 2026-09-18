# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, copy_metadata


runtime_dir = Path(SPECPATH)
browser_datas, browser_binaries, browser_hiddenimports = collect_all("browser_use")
cdp_datas, cdp_binaries, cdp_hiddenimports = collect_all("cdp_use")
datas = browser_datas + cdp_datas + copy_metadata("browser-use") + copy_metadata("cdp-use")
binaries = browser_binaries + cdp_binaries
hiddenimports = browser_hiddenimports + cdp_hiddenimports + [
    "browser_use.browser",
    "browser_use.llm.openai",
    "browser_use.tools.service",
]

a = Analysis(
    [str(runtime_dir / "agent_host.py")],
    pathex=[str(runtime_dir)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "IPython",
        "jupyter",
        "matplotlib",
        "notebook",
        "pytest",
        "tkinter",
    ],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="agent-host",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="agent-host",
)
