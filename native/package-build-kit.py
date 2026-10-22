#!/usr/bin/env python3
"""Create a portable build workspace without SDKs, projects, or Git history."""
import argparse
import pathlib
import zipfile

root = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('output', type=pathlib.Path)
args = parser.parse_args()
files = [root/'Build-Windows.ps1', root/'README.md']
for directory in ['mask-motion', 'native']:
    for path in (root/directory).rglob('*'):
        relative = path.relative_to(root/directory)
        if any(part in {'.git', 'node_modules', 'build', '__pycache__', '.codex', '.agents'} for part in relative.parts):
            continue
        if path.is_file() and (path.name in {'preinstall', 'postinstall'} or path.suffix in {'.js', '.json', '.html', '.css', '.svg', '.md', '.mm', '.hpp', '.cpp', '.py', '.prmf', '.bin', '.iss'}):
            files.append(path)
docs = root if (root/'INSTALL-ko.md').is_file() else root/'distribution'
files += [docs/name for name in ['README.md', 'INSTALL-ko.md', 'INSTALL-windows-ko.md']]
if not all(path.is_file() for path in files):
    raise SystemExit('Build workspace files are incomplete')
args.output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(args.output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in sorted(set(files)):
        archive.write(path, pathlib.PurePosixPath('Mask-Tracker-Build')/path.relative_to(root).as_posix())
print(args.output.resolve())
