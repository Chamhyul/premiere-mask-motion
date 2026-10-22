#!/usr/bin/env python3
"""Run on Windows as a normal user, with Premiere closed. Fixture files only."""
import os
import pathlib
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET
from importlib.util import spec_from_file_location, module_from_spec

spec = spec_from_file_location('fixtures', pathlib.Path(__file__).with_name('test-registration.py'))
fixtures = module_from_spec(spec)
spec.loader.exec_module(fixtures)
HELPER = os.environ.get('MASK_TRACKER_REGISTRATION_HELPER')

@unittest.skipUnless(os.name == 'nt' and HELPER, 'Requires built Windows helper and a normal Windows user')
class WindowsRegistrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='Mask Tracker 등록 ')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.file = self.root/'ControlSurface/ControlSurfaceSettings.xml'
        self.file.parent.mkdir()
        self.module = self.root/'MaskTrackerClipboard.acsrf'
        self.module.write_bytes(b'fixture module only')

    def run_helper(self):
        return subprocess.run([HELPER, '--settings-file', str(self.file), '--module-path', str(self.module)],
                              capture_output=True)

    def unrelated(self, root):
        for name in ['ActivePluginIDs', 'PluginList', 'PluginSettingsList']:
            group = fixtures.group(root, name)
            for entry in list(group):
                if (entry.findtext('ustring') == fixtures.PID or
                        entry.findtext('key') in {fixtures.PID, str(self.module)}):
                    group.remove(entry)
        return fixtures.signature(root)

    def test_existing_devices_settings_backup_and_idempotence(self):
        self.file.write_text(fixtures.SAMPLE, encoding='utf-8')
        before = self.file.read_bytes()
        result = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr)
        backups = list(self.file.parent.glob('*.mask-tracker-backup-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), before)
        self.assertEqual(self.unrelated(ET.fromstring(before)), self.unrelated(ET.parse(self.file).getroot()))
        root = ET.parse(self.file).getroot()
        self.assertEqual([e.findtext('ustring') for e in fixtures.group(root, 'ActivePluginIDs')], ['other.device', fixtures.PID])
        after = self.file.read_bytes(); mtime = self.file.stat().st_mtime_ns
        result = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b'already_registered', result.stdout)
        self.assertEqual(self.file.read_bytes(), after)
        self.assertEqual(self.file.stat().st_mtime_ns, mtime)
        self.assertEqual(len(list(self.file.parent.glob('*.mask-tracker-backup-*'))), 1)

    def test_utf16_existing_settings_are_preserved(self):
        self.file.write_bytes(fixtures.SAMPLE.replace('<?xml version="1.0"?>', '<?xml version="1.0" encoding="UTF-16"?>').encode('utf-16'))
        before = self.file.read_bytes()
        result = self.run_helper(); self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.unrelated(ET.fromstring(before)), self.unrelated(ET.parse(self.file).getroot()))

    def test_module_path_collision_leaves_existing_file_unchanged(self):
        source = fixtures.SAMPLE.replace('/Other.bundle', str(self.module))
        self.file.write_text(source, encoding='utf-8'); before = self.file.read_bytes()
        self.assertNotEqual(self.run_helper().returncode, 0)
        self.assertEqual(self.file.read_bytes(), before)
        self.assertFalse(list(self.file.parent.glob('*.mask-tracker-backup-*')))

    def test_missing_file_creation(self):
        self.file.parent.rmdir()
        result = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr)
        root = ET.parse(self.file).getroot()
        self.assertEqual([e.findtext('ustring') for e in fixtures.group(root, 'ActivePluginIDs')], [fixtures.PID])

    def test_invalid_or_unsupported_xml_is_unchanged(self):
        for source in ['broken', fixtures.SAMPLE.replace('version="4"', 'version="99"'),
                       fixtures.SAMPLE.replace('</prop.list></prop.map>', '<prop.pair><key>SettingsVersion</key><ustring>duplicate</ustring></prop.pair></prop.list></prop.map>'),
                       '<!DOCTYPE x [<!ENTITY test SYSTEM "file:///C:/Windows/win.ini">]>'+fixtures.SAMPLE]:
            with self.subTest(source=source[:50]):
                self.file.write_text(source, encoding='utf-8'); before = self.file.read_bytes()
                self.assertNotEqual(self.run_helper().returncode, 0)
                self.assertEqual(self.file.read_bytes(), before)
                self.assertFalse(list(self.file.parent.glob('*.mask-tracker-backup-*')))

    def test_own_settings_and_case_insensitive_module_key_are_preserved(self):
        root = ET.fromstring(fixtures.SAMPLE)
        active = fixtures.group(root, 'ActivePluginIDs')
        entry = ET.SubElement(active, 'prop.pair')
        ET.SubElement(entry, 'key').text = 'PluginID1'
        ET.SubElement(entry, 'ustring').text = fixtures.PID
        catalog = fixtures.group(root, 'PluginList')
        entry = ET.SubElement(catalog, 'prop.pair')
        ET.SubElement(entry, 'key').text = str(self.module).upper()
        fields = ET.SubElement(entry, 'prop.list')
        for key, value in [('ID', fixtures.PID), ('Name', 'Mask Tracker')]:
            pair = ET.SubElement(fields, 'prop.pair')
            ET.SubElement(pair, 'key').text = key; ET.SubElement(pair, 'ustring').text = value
        settings = fixtures.group(root, 'PluginSettingsList')
        entry = ET.SubElement(settings, 'prop.pair'); ET.SubElement(entry, 'key').text = fixtures.PID
        own = ET.SubElement(entry, 'prop.list')
        pair = ET.SubElement(own, 'prop.pair'); ET.SubElement(pair, 'key').text = 'Keep'
        ET.SubElement(pair, 'ustring').text = '사용자 설정'
        self.file.write_bytes(ET.tostring(root, encoding='utf-8'))
        before = self.file.read_bytes()
        result = self.run_helper(); self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.file.read_bytes(), before)
        self.assertFalse(list(self.file.parent.glob('*.mask-tracker-backup-*')))

    def test_junction_parent_is_rejected(self):
        actual = self.root/'actual'; actual.mkdir()
        (actual/self.file.name).write_text(fixtures.SAMPLE, encoding='utf-8')
        self.file.parent.rmdir()
        # mklink /J works for normal users; remove the junction before temp cleanup.
        result = subprocess.run(['cmd', '/d', '/c', 'mklink', '/J', str(self.file.parent), str(actual)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        try:
            self.assertNotEqual(self.run_helper().returncode, 0)
            self.assertEqual((actual/self.file.name).read_text(encoding='utf-8'), fixtures.SAMPLE)
        finally:
            os.rmdir(self.file.parent)

if __name__ == '__main__':
    unittest.main()
