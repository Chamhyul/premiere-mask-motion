#!/usr/bin/env python3
"""Run in an x64 Visual Studio Developer PowerShell. Does not install or publish."""
import argparse, os, pathlib, shutil, subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--sdk', required=True, type=pathlib.Path)
parser.add_argument('--output', type=pathlib.Path, default=pathlib.Path('native/build/windows-x64'))
parser.add_argument('--diagnostics', action='store_true', help='Also build the read-only clipboard inspector')
args = parser.parse_args()
if os.name != 'nt':
    parser.error('Build on Windows with the x64 MSVC toolchain and Windows SDK')
if not shutil.which('cl'):
    parser.error('Open Developer PowerShell for VS 2022 (x64) before building')
root = pathlib.Path(__file__).resolve().parent
headers = args.sdk.resolve() / 'Examples/Headers'
if not (headers / 'adobesdk/controlsurface/host/ControlSurfaceHostCommandSuite.h').is_file():
    parser.error('Premiere C++ SDK headers not found')
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=True)
common = ['cl', '/nologo', '/std:c++17', '/EHsc', '/MD', '/O2', '/W4', '/utf-8',
          '/DWIN_ENV=1', '/DUNICODE', '/D_UNICODE', '/DNOMINMAX', '/I'+str(headers)]
subprocess.run(common + ['/LD', str(root/'windows/MaskTrackerClipboard.cpp'),
                '/Fo'+str(output/'MaskTrackerClipboard.obj'), '/link',
                '/OUT:'+str(output/'MaskTrackerClipboard.acsrf'),
                '/IMPLIB:'+str(output/'MaskTrackerClipboard.lib'),
                'user32.lib', 'gdi32.lib', 'ole32.lib', 'shell32.lib', 'advapi32.lib', 'uuid.lib'],
               cwd=output, check=True)
# Import libraries and object files are intermediate build outputs, not assets.
for suffix in ['obj', 'lib', 'exp']:
    (output/('MaskTrackerClipboard.'+suffix)).unlink(missing_ok=True)
if args.diagnostics:
    subprocess.run(common + [str(root/'windows/clipboard-inspect.cpp'),
                    '/Fo'+str(output/'clipboard-inspect.obj'), '/Fe'+str(output/'clipboard-inspect.exe'),
                    '/link', 'user32.lib', 'gdi32.lib', 'ole32.lib', 'advapi32.lib'], cwd=output, check=True)
    (output/'clipboard-inspect.obj').unlink(missing_ok=True)
    subprocess.run(common + [str(root/'bridge-protocol-test.cpp'),
                    '/Fo'+str(output/'bridge-protocol-test.obj'), '/Fe'+str(output/'bridge-protocol-test.exe')], cwd=output, check=True)
    (output/'bridge-protocol-test.obj').unlink(missing_ok=True)
print(output/'MaskTrackerClipboard.acsrf')
