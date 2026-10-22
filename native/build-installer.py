#!/usr/bin/env python3
"""Build one installer from staged native+CCX assets; never install or publish."""
import argparse
import os
import pathlib
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
from xml.sax.saxutils import escape

ROOT = pathlib.Path(__file__).resolve().parent

def windows_compiler():
    configured = os.environ.get('MASK_TRACKER_ISCC')
    if configured:
        path = pathlib.Path(configured)
        if not path.is_file():
            raise RuntimeError('MASK_TRACKER_ISCC must point to ISCC.exe')
        return str(path)
    found = shutil.which('ISCC.exe')
    if found:
        return found
    for key in ['ProgramFiles(x86)', 'ProgramFiles']:
        if os.environ.get(key):
            path = pathlib.Path(os.environ[key])/'Inno Setup 6/ISCC.exe'
            if path.is_file():
                return str(path)
    raise RuntimeError('Install Inno Setup 6.3+ or set MASK_TRACKER_ISCC to ISCC.exe')

def build(stage, output, version, platform, arch):
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', version):
        raise ValueError('Invalid version')
    ccx = stage/('Mask-Tracker-'+version+'.ccx')
    native = stage/('MaskTrackerClipboard.acsrf' if platform == 'windows' else 'MaskTrackerClipboard.bundle')
    if not ccx.is_file() or not native.exists():
        raise ValueError('Staged CCX/native assets are incomplete')
    output.mkdir(parents=True, exist_ok=True)
    numeric = version.split('-')[0]
    if platform == 'windows':
        if sys.platform != 'win32' or arch != 'x64':
            raise RuntimeError('Build the Windows installer on Windows x64')
        installer = output/('Mask-Tracker-Windows-x64-'+version+'-Setup.exe')
        compiler = windows_compiler()
        subprocess.run([compiler, '/DStageDir='+str(stage), '/DOutputDir='+str(output),
                        '/DVersion='+version, '/DVersionNumeric='+numeric+'.0',
                        str(ROOT/'installer/windows.iss')], check=True)
    else:
        if sys.platform != 'darwin' or arch not in {'arm64', 'x64'}:
            raise RuntimeError('Build the macOS installer on macOS arm64/x64')
        installer = output/('Mask-Tracker-macOS-'+arch+'-'+version+'.pkg')
        with tempfile.TemporaryDirectory(prefix='mask-tracker-installer-') as temp:
            temp = pathlib.Path(temp)
            payload = temp/'payload'
            native_relative = pathlib.Path('Library/Application Support/Adobe/Common/Plug-ins/ControlSurface/MaskTrackerClipboard.bundle')
            destination = payload/native_relative
            destination.parent.mkdir(parents=True)
            shutil.copytree(native, destination, symlinks=True)
            ccx_destination = payload/'Library/Application Support/Mask Tracker/Installer/Mask-Tracker.ccx'
            ccx_destination.parent.mkdir(parents=True)
            shutil.copy2(ccx, ccx_destination)
            # Root-owned payload must be readable/executable by the Adobe user.
            for path in payload.rglob('*'):
                if not path.is_symlink():
                    path.chmod(0o755 if path.is_dir() or os.access(path, os.X_OK) else 0o644)
            scripts = temp/'scripts'
            scripts.mkdir()
            for name in ['preinstall', 'postinstall']:
                target = scripts/name
                target.write_text((ROOT/'installer/macos'/name).read_text().replace('@ARCH@', 'arm64' if arch == 'arm64' else 'x86_64'))
                target.chmod(0o755)
            components = temp/'components.plist'
            components.write_bytes(plistlib.dumps([{'RootRelativeBundlePath':str(native_relative),
                'BundleIsRelocatable':False, 'BundleOverwriteAction':'upgrade', 'BundleHasStrictIdentifier':True}]))
            component = temp/'payload.pkg'
            subprocess.run(['/usr/bin/pkgbuild', '--root', str(payload), '--install-location', '/',
                '--identifier', 'com.local.premiere.masktracker.installer', '--version', numeric,
                '--ownership', 'recommended', '--component-plist', str(components),
                '--scripts', str(scripts), str(component)], check=True)
            resources = temp/'resources'
            resources.mkdir()
            conclusion = resources/'conclusion.html'
            conclusion.write_text('<html><meta charset="utf-8"><body><h2>Mask Tracker</h2>'
                '<p>네이티브 모듈과 CCX를 설치했습니다.</p>'
                '<p>Premiere의 환경 설정 → 컨트롤 표면 → 추가에서 Mask Tracker를 선택하세요. 처음 한 번만 설정하면 됩니다.</p></body></html>')
            distribution = temp/'Distribution.xml'
            distribution.write_text('<?xml version="1.0" encoding="utf-8"?>\n<installer-gui-script minSpecVersion="2">'
                '<title>Mask Tracker</title><options customize="never" require-scripts="true" hostArchitectures="'+('arm64' if arch == 'arm64' else 'x86_64')+'"/>'
                '<domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>'
                '<conclusion file="conclusion.html" mime-type="text/html"/>'
                '<choices-outline><line choice="default"/></choices-outline>'
                '<choice id="default" visible="false"><pkg-ref id="com.local.premiere.masktracker.installer"/></choice>'
                '<pkg-ref id="com.local.premiere.masktracker.installer" version="'+escape(numeric)+'" auth="Root">payload.pkg</pkg-ref></installer-gui-script>')
            command = ['/usr/bin/productbuild', '--distribution', str(distribution), '--package-path', str(temp), '--resources', str(resources)]
            identity = os.environ.get('MASK_TRACKER_INSTALLER_SIGN_IDENTITY')
            if identity:
                command += ['--sign', identity]
            subprocess.run(command+[str(installer)], check=True)
    if not installer.is_file():
        raise RuntimeError('Installer compiler did not produce the expected file')
    return installer

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', required=True, type=pathlib.Path)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    parser.add_argument('--version', required=True)
    parser.add_argument('--platform', required=True, choices=['macos', 'windows'])
    parser.add_argument('--arch', required=True, choices=['arm64', 'x64'])
    args = parser.parse_args()
    print(build(args.stage.resolve(), args.output.resolve(), args.version, args.platform, args.arch))

if __name__ == '__main__':
    main()
