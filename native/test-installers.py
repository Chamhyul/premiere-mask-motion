#!/usr/bin/env python3
"""Exercise installer shell control flow using fake tools, never system paths."""
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('installer', ROOT/'build-installer.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mask-tracker-install-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.env = dict(os.environ, TEST_ROOT=str(self.root))
        self.agent = self.tool('agent', '#!/usr/bin/env python3\nimport os,sys,json,pathlib\npathlib.Path(os.environ["TEST_ROOT"],"agent-args.json").write_text(json.dumps(sys.argv[1:]))\nsys.exit(int(os.environ.get("AGENT_EXIT","0")))\n')
        self.ccx = self.root/'payload with spaces.ccx'
        self.ccx.write_bytes(b'test-only')
        self.replacements = {
            '/usr/bin/id': self.tool('id', '#!/bin/sh\nif [ "$1" = -u ]; then echo "${TEST_UID:-0}"; else echo testuser; fi\n'),
            '/usr/bin/stat': self.tool('stat', '#!/bin/sh\necho "${CONSOLE_UID:-501}"\n'),
            '/usr/bin/pgrep': self.tool('pgrep', '#!/bin/sh\nexit "${PREMIERE_RUNNING:-1}"\n'),
            '/usr/sbin/sysctl': self.tool('sysctl', '#!/bin/sh\necho "${ARM64:-1}"\n'),
            '/bin/launchctl': self.tool('launchctl', '#!/bin/sh\n[ "$1" = asuser ] && [ "$2" = 501 ] || exit 71\nshift 2\nexec "$@"\n'),
            '/usr/bin/sudo': self.tool('sudo', '#!/bin/sh\n[ "$1" = -H ] && [ "$2" = -u ] && [ "$3" = testuser ] || exit 72\nshift 3\nexec "$@"\n'),
            '/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent': self.agent,
            '/Library/Application Support/Mask Tracker/Installer/Mask-Tracker.ccx': self.ccx,
        }

    def tool(self, name, source):
        path = self.root/name
        path.write_text(source)
        path.chmod(0o755)
        return path

    def script(self, name, volume='/', **env):
        source = (ROOT/'installer/macos'/name).read_text().replace('@ARCH@', 'arm64')
        for old, new in self.replacements.items():
            source = source.replace(old, str(new))
        path = self.tool(name, source)
        return subprocess.run(['/bin/sh', str(path), 'unused', 'unused', volume], env={**self.env, **env}, capture_output=True, text=True)

    @unittest.skipIf(os.name == 'nt', 'macOS shell control flow')
    def test_preinstall_accepts_ready_desktop(self):
        self.assertEqual(self.script('preinstall').returncode, 0)

    @unittest.skipIf(os.name == 'nt', 'macOS shell control flow')
    def test_preinstall_rejects_running_premiere_missing_agent_wrong_arch_and_volume(self):
        for options in [dict(PREMIERE_RUNNING='0'), dict(ARM64='0'), dict(TEST_UID='501'), dict(CONSOLE_UID='0'), dict(volume='/Volumes/Other')]:
            with self.subTest(options=options):
                self.assertNotEqual(self.script('preinstall', **options).returncode, 0)
        self.agent.unlink()
        self.assertNotEqual(self.script('preinstall').returncode, 0)

    @unittest.skipIf(os.name == 'nt', 'macOS shell control flow')
    def test_postinstall_uses_desktop_user_and_exact_ccx_path(self):
        result = self.script('postinstall')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((self.root/'agent-args.json').read_text()), ['--install', str(self.ccx)])
        self.assertIn('CCX 설치 완료', result.stdout)

    @unittest.skipIf(os.name == 'nt', 'macOS shell control flow')
    def test_postinstall_propagates_adobe_failure_instead_of_success(self):
        result = self.script('postinstall', AGENT_EXIT='87')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('코드 87', result.stderr)
        self.assertNotIn('CCX 설치 완료', result.stdout)
        self.ccx.unlink()
        self.assertNotEqual(self.script('postinstall').returncode, 0)

    def test_builder_rejects_incomplete_assets_and_invalid_version(self):
        with self.assertRaises(ValueError):
            installer.build(self.root, self.root/'out', '0.4.0-beta.1', 'macos', 'arm64')
        with self.assertRaises(ValueError):
            installer.build(self.root, self.root/'out', '../bad', 'macos', 'arm64')

    def test_windows_compiler_failure_propagates_without_reporting_an_installer(self):
        stage = self.root/'stage'
        stage.mkdir()
        (stage/'Mask-Tracker-0.4.0-beta.1.ccx').write_bytes(b'test-only')
        (stage/'MaskTrackerClipboard.acsrf').write_bytes(b'test-only')
        with mock.patch.object(installer.sys, 'platform', 'win32'), mock.patch.object(installer, 'windows_compiler', return_value='ISCC.exe'):
            with mock.patch.object(installer.subprocess, 'run', side_effect=subprocess.CalledProcessError(2, 'ISCC.exe')):
                with self.assertRaises(subprocess.CalledProcessError):
                    installer.build(stage, self.root/'out', '0.4.0-beta.1', 'windows', 'x64')
            with mock.patch.object(installer.subprocess, 'run'):
                with self.assertRaisesRegex(RuntimeError, 'did not produce'):
                    installer.build(stage, self.root/'out', '0.4.0-beta.1', 'windows', 'x64')

if __name__ == '__main__':
    unittest.main()
