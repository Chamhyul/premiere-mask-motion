#!/usr/bin/env python3
import json, os, pathlib, subprocess, tempfile, unittest
import xml.etree.ElementTree as ET

HELPER = os.environ.get('MASK_TRACKER_REGISTRATION_HELPER')
PID = 'com.local.premiere.masktracker.clipboard'
MODULE = '/Library/Application Support/Adobe/Common/Plug-ins/ControlSurface/MaskTrackerClipboard.bundle'
SAMPLE = '''<?xml version="1.0"?><prop.map version="4"><prop.list>
<prop.pair><key>ActivePluginIDs</key><prop.list><prop.pair><key>PluginID0</key><ustring>other.device</ustring></prop.pair></prop.list></prop.pair>
<prop.pair><key>PluginList</key><prop.list><prop.pair><key>/Other.bundle</key><prop.list><prop.pair><key>ID</key><ustring>other.device</ustring></prop.pair><prop.pair><key>Name</key><ustring>다른 장치 &amp; 설정</ustring></prop.pair></prop.list></prop.pair></prop.list></prop.pair>
<prop.pair><key>PluginSettingsList</key><prop.list><prop.pair><key>other.device</key><ustring>사용자 설정 &amp; 그대로</ustring></prop.pair></prop.list></prop.pair>
<prop.pair><key>SettingsVersion</key><int type="unsigned" size="32">1</int></prop.pair>
<prop.pair><key>UnknownFutureSetting</key><ustring>untouched</ustring></prop.pair>
</prop.list></prop.map>'''

def pairs(node): return {e.findtext('key'): e for e in node.findall('prop.pair')}
def group(root, name): return pairs(root.find('prop.list'))[name].find('prop.list')
def own(e): return e.findtext('ustring') == PID or e.findtext('key') in {PID, MODULE}
def unrelated(root):
    for name in ['ActivePluginIDs', 'PluginList', 'PluginSettingsList']:
        g = group(root, name)
        for e in list(g):
            if own(e): g.remove(e)
    return signature(root)
def signature(node):
    kids = list(node)
    if node.tag == 'prop.list': kids.sort(key=lambda e:e.findtext('key') or '')
    return node.tag, tuple(sorted(node.attrib.items())), (node.text or '').strip(), tuple(signature(e) for e in kids)

@unittest.skipUnless(HELPER, 'Set MASK_TRACKER_REGISTRATION_HELPER to a macOS binary; quit Premiere first')
class RegistrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mask-tracker-register-test-', dir='/private/tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.file = self.root/'ControlSurface/ControlSurfaceSettings.xml'
        self.file.parent.mkdir()

    def run_helper(self):
        return subprocess.run([HELPER, '--settings-file', str(self.file)], text=True, capture_output=True)

    def test_existing_devices_settings_backup_permissions_and_idempotence(self):
        self.file.write_text(SAMPLE); self.file.chmod(0o640)
        before = self.file.read_bytes()
        result = self.run_helper(); self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)[0]
        self.assertEqual(pathlib.Path(report['backup']).read_bytes(), before)
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o640)
        self.assertEqual(unrelated(ET.fromstring(before)), unrelated(ET.parse(self.file).getroot()))
        root = ET.parse(self.file).getroot()
        self.assertEqual([e.findtext('ustring') for e in group(root,'ActivePluginIDs')], ['other.device',PID])
        after = self.file.read_bytes();mtime=self.file.stat().st_mtime_ns
        result=self.run_helper(); self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout)[0]['status'],'already_registered')
        self.assertEqual(self.file.read_bytes(),after);self.assertEqual(self.file.stat().st_mtime_ns,mtime)
        self.assertEqual(len(list(self.file.parent.glob('*.mask-tracker-backup-*'))),1)

    def test_missing_file_is_created_with_private_permissions(self):
        self.file.parent.rmdir()
        result=self.run_helper();self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(self.file.stat().st_mode & 0o777,0o600)
        self.assertEqual([e.findtext('ustring') for e in group(ET.parse(self.file).getroot(),'ActivePluginIDs')],[PID])

    def test_malformed_unsupported_duplicate_or_external_entity_input_is_preserved(self):
        for source in ['broken', SAMPLE.replace('version="4"','version="99"'), SAMPLE.replace('</prop.list></prop.map>','<prop.pair><key>SettingsVersion</key><ustring>duplicate</ustring></prop.pair></prop.list></prop.map>'), '<!DOCTYPE x [<!ENTITY test SYSTEM "file:///etc/passwd">]>'+SAMPLE]:
            self.file.write_text(source);before=self.file.read_bytes()
            self.assertNotEqual(self.run_helper().returncode,0)
            self.assertEqual(self.file.read_bytes(),before)
            self.assertFalse(list(self.file.parent.glob('*.mask-tracker-backup-*')))

    def test_symlink_file_and_parent_are_rejected_without_touching_destination(self):
        real=self.root/'real.xml';real.write_text(SAMPLE)
        self.file.symlink_to(real)
        self.assertNotEqual(self.run_helper().returncode,0);self.assertEqual(real.read_text(),SAMPLE)
        self.file.unlink();self.file.parent.rmdir()
        actual=self.root/'actual';actual.mkdir();(actual/self.file.name).write_text(SAMPLE)
        self.file.parent.symlink_to(actual,target_is_directory=True)
        self.assertNotEqual(self.run_helper().returncode,0);self.assertEqual((actual/self.file.name).read_text(),SAMPLE)

if __name__=='__main__': unittest.main()
