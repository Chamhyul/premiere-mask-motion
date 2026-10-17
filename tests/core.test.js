"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { decodeAlpha, measure, sampleTimes, clipSampleTimes, planKeys, point, validateTracking } = require("../core.js");
function tga(width, height, descriptor, alpha, rle = false) {
  const bytes = Buffer.alloc(18 + alpha.length * (rle ? 5 : 4));
  bytes[2] = rle ? 10 : 2; bytes.writeUInt16LE(width, 12); bytes.writeUInt16LE(height, 14);
  bytes[16] = 32; bytes[17] = descriptor;
  let offset = 18;
  for (const a of alpha) { if (rle) bytes[offset++] = 128; bytes[offset + 3] = a; offset += 4; }
  return bytes;
}
test("TGA raw and RLE normalize all four origin orientations", () => {
  for (const rle of [false, true]) {
    for (const descriptor of [8, 24, 40, 56]) {
      const result = decodeAlpha(tga(2, 2, descriptor, [1, 2, 3, 4], rle));
      const expected = descriptor === 8 ? [3, 4, 1, 2] : descriptor === 24 ? [4, 3, 2, 1] : descriptor === 40 ? [1, 2, 3, 4] : [2, 1, 4, 3];
      assert.deepEqual([...result.alpha], expected);
    }
  }
});
test("TGA RLE repeats packets and rejects overflow or truncated pixels", () => {
  const bytes = tga(2, 2, 40, [17]); bytes[2] = 10;
  const repeated = Buffer.concat([bytes.subarray(0, 18), Buffer.from([131, 0, 0, 0, 17])]);
  assert.deepEqual([...decodeAlpha(repeated).alpha], [17, 17, 17, 17]);
  repeated[18] = 132; assert.throws(() => decodeAlpha(repeated), /픽셀/);
  assert.throws(() => decodeAlpha(bytes.subarray(0, 19)), /픽셀/);
});
test("TGA requires explicit 8-bit alpha and bounded dimensions", () => {
  const bytes = tga(2, 2, 40, [1, 2, 3, 4]);
  bytes[16] = 24; assert.throws(() => decodeAlpha(bytes), /ALPHA_UNAVAILABLE/);
  bytes[16] = 32; bytes[17] = 32; assert.throws(() => decodeAlpha(bytes), /ALPHA_UNAVAILABLE/);
  bytes[17] = 40; bytes.writeUInt16LE(65535, 12); bytes.writeUInt16LE(65535, 14);
  assert.throws(() => decodeAlpha(bytes), /해상도/);
});
test("Premiere descriptor-zero alpha is accepted only for host exports", () => {
  const bytes = tga(2, 2, 32, [0, 255, 127, 0]);
  assert.throws(() => decodeAlpha(bytes), /ALPHA_UNAVAILABLE/);
  const result = decodeAlpha(bytes, { allowPremiereAlpha: true });
  assert.equal(result.alphaDeclared, false); assert.deepEqual([...result.alpha], [0, 255, 127, 0]);
});
function image(x, y) {
  const alpha = new Uint8Array(100);
  for (let row = y; row < y + 2; row++) for (let col = x; col < x + 2; col++) alpha[row * 10 + col] = 255;
  return { width: 10, height: 10, alpha };
}
test("centroid follows alpha movement regardless of RGB, in normalized units", () => {
  const first = measure(image(2, 3)), last = measure(image(5, 4));
  assert.equal(first.x, 0.3); assert.equal(first.y, 0.4);
  assert.equal(last.x, 0.6); assert.equal(last.y, 0.5);
  assert.equal(first.area, 4);
});
test("opaque, empty and clipped masks are rejected", () => {
  assert.throws(() => measure({ width: 10, height: 10, alpha: new Uint8Array(100).fill(255) }), /ALPHA_UNAVAILABLE/);
  assert.throws(() => measure({ width: 10, height: 10, alpha: new Uint8Array(100) }), /MASK_EMPTY/);
  assert.throws(() => measure(image(0, 2)), /MASK_CLIPPED/);
});
test("sample times preserve fractional-rate ticks and include last frame", () => {
  const frame = 4237833600n, start = frame * 100n;
  assert.deepEqual(sampleTimes(start, start, start + frame * 6n, frame, 6, 2), [0n, 2n, 4n, 5n].map(n => String(start + n * frame)));
  assert.throws(() => sampleTimes(start, start, start + frame * 6n, frame, 7, 1), /클립 끝/);
  assert.throws(() => sampleTimes(start + 1n, start, start + frame * 6n, frame, 2, 1), /프레임 경계/);
});
test("whole-clip sampling ignores the playhead and includes the final in-range frame", () => {
  assert.deepEqual(clipSampleTimes("100", "160", "10", 2), ["100", "120", "140", "150"]);
  assert.deepEqual(clipSampleTimes("100", "155", "10", 2), ["100", "120", "140", "150"]);
  assert.throws(() => clipSampleTimes("100", "110", "10"), /최소 2프레임/);
  assert.throws(() => clipSampleTimes("101", "160", "10"), /프레임 범위/);
  assert.throws(() => clipSampleTimes("0", "1000010", "10"), /10만 샘플/);
});
test("whole-clip tracking beyond 600 frames can be saved, loaded and mapped without truncation", () => {
  const times = clipSampleTimes("0", "10010", "10");
  const data = { format: "MaskMotion", version: 1, projectGuid: "project", sequenceGuid: "sequence",
    source: { start: "0", end: "10010" }, size: { width: 1920, height: 1080 }, frameTicks: "10",
    samples: times.map(ticks => ({ ticks, x: 0.2, y: 0.4 })) };
  const loaded = validateTracking(JSON.parse(JSON.stringify(data)));
  const keys = planKeys(loaded.samples, { start: "0", end: "10010", inPoint: "100" }, { x: 0.5, y: 0.5 });
  assert.equal(keys.length, 1001); assert.equal(keys[1000].mediaTicks, "10100");
});
test("Position plan adds displacement to target baseline and honors trim in-point", () => {
  const samples = [{ ticks: "100", x: 0.3, y: 0.4 }, { ticks: "110", x: 0.6, y: 0.5 }];
  const keys = planKeys(samples, { start: "90", end: "120", inPoint: "3600000000000" }, { x: 0.2, y: 0.7 });
  assert.equal(keys[0].mediaTicks, "3600000000010");
  assert.ok(Math.abs(keys[0].x - 0.2) < 1e-12); assert.ok(Math.abs(keys[1].x - 0.5) < 1e-12);
  assert.ok(Math.abs(keys[1].y - 0.8) < 1e-12);
  assert.throws(() => planKeys(samples, { start: "100", end: "110", inPoint: "0" }, { x: 0, y: 0 }), /전체 측정/);
  assert.throws(() => planKeys(samples.slice().reverse(), { start: "0", end: "200", inPoint: "0" }, { x: 0, y: 0 }), /전체 측정/);
});
test("Position handles actual Premiere point wrappers", () => {
  assert.deepEqual(point({ value: { value: [0.5, 0.6] } }), { x: 0.5, y: 0.6 });
  assert.throws(() => point({ value: [NaN, 0.5] }), /2차원/);
});
test("tracking JSON validation refuses unordered times and out-of-range points", () => {
  const data = { format: "MaskMotion", version: 1, projectGuid: "project", sequenceGuid: "sequence",
    source: { start: "100", end: "200" }, size: { width: 1920, height: 1080 }, frameTicks: "10",
    samples: [{ ticks: "100", x: 0.2, y: 0.4 }, { ticks: "110", x: 0.3, y: 0.5 }] };
  assert.equal(validateTracking(data), data);
  assert.throws(() => validateTracking({ ...data, samples: data.samples.slice().reverse() }), /좌표 또는/);
  assert.throws(() => validateTracking({ ...data, samples: [data.samples[0], { ticks: "110", x: 20, y: 0.5 }] }), /좌표 또는/);
  assert.throws(() => validateTracking({ ...data, frameTicks: "0" }), /시간 정보/);
});
