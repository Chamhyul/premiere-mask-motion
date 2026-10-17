"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const host = require("../host.js");
function track(muted, failRestore = false) {
  const original = muted;
  return { muted, async isMuted() { return this.muted; },
    async setMute(value) { if (failRestore && value === original) throw new Error("host failure"); this.muted = value; return true; } };
}
test("isolation restores originally hidden and visible tracks on success", async () => {
  const tracks = [track(false), track(true), track(false)], recovery = [];
  const sequence = { getVideoTrackCount: async () => tracks.length, getVideoTrack: async i => tracks[i] };
  const result = await host.isolated(sequence, 1, recovery, async () => {
    assert.deepEqual(tracks.map(t => t.muted), [true, false, true]); return "done";
  });
  assert.equal(result, "done"); assert.deepEqual(tracks.map(t => t.muted), [false, true, false]);
  assert.ok(recovery.every(entry => !entry.pending));
});
test("failed export/cancel restores every track", async () => {
  const tracks = [track(false), track(false)], recovery = [];
  const sequence = { getVideoTrackCount: async () => 2, getVideoTrack: async i => tracks[i] };
  await assert.rejects(host.isolated(sequence, 0, recovery, async () => { throw new Error("cancelled"); }), /cancelled/);
  assert.deepEqual(tracks.map(t => t.muted), [false, false]);
});
test("failed restore retains recovery data and still restores other tracks", async () => {
  const tracks = [track(false, true), track(true)], recovery = [];
  const sequence = { getVideoTrackCount: async () => 2, getVideoTrack: async i => tracks[i] };
  await assert.rejects(host.isolated(sequence, 1, recovery, async () => 1), /복구 실패/);
  assert.equal(recovery[0].pending, true); assert.equal(recovery[1].pending, false); assert.equal(tracks[1].muted, true);
  tracks[0].setMute = async function (v) { this.muted = v; return true; };
  await host.restoreTracks(recovery); assert.equal(tracks[0].muted, false); assert.equal(recovery[0].pending, false);
});
function fixture() {
  const state = { enabled: false, keys: [], transactions: 0, interpolate: [] };
  const time = ticks => ({ ticks });
  const param = { areKeyframesSupported: async () => true, isTimeVarying: async () => state.enabled,
    getKeyframeListAsTickTimes: async () => state.keys.map(k => k.position),
    getStartValue: async () => ({ value: { value: [0.5, 0.5] } }),
    createKeyframe: value => ({ value: { value: [value.x, value.y] }, position: time("0") }),
    createSetTimeVaryingAction: value => () => { state.enabled = value; },
    createAddKeyframeAction: key => () => { assert.ok(state.enabled); state.keys.push(key); },
    createRemoveKeyframeAction: t => () => { state.keys = state.keys.filter(key => key.position.ticks !== t.ticks); },
    createSetInterpolationAtKeyframeAction: (t, mode) => () => { assert.ok(state.keys.some(k => k.position.ticks === t.ticks)); state.interpolate.push(mode); },
    getValueAtTime: async t => state.keys.find(k => k.position.ticks === t.ticks) };
  class Clip {
    async getName() { return "text nest"; } async getTrackIndex() { return 1; }
    async getStartTime() { return time("100"); } async getEndTime() { return time("200"); }
    async getInPoint() { return time("1000"); } async getSpeed() { return 1; } async isSpeedReversed() { return 0; }
    async getProjectItem() { return { isSequence: async () => true, getSequence: async () => sequence }; }
    async getComponentChain() { return { getComponentCount: () => 1, getComponentAtIndex: () => ({ getMatchName: () => "AE.ADBE Motion", getParam: () => param }) }; }
  }
  const clip = new Clip(), sequence = { guid: "sequence", getFrameSize: async () => ({ width: 1920, height: 1080 }),
    getPlayerPosition: async () => time("100"), getSelection: async () => ({ getTrackItems: async () => [clip] }) };
  const project = { guid: "project", getActiveSequence: async () => sequence,
    lockedAccess: cb => cb(), executeTransaction: cb => { const actions = []; cb({ addAction: a => actions.push(a) }); actions.forEach(a => a()); state.transactions++; return true; } };
  const ppro = { VideoClipTrackItem: Clip, Project: { getActiveProject: async () => project },
    ClipProjectItem: { cast: item => item }, TickTime: { createWithTicks: time },
    PointF: class { constructor(x, y) { this.x = x; this.y = y; } }, Constants: { InterpolationMode: { LINEAR: 0 } } };
  const tracking = { projectGuid: "project", sequenceGuid: "sequence", source: { name: "source", track: 0 },
    size: { width: 1920, height: 1080 }, samples: [{ ticks: "100", x: 0.2, y: 0.4 }, { ticks: "110", x: 0.3, y: 0.5 }] };
  return { state, ppro, tracking, param, sequence, clip };
}
test("prepare then apply writes mapped PointF keys in one transaction and verifies", async () => {
  const { state, ppro, tracking } = fixture();
  const plan = await host.prepare(ppro, tracking);
  assert.equal(state.transactions, 0); assert.equal(plan.keys[1].mediaTicks, "1010");
  const result = await host.apply(ppro, plan);
  assert.equal(result.verified, true); assert.equal(state.transactions, 1);
  assert.equal(state.keys.length, 2); assert.ok(Math.abs(state.keys[1].value.value[0] - 0.6) < 1e-12);
  assert.deepEqual(state.interpolate, [0, 0]);
});
test("existing animation and target edits prevent any write", async () => {
  const f = fixture(); f.state.enabled = true;
  await assert.rejects(host.prepare(f.ppro, f.tracking), /기존 키프레임/);
  f.state.enabled = false; const plan = await host.prepare(f.ppro, f.tracking);
  f.clip.getStartTime = async () => ({ ticks: "101" });
  await assert.rejects(host.apply(f.ppro, plan), /선택 대상/); assert.equal(f.state.transactions, 0);
});
test("PointF runtime mismatch blocks transaction before changes", async () => {
  const f = fixture(), plan = await host.prepare(f.ppro, f.tracking);
  f.param.createKeyframe = () => ({ value: { value: [0, 0] } });
  await assert.rejects(host.apply(f.ppro, plan), /PointF/); assert.equal(f.state.transactions, 0);
});
test("post-write mismatch cannot report success", async () => {
  const f = fixture(), plan = await host.prepare(f.ppro, f.tracking);
  f.param.getValueAtTime = async () => ({ value: [0, 0] });
  await assert.rejects(host.apply(f.ppro, plan), /실행 취소/); assert.equal(f.state.transactions, 1);
});
test("different project or sequence rejects prepared operation", async () => {
  const f = fixture(), plan = await host.prepare(f.ppro, f.tracking);
  f.sequence.guid = "other";
  await assert.rejects(host.apply(f.ppro, plan), /시퀀스가 바뀌/); assert.equal(f.state.transactions, 0);
});
function captureFixture(opaque = false) {
  const f = fixture(), files = new Map(), exports = [];
  f.ppro.Constants.TrackItemType = { TRANSITION: 2 };
  const tracks = [track(false), track(false)];
  tracks[1].getTrackItems = async () => [];
  Object.assign(f.sequence, { getTimebase: async () => "10", getVideoTrackCount: async () => 2,
    getVideoTrack: async i => tracks[i], getCaptionTrackCount: async () => 0 });
  const folder = { nativePath: "/mock/capture",
    getEntry: async name => { if (!files.has(name)) throw new Error("missing file"); return files.get(name); },
    createFile: async name => { const file = { write: async text => { file.text = text; } }; files.set(name, file); return file; } };
  f.ppro.Exporter = { exportSequenceFrame: async (sequence, time, name, path, width, height) => {
    assert.equal(sequence, f.sequence); assert.equal(path, folder.nativePath);
    assert.deepEqual(tracks.map(t => t.muted), [true, false]);
    const bytes = Buffer.alloc(18 + width * height * 4);
    bytes[2] = 2; bytes[16] = 32; bytes[17] = 40;
    bytes.writeUInt16LE(width, 12); bytes.writeUInt16LE(height, 14);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      bytes[18 + (y * width + x) * 4 + 3] = opaque || (x >= 10 + exports.length && x < 13 + exports.length && y >= 10 && y < 13) ? 255 : 0;
    }
    files.set(name, { read: async () => bytes, delete: async () => { files.delete(name); } });
    exports.push(time.ticks); return true;
  } };
  const uxp = { host: { version: "mock" }, storage: { formats: { binary: "binary" },
    localFileSystem: { getFolder: async () => ({ createFolder: async () => folder }) } } };
  const options = { frames: 3, step: 1, width: 160, cancelled: () => false, progress: () => {} };
  return { ...f, uxp, options, files, exports, tracks };
}
test("full capture exports correct sequence times and keeps first/last plus JSON", async () => {
  const f = captureFixture();
  const result = await host.capture(f.ppro, f.uxp, f.options, []);
  assert.deepEqual(f.exports, ["100", "110", "120"]);
  assert.equal(result.samples.length, 3); assert.ok(result.samples[2].x > result.samples[0].x);
  assert.deepEqual([...f.files.keys()], ["frame-0000.tga", "frame-0002.tga", "tracking.json"]);
  assert.deepEqual(JSON.parse(f.files.get("tracking.json").text).samples, result.samples);
  assert.deepEqual(f.tracks.map(t => t.muted), [false, false]); assert.equal(f.state.transactions, 0);
});
test("whole-clip capture uses automatic storage and succeeds with the playhead outside the source", async () => {
  const f = captureFixture();
  f.options.range = "clip"; f.options.internalStorage = true;
  f.sequence.getPlayerPosition = async () => { throw new Error("capture must not read the playhead"); };
  f.uxp.storage.localFileSystem.getDataFolder = f.uxp.storage.localFileSystem.getFolder;
  f.uxp.storage.localFileSystem.getFolder = async () => { throw new Error("folder picker must not open"); };
  const progress = []; f.options.sampleProgress = value => progress.push(value);
  const result = await host.capture(f.ppro, f.uxp, f.options, []);
  assert.deepEqual(f.exports, ["100", "110", "120", "130", "140", "150", "160", "170", "180", "190"]);
  assert.equal(result.samples.length, 10); assert.equal(progress[0].alphaChecked, true);
  assert.equal(progress[9].completed, 10); assert.equal(progress[9].total, 10);
});
test("static target preparation no longer requires the playhead at the captured first frame", async () => {
  const f = transformFixture(); f.sequence.getPlayerPosition = async () => { throw new Error("prepare must not read the playhead"); };
  const added = await host.addTransform(f.ppro, f.tracking);
  const plan = await host.prepare(f.ppro, f.tracking, { effect: "transform", addedTransform: added });
  assert.equal(plan.keys[0].mediaTicks, "1000");
  assert.equal((await host.apply(f.ppro, plan)).verified, true);
});
test("opaque first export stops capture immediately, preserves diagnosis and restores tracks", async () => {
  const f = captureFixture(true);
  await assert.rejects(host.capture(f.ppro, f.uxp, f.options, []), /ALPHA_UNAVAILABLE/);
  assert.equal(f.exports.length, 1); assert.equal(f.files.has("tracking.json"), false);
  assert.equal(f.files.has("frame-0000.tga"), true);
  assert.deepEqual(f.tracks.map(t => t.muted), [false, false]); assert.equal(f.state.transactions, 0);
});
test("capture cancellation discards partial trajectory and restores visibility", async () => {
  const f = captureFixture(); f.options.cancelled = () => f.exports.length > 0;
  await assert.rejects(host.capture(f.ppro, f.uxp, f.options, []), /중지/);
  assert.equal(f.exports.length, 1); assert.equal(f.files.has("tracking.json"), false);
  assert.deepEqual(f.tracks.map(t => t.muted), [false, false]);
});
test("readFrame waits for zero-byte and partially written exports", async () => {
  const bytes = Buffer.alloc(34); bytes[2] = 2; bytes[16] = 32; bytes[17] = 32;
  bytes.writeUInt16LE(2, 12); bytes.writeUInt16LE(2, 14);
  let reads = 0, pauses = 0;
  const folder = { getEntry: async () => ({ read: async () => {
    reads++; return reads === 1 ? new ArrayBuffer(0) : reads === 2 ? bytes.subarray(0, 20) : bytes;
  } }) };
  const result = await host.readFrame(folder, "frame.tga", { storage: { formats: { binary: "binary" } } }, { pause: async () => { pauses++; } });
  assert.equal(reads, 3); assert.equal(pauses, 2); assert.equal(result.image.width, 2);
});
function transformFixture() {
  const f = fixture();
  const motionValues = { 1: 100, 2: 100, 3: true, 4: 0 };
  const components = [{ getMatchName: () => "AE.ADBE Motion", getParam: index => index === 0 ? {
    getStartValue: async () => ({ value: { value: [0.5, 0.5] } })
  } : { isTimeVarying: () => false, getStartValue: async () => ({ value: { value: motionValues[index] } }) } }];
  const chain = { getComponentCount: () => components.length, getComponentAtIndex: i => components[i],
    createAppendComponentAction: component => () => components.push(component),
    createRemoveComponentAction: component => () => {
      const index = components.indexOf(component); assert.ok(index >= 0); components.splice(index, 1);
    } };
  f.clip.getComponentChain = async () => chain;
  const projectItem = {};
  const clipProjectItem = { isSequence: async () => false, getMediaFilePath: async () => "/mock/image.png" };
  f.clip.getProjectItem = async () => projectItem;
  f.ppro.ClipProjectItem.cast = item => { assert.equal(item, projectItem); return clipProjectItem; };
  f.ppro.Metadata = { getProjectColumnsMetadata: async item => {
    assert.equal(item, projectItem, "Metadata must receive the original ProjectItem, not its ClipProjectItem wrapper");
    return JSON.stringify([{ ColumnID: "Column.Intrinsic.VideoInfo", ColumnValue: "3840 x 2160 (1.0)" }]);
  } };
  f.ppro.VideoFilterFactory = { createComponent: async name => {
    assert.equal(name, "AE.ADBE Geometry2");
    f.param.displayName = "위치";
    return { getMatchName: () => name, getParamCount: () => 2,
      getParam: i => i === 0 ? { displayName: "기준점", getStartValue: async () => ({ value: { value: [0.5, 0.5] } }) } : f.param };
  } };
  return { ...f, components, motionValues };
}
test("ordinary image gets a new Transform; prepare targets it and preserves Motion", async () => {
  const f = transformFixture();
  // There is deliberately no nested sequence in this fixture.
  const added = await host.addTransform(f.ppro, f.tracking);
  assert.equal(f.components.length, 2); assert.equal(added.componentIndex, 1);
  const plan = await host.prepare(f.ppro, f.tracking, { effect: "transform", addedTransform: added });
  assert.equal(plan.destination.matchName, "AE.ADBE Geometry2");
  assert.ok(Math.abs(plan.keys[1].x - 0.55) < 1e-12); // 1920/3840 source basis
  const result = await host.apply(f.ppro, plan);
  assert.equal(result.effect, "Transform"); assert.equal(f.state.transactions, 2);
  assert.deepEqual(f.motionValues, { 1: 100, 2: 100, 3: true, 4: 0 });
});
test("preview retries reuse the created Transform and don't duplicate effects", async () => {
  const f = transformFixture();
  const first = await host.addTransform(f.ppro, f.tracking);
  const second = await host.addTransform(f.ppro, f.tracking, first);
  assert.equal(second, first); assert.equal(f.components.length, 2); assert.equal(f.state.transactions, 1);
});
test("new Transform is selected even when old Transform effects exist", async () => {
  const f = transformFixture();
  f.components.push({ getMatchName: () => "AE.ADBE Geometry2", getParam: () => { throw new Error("old effect was touched"); } });
  const added = await host.addTransform(f.ppro, f.tracking);
  assert.equal(added.componentIndex, 2);
  const plan = await host.prepare(f.ppro, f.tracking, { effect: "transform", addedTransform: added });
  assert.equal(plan.destination.componentIndex, 2); await host.apply(f.ppro, plan);
});
test("Transform conversion compensates static Motion scale and rotation", async () => {
  const f = transformFixture(); f.motionValues[1] = 50; f.motionValues[4] = 90;
  const added = await host.addTransform(f.ppro, f.tracking);
  const plan = await host.prepare(f.ppro, f.tracking, { effect: "transform", addedTransform: added });
  const key = plan.keys[1];
  assert.ok(Math.abs(key.x - (0.5 + 108 / 0.5 / 3840)) < 1e-12);
  assert.ok(Math.abs(key.y - (0.5 - 192 / 0.5 / 2160)) < 1e-12);
  f.motionValues[4] = 0;
  await assert.rejects(host.apply(f.ppro, plan), /좌표 기준이 변경/);
  assert.equal(f.state.transactions, 1);
});
test("missing source dimensions require an explicit override", async () => {
  const f = transformFixture(); f.ppro.Metadata.getProjectColumnsMetadata = async () => "[]";
  const added = await host.addTransform(f.ppro, f.tracking);
  await assert.rejects(host.prepare(f.ppro, f.tracking, { effect: "transform", addedTransform: added }), /가로·세로 크기/);
  const plan = await host.prepare(f.ppro, f.tracking, { effect: "transform", addedTransform: added, basisWidth: 1920, basisHeight: 1080 });
  assert.ok(Math.abs(plan.keys[1].x - 0.6) < 1e-12);
});
test("creating Transform on source clip is refused before any mutation", async () => {
  const f = transformFixture();
  f.tracking.source = { name: "text nest", track: 1, start: "100", end: "200", inPoint: "1000" };
  await assert.rejects(host.addTransform(f.ppro, f.tracking), /원본이 선택/);
  assert.equal(f.state.transactions, 0);
});
test("production-path diagnosis detects a zero key alongside all planned keys and removes only temporary effect", async () => {
  const f = transformFixture();
  f.components.push({ getMatchName: () => "AE.ADBE Geometry2", getParam: () => { throw new Error("existing effect touched"); } });
  f.param.createSetTimeVaryingAction = value => () => {
    f.state.enabled = value;
    f.state.keys.push({ position: { ticks: "0" }, value: { value: [0, 0] } });
  };
  const report = await host.diagnoseTiming(f.ppro, f.tracking);
  assert.equal(report.error, undefined);
  assert.equal(report.firstUnexpectedStage, null);
  assert.deepEqual(report.stages.map(stage => stage.count), [0, 2]);
  assert.deepEqual(report.stages[1].unexpected, []);
  assert.deepEqual(report.application.removedUnexpected, [{ ticks: "0", value: { x: 0, y: 0 } }]);
  assert.deepEqual(report.stages[1].missing, []);
  assert.equal(report.application.keyCount, 2);
  assert.equal(f.state.transactions, 4); // append, production apply, extra-key cleanup, effect removal
  assert.equal(report.cleanup, "removed"); assert.equal(f.components.length, 2);
});
test("extra-key cleanup keeps the intended first key even when it is at time zero", async () => {
  const f = fixture(); f.clip.getInPoint = async () => ({ ticks: "0" });
  const plan = await host.prepare(f.ppro, f.tracking);
  const result = await host.apply(f.ppro, plan);
  assert.equal(result.removedUnexpected.length, 0);
  assert.deepEqual(f.state.keys.map(key => key.position.ticks), ["0", "10"]);
  assert.equal(f.state.transactions, 1);
});
test("a host that retains an extra key after removal cannot pass complete verification", async () => {
  const f = fixture(); const plan = await host.prepare(f.ppro, f.tracking);
  f.param.createSetTimeVaryingAction = value => () => {
    f.state.enabled = value; f.state.keys.push({ position: { ticks: "0" }, value: { value: [0, 0] } });
  };
  f.param.createRemoveKeyframeAction = () => () => {};
  await assert.rejects(host.apply(f.ppro, plan), /전체 키프레임 시간 또는 개수 불일치/);
});
test("timing diagnosis retains partial findings and removes temporary effect after a host failure", async () => {
  const f = transformFixture();
  f.param.createSetInterpolationAtKeyframeAction = () => { throw new Error("interpolation failure"); };
  const report = await host.diagnoseTiming(f.ppro, f.tracking);
  assert.match(report.error, /interpolation failure/);
  assert.equal(report.stages.length, 2);
  assert.equal(report.firstUnexpectedStage, null);
  assert.equal(report.cleanup, "removed"); assert.equal(f.components.length, 1);
});
test("diagnosis uses exactly the same action order and complete keyframe values as production apply", async () => {
  async function record(diagnostic) {
    const f = transformFixture(), batches = [];
    const project = await f.ppro.Project.getActiveProject();
    project.executeTransaction = callback => {
      const actions = []; callback({ addAction: action => actions.push(action) });
      batches.push(actions.length); actions.forEach(action => action()); f.state.transactions++; return true;
    };
    const order = [];
    for (const method of ["createSetTimeVaryingAction", "createAddKeyframeAction", "createSetInterpolationAtKeyframeAction"]) {
      const original = f.param[method];
      f.param[method] = (...args) => { order.push(method); return original(...args); };
    }
    if (diagnostic) await host.diagnoseTiming(f.ppro, f.tracking);
    else {
      const added = await host.addTransform(f.ppro, f.tracking);
      await host.apply(f.ppro, await host.prepare(f.ppro, f.tracking, { effect: "transform", addedTransform: added }));
    }
    return { order, applyBatch: batches[1], keys: f.state.keys, interpolation: f.state.interpolate };
  }
  assert.deepEqual(await record(true), await record(false));
});
