"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs");
const core = require("../core.js");
function panel() {
  const markup = fs.readFileSync(require.resolve("../index.html"), "utf8");
  const elements = Object.fromEntries([...markup.matchAll(/id="([^"]+)"/g)].map(match => [match[1], {
    value: "0", textContent: "", disabled: false, hidden: false, checked: false, attributes: {}, listeners: {}, style: {},
    getAttribute(key) { return this.attributes[key]; }, setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; }
  }]));
  elements.width.value = "640"; elements.step.value = "1";
  const data = { format: "MaskMotion", version: 1, projectGuid: "p", sequenceGuid: "s", frameTicks: "10",
    source: { name: "video", track: 0, start: "100", end: "130", inPoint: "0" }, size: { width: 1920, height: 1080 },
    samples: [{ ticks: "100", x: .2, y: .3 }, { ticks: "110", x: .3, y: .3 }, { ticks: "120", x: .4, y: .3 }] };
  let target = false, interval;
  const calls = [];
  const host = {
    selection: async () => ({ projectGuid: "p", sequenceGuid: "s", clip: {
      getName: async () => target ? "subtitle" : "video", getTrackIndex: async () => target ? 1 : 0,
      getStartTime: async () => ({ ticks: "100" }), getEndTime: async () => ({ ticks: "130" }), getInPoint: async () => ({ ticks: "0" })
    } }),
    capture: async (ppro, uxp, options) => { calls.push(["capture", options]); options.rangeInfo({ source: data.source }); options.sampleProgress({ completed: 3, total: 3 }); return data; },
    addTransform: async () => { calls.push(["add"]); return { componentIndex: 3 }; },
    prepare: async (ppro, tracking, options) => { calls.push(["prepare", tracking, options]); return { keys: tracking.samples }; },
    apply: async () => { calls.push(["apply"]); return { effect: "Transform", keyCount: 3, removedUnexpected: [] }; }
  };
  const uxp = { entrypoints: { setup() {} }, storage: { localFileSystem: { getDataFolder: async () => { throw new Error("no prior data"); } } } };
  vm.runInNewContext(fs.readFileSync(require.resolve("../index.js"), "utf8"), {
    require: name => ({ premierepro: {}, uxp, "./host.js": host, "./core.js": core })[name],
    document: { readyState: "complete", getElementById: id => { assert.ok(elements[id], id); return elements[id]; } },
    console: { log() {}, warn() {} }, setInterval: callback => { interval = callback; return 1; }, clearInterval() {}
  });
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  return { elements, host, calls, flush, chooseTarget: async () => { target = true; await flush(); await interval(); } };
}
test("two-step panel captures the whole clip and prepares/applies the selected target in one click", async () => {
  const f = panel(); await f.flush(); await f.elements.capture.listeners.click(); await f.flush();
  const options = f.calls[0][1]; assert.equal(options.range, "clip"); assert.equal(options.internalStorage, true);
  assert.equal(options.frames, undefined); assert.equal(f.elements.percent.textContent, "100%");
  await f.chooseTarget(); assert.equal(f.elements.apply.disabled, false);
  assert.equal(f.elements["source-name"].textContent, "subtitle");
  assert.match(f.elements["source-message"].textContent, /video/);
  await f.elements.apply.listeners.click(); await f.flush();
  assert.deepEqual(f.calls.map(call => call[0]), ["capture", "add", "prepare", "apply"]);
  assert.match(f.elements["target-message"].textContent, /3개 적용/);
});
test("panel startup does not restore old source data over the current selection", async () => {
  const f = panel(); await f.flush();
  assert.equal(f.elements["source-name"].textContent, "video");
  assert.equal(f.elements.apply.disabled, true);
  await f.chooseTarget();
  assert.equal(f.elements["source-name"].textContent, "subtitle");
  assert.equal(f.elements.apply.disabled, true);
});
test("opaque-frame failure shows actionable feedback and keeps target application disabled", async () => {
  const f = panel(); await f.flush();
  f.host.capture = async () => { throw new Error("ALPHA_UNAVAILABLE: 추적할 투명 영역이 없습니다. 불투명도에 마스크를 적용하세요."); };
  await f.elements.capture.listeners.click(); await f.flush();
  assert.match(f.elements.status.textContent, /불투명도에 마스크/); assert.equal(f.elements.status.className, "error");
  assert.equal(f.elements.apply.disabled, true); assert.equal(f.elements.capture.disabled, false);
});
