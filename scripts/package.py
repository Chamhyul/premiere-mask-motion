"""Build the pure UXP CCX and beta documentation; no SDK or user data."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
FILES = ("manifest.json", "index.html", "index.js", "host.js", "core.js", "style.css")
version = json.loads((ROOT / "manifest.json").read_text())["version"]
label = version + "-beta.1"
DIST.mkdir(exist_ok=True)
package = DIST / ("Mask-Motion-" + label + ".ccx")
with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
    for name in FILES:
        info = zipfile.ZipInfo(name, (2026, 10, 17, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, (ROOT / name).read_bytes())
with zipfile.ZipFile(package) as archive:
    assert set(archive.namelist()) == set(FILES)
    assert archive.testzip() is None
    assert json.loads(archive.read("manifest.json"))["main"] in FILES
instructions = DIST / "INSTALL-ko.md"
instructions.write_text((ROOT / "README.md").read_text())
checksums = "".join(hashlib.sha256(path.read_bytes()).hexdigest() + "  " + path.name + "\n"
                    for path in (package, instructions))
(DIST / "SHA256SUMS.txt").write_text(checksums)
print(package)
print(checksums)
