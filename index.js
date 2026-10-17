"use strict";
const ppro = require("premierepro"), uxp = require("uxp"), host = require("./host.js"), core = require("./core.js");
const $ = id => document.getElementById(id);
let tracking = null, addedTransform = null, busy = false, cancelled = false, diagnostic = null, lastReport = null, generation = 0;
let pollTimer = null, polling = false, selected = null;
const recovery = [];
const controlIds = ["apply", "diagnose-timing", "save-report", "save", "load", "restore-recent", "restore", "step", "width", "motion-mode", "basis-width", "basis-height"];
function status(text, error = false) { $("status").textContent = text; $("status").className = error ? "error" : ""; }
function show(value) { $("output").textContent = JSON.stringify(value, null, 2); console.log("[MaskMotion] " + $("output").textContent); }
function seconds(start, end) { return (Number(BigInt(end) - BigInt(start)) / 254016000000).toFixed(2); }
function sourceDisplay(source, label) {
  $("source-name").textContent = source.name; $("source-meta").textContent = "V" + (source.track + 1) + " · " + label;
  $("range").textContent = "클립 전체 · " + seconds(source.start, source.end) + "초";
}
function isSource(info) { return tracking && info && info.name === tracking.source.name && info.track === tracking.source.track && info.start === tracking.source.start && info.inPoint === tracking.source.inPoint; }
function readyControls() {
  $("apply").disabled = busy || !tracking || !selected || isSource(selected) || recovery.some(entry => entry.pending);
  $("diagnose-timing").disabled = busy || !tracking;
  $("save").disabled = busy || !tracking;
  $("save-report").disabled = busy || !lastReport;
}
async function pollSelection() {
  if (busy || polling) return;
  polling = true; const epoch = generation;
  try {
    const context = await host.selection(ppro), clip = context.clip;
    const info = { name: await clip.getName(), track: await clip.getTrackIndex(), start: String((await clip.getStartTime()).ticks), end: String((await clip.getEndTime()).ticks), inPoint: String((await clip.getInPoint()).ticks) };
    if (busy || generation !== epoch) return;
    selected = info;
    sourceDisplay(info, "현재 선택한 클립");
    const eligible = tracking && context.projectGuid === tracking.projectGuid && context.sequenceGuid === tracking.sequenceGuid && !isSource(info);
    if (eligible) {
      $("target-name").textContent = info.name; $("target-meta").textContent = "V" + (info.track + 1) + " · 선택한 대상";
    } else { selected = tracking ? null : info; $("target-name").textContent = tracking ? "움직일 대상 클립을 선택하세요." : "측정 후 움직일 클립을 선택하세요."; $("target-meta").textContent = ""; }
  } catch (_) {
    if (busy || generation !== epoch) return;
    selected = null;
    $("source-name").textContent = "원본 비디오 클립을 선택하세요"; $("source-meta").textContent = "타임라인에서 클립 하나를 선택하세요."; $("range").textContent = "클립 전체";
    $("target-name").textContent = "대상 클립 하나를 선택하세요."; $("target-meta").textContent = "";
  } finally { polling = false; if (!busy) readyControls(); }
}
function startPolling() { if (!pollTimer) { pollSelection(); pollTimer = setInterval(pollSelection, 1000); } }
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
async function run(task, kind) {
  if (busy) return;
  busy = true; cancelled = false; generation++;
  controlIds.forEach(id => { $(id).disabled = true; });
  $("capture").disabled = kind !== "capture";
  if (kind === "capture") $("capture").textContent = "측정 중지";
  try { await task(); }
  catch (error) {
    const text = String(error.message || error).replace(/^(ALPHA_UNAVAILABLE|MASK_EMPTY|MASK_CLIPPED):\s*/, "");
    status(text, true);
    if (kind === "capture") { $("source-badge").textContent = "확인 필요"; $("source-message").textContent = text; }
    else { $("target-badge").textContent = "확인 필요"; $("target-message").textContent = text; }
    show({ error: String(error.message || error), diagnostic, addedTransform, pendingTrackRestore: recovery.filter(entry => entry.pending).map(entry => "V" + (entry.index + 1)) });
  } finally {
    busy = false; controlIds.forEach(id => { $(id).disabled = false; });
    $("capture").disabled = false; $("capture").textContent = tracking ? "다시 측정" : "클립 전체 측정";
    readyControls(); pollSelection();
  }
}
async function persist(value) {
  try { const folder = await uxp.storage.localFileSystem.getDataFolder(); const file = await folder.createFile("last-tracking.json", { overwrite: true }); await file.write(JSON.stringify(value)); }
  catch (error) { console.warn("[MaskMotion] 최근 측정 저장 실패: " + String(error.message || error)); }
}
function measured(data) {
  tracking = data; $("source-badge").textContent = "완료";
  $("source-message").textContent = "측정 데이터: " + data.source.name + " · " + data.samples.length + "프레임"; $("target-badge").textContent = "적용 준비";
  status("측정 완료. 원본 마스크를 비활성화하고 움직일 대상을 선택하세요."); readyControls(); pollSelection();
}
async function restoreRecent() {
  const folder = await uxp.storage.localFileSystem.getDataFolder();
  const file = await folder.getEntry("last-tracking.json"); const text = await file.read();
  if (text.length > 64000000) throw new Error("최근 측정 JSON이 너무 큽니다.");
  measured(core.validateTracking(JSON.parse(text)));
}
const basisOptions = () => ({ basisWidth: Number($("basis-width").value), basisHeight: Number($("basis-height").value) });
function init() {
  if ($("capture").getAttribute("data-wired")) { startPolling(); return; }
  $("capture").setAttribute("data-wired", "yes");
  $("capture").addEventListener("click", () => {
    if (busy) { cancelled = true; status("현재 프레임 처리가 끝나면 중지하고 트랙 표시를 복구합니다."); return; }
    return run(async () => {
      tracking = null; addedTransform = null; diagnostic = null; $("target-badge").textContent = "대기"; $("target-message").textContent = "재생헤드를 시작 프레임에 맞출 필요가 없습니다.";
      $("source-badge").textContent = "확인 중"; $("progress-area").hidden = false; $("progress-fill").style.width = "0%"; $("percent").textContent = "0%";
      $("progress").setAttribute("aria-valuenow", "0"); status("선택한 원본을 확인하고 있습니다…");
      const data = await host.capture(ppro, uxp, {
        range: "clip", internalStorage: true, step: Number($("step").value), width: Number($("width").value), cancelled: () => cancelled,
        progress: text => { status(text); $("progress-label").textContent = text; },
        diagnostic: value => { diagnostic = value; },
        rangeInfo: info => sourceDisplay(info.source, "선택한 비디오 클립"),
        sampleProgress: info => { const percent = Math.round(info.completed / info.total * 100); $("progress-fill").style.width = percent + "%"; $("percent").textContent = percent + "%"; $("progress").setAttribute("aria-valuenow", String(percent)); $("source-badge").textContent = "측정 중"; $("source-message").textContent = "투명 영역 확인 완료 · " + info.completed + " / " + info.total + "프레임"; }
      }, recovery);
      await persist(data); measured(data); show({ "원본": data.source.name, "측정 프레임 수": data.samples.length, "측정 범위": "클립 전체", "저장 폴더": data.folder });
    }, "capture");
  });
  $("apply").addEventListener("click", () => run(async () => {
    if (recovery.some(entry => entry.pending)) throw new Error("먼저 트랙 표시 복구를 완료하세요.");
    $("target-badge").textContent = "적용 중";
    const effect = $("motion-mode").checked ? "motion" : "transform";
    if (effect === "transform") { status("대상에 변형 효과를 준비하고 있습니다…"); addedTransform = await host.addTransform(ppro, tracking, addedTransform); }
    const plan = await host.prepare(ppro, tracking, { ...basisOptions(), effect, addedTransform: effect === "transform" ? addedTransform : null });
    status("추적 이동을 적용하고 있습니다…"); const result = await host.apply(ppro, plan); addedTransform = null;
    $("target-badge").textContent = "완료"; $("target-message").textContent = result.effect + " Position " + result.keyCount + "개 적용 · 검증 완료";
    status("적용 완료. 타임라인에서 재생해 확인하세요."); show(result);
  }, "apply"));
  $("advanced-toggle").addEventListener("click", () => { const open = $("advanced").hidden; $("advanced").hidden = !open; $("advanced-toggle").textContent = open ? "고급 설정 ▴" : "고급 설정 ▾"; $("advanced-toggle").setAttribute("aria-expanded", String(open)); });
  $("restore").addEventListener("click", () => run(async () => { await host.restoreTracks(recovery); status("원래 트랙 표시 상태를 복구했습니다."); }, "restore"));
  $("restore-recent").addEventListener("click", () => run(async () => { addedTransform = null; await restoreRecent(); }, "load"));
  $("diagnose-timing").addEventListener("click", () => run(async () => {
    if (recovery.some(entry => entry.pending)) throw new Error("먼저 트랙 표시 복구를 완료하세요.");
    status("실제 적용 방식으로 진단하고 있습니다…");
    lastReport = await host.diagnoseTiming(ppro, tracking, { ...basisOptions(), progress: value => { diagnostic = value; show(value); } });
    if (lastReport.cleanup === "failed") status(lastReport.cleanupError, true);
    else if (lastReport.error) status(lastReport.error, true);
    else { const after = lastReport.stages[lastReport.stages.length - 1]; status("진단 완료: 예상 " + lastReport.expectedCount + " / 실제 " + after.count + " / 추가 제거 " + lastReport.application.removedUnexpected.length + ". 임시 효과 제거 완료"); }
  }, "diagnose"));
  $("save-report").addEventListener("click", () => run(async () => { if (!lastReport) throw new Error("진단 결과가 없습니다."); const file = await uxp.storage.localFileSystem.getFileForSaving("mask-motion-diagnostic.json", { types: ["json"] }); if (file) { await file.write(JSON.stringify(lastReport, null, 2)); status("진단 결과 저장 완료"); } }, "save"));
  $("save").addEventListener("click", () => run(async () => { if (!tracking) throw new Error("측정 결과가 없습니다."); const file = await uxp.storage.localFileSystem.getFileForSaving("mask-motion.json", { types: ["json"] }); if (file) { await file.write(JSON.stringify(tracking, null, 2)); status("측정 저장 완료"); } }, "save"));
  $("load").addEventListener("click", () => run(async () => { const file = await uxp.storage.localFileSystem.getFileForOpening({ types: ["json"] }); if (!file) return; const text = await file.read(); if (text.length > 64000000) throw new Error("측정 JSON이 너무 큽니다."); const data = core.validateTracking(JSON.parse(text)); addedTransform = null; await persist(data); measured(data); show({ "원본": data.source.name, "측정 프레임 수": data.samples.length }); }, "load"));
  readyControls(); startPolling();
}
uxp.entrypoints.setup({ panels: { maskmotion: { create() { init(); }, show() { init(); startPolling(); }, hide() { stopPolling(); }, destroy() { stopPolling(); } } } });
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
