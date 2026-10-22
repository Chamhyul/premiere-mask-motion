#!/usr/bin/env python3
"""Build the separate macOS Control Surface, without installing or publishing."""
import argparse, json, os, pathlib, plistlib, subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--sdk', required=True, type=pathlib.Path)
parser.add_argument('--output', type=pathlib.Path, default=pathlib.Path('/private/tmp/mask-tracker-native-build'))
parser.add_argument('--arch', choices=['arm64', 'x86_64'])
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parent
version = json.loads((root.parent/'mask-motion/manifest.json').read_text())['version']
headers = args.sdk / 'Examples/Headers'
if not (headers / 'adobesdk/controlsurface/host/ControlSurfaceHostCommandSuite.h').is_file():
    parser.error('Premiere C++ SDK headers not found')
bundle = args.output.resolve() / 'MaskTrackerClipboard.bundle'
contents = bundle / 'Contents'
(contents / 'MacOS').mkdir(parents=True, exist_ok=True)
(contents / 'Info.plist').write_bytes(plistlib.dumps({
    'CFBundleExecutable': 'MaskTrackerClipboard',
    'CFBundleIdentifier': 'com.local.premiere.masktracker.clipboard',
    'CFBundleName': 'MaskTrackerClipboard', 'CFBundlePackageType': 'BNDL',
    'CFBundleVersion': version, 'CFBundleShortVersionString': version,
}))
subprocess.run(['clang++', '-std=c++17', '-Wno-pragma-pack', '-fobjc-arc', '-fblocks',
                *(['-arch', args.arch] if args.arch else []),
                '-DMAC_ENV=1', '-bundle', '-I'+str(headers), '-framework', 'AppKit',
                '-framework', 'UniformTypeIdentifiers', str(root/'MaskTrackerClipboard.mm'),
                '-o', str(contents/'MacOS/MaskTrackerClipboard')], check=True)
identity = os.environ.get('MASK_TRACKER_CODE_SIGN_IDENTITY', '-')
subprocess.run(['codesign', '--force', '--sign', identity, *(['--timestamp', '--options', 'runtime'] if identity != '-' else []), str(bundle)], check=True)
print(bundle)
