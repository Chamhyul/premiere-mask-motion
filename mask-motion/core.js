"use strict";
const MAX_SAMPLES = 100000;

// TGA avoids canvas and a third-party PNG/DEFLATE runtime. Only explicit alpha
// is used: black RGB pixels are never interpreted as a mask.
function decodeAlpha(buffer, options = {}) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 18 || bytes.length > 40000000) throw new Error("TGA 파일 크기가 잘못되었습니다.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = bytes[2], width = view.getUint16(12, true), height = view.getUint16(14, true);
  const descriptor = bytes[17];
  const alphaBits = descriptor & 15;
  const alphaSupported = alphaBits === 8 || (alphaBits === 0 && options.allowPremiereAlpha === true);
  if (bytes[1] !== 0 || ![2, 10].includes(type) || bytes[16] !== 32 || !alphaSupported || (descriptor & 192)) {
    throw new Error("ALPHA_UNAVAILABLE: 8비트 알파를 가진 32비트 TGA가 아닙니다. 프레임 저장 경로의 알파 보존을 확인해야 합니다.");
  }
  const count = width * height;
  if (!width || !height || count > 4000000) throw new Error("TGA 해상도가 지원 범위를 벗어납니다.");
  let offset = 18 + bytes[0], pixel = 0;
  const alpha = new Uint8Array(count);
  function emit(a) {
    const row = Math.floor(pixel / width), col = pixel % width;
    const y = descriptor & 32 ? row : height - 1 - row;
    const x = descriptor & 16 ? width - 1 - col : col;
    alpha[y * width + x] = a; pixel++;
  }
  while (pixel < count) {
    let size = 1, repeated = false;
    if (type === 10) {
      if (offset >= bytes.length) throw new Error("TGA RLE 패킷이 잘렸습니다.");
      const packet = bytes[offset++]; size = (packet & 127) + 1; repeated = !!(packet & 128);
    }
    if (size > count - pixel || offset + (repeated ? 4 : size * 4) > bytes.length) throw new Error("TGA 픽셀 데이터가 잘못되었습니다.");
    if (repeated) { const a = bytes[offset + 3]; offset += 4; for (let i = 0; i < size; i++) emit(a); }
    else { for (let i = 0; i < size; i++) { emit(bytes[offset + 3]); offset += 4; } }
  }
  return { width, height, alpha, alphaDeclared: alphaBits === 8 };
}

function measure(image, options = {}) {
  const { width, height, alpha } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || alpha.length !== width * height) throw new Error("알파 이미지 크기가 잘못되었습니다.");
  let mass = 0, sx = 0, sy = 0, clear = 0, visible = 0;
  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = alpha[y * width + x];
      if (a <= 8) clear++;
      if (a >= 32) {
        visible++; left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
      // Suppress nearly transparent background noise; keep feather weights.
      if (a > 8) { mass += a; sx += (x + 0.5) * a; sy += (y + 0.5) * a; }
    }
  }
  if (!options.allowOpaque && clear < Math.max(1, width * height * 0.01)) throw new Error("ALPHA_UNAVAILABLE: 추적할 투명 영역이 없습니다. 불투명도에 마스크를 적용하세요.");
  if (visible < 4 || !mass) throw new Error("MASK_EMPTY: 측정할 마스크가 없거나 너무 작습니다.");
  // Edge clipping changes the centroid for reasons unrelated to tracking.
  if (left === 0 || top === 0 || right === width - 1 || bottom === height - 1) throw new Error("MASK_CLIPPED: 마스크가 화면 가장자리에 닿았습니다. 이 구간은 중심 이동을 안전하게 측정할 수 없습니다.");
  return { x: sx / mass / width, y: sy / mass / height,
    bounds: { left, top, right, bottom }, area: mass / 255,
    transparentFraction: clear / (width * height) };
}

function ticks(value) {
  const s = String(value);
  if (!/^-?\d+$/.test(s)) throw new Error("TickTime 값이 잘못되었습니다.");
  return BigInt(s);
}
function sampleTimes(start, clipStart, clipEnd, frameTicks, frameCount, step) {
  const first = ticks(start), begin = ticks(clipStart), end = ticks(clipEnd), frame = ticks(frameTicks);
  if (frame <= 0n || first < begin || first >= end || first % frame !== 0n) throw new Error("재생헤드를 원본 클립 안의 프레임 경계에 놓으세요.");
  if (!Number.isInteger(frameCount) || frameCount < 2 || frameCount > 600 || !Number.isInteger(step) || step < 1 || step > 60) throw new Error("측정 길이 2–600프레임, 간격 1–60프레임을 입력하세요.");
  const last = first + BigInt(frameCount - 1) * frame;
  if (last >= end) throw new Error("측정 구간이 원본 클립 끝을 넘습니다. 길이를 줄이세요.");
  const result = [];
  for (let i = 0; i < frameCount; i += step) result.push(String(first + BigInt(i) * frame));
  if (result[result.length - 1] !== String(last)) result.push(String(last));
  return result;
}
function point(value, depth = 0) {
  if (depth > 4 || !value) throw new Error("Position 반환값을 읽을 수 없습니다.");
  if (Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)) return { x: value[0], y: value[1] };
  if (typeof value === "object" && "value" in value) return point(value.value, depth + 1);
  if (Number.isFinite(value.x) && Number.isFinite(value.y)) return { x: value.x, y: value.y };
  throw new Error("Position이 2차원 좌표가 아닙니다.");
}
function clipSampleTimes(clipStart, clipEnd, frameTicks, step = 1) {
  const start = ticks(clipStart), end = ticks(clipEnd), frame = ticks(frameTicks);
  if (frame <= 0n || start < 0n || end <= start || start % frame !== 0n) throw new Error("클립의 프레임 범위를 확인할 수 없습니다.");
  if (!Number.isInteger(step) || step < 1 || step > 60) throw new Error("측정 간격은 1–60프레임이어야 합니다.");
  // End time is exclusive. Include the last sequence frame inside the clip,
  // even if its duration or chosen step doesn't divide evenly.
  const lastIndex = (end - start - 1n) / frame;
  if (lastIndex < 1n) throw new Error("측정할 클립은 최소 2프레임이어야 합니다.");
  const count = lastIndex / BigInt(step) + 1n + (lastIndex % BigInt(step) ? 1n : 0n);
  if (count > BigInt(MAX_SAMPLES)) throw new Error("클립 전체 측정이 10만 샘플을 넘습니다. 고급 설정에서 측정 간격을 늘리세요.");
  const times = [];
  for (let i = 0n; i <= lastIndex; i += BigInt(step)) times.push(String(start + i * frame));
  const last = String(start + lastIndex * frame);
  if (times[times.length - 1] !== last) times.push(last);
  return times;
}
function planKeys(samples, target, base, gain = { x: 1, y: 1 }, ranges = null) {
  if (!Array.isArray(samples) || samples.length < 2 || samples.length > MAX_SAMPLES) throw new Error("완료된 측정 결과가 필요합니다.");
  const start = ticks(target.start), end = ticks(target.end), inPoint = ticks(target.inPoint);
  if (end <= start || start < 0n || inPoint < 0n) throw new Error("대상 클립의 시간 범위가 잘못되었습니다.");
  let previous = null;
  // Validate the complete snapshot before selecting the timeline intersection.
  const overlap = samples.filter(sample => {
    const t = ticks(sample.ticks);
    if (previous !== null && t <= previous) throw new Error("측정 프레임 시간이 순서대로 정렬되어 있지 않습니다.");
    previous = t;
    if (![sample.x, sample.y].every(Number.isFinite)) throw new Error("잘못된 측정 좌표입니다.");
    return t >= start && t < end && (!ranges || ranges.some(r => t >= ticks(r.startTicks) && t < ticks(r.endTicks)));
  });
  if (!overlap.length) throw new Error("대상 클립과 측정 구간이 겹치지 않습니다.");
  const first = overlap[0];
  const xy = gain.xy || 0, yx = gain.yx || 0;
  return overlap.map(sample => {
    const t = ticks(sample.ticks);
    if (![base.x, base.y, gain.x, gain.y, xy, yx].every(Number.isFinite) || Math.abs(gain.x * gain.y - xy * yx) < 1e-12) throw new Error("잘못된 측정 좌표 또는 좌표 기준입니다.");
    const dx = sample.x - first.x, dy = sample.y - first.y;
    return { sequenceTicks: String(t), mediaTicks: String(inPoint + t - start),
      x: base.x + dx * gain.x + dy * xy, y: base.y + dy * gain.y + dx * yx };
  });
}
function validateTracking(data) {
  if (!data || data.format !== "MaskMotion" || data.version !== 1 || !data.source || !data.size || !Array.isArray(data.samples) || data.samples.length < 2 || data.samples.length > MAX_SAMPLES || typeof data.projectGuid !== "string" || typeof data.sequenceGuid !== "string") throw new Error("Mask Motion 측정 JSON이 아닙니다.");
  if (![data.size.width, data.size.height].every(n => Number.isInteger(n) && n > 0 && n <= 32768)) throw new Error("측정 해상도가 잘못되었습니다.");
  const frame = ticks(data.frameTicks), start = ticks(data.source.start), end = ticks(data.source.end);
  if (frame <= 0n || start < 0n || end <= start) throw new Error("측정 시간 정보가 잘못되었습니다.");
  let previous = null;
  for (const sample of data.samples) {
    const t = ticks(sample.ticks);
    if (t < start || t >= end || t % frame !== 0n || (previous !== null && t <= previous) || ![sample.x, sample.y].every(n => Number.isFinite(n) && (n >= 0 && n <= 1 || ["estimated", "interpolated", "held"].includes(sample.quality) && n >= -1 && n <= 2))) throw new Error("측정 좌표 또는 프레임 시간이 잘못되었습니다.");
    previous = t;
  }
  if (data.ranges !== undefined) {
    if (!Array.isArray(data.ranges) || !data.ranges.length) throw new Error("마스크 추적 구간이 없습니다.");
    let lastEnd = null;
    for (const range of data.ranges) {
      const a = ticks(range.startTicks), b = ticks(range.endTicks);
      if (a < start || b > end || a >= b || a % frame !== 0n || (lastEnd !== null && a < lastEnd)) throw new Error("마스크 추적 구간이 잘못되었습니다.");
      lastEnd = b;
    }
    if (data.samples.some(s => !data.ranges.some(r => ticks(s.ticks) >= ticks(r.startTicks) && ticks(s.ticks) < ticks(r.endTicks)))) throw new Error("마스크 추적 구간 밖의 분석 결과입니다.");
  }
  return data;
}
module.exports = { decodeAlpha, measure, ticks, sampleTimes, clipSampleTimes, point, planKeys, validateTracking, MAX_SAMPLES };
