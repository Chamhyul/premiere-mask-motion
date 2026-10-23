"use strict";
const fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib"), crypto = require("node:crypto");
const os = require("node:os"), { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
// Support the local workspace and the downloadable GitHub repository layout.
const docs = fs.existsSync(path.resolve(root, "../INSTALL-ko.md")) ? path.resolve(root, "..") : path.resolve(root, "../distribution");
const dist = path.join(docs, "dist");
const { CURRENT_VERSION } = require("../updates.js"), manifest = require("../manifest.json"), pkg = require("../package.json");
if (manifest.version !== CURRENT_VERSION.split("-")[0] || pkg.version !== CURRENT_VERSION || manifest.name !== "Mask Tracker") throw Error("Release version/name mismatch");
const windows = process.platform === "win32";
if ((!windows && process.platform !== "darwin") || (windows ? process.arch !== "x64" : !["arm64", "x64"].includes(process.arch))) throw Error("Build on macOS or Windows x64 with the corresponding native toolchain");
const names = ["assets/refresh.svg", "manifest.json", "index.html", "index.js", "host.js", "live-mask.js", "core.js", "style.css", "deflate.js", "prmf.js", "edge-motion.js", "project-mask.js", "mask-source.js", "project-access.js", "updates.js"];
for (const name of names.filter(name => name.endsWith(".js"))) {
  for (const match of fs.readFileSync(path.join(root, name), "utf8").matchAll(/require\(["'](\.\/[^"']+)["']\)/g)) {
    if (!names.includes(match[1].slice(2))) throw Error("Missing runtime dependency: " + match[1]);
  }
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
const local = [], central = []; let offset = 0;
for (const name of names) {
  const filename = Buffer.from(name), data = fs.readFileSync(path.join(root, name)), compressed = zlib.deflateRawSync(data, { level: 9 }), crc = crc32(data);
  const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
  const entry = Buffer.concat([header, filename, compressed]); local.push(entry);
  const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10); directory.writeUInt16LE(33, 14);
  directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
  central.push(Buffer.concat([directory, filename])); offset += entry.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
fs.mkdirSync(dist, { recursive: true });
const asset = "Mask-Tracker-" + CURRENT_VERSION + ".ccx";
const installer = "Mask-Tracker-" + (windows ? "Windows-x64-" + CURRENT_VERSION + "-Setup.exe" : "macOS-" + process.arch + "-" + CURRENT_VERSION + ".pkg");
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "mask-tracker-package-"));
try {
  fs.writeFileSync(path.join(stage, asset), Buffer.concat([...local, directory, end]));
  const sdk = process.env.PREMIERE_CPP_SDK || path.resolve(root, "../../local_sdk/Premiere Pro 26.0 C++ SDK");
  const python = process.env.MASK_TRACKER_PYTHON || (windows ? "python" : "python3");
  execFileSync(python, [path.resolve(root, windows ? "../native/build-windows.py" : "../native/build-macos.py"), "--sdk", sdk, "--output", stage,
    ...(windows ? [] : ["--arch", process.arch === "x64" ? "x86_64" : "arm64"])], { stdio: "inherit" });
  execFileSync(python, [path.resolve(root, "../native/build-installer.py"), "--stage", stage,
    "--output", dist, "--version", CURRENT_VERSION, "--platform", windows ? "windows" : "macos", "--arch", process.arch], { stdio: "inherit" });
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(dist, installer))).digest("hex");
console.log(JSON.stringify({ version: CURRENT_VERSION, installer: path.join(dist, installer), runtimeFiles: names.length, sha256 }, null, 2));
