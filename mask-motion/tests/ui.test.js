"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs");
const core = require("../core.js");
function panel({ multiple = false, release = null } = {}) {
  const markup = fs.readFileSync(require.resolve("../index.html"), "utf8");
  const documentListeners = {};
  const elements = Object.fromEntries([...markup.matchAll(/id="([^"]+)"/g)].map(match => [match[1], {
    value: "0", textContent: "", disabled: false, hidden: false, checked: false, attributes: {}, listeners: {}, style: {}, children: [],
    focus() { this.focused = true; },
    get firstChild() { return this.children[0]; },
    appendChild(child) { this.children.push(child); }, removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
    getAttribute(key) { return this.attributes[key]; }, setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; }
  }]));
  elements["mask-choice"].value = "";
  const data = { format: "MaskMotion", version: 1, projectGuid: "p", sequenceGuid: "s", frameTicks: "10",
    source: { name: "video", track: 0, start: "100", end: "130", inPoint: "0" }, size: { width: 1920, height: 1080 },
    samples: [{ ticks: "100", x: .2, y: .3 }, { ticks: "110", x: .3, y: .3 }, { ticks: "120", x: .4, y: .3 }] };
  let target = false, interval, sequenceGuid = "s";
  const folder = { isFolder: true }, files = {};
  const context = () => ({ projectGuid: "p", sequenceGuid, project: { path: "/work/demo.prproj" } });
  const source = () => target ? { ...data.source, name: "subtitle", track: 1 } : data.source;
  const masks = multiple ? [{ id: "mask-a", name: "01", tracked: true }, { id: "mask-b", name: "02", tracked: true }, { id: "seed", name: "03", tracked: false }] : [{ id: "mask-a", name: "01", tracked: true }];
  const calls = [];
  const host = {
    selection: async () => ({ ...context(), clip: {
      getName: async () => target ? "subtitle" : "video", getTrackIndex: async () => target ? 1 : 0,
      getStartTime: async () => ({ ticks: "100" }), getEndTime: async () => ({ ticks: "130" }), getInPoint: async () => ({ ticks: "0" })
    } }),
    listMasks: async () => { calls.push(["list"]); return { ...context(), folder, masks, source: source() }; },
    captureMask: async (ppro, uxp, options) => { calls.push(["capture", options]); options.rangeInfo({ source: data.source }); options.sampleProgress({ completed: 3, total: 3 }); return { ...data, maskId: options.maskId, maskName: options.maskId === "mask-b" ? "02" : "01", method: "saved-object-mask-centroid-experimental" }; },
    addTransform: async () => { calls.push(["add"]); return { componentIndex: 3 }; },
    prepare: async (ppro, tracking, options) => { calls.push(["prepare", tracking, options]); return { keys: tracking.samples }; },
    apply: async () => { calls.push(["apply"]); return { effect: "Transform", keyCount: 3, removedUnexpected: [] }; }
  };
  const uxp = { shell: { openExternal: async url => { calls.push(["release", url]); return ""; } }, entrypoints: { setup() {} }, storage: { localFileSystem: {
    getFolder: async () => { calls.push(["picker"]); return folder; },
    getEntryWithUrl: async url => { assert.equal(url, "file:/work"); return folder; },
    getDataFolder: async () => ({
      getEntry: async name => { if (!(name in files)) throw Error("not found"); return { read: async () => files[name] }; },
      createFile: async name => ({ write: async text => { files[name] = text; } })
    })
  } } };
  vm.runInNewContext(fs.readFileSync(require.resolve("../index.js"), "utf8"), {
    require: name => ({ premierepro: {}, uxp, "./host.js": host, "./core.js": core, "./project-access.js": require("../project-access.js"), "./updates.js": require("../updates.js") })[name],
    document: { readyState: "complete", addEventListener: (name, callback) => { documentListeners[name] = callback; }, createElement: () => ({ listeners: {}, setAttribute() {}, addEventListener(name, callback) { this.listeners[name] = callback; } }), getElementById: id => { assert.ok(elements[id], id); return elements[id]; } },
    console: { log() {}, warn() {} }, fetch: async () => ({ ok: true, json: async () => release ? [release] : [] }), setInterval: (callback, ms) => { if (ms === 1000) interval = callback; return ms; }, clearInterval() {}
  });
  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  return { elements, documentListeners, host, uxp, calls, files, folder, data, masks, flush,
    tick: async () => { await interval(); await flush(); },
    setTarget: value => { target = value; },
    setSequence: value => { sequenceGuid = value; },
    chooseTarget: async () => { target = true; await flush(); await interval(); await flush(); },
    chooseSource: async () => { target = false; await flush(); await interval(); await flush(); }
  };
}
test("connected project automatically lists masks, captures the selected mask and applies to a target", async () => {
  const f = panel(); await f.flush();
  assert.deepEqual(f.calls.map(x => x[0]), ["list"]);
  assert.equal(f.elements["mask-choice"].value, "mask-a");
  assert.equal(f.elements.capture.disabled, false);
  await f.elements.capture.listeners.click(); await f.flush();
  const options = f.calls.find(x => x[0] === "capture")[1];
  assert.equal(options.range, "clip"); assert.equal(options.folder, f.folder);
  assert.equal(options.maskId, "mask-a"); assert.equal(options.expectedSource.source, f.data.source);
  assert.equal(f.elements.percent.textContent, "100%");
  await f.chooseTarget(); assert.equal(f.elements.apply.disabled, false);
  assert.equal(f.elements["source-name"].textContent, "video");
  assert.equal(f.elements["target-name"].textContent, "subtitle");
  assert.equal(f.elements["source-badge"].textContent, "분석 완료");
  assert.equal(f.elements["source-message"].textContent, "");
  assert.equal(f.elements.capture.disabled, true);
  await f.elements.apply.listeners.click(); await f.flush();
  assert.deepEqual(f.calls.map(x => x[0]), ["list", "capture", "prepare", "apply"]);
  assert.equal(f.elements["target-badge"].textContent, "적용 완료");
  assert.equal(f.elements["target-message"].textContent, "");
});
test("capture finishes with its original source across clip and sequence navigation", async () => {
  const f = panel(); await f.flush();
  const capture = f.host.captureMask;
  let finish;
  f.host.captureMask = async (...args) => {
    await new Promise(resolve => { finish = resolve; });
    return capture(...args);
  };
  const pending = f.elements.capture.listeners.click(); await f.flush();
  f.setTarget(true); await f.tick();
  f.setSequence("another-sequence"); await f.tick();
  assert.equal(f.elements["source-name"].textContent, "video");
  finish(); await pending; await f.flush(); await f.tick();
  assert.equal(f.elements["source-badge"].textContent, "분석 완료");
  assert.equal(f.elements["source-name"].textContent, "video");
  assert.equal(f.elements.apply.disabled, true);
  assert.equal(f.calls.filter(call => call[0] === "list").length, 1);
  f.setSequence("s"); await f.tick();
  assert.equal(f.elements.apply.disabled, false);
  await f.elements.apply.listeners.click(); await f.flush();
  const tracking = f.calls.find(call => call[0] === "prepare")[1];
  assert.equal(tracking.sequenceGuid, "s"); assert.equal(tracking.source.name, "video");
});
test("clip selection and refresh resolve the project path without any folder picker", async () => {
  const f = panel(); await f.flush();
  assert.equal(f.elements.capture.disabled, false);
  assert.equal(f.elements["connect-folder"], undefined);
  await f.chooseTarget(); assert.equal(f.elements["source-name"].textContent, "subtitle");
  await f.chooseSource(); await f.elements["read-masks"].listeners.click(); await f.flush();
  assert.equal(f.calls.filter(x => x[0] === "picker").length, 0);
  assert.equal(f.calls.filter(x => x[0] === "list").length, 4);
  assert.equal(f.elements["source-name"].textContent, "video");
  assert.equal(f.elements.apply.disabled, true);
});
test("unchanged source and target selections do not rewrite the step-three text", async () => {
  const f = panel(); await f.flush();
  let writes = 0;
  for (const id of ["target-name", "target-meta"]) {
    const node = f.elements[id]; let text = node.textContent;
    Object.defineProperty(node, "textContent", { get: () => text, set: value => { writes++; text = value; } });
  }
  for (let i = 0; i < 5; i++) await f.tick();
  assert.equal(writes, 0);
  assert.equal(f.elements["target-name"].textContent, "분석 후 움직일 클립을 선택하세요.");
  await f.elements.capture.listeners.click(); await f.flush();
  await f.chooseTarget();
  assert.equal(f.elements["target-name"].textContent, "subtitle");
  assert.equal(f.elements["target-meta"].textContent, "V2");
  assert.equal(f.elements.apply.disabled, false);
  writes = 0;
  for (let i = 0; i < 5; i++) await f.tick();
  assert.equal(writes, 0);
  await f.chooseSource();
  assert.equal(f.elements["target-name"].textContent, "움직일 대상 클립을 선택하세요.");
  assert.equal(f.elements["target-meta"].textContent, "");
  assert.equal(f.elements.apply.disabled, true);
  writes = 0;
  for (let i = 0; i < 5; i++) await f.tick();
  assert.equal(writes, 0);
});
test("multiple masks require an explicit choice and changing it invalidates the measured result", async () => {
  const f = panel({ multiple: true }); await f.flush();
  assert.equal(f.elements["mask-choice"].value, ""); assert.equal(f.elements.capture.disabled, true);
  assert.deepEqual(f.elements["mask-choice"].children.map(x => x.value), ["", "mask-a", "mask-b", "seed"]);
  assert.equal(f.elements["mask-choice"].children[3].disabled, true);
  f.elements["mask-picker"].listeners.click();
  assert.equal(f.elements["mask-options"].hidden, false);
  f.elements["mask-options"].children[1].listeners.click();
  assert.equal(f.elements["mask-choice"].value, "mask-b");
  assert.equal(f.elements["mask-options"].hidden, true);
  assert.match(f.elements["mask-picker-label"].textContent, /02/);
  assert.equal(f.elements.capture.disabled, false);
  await f.elements.capture.listeners.click(); await f.flush();
  assert.equal(f.calls.find(x => x[0] === "capture")[1].maskId, "mask-b");
  await f.chooseTarget(); assert.equal(f.elements.apply.disabled, false);
  f.elements["mask-choice"].value = "mask-a"; f.elements["mask-choice"].listeners.change();
  assert.equal(f.elements.apply.disabled, true); assert.equal(f.elements.capture.disabled, true);
  await f.tick(); assert.equal(f.elements["source-name"].textContent, "video");
  await f.chooseSource(); assert.equal(f.elements.capture.disabled, false);
});
test("changing source explicitly resumes live selection; another sequence never enables apply", async () => {
  const f = panel(); await f.flush(); await f.elements.capture.listeners.click(); await f.flush();
  f.setSequence("other"); await f.chooseTarget(); assert.equal(f.elements.apply.disabled, true);
  f.setSequence("s"); await f.tick(); assert.equal(f.elements.apply.disabled, false);
  assert.equal(f.elements["change-source"], undefined);
  assert.equal(f.elements["read-masks"].disabled, false);
  f.elements["read-masks"].listeners.click(); await f.flush();
  assert.equal(f.elements["source-name"].textContent, "subtitle"); assert.equal(f.elements.apply.disabled, true);
});
test("late mask results are discarded when the selected clip changes", async () => {
  const f = panel(); await f.flush();
  let release;
  f.host.listMasks = () => new Promise(resolve => { release = resolve; });
  f.setTarget(true); const pending = f.tick(); await f.flush();
  f.setTarget(false);
  release({ folder: f.folder, masks: [{ id: "stale", name: "wrong", tracked: true }], source: { ...f.data.source, name: "subtitle", track: 1 }, projectGuid: "p", sequenceGuid: "s" });
  await pending;
  assert.equal(f.elements["mask-choice"].value, ""); assert.equal(f.elements.capture.disabled, true);
});
test("tracking uses Motion and requests an empty Transform for scaling", async () => {
  const f = panel(); await f.flush();
  assert.equal(f.elements["alpha-mode"], undefined);
  assert.equal(f.elements["diagnose-timing"], undefined);
  assert.equal(f.elements.output, undefined);
  await f.elements.capture.listeners.click(); await f.flush();
  assert.equal(f.elements["motion-mode"], undefined);
  await f.chooseTarget(); await f.elements.apply.listeners.click(); await f.flush();
  assert.equal(f.calls.some(call => call[0] === "add"), false);
  assert.equal(f.calls.find(call => call[0] === "prepare")[2].effect, "motion");
  assert.equal(f.calls.find(call => call[0] === "prepare")[2].appendEmptyTransform, true);
});
test("empty selection resets the card once and resumes when a clip is selected", async () => {
  const f = panel(); await f.flush();
  const originalSelection = f.host.selection;
  f.host.selection = async () => { throw Error("no selected clip"); };
  await f.tick();
  const placeholder = f.elements["mask-choice"].firstChild;
  let writes = 0;
  for (const id of ["source-name", "source-meta", "target-name", "target-meta"]) {
    const node = f.elements[id]; let value = node.textContent;
    Object.defineProperty(node, "textContent", { get: () => value, set: next => { writes++; value = next; } });
  }
  for (let i = 0; i < 5; i++) await f.tick();
  assert.equal(writes, 0);
  assert.equal(f.elements["mask-choice"].firstChild, placeholder);
  assert.equal(f.elements.capture.disabled, true);
  assert.equal(f.elements.apply.disabled, true);
  f.host.selection = originalSelection; await f.tick();
  assert.equal(f.elements["source-name"].textContent, "video");
  assert.equal(f.elements["mask-choice"].value, "mask-a");
  assert.equal(f.elements.capture.disabled, false);
  writes = 0; await f.tick(); assert.equal(writes, 0);
});

test("only release updates appear at the top; capture errors stay by measurement", async () => {
  const f = panel({release: {tag_name:"v1.0.1",draft:false,prerelease:false}}); await f.flush();
  assert.equal(f.elements.status, undefined);
  assert.equal(f.elements["notice-area"].hidden, false);
  assert.equal(f.elements["update-notice"].hidden, false);
  assert.match(f.elements["update-message"].textContent, /1\.0\.1/);
  await f.elements["update-open"].listeners.click();
  assert.equal(f.calls.find(call => call[0] === "release")[1], "https://github.com/Chamhyul/premiere-mask-tracker/releases/tag/v1.0.1");
  f.host.captureMask = async () => { throw Error("측정 실패"); };
  await f.elements.capture.listeners.click(); await f.flush();
  assert.equal(f.elements["update-notice"].hidden, false);
  assert.match(f.elements["source-message"].textContent,/분석 실패/);
  assert.equal(f.elements["source-message"].className, "message error");
  assert.equal(f.elements["target-message"].textContent, "");
  assert.equal(f.elements["progress-area"].hidden, true);
});
test('measurement recovery gives one local review notice without diagnostic counts or times', async () => {
 const f=panel();await f.flush();
 const capture=f.host.captureMask;
 f.host.captureMask=async(...args)=>({...await capture(...args),recovery:{estimated:1,interpolated:1,held:1,ranges:[{quality:'held',startTicks:'100',endTicks:'110',frames:1}]}});
 await f.elements.capture.listeners.click();await f.flush();
 assert.match(f.elements['source-message'].textContent,/추정.*확인하세요/);
 assert.doesNotMatch(f.elements['source-message'].textContent,/프레임|100|110|보간|Position/);
 assert.equal(f.elements['source-message'].className,'message warning');
 assert.equal(f.elements['progress-area'].hidden,true);
 assert.equal(f.elements['notice-area'].hidden,true);
});
test('apply errors stay beside the target and persist across unchanged selection polling',async()=>{
 const f=panel();await f.flush();await f.elements.capture.listeners.click();await f.flush();await f.chooseTarget();
 f.host.apply=async()=>{throw Error('적용 후 키프레임 검증 실패 (시간 또는 값 불일치). Premiere에서 실행 취소하세요.');};
 await f.elements.apply.listeners.click();await f.flush();
 assert.match(f.elements['target-message'].textContent,/실행 취소/);
 assert.doesNotMatch(f.elements['target-message'].textContent,/키프레임|검증 실패|Premiere/);
 assert.equal(f.elements['target-message'].className,'message error');
 assert.equal(f.elements['source-message'].textContent,'');
 assert.equal(f.elements['notice-area'].hidden,true);
 const message=f.elements['target-message'].textContent;await f.tick();await f.tick();
 assert.equal(f.elements['target-message'].textContent,message);
});
test('list errors and release-link errors remain next to their respective controls',async()=>{
 const f=panel({release:{tag_name:'v1.0.1',draft:false,prerelease:false}});await f.flush();
 f.host.listMasks=async()=>{throw Error('프로젝트를 먼저 저장하세요.');};
 await f.elements['read-masks'].listeners.click();await f.flush();
 assert.match(f.elements['mask-message'].textContent,/프로젝트.*저장/);
 assert.equal(f.elements['source-message'].textContent,'');
 f.uxp.shell.openExternal=async()=>{throw Error('native shell failed');};
 await f.elements['update-open'].listeners.click();await f.flush();
 assert.match(f.elements['update-error'].textContent,/열지 못했습니다/);
 assert.match(f.elements['mask-message'].textContent,/프로젝트.*저장/);
});
test('native progress details and file identifiers never become panel text',async()=>{
 const f=panel();await f.flush();let finish;
 f.host.captureMask=async(p,u,options)=>{
  options.progress('PRMF file 123.prmf / offset 345');options.sampleProgress({completed:1,total:3});
  await new Promise(resolve=>finish=resolve);throw Error('PRMF 123.prmf offset 범위 초과');
 };
 const pending=f.elements.capture.listeners.click();await f.flush();
 assert.equal(f.elements['progress-label'].textContent,'분석 중');
 assert.equal(f.elements['source-message'].textContent,'');assert.equal(f.elements.percent.textContent,'33%');
 finish();await pending;await f.flush();
 assert.match(f.elements['source-message'].textContent,/클립을 다시 선택/);
 assert.doesNotMatch(f.elements['source-message'].textContent,/PRMF|123|offset|345/);
});

test("mask menu dismisses on outside clicks and Escape, preserving inside clicks", async () => {
  const f = panel(); await f.flush();
  const picker = f.elements["mask-picker"], menu = f.elements["mask-options"];
  picker.listeners.click();
  f.documentListeners.click({ target: { parentNode: picker } });
  assert.equal(menu.hidden, false);
  f.documentListeners.click({ target: { parentNode: menu } });
  assert.equal(menu.hidden, false);
  f.documentListeners.click({ target: f.elements.capture });
  assert.equal(menu.hidden, true); assert.equal(picker.attributes["aria-expanded"], "false");
  picker.listeners.click(); let prevented = false;
  f.documentListeners.keydown({ key: "Escape", preventDefault() { prevented = true; } });
  assert.equal(menu.hidden, true); assert.equal(picker.attributes["aria-expanded"], "false");
  assert.equal(prevented, true); assert.equal(picker.focused, true);
});

test("analysis terminology preserves cancellation from native measurement errors", async () => {
  const f = panel(); await f.flush();
  assert.equal(f.elements["source-badge"].textContent, "대기");
  f.host.captureMask = async () => { throw Error("측정을 중지했습니다."); };
  await f.elements.capture.listeners.click(); await f.flush();
  assert.equal(f.elements["source-badge"].textContent, "중지");
  assert.equal(f.elements["source-message"].textContent, "분석을 중지했습니다.");
  assert.equal(f.elements["target-badge"].textContent, "대기");
});
