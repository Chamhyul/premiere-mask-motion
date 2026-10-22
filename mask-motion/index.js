"use strict";
const ppro = require("premierepro"), uxp = require("uxp"), host = require("./host.js");
const updates = require("./updates.js");
const updateChecker = updates.createChecker((...args) => fetch(...args));
const $ = id => document.getElementById(id);
let tracking = null, addedTransform = null, busy = false, cancelled = false, generation = 0;
let pollTimer = null, polling = false, selected = null, selectionEmpty = false;
let maskList = null, live = null, autoKey = null, sourcePinned = false, loadingMasks = false;
let updateRelease = null, updateTimer = null, activeKind = null, targetKey = null;
let listening = false, selectionPending = false;
const controlIds = ["apply", "read-masks", "mask-choice"];
const buttonIds = ["capture", "apply", "mask-picker", "read-masks", "update-open"];
function updateButtonStates() {
  for (const id of buttonIds) { const node = $(id); node.setAttribute("aria-disabled", String(!!node.disabled)); node.setAttribute("tabindex", node.disabled ? "-1" : "0"); }
}
function wireButton(node, callback) {
  node.setAttribute("role", "button"); node.setAttribute("tabindex", node.disabled ? "-1" : "0"); node.setAttribute("aria-disabled", String(!!node.disabled));
  node.addEventListener("click", () => { if (!node.disabled) return callback(); });
  node.addEventListener("keydown", event => { if (!node.disabled && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); return callback(); } });
}
function onClick(id, callback) { wireButton($(id), callback); }
function renderNotices() {
  const showUpdate = !!updateRelease && !busy;
  $("notice-area").hidden = !showUpdate;
  $("update-notice").hidden = !showUpdate;
}
function status(text, error = false, scope = activeKind || "masks") {
  const id = { masks: "mask-message", capture: "source-message", apply: "target-message", update: "update-error" }[scope];
  const node = $(id), cls = "message" + (error ? " error" : "");
  if (node.textContent !== text) node.textContent = text;
  if (node.className !== cls) node.className = cls;
}
function userError(error, kind) {
  const text = String(error.message || error).replace(/측정/g, "분석").replace(/^(ALPHA_UNAVAILABLE|MASK_EMPTY|MASK_CLIPPED):\s*/, "");
  // Keep native identifiers and diagnostic details in the console, not the panel.
  console.warn("Mask Tracker:", kind, error);
  if (/분석을 중지/.test(text)) return "분석을 중지했습니다.";
  if (/적용 후 키프레임 검증 실패|기존 Position 키프레임 삭제 확인 실패/.test(text)) return "적용을 완료하지 못했습니다. 실행 취소 후 다시 시도하세요.";
  if (/PointF|Position|트랜잭션/.test(text)) return kind === "apply" ? "클립의 위치를 적용하지 못했습니다. 클립 상태를 확인하세요." : "클립의 위치를 확인하지 못했습니다.";
  if (/PRMF|GDeflate|FlatBuffer|CRC|UTF-8|offset|TypeError|ReferenceError|\.prmf|범위 초과|추적 파일/.test(text)) return "마스크를 읽지 못했습니다. 클립을 다시 선택하고 분석하세요.";
  if (!/[가-힣]/.test(text)) return kind === "apply" ? "적용하지 못했습니다. 클립을 확인하고 다시 시도하세요." : "마스크를 불러오지 못했습니다. 클립을 다시 선택하세요.";
  if (text.length > 160) return kind === "apply" ? "적용하지 못했습니다. 클립을 확인하고 다시 시도하세요." : "마스크를 읽지 못했습니다. 클립을 다시 선택하세요.";
  return text;
}
async function checkUpdates() {
  updateRelease = await updateChecker.check();
  if (updateRelease) $("update-message").textContent = "새 버전 " + updateRelease.version + " 업데이트 안내";
  renderNotices();
}
function sourceDisplay(source, label) {
  const name = $("source-name"), meta = $("source-meta"), text = "V" + (source.track + 1);
  if (name.textContent !== source.name) name.textContent = source.name;
  if (meta.textContent !== text) meta.textContent = text;
}
function targetDisplay(name, meta = "") {
  if ($("target-name").textContent !== name) $("target-name").textContent = name;
  if ($("target-meta").textContent !== meta) $("target-meta").textContent = meta;
}
function sameSource(a, b) { return a && b && ["name", "track", "start", "end", "inPoint"].every(key => a[key] === b[key]); }
function matches(context, info, record) { return record && context.projectGuid === record.projectGuid && context.sequenceGuid === record.sequenceGuid && sameSource(info, record.source); }
function isSource(info) { return tracking && sameSource(info, tracking.source); }
function selectionKey(context, info) { return JSON.stringify([context.projectGuid, context.project.path, context.sequenceGuid, info]); }
async function readLive() {
  const context = await host.selection(ppro), clip = context.clip;
  const info = { name: await clip.getName(), track: await clip.getTrackIndex(), start: String((await clip.getStartTime()).ticks), end: String((await clip.getEndTime()).ticks), inPoint: String((await clip.getInPoint()).ticks) };
  return { context, info, key: selectionKey(context, info) };
}
function closeMaskPicker() {
  $("mask-options").hidden = true;
  $("mask-picker").setAttribute("aria-expanded", "false");
}
function clearMasks(message) {
  maskList = null;
  const choice = $("mask-choice");
  while (choice.firstChild) choice.removeChild(choice.firstChild);
  const option = document.createElement("option"); option.value = ""; option.textContent = message; choice.appendChild(option); choice.value = "";
  while ($("mask-options").firstChild) $("mask-options").removeChild($("mask-options").firstChild);
  $("mask-options").hidden = true;
  $("mask-picker-label").textContent = "마스크 목록";
  $("mask-picker").setAttribute("aria-expanded", "false");
}
function syncMaskPicker() {
  const choice = $("mask-choice"), mask = maskList && maskList.masks.find(item => item.id === choice.value);
  $("mask-picker").disabled = choice.disabled;
  if (maskList) $("mask-picker-label").textContent = mask ? mask.name : "마스크 목록";
  if (choice.disabled) { $("mask-options").hidden = true; $("mask-picker").setAttribute("aria-expanded", "false"); }
  for (const option of $("mask-options").children) option.className = "button" + (option.value === choice.value ? " chosen" : "");
}
function maskChanged() {
  if (tracking && tracking.maskId !== $("mask-choice").value) {
    tracking = null; addedTransform = null;
    $("source-badge").textContent = "대기"; $("target-badge").textContent = "대기";
    status("", false, "capture");
    status("");
  }
  readyControls();
}
function renderMasks(result) {
  const previous = maskList && matches(result, result.source, maskList) ? $("mask-choice").value : "";
  clearMasks("분석할 마스크를 선택하세요");
  $("mask-choice").firstChild.textContent = result.masks.length ? "분석할 마스크를 선택하세요" : "마스크가 없습니다";
  for (const mask of result.masks) {
    const option = document.createElement("option"); option.value = mask.id; option.textContent = mask.name + (mask.tracked ? "" : " · 추적 필요"); option.disabled = !mask.tracked; $("mask-choice").appendChild(option);
    const button = document.createElement("div"); button.className = "button"; button.value = mask.id; button.textContent = option.textContent; button.disabled = option.disabled;
    wireButton(button, () => { $("mask-choice").value = mask.id; $("mask-options").hidden = true; $("mask-picker").setAttribute("aria-expanded", "false"); maskChanged(); });
    $("mask-options").appendChild(button);
  }
  $("mask-choice").value = result.masks.some(mask => mask.id === previous && mask.tracked) ? previous : result.masks.length === 1 && result.masks[0].tracked ? result.masks[0].id : "";
  maskList = result;
  $("source-badge").textContent = "대기";
  status(result.masks.length ? "" : "오브젝트 마스크를 만들고 추적하세요.", false, "masks");
}
function readyControls() {
  const sourceSelected = live && maskList && matches(live.context, live.info, maskList);
  $("apply").disabled = busy || !tracking || !selected || isSource(selected);
  $("capture").disabled = busy ? activeKind !== "capture" : loadingMasks || !sourceSelected || !$("mask-choice").value;
  $("mask-choice").disabled = busy || loadingMasks || !maskList;
  $("read-masks").disabled = busy || loadingMasks || (!live && !sourcePinned);
  syncMaskPicker(); updateButtonStates();
}
async function readMasksFor(current, valid) {
  const result = await host.listMasks(ppro, uxp);
  const latest = await readLive();
  if (!valid()) return;
  if (latest.key !== current.key) { live = latest; autoKey = null; return; }
  if (!matches(current.context, current.info, result)) throw Error("선택한 클립이 바뀌었습니다. 목록을 다시 불러오세요.");
  renderMasks(result);
  if (result.masks.length) status("", false, "masks");
}
async function autoRead(current, epoch) {
  const valid = () => !busy && generation === epoch && live && live.key === current.key && !sourcePinned;
  loadingMasks = true; readyControls();
  try {
    if (!valid()) return;
    $("source-badge").textContent = "불러오는 중"; status("", false, "masks");
    await readMasksFor(current, valid);
  } catch (error) {
    if (valid()) { $("source-badge").textContent = "확인 필요"; status(userError(error, "masks"), true, "masks"); }
  } finally { loadingMasks = false; if (!maskList && generation !== epoch) autoKey = null; readyControls(); }
}
async function pollSelection() {
  if (busy || polling) return;
  polling = true; const epoch = generation;
  try {
    const current = await readLive(), { context, info } = current;
    if (busy || generation !== epoch) return;
    selectionEmpty = false;
    live = current;
    selected = null;
    if (!sourcePinned) {
      sourceDisplay(info, "선택한 클립");
      if (autoKey !== live.key) {
        autoKey = live.key; clearMasks("마스크 목록을 확인하고 있습니다…");
        await autoRead(live, epoch);
      }
    }
    if (busy || generation !== epoch) return;
    const eligible = tracking && context.projectGuid === tracking.projectGuid && context.sequenceGuid === tracking.sequenceGuid && !isSource(info);
    if (eligible) {
      selected = info; targetDisplay(info.name, "V" + (info.track + 1));
      if (targetKey !== current.key) { targetKey = current.key; status("", false, "apply"); $("target-badge").textContent = "대기"; }
    } else { targetDisplay(tracking ? "움직일 대상 클립을 선택하세요." : "분석 후 움직일 클립을 선택하세요."); }
  } catch (_) {
    if (busy || generation !== epoch) return;
    if (selectionEmpty) return;
    selectionEmpty = true;
    live = null; selected = null; autoKey = null;
    if (!sourcePinned) { clearMasks("비디오 클립을 먼저 선택하세요"); $("source-name").textContent = "클립을 선택하세요."; $("source-meta").textContent = ""; }
    targetDisplay("대상 클립 하나를 선택하세요.");
  } finally { polling = false; if (!busy) readyControls(); if (selectionPending) { selectionPending = false; pollSelection(); } }
}
function selectionChanged() {
  if (busy || sourcePinned) return;
  autoKey = null;
  if (polling) selectionPending = true;
  else pollSelection();
}
function startPolling() {
  if (!listening && ppro.EventManager && ppro.Constants && ppro.Constants.SequenceEvent) {
    ppro.EventManager.addGlobalEventListener(ppro.Constants.SequenceEvent.SELECTION_CHANGED, selectionChanged, false);
    listening = true;
  }
  if (!pollTimer) { if (!sourcePinned) autoKey = null; pollSelection(); pollTimer = setInterval(pollSelection, 1000); }
  if (!updateTimer) { checkUpdates(); updateTimer = setInterval(checkUpdates, updates.CHECK_INTERVAL); }
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); if (updateTimer) clearInterval(updateTimer); pollTimer = null; updateTimer = null; if (listening) { ppro.EventManager.removeGlobalEventListener(ppro.Constants.SequenceEvent.SELECTION_CHANGED, selectionChanged, false); listening = false; } }
async function run(task, kind) {
  if (busy) return;
  busy = true; activeKind = kind; cancelled = false; generation++;
  status("");
  controlIds.forEach(id => { $(id).disabled = true; });
  syncMaskPicker();
  $("capture").disabled = kind !== "capture";
  if (kind === "capture") $("capture").textContent = "중지";
  updateButtonStates(); renderNotices();
  try { await task(); }
  catch (error) {
    const stopped = /(?:측정|분석)을 중지/.test(String(error.message || error));
    status(userError(error, kind), !stopped);
    if (kind === "capture") $("progress-area").hidden = true;
    if (kind === "capture" || kind === "masks") $("source-badge").textContent = stopped ? "중지" : "확인 필요";
    else $("target-badge").textContent = "확인 필요";
  } finally {
    busy = false; activeKind = null; controlIds.forEach(id => { $(id).disabled = false; });
    $("capture").disabled = false; $("capture").textContent = "분석";
    renderNotices(); readyControls(); pollSelection();
  }
}
function measured(data) {
  tracking = data; sourcePinned = true; sourceDisplay(data.source, "분석한 클립"); $("source-badge").textContent = "분석 완료";
  $("target-badge").textContent = "대기";
  const r = data.recovery, review = r && (r.estimated || r.interpolated || r.held);
  status(review ? "일부 구간은 움직임을 추정했습니다. 적용 후 확인하세요." : "", false, "capture");
  if (review) $("source-message").className = "message warning";
  $("progress-area").hidden = true;
  readyControls(); pollSelection();
}

function init() {
  if ($("capture").getAttribute("data-wired")) { startPolling(); return; }
  $("capture").setAttribute("data-wired", "yes");
  $("plugin-version").textContent = updates.CURRENT_VERSION;
  onClick("update-open", async () => {
    if (!updateRelease || busy) return;
    status("", false, "update");
    try {
      const error = await uxp.shell.openExternal(updateRelease.url, "Mask Tracker의 새 릴리스를 확인합니다.");
      if (error) status("릴리스 페이지를 열지 못했습니다. 다시 시도하세요.", true, "update");
    } catch (_) { status("릴리스 페이지를 열지 못했습니다. 다시 시도하세요.", true, "update"); }
  });
  $("mask-choice").addEventListener("change", maskChanged);
  onClick("mask-picker", () => {
    const open = $("mask-options").hidden;
    $("mask-options").hidden = !open;
    $("mask-picker").setAttribute("aria-expanded", String(open));
    if (open) $("mask-picker").focus();
  });
  document.addEventListener("click", event => {
    if ($("mask-options").hidden) return;
    for (let node = event.target; node; node = node.parentNode) {
      if (node === $("mask-picker") || node === $("mask-options")) return;
    }
    closeMaskPicker();
  });
  document.addEventListener("keydown", event => {
    if ((event.key !== "Escape" && event.key !== "Esc" && event.keyCode !== 27) || $("mask-options").hidden) return;
    event.preventDefault(); closeMaskPicker(); $("mask-picker").focus();
  });
  onClick("read-masks", () => {
    generation++; tracking = null; addedTransform = null; sourcePinned = false; autoKey = null; selectionEmpty = false;
    clearMasks("비디오 클립을 먼저 선택하세요"); $("source-badge").textContent = "대기"; $("target-badge").textContent = "대기";
    $("progress-area").hidden = true; status(""); status("", false, "capture"); status("", false, "apply"); targetKey = null; readyControls(); pollSelection();
  });
  onClick("capture", () => {
    if (busy) { cancelled = true; status("분석을 중지하고 있습니다…", false, "capture"); return; }
    return run(async () => {
      if (!maskList || !live || !matches(live.context, live.info, maskList)) throw Error("마스크 목록을 불러온 비디오 클립을 선택하세요.");
      if (!$("mask-choice").value) throw Error("분석할 마스크 하나를 선택하세요.");
      tracking = null; addedTransform = null; $("target-badge").textContent = "대기"; $("target-message").textContent = "";
      $("source-badge").textContent = "분석 중"; $("progress-area").hidden = false; $("progress-fill").style.width = "0%"; $("percent").textContent = "0%";
      $("progress").setAttribute("aria-valuenow", "0"); status(""); $("progress-label").textContent = "분석 중";

      const data = await host.captureMask(ppro, uxp, {
        folder: maskList.folder,
        maskId: $("mask-choice").value,
        expectedSource: maskList,
        range: "clip", step: 1, cancelled: () => cancelled,
        progress: () => { $("progress-label").textContent = "분석 중"; },
        rangeInfo: info => sourceDisplay(info.source, "선택한 비디오 클립"),
        sampleProgress: info => { const percent = Math.round(info.completed / info.total * 100); $("progress-fill").style.width = percent + "%"; $("percent").textContent = percent + "%"; $("progress").setAttribute("aria-valuenow", String(percent)); $("source-badge").textContent = "분석 중"; }
      });
      measured(data);
    }, "capture");
  });
  onClick("apply", () => run(async () => {
    $("target-badge").textContent = "적용 중";
    const plan = await host.prepare(ppro, tracking, { effect: "motion", appendEmptyTransform: true });
    status("적용 중…"); await host.apply(ppro, plan); addedTransform = null;
    $("target-badge").textContent = "적용 완료"; status("");

  }, "apply"));
  readyControls(); startPolling();
}
uxp.entrypoints.setup({ panels: { maskmotion: { create() { init(); }, show() { init(); startPolling(); }, hide() { stopPolling(); }, destroy() { stopPolling(); } } } });
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
