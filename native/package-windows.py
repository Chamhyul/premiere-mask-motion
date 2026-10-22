#!/usr/bin/env python3
"""Package built assets only. No source, diagnostics, install, or publish step."""
import pathlib, sys, zipfile

stage, output = map(pathlib.Path, sys.argv[1:])
files = sorted(stage.glob('*.ccx')) + [stage/'MaskTrackerClipboard.acsrf', stage/'INSTALL-ko.md', stage/'README.md']
if len(list(stage.glob('*.ccx'))) != 1 or not all(p.is_file() for p in files):
    raise SystemExit('Windows package assets are incomplete')
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for file in files:
        archive.write(file, file.name)
