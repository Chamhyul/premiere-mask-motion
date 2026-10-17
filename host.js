"use strict";
const core = require("./core.js");

const guid = value => value.toString();
const time = value => String(value.ticks);
async function selection(ppro) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("활성 프로젝트가 없습니다.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("활성 시퀀스가 없습니다.");
  const selected = await (await sequence.getSelection()).getTrackItems();
  const clips = selected.filter(item => item instanceof ppro.VideoClipTrackItem);
  if (clips.length !== 1) throw new Error("비디오 또는 그래픽 클립 하나를 선택하세요. 연결된 오디오는 제외합니다.");
  return { project, sequence, clip: clips[0], projectGuid: guid(project.guid), sequenceGuid: guid(sequence.guid) };
}
async function active(ppro, context) {
  const project = await ppro.Project.getActiveProject();
  const sequence = project && await project.getActiveSequence();
  if (!sequence || guid(project.guid) !== context.projectGuid || guid(sequence.guid) !== context.sequenceGuid) throw new Error("작업 중 프로젝트 또는 시퀀스가 바뀌었습니다. 원래 시퀀스로 돌아오세요.");
}
async function clipInfo(clip) {
  return { name: await clip.getName(), track: await clip.getTrackIndex(),
    start: time(await clip.getStartTime()), end: time(await clip.getEndTime()),
    inPoint: time(await clip.getInPoint()), speed: await clip.getSpeed(), reversed: !!(await clip.isSpeedReversed()) };
}
async function dimensions(sequence) {
  const rect = await sequence.getFrameSize();
  if (!Number.isInteger(rect.width) || !Number.isInteger(rect.height) || rect.width < 1 || rect.height < 1) throw new Error("시퀀스 해상도를 읽을 수 없습니다.");
  return { width: rect.width, height: rect.height };
}
function sameClip(a, b) { return a.track === b.track && a.start === b.start && a.end === b.end && a.name === b.name && a.inPoint === b.inPoint; }

// Recovery state is kept until every original visibility setting is restored.
async function restoreTracks(recovery) {
  const failures = [];
  for (const entry of recovery) {
    if (!entry.pending) continue;
    try {
      if (await entry.track.setMute(entry.muted) === false || await entry.track.isMuted() !== entry.muted) throw new Error("표시 상태가 일치하지 않습니다.");
      entry.pending = false;
    } catch (error) { failures.push("V" + (entry.index + 1) + ": " + String(error.message || error)); }
  }
  if (failures.length) throw new Error("트랙 표시 복구 실패 — 복구 재시도 버튼을 누르세요. " + failures.join(" / "));
}
async function isolated(sequence, sourceIndex, recovery, task) {
  if (recovery.some(entry => entry.pending)) throw new Error("먼저 트랙 표시 복구를 완료하세요.");
  recovery.length = 0;
  const count = await sequence.getVideoTrackCount();
  // Read all states before the first write.
  for (let i = 0; i < count; i++) {
    const track = await sequence.getVideoTrack(i);
    recovery.push({ track, index: i, muted: await track.isMuted(), pending: false });
  }
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= count) throw new Error("원본 트랙을 확인할 수 없습니다.");
  let result, error;
  try {
    for (const entry of recovery) {
      const muted = entry.index !== sourceIndex;
      if (entry.muted !== muted) {
        entry.pending = true; // setMute can throw after changing host state.
        if (await entry.track.setMute(muted) === false || await entry.track.isMuted() !== muted) throw new Error("측정을 위한 트랙 표시 전환에 실패했습니다.");
      }
    }
    result = await task();
  } catch (e) { error = e; }
  try { await restoreTracks(recovery); }
  catch (restoreError) { throw new Error((error ? String(error.message || error) + " / " : "") + restoreError.message); }
  if (error) throw error;
  return result;
}

// Premiere 26.5.2 returned success before the TGA payload was written:
// immediate UXP read was a zero-byte ArrayBuffer, but the final file was valid.
async function readFrame(folder, name, uxp, options = {}) {
  const pause = options.pause || (() => new Promise(resolve => setTimeout(resolve, 100)));
  let lastError = "파일이 아직 비어 있습니다.";
  for (let attempt = 0; attempt < 50; attempt++) {
    if (options.cancelled && options.cancelled()) throw new Error("측정을 중지했습니다.");
    try {
      const file = await folder.getEntry(name);
      const buffer = await file.read({ format: uxp.storage.formats.binary });
      const bytes = new Uint8Array(buffer);
      if (options.diagnostic) options.diagnostic({ attempt: attempt + 1, byteLength: bytes.length });
      if (bytes.length >= 18) {
        // This host writes real alpha in byte 4 but leaves the TGA descriptor
        // alpha-bit count at 0. Accept only our own Premiere exports here;
        // measure() still requires a non-empty object and transparent backdrop.
        const image = core.decodeAlpha(bytes, { allowPremiereAlpha: true });
        return { file, image, byteLength: bytes.length };
      }
    } catch (error) {
      lastError = String(error.message || error);
      if (/ALPHA_UNAVAILABLE|해상도/.test(lastError)) throw error;
    }
    await pause();
  }
  throw new Error("프레임 저장 완료를 5초 동안 기다렸지만 읽을 수 없습니다: " + lastError);
}

async function capture(ppro, uxp, options, recovery) {
  options.progress("선택한 원본 클립을 확인하고 있습니다…");
  const context = await selection(ppro), source = await clipInfo(context.clip);
  const size = await dimensions(context.sequence);
  const frameTicks = await context.sequence.getTimebase();
  const times = options.range === "clip" || options.frames === undefined
    ? core.clipSampleTimes(source.start, source.end, frameTicks, options.step)
    : core.sampleTimes(time(await context.sequence.getPlayerPosition()), source.start, source.end, frameTicks, options.frames, options.step);
  if (options.rangeInfo) options.rangeInfo({ source, size, count: times.length, frameTicks: String(frameTicks) });
  if (!Number.isInteger(options.width) || options.width < 160 || options.width > 1920) throw new Error("측정 해상도는 160–1920 사이의 정수로 입력하세요.");
  const height = Math.max(1, Math.round(options.width * size.height / size.width));
  if (options.width * height > 4000000) throw new Error("측정 해상도를 줄이세요 (400만 픽셀 상한).");
  const sourceTrack = await context.sequence.getVideoTrack(source.track);
  const transitions = await sourceTrack.getTrackItems(ppro.Constants.TrackItemType.TRANSITION, false);
  for (const transition of transitions) {
    if (core.ticks(time(await transition.getStartTime())) <= core.ticks(times[times.length - 1]) && core.ticks(time(await transition.getEndTime())) > core.ticks(times[0])) {
      throw new Error("측정 구간에 전환 효과가 있습니다. 전환을 제외한 구간을 사용하세요.");
    }
  }
  // Captions may be composited outside the video track visibility switches.
  if (await context.sequence.getCaptionTrackCount() > 0) throw new Error("첫 버전은 캡션 트랙이 없는 시퀀스에서 측정하세요. 그래픽 텍스트는 사용할 수 있습니다.");
  options.progress(options.internalStorage ? "측정을 준비하고 있습니다…" : "프레임을 저장할 폴더를 선택하세요.");
  const folder = options.internalStorage ? await uxp.storage.localFileSystem.getDataFolder() : await uxp.storage.localFileSystem.getFolder();
  if (!folder) throw new Error("측정을 취소했습니다.");
  const work = await folder.createFolder("mask-motion-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8));
  const diagnostic = options.diagnostic || (() => {});
  diagnostic({ stage: "capture", folder: work.nativePath, source, size, sampleCount: times.length });
  await active(ppro, context);
  return isolated(context.sequence, source.track, recovery, async () => {
    const samples = [];
    for (let i = 0; i < times.length; i++) {
      if (options.cancelled()) throw new Error("측정을 중지했습니다. 부분 결과는 적용하지 않습니다.");
      await active(ppro, context);
      if (!sameClip(source, await clipInfo(context.clip))) throw new Error("원본 클립이 수정되었습니다. 다시 측정하세요.");
      const name = "frame-" + String(i).padStart(4, "0") + ".tga";
      options.progress(i === 0 ? "투명 영역 확인 중…" : "클립 전체 측정 " + (i + 1) + " / " + times.length);
      diagnostic({ stage: "export", folder: work.nativePath, frame: name, sequenceTicks: times[i] });
      const success = await ppro.Exporter.exportSequenceFrame(context.sequence, ppro.TickTime.createWithTicks(times[i]), name, work.nativePath, options.width, height);
      if (!success) throw new Error("프레임 저장에 실패했습니다: " + name);
      options.progress("프레임 저장 완료 확인 " + (i + 1) + " / " + times.length);
      const { file, image, byteLength } = await readFrame(work, name, uxp, {
        cancelled: options.cancelled,
        diagnostic: state => diagnostic({ stage: "file-read", folder: work.nativePath, frame: name, sequenceTicks: times[i], ...state })
      });
      if (image.width !== options.width || image.height !== height) throw new Error("저장 프레임 크기가 요청과 다릅니다.");
      diagnostic({ stage: "alpha", folder: work.nativePath, frame: name, sequenceTicks: times[i], width: image.width, height: image.height, byteLength, alphaDeclared: image.alphaDeclared });
      samples.push({ ticks: times[i], ...core.measure(image) });
      if (options.sampleProgress) options.sampleProgress({ completed: i + 1, total: times.length, alphaChecked: true });
      // Retain first/last snapshots for diagnosis; only remove our own files.
      if (i > 0 && i < times.length - 1) await file.delete();
    }
    if (options.cancelled()) throw new Error("측정을 중지했습니다.");
    await active(ppro, context);
    if (!sameClip(source, await clipInfo(context.clip))) throw new Error("원본 클립이 수정되었습니다.");
    const result = { format: "MaskMotion", version: 1, capturedAt: new Date().toISOString(),
      hostVersion: uxp.host.version, projectGuid: context.projectGuid, sequenceGuid: context.sequenceGuid,
      source, size, frameTicks: String(frameTicks), exportSize: { width: options.width, height },
      method: "rendered-alpha-weighted-centroid", folder: work.nativePath, samples };
    const json = await work.createFile("tracking.json", { overwrite: false });
    await json.write(JSON.stringify(result, null, 2));
    return result;
  });
}

async function positionParameter(clip, effect = "motion", componentIndex = null) {
  const spec = effect === "motion" ? { match: "AE.ADBE Motion", label: "Motion", index: 0 }
    : effect === "transform" ? { match: "AE.ADBE Geometry2", label: "Transform", index: 1 } : null;
  if (!spec) throw new Error("지원하지 않는 적용 효과입니다.");
  const chain = await clip.getComponentChain();
  const count = await chain.getComponentCount();
  const matches = [];
  for (let i = 0; i < count; i++) {
    const component = await chain.getComponentAtIndex(i);
    if (await component.getMatchName() === spec.match && (componentIndex === null || i === componentIndex)) matches.push({ component, index: i });
  }
  if (!matches.length) throw new Error(spec.label + " 효과가 없습니다. " + (effect === "transform" ? "대상 클립에 비디오 효과 ‘변형(Transform)’을 추가하세요." : "이 클립은 Transform 효과를 추가해 적용하세요."));
  if (matches.length !== 1) throw new Error(spec.label + " 효과가 여러 개입니다. 적용할 효과 하나만 남긴 대상을 사용하세요.");
  const { component, index } = matches[0];
  let param;
  if (effect === "motion") param = await component.getParam(0);
  else {
    // Transform has Anchor and Position point params. Resolve Position by its
    // actual label rather than guessing which PointF is Position.
    const names = ["position", "위치", "位置"];
    const params = await component.getParamCount();
    for (let i = 0; i < params; i++) {
      const candidate = await component.getParam(i);
      if (names.includes(String(candidate.displayName).trim().toLowerCase())) {
        if (param) throw new Error("Transform Position 파라미터가 모호합니다.");
        param = candidate;
      }
    }
    if (!param) throw new Error("Transform의 Position 파라미터를 식별할 수 없습니다. 현재 언어의 효과 파라미터 이름을 확인해야 합니다.");
  }
  if (!await param.areKeyframesSupported()) throw new Error("대상 Position이 키프레임을 지원하지 않습니다.");
  core.point(await param.getStartValue());
  return { param, componentIndex: index, matchName: spec.match, label: spec.label };
}
async function transformBasis(ppro, context, size, options) {
  const units = options.units || "normalized";
  if (!["normalized", "pixels"].includes(units)) throw new Error("Transform Position의 좌표 단위를 선택하세요.");
  // Standard effects run before fixed Motion. Scaling/rotation afterwards
  // changes the screen displacement; invert its static linear transform.
  const chain = await context.clip.getComponentChain();
  let scaleX = 1, scaleY = 1, angle = 0;
  for (let i = 0; i < await chain.getComponentCount(); i++) {
    const comp = await chain.getComponentAtIndex(i);
    if (await comp.getMatchName() !== "AE.ADBE Motion") continue;
    const values = {};
    for (const index of [1, 2, 3, 4]) {
      const p = await comp.getParam(index);
      if (await p.isTimeVarying()) throw new Error("Transform 적용 시 대상 Motion의 Scale/Rotation 애니메이션은 지원하지 않습니다.");
      let value = await p.getStartValue();
      for (let j = 0; j < 4 && value && typeof value === "object" && "value" in value; j++) value = value.value;
      values[index] = value;
    }
    scaleY = values[1] / 100; scaleX = (values[3] ? values[1] : values[2]) / 100;
    angle = values[4] * Math.PI / 180;
    if (![scaleX, scaleY, angle].every(Number.isFinite) || scaleX <= 0 || scaleY <= 0) throw new Error("대상 Motion의 Scale/Rotation을 읽을 수 없거나 크기가 0입니다.");
  }
  const c = Math.cos(angle), s = Math.sin(angle);
  const gain = (width, height) => ({ x: size.width * c / scaleX / width, xy: size.height * s / scaleX / width,
    y: size.height * c / scaleY / height, yx: -size.width * s / scaleY / height });
  if (units === "pixels") return { gain: gain(1, 1), label: "픽셀" };
  let width = Number(options.basisWidth), height = Number(options.basisHeight);
  if (!width && !height) {
    const projectItem = await context.clip.getProjectItem();
    const item = ppro.ClipProjectItem.cast(projectItem);
    if (item && await item.isSequence()) {
      const nativeSize = await dimensions(await item.getSequence()); width = nativeSize.width; height = nativeSize.height;
    } else if (item && ppro.Metadata && typeof ppro.Metadata.getProjectColumnsMetadata === "function") {
      // Metadata requires the original ProjectItem, not the ClipProjectItem
      // wrapper used for clip-specific methods (Premiere rejects that wrapper).
      const columns = JSON.parse(await ppro.Metadata.getProjectColumnsMetadata(projectItem));
      const info = Array.isArray(columns) && columns.find(column => column.ColumnID === "Column.Intrinsic.VideoInfo");
      const match = info && String(info.ColumnValue).match(/^\s*(\d+)\s*[x×]\s*(\d+)(?:\s|$)/);
      if (match) { width = Number(match[1]); height = Number(match[2]); }
    }
    if (!width && !height && item && typeof item.getMediaFilePath === "function" && !(await item.getMediaFilePath())) {
      // Generated graphics have no source media path and use sequence canvas.
      width = size.width; height = size.height;
    }
  }
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 32768)) throw new Error("Transform의 정규화 좌표 기준 가로·세로 크기를 입력하세요. 영상·이미지는 원본 크기, 그래픽은 그래픽 캔버스 크기입니다.");
  return { gain: gain(width, height), label: "정규화 / " + width + "×" + height };
}
async function addTransform(ppro, tracking, previous = null) {
  if (!tracking) throw new Error("먼저 마스크 측정 결과를 준비하세요.");
  const context = await selection(ppro), target = await clipInfo(context.clip);
  if (context.projectGuid !== tracking.projectGuid || context.sequenceGuid !== tracking.sequenceGuid) throw new Error("측정한 시퀀스에서 대상을 선택하세요.");
  if (sameClip(target, tracking.source)) throw new Error("원본이 선택되어 있습니다. 움직일 대상 클립을 선택하세요.");
  if (target.speed !== 1 || target.reversed) throw new Error("대상은 정방향 100% 속도여야 합니다.");
  core.planKeys(tracking.samples, target, { x: 0, y: 0 });
  const chain = await context.clip.getComponentChain(), count = await chain.getComponentCount();
  if (previous && sameClip(previous.target, target) && previous.componentIndex < count &&
      await (await chain.getComponentAtIndex(previous.componentIndex)).getMatchName() === "AE.ADBE Geometry2") return previous;
  const component = await ppro.VideoFilterFactory.createComponent("AE.ADBE Geometry2");
  await active(ppro, context);
  if (!sameClip(target, await clipInfo((await selection(ppro)).clip))) throw new Error("선택 대상이 바뀌었습니다.");
  let success = false;
  context.project.lockedAccess(() => {
    success = context.project.executeTransaction(compound => {
      compound.addAction(chain.createAppendComponentAction(component));
    }, "Mask Motion: 대상에 새 변형 효과 추가");
  });
  if (!success) throw new Error("변형 효과 추가에 실패했습니다.");
  const refreshed = await context.clip.getComponentChain();
  if (await refreshed.getComponentCount() !== count + 1 || await (await refreshed.getComponentAtIndex(count)).getMatchName() !== "AE.ADBE Geometry2") throw new Error("추가된 변형 효과 위치를 확인할 수 없습니다. 실행 취소 후 효과 구성을 확인하세요.");
  return { target, componentIndex: count };
}
async function prepare(ppro, tracking, options = {}) {
  if (!tracking) throw new Error("먼저 마스크 측정을 완료하세요.");
  const context = await selection(ppro);
  if (context.projectGuid !== tracking.projectGuid || context.sequenceGuid !== tracking.sequenceGuid) throw new Error("측정한 프로젝트와 시퀀스에서 대상을 선택하세요.");
  const target = await clipInfo(context.clip);
  if (sameClip(target, tracking.source)) throw new Error("원본 비디오가 선택되어 있습니다. 움직일 대상 클립을 선택하세요.");
  if (target.speed !== 1 || target.reversed) throw new Error("대상은 정방향 100% 속도여야 합니다.");
  const currentSize = await dimensions(context.sequence);
  if (currentSize.width !== tracking.size.width || currentSize.height !== tracking.size.height) throw new Error("현재 시퀀스 해상도가 측정 당시 해상도와 같아야 합니다.");
  // Position must be static and keyframe-free below, so its baseline is
  // independent of the current playhead. Key times come from the capture.
  const effect = options.effect || "motion";
  if (options.addedTransform && !sameClip(target, options.addedTransform.target)) throw new Error("변형 효과를 추가한 대상과 현재 선택이 다릅니다. 새 대상에 변형 효과를 추가하세요.");
  const componentIndex = options.addedTransform ? options.addedTransform.componentIndex : null;
  const destination = await positionParameter(context.clip, effect, componentIndex), param = destination.param;
  if (await param.isTimeVarying() || (await param.getKeyframeListAsTickTimes()).length) throw new Error("선택한 효과의 Position에 기존 키프레임이 있습니다. 키프레임이 없는 대상 효과를 사용하세요.");
  const basis = effect === "transform" ? await transformBasis(ppro, context, currentSize, options) : { gain: { x: 1, y: 1 }, label: "시퀀스 정규화 좌표" };
  const base = core.point(await param.getStartValue());
  const keys = core.planKeys(tracking.samples, target, base, basis.gain);
  const first = tracking.samples[0], last = tracking.samples[tracking.samples.length - 1];
  return { context, target, param, base, keys, effect, destination, basis, sequenceSize: currentSize, options: { ...options }, summary: {
    "대상": target.name, "트랙": "V" + (target.track + 1), "Position 키프레임 수": keys.length,
    "적용 효과": destination.label, "좌표 기준": basis.label,
    "마지막 프레임까지의 이동 (픽셀)": { x: Math.round((last.x - first.x) * currentSize.width * 100) / 100,
      y: Math.round((last.y - first.y) * currentSize.height * 100) / 100 },
    "적용 방식": "대상의 현재 위치를 유지하고 측정 시작 이후의 중심 이동량을 더합니다. 시간 위치는 원본 측정 구간과 동일합니다." } };
}
async function apply(ppro, plan) {
  if (!plan) throw new Error("먼저 대상 적용 미리보기를 누르세요.");
  const { context, keys } = plan;
  await active(ppro, context);
  const selected = await selection(ppro);
  if (!sameClip(plan.target, await clipInfo(selected.clip))) throw new Error("선택 대상이 바뀌었습니다. 미리보기를 다시 실행하세요.");
  const destination = await positionParameter(selected.clip, plan.effect, plan.destination.componentIndex);
  const param = destination.param;
  if (destination.componentIndex !== plan.destination.componentIndex || destination.matchName !== plan.destination.matchName) throw new Error("대상 효과 구성이 변경되었습니다. 미리보기를 다시 실행하세요.");
  const currentSize = await dimensions(context.sequence);
  if (currentSize.width !== plan.sequenceSize.width || currentSize.height !== plan.sequenceSize.height) throw new Error("미리보기 이후 시퀀스 해상도가 변경되었습니다.");
  if (plan.effect === "transform") {
    const basis = await transformBasis(ppro, context, currentSize, plan.options);
    if (JSON.stringify(basis.gain) !== JSON.stringify(plan.basis.gain)) throw new Error("대상 Motion 또는 좌표 기준이 변경되었습니다. 미리보기를 다시 실행하세요.");
  }
  if (await param.isTimeVarying() || (await param.getKeyframeListAsTickTimes()).length) throw new Error("미리보기 이후 Position 키프레임이 변경되었습니다.");
  const base = core.point(await param.getStartValue());
  if (Math.abs(base.x - plan.base.x) > 1e-7 || Math.abs(base.y - plan.base.y) > 1e-7) throw new Error("대상 위치가 변경되었습니다. 미리보기를 다시 실행하세요.");
  const frames = keys.map(key => {
    const frame = param.createKeyframe(new ppro.PointF(key.x, key.y));
    const value = core.point(frame);
    if (Math.abs(value.x - key.x) > 1e-6 || Math.abs(value.y - key.y) > 1e-6) throw new Error("이 Premiere 버전에서 PointF 키프레임 값 생성이 일치하지 않습니다. 대상은 변경하지 않았습니다.");
    frame.position = ppro.TickTime.createWithTicks(key.mediaTicks);
    return frame;
  });
  let success = false;
  context.project.lockedAccess(() => {
    success = context.project.executeTransaction(compound => {
      compound.addAction(param.createSetTimeVaryingAction(true));
      for (const frame of frames) {
        compound.addAction(param.createAddKeyframeAction(frame));
        compound.addAction(param.createSetInterpolationAtKeyframeAction(frame.position, ppro.Constants.InterpolationMode.LINEAR, true));
      }
    }, "Mask Motion: " + plan.destination.label + " Position 키프레임 적용");
  });
  if (!success) throw new Error("Position 적용 트랜잭션이 실패했습니다. Effect Controls를 확인하세요.");
  const removedUnexpected = [];
  // Do not claim success based solely on the transaction return value.
  try {
    const expectedTimes = new Set(keys.map(key => key.mediaTicks));
    const extraTimes = (await param.getKeyframeListAsTickTimes()).filter(t => !expectedTimes.has(time(t)));
    for (const t of extraTimes) removedUnexpected.push({ ticks: time(t), value: core.point(await param.getValueAtTime(t)) });
    if (extraTimes.length) {
      await active(ppro, context);
      if (!sameClip(plan.target, await clipInfo((await selection(ppro)).clip))) throw new Error("추가 키프레임 정리 전 선택 대상이 바뀌었습니다.");
      let cleaned = false;
      context.project.lockedAccess(() => {
        cleaned = context.project.executeTransaction(compound => {
          for (const t of extraTimes) compound.addAction(param.createRemoveKeyframeAction(t, true));
        }, "Mask Motion: 자동 생성된 추가 Position 키프레임 정리");
      });
      if (!cleaned) throw new Error("추가 키프레임 정리 실패");
    }
    const actualList = (await param.getKeyframeListAsTickTimes()).map(time);
    const actualTimes = new Set(actualList);
    if (actualList.length !== keys.length || actualTimes.size !== expectedTimes.size || actualList.some(t => !expectedTimes.has(t))) throw new Error("전체 키프레임 시간 또는 개수 불일치");
    for (const key of keys) {
      const value = core.point(await param.getValueAtTime(ppro.TickTime.createWithTicks(key.mediaTicks)));
      if (!actualTimes.has(key.mediaTicks) || Math.abs(value.x - key.x) > 1e-5 || Math.abs(value.y - key.y) > 1e-5) throw new Error("시간 또는 값 불일치");
    }
  } catch (error) {
    throw new Error("적용 후 키프레임 검증 실패 (" + String(error.message || error) + "). Premiere에서 이번 Position 적용 및 추가 키프레임 정리 작업을 실행 취소(Cmd/Ctrl+Z)하고 결과를 확인하세요.");
  }
  return { keyCount: keys.length, verified: true, target: plan.target.name, effect: plan.destination.label, removedUnexpected };
}
// Run the production apply() path on a fresh temporary effect. Splitting
// activation, insertion and interpolation into transactions changes host behavior.
async function diagnoseTiming(ppro, tracking, options = {}) {
  const context = await selection(ppro);
  const report = { target: await context.clip.getName(), stages: [], firstUnexpectedStage: null, cleanup: "pending" };
  const emit = () => { if (options.progress) options.progress(report); };
  let added = null, expected = new Set();
  const transact = (actions, label) => {
    let success = false;
    context.project.lockedAccess(() => {
      success = context.project.executeTransaction(compound => actions.forEach(action => compound.addAction(action)), "Mask Motion 진단: " + label);
    });
    if (!success) throw new Error(label + " 실행 실패");
  };
  try {
    added = await addTransform(ppro, tracking);
    const destination = await positionParameter(context.clip, "transform", added.componentIndex);
    const param = destination.param;
    const snapshot = async stage => {
      const times = await param.getKeyframeListAsTickTimes();
      const keys = [];
      for (const t of times) keys.push({ ticks: time(t), value: core.point(await param.getValueAtTime(t)) });
      const unexpected = keys.filter(key => !expected.has(key.ticks));
      if (unexpected.length && !report.firstUnexpectedStage) report.firstUnexpectedStage = stage;
      const present = new Set(keys.map(key => key.ticks));
      report.stages.push({ stage, count: keys.length, keys, unexpected,
        missing: [...expected].filter(t => !present.has(t)) });
      emit();
    };
    // The expected range is known before activation, even if the host already
    // supplied an initial key while appending the effect.
    const target = await clipInfo(context.clip);
    expected = new Set(core.planKeys(tracking.samples, target, { x: 0, y: 0 }).map(key => key.mediaTicks));
    report.clipInPointTicks = target.inPoint;
    await snapshot("변형 추가 직후");
    const plan = await prepare(ppro, tracking, { ...options, effect: "transform", addedTransform: added });
    report.expectedFirstTicks = plan.keys[0].mediaTicks;
    report.expectedCount = plan.keys.length;
    report.execution = "3번과 동일한 apply(): 전체 키프레임 및 보간을 단일 트랜잭션으로 적용";
    // Call the exact same implementation as button 3; do not copy its actions
    // or insert observations inside the compound transaction.
    try { report.application = await apply(ppro, plan); }
    finally { await snapshot("3번과 동일한 일괄 적용 직후"); }
  } catch (error) {
    report.error = String(error.message || error);
  } finally {
    if (added) {
      try {
        const chain = await context.clip.getComponentChain();
        if (await chain.getComponentCount() !== added.componentIndex + 1) throw new Error("진단 중 효과 구성이 바뀌었습니다.");
        const component = await chain.getComponentAtIndex(added.componentIndex);
        if (await component.getMatchName() !== "AE.ADBE Geometry2") throw new Error("진단 효과를 식별할 수 없습니다.");
        transact([chain.createRemoveComponentAction(component)], "임시 변형 효과 제거");
        if (await chain.getComponentCount() !== added.componentIndex) throw new Error("진단 효과 제거를 확인할 수 없습니다.");
        report.cleanup = "removed";
      } catch (error) {
        report.cleanup = "failed";
        report.cleanupError = String(error.message || error) + " 임시 변형 효과가 남아 있을 수 있습니다. 효과 컨트롤에서 확인하세요.";
      }
    } else report.cleanup = "not-created";
    emit();
  }
  return report;
}
module.exports = { selection, capture, prepare, apply, restoreTracks, isolated, readFrame, addTransform, diagnoseTiming };
