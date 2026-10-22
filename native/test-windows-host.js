"use strict";
// Run only with Premiere open and the test clip selected. Uses the production
// file bridge and reader; never changes the clipboard directly or logs its XML.
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const live = require("../mask-motion/live-mask.js");
const masks = require("../mask-motion/project-mask.js");
const root = path.resolve(__dirname, "..");
const bridge = path.join(os.homedir(), ".mask-tracker", "bridge");
const inspector = path.join(__dirname, "build/windows-x64/clipboard-inspect.exe");
function inspect() {
  const result = spawnSync(inspector, [], { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  const formats = (result.stdout || "").split(/\r?\n/).filter(line => line.startsWith("format="));
  if (!formats.length && result.status !== 0) throw Error("Clipboard inspector failed: " + result.stderr);
  return { formats, cloneable: result.status === 0 };
}
function at(node, route) {
  for (const tag of route.split("/")) node = node && node.children.find(child => child.tag === tag);
  return node;
}
function value(node, route, fallback = "0") { return at(node, route)?.text.trim() || fallback; }
async function main() {
  if (process.platform !== "win32") throw Error("Windows only");
  const project = path.resolve(process.argv[2] || path.join(root, "premiere/무제.prproj"));
  const xml = masks.xml(new Uint8Array(await fs.readFile(project)));
  const ids = new Map(xml.children.map(node => [node.attrs.ObjectID, node]));
  const ref = node => node && ids.get(node.attrs.ObjectRef);
  const items = xml.children.filter(node => node.tag === "VideoClipTrackItem");
  if (items.length !== 1) throw Error("Expected exactly one test video item");
  const item = items[0], sub = ref(at(item, "ClipTrackItem/SubClip")), clip = ref(at(sub, "Clip"));
  const source = { name: value(sub, "Name", ""), track: 0,
    start: value(item, "ClipTrackItem/TrackItem/Start"), end: value(item, "ClipTrackItem/TrackItem/End"),
    inPoint: value(clip, "Clip/InPoint"), speed: 1, reversed: false };
  let nativeReply;
  const entry = name => ({
    read: async () => {
      const text = await fs.readFile(path.join(bridge, name), "utf8");
      if (name.startsWith("result-")) nativeReply = JSON.parse(text);
      return text;
    },
    write: text => fs.writeFile(path.join(bridge, name), text, { flag: "wx" }),
    delete: () => fs.unlink(path.join(bridge, name))
  });
  const uxp = { storage: { localFileSystem: { getEntryWithUrl: async url => {
    if (url !== live.bridgeURL()) throw Error("Unexpected bridge path");
    return { getEntry: async name => entry(name), createFile: async name => entry(name) };
  } } } };
  const before = inspect(), report = { testedAt: new Date().toISOString(), clipboardCloneable: before.cloneable };
  try {
    const snapshot = await live.read(uxp, source);
    report.masks = masks.listMasks(snapshot.xml, "", source);
    report.maskRead = true;
  } catch (error) { report.maskRead = false; report.error = error.message; }
  const after = inspect();
  report.clipboardFormatsUnchanged = JSON.stringify(before.formats) === JSON.stringify(after.formats);
  report.clipboardFormatCount = before.formats.length;
  if (nativeReply) report.native = {
    ok: nativeReply.ok, clipboardRestored: nativeReply.clipboardRestored,
    clipboardVerified: nativeReply.clipboardVerified, message: nativeReply.message,
    copiedFormats: nativeReply.copiedFormats
  };
  // Only diagnostic metadata is persisted; copied XML and clipboard bytes stay in memory.
  const out = path.join(__dirname, "build/host-test/host-report.json");
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (!report.maskRead || !report.clipboardFormatsUnchanged) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
