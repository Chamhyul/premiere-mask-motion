"use strict";
// The native Control Surface owns the copy/restore transaction. Never read the
// system clipboard through UXP or fall back to an older saved project here.
const BRIDGE_URL = "file:/private/tmp/com.local.premiere.maskmotion";
function bridgeURL(os = require("os")) {
  if (!/^win/i.test(os.platform())) return BRIDGE_URL;
  const home = String(os.homedir()).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!/^[a-z]:\//i.test(home) && !/^\/\/[^/]+\/[^/]+/.test(home)) throw Error("Windows 사용자 폴더를 확인하지 못했습니다.");
  return (home.startsWith("//") ? "file:" : "file:/") + home + "/.mask-tracker/bridge";
}
let pending = Promise.resolve();
async function request(uxp, source, options = {}) {
  const pause = options.pause || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = options.now || Date.now;
  let folder, ready;
  try {
    folder = await uxp.storage.localFileSystem.getEntryWithUrl(bridgeURL(options.os));
    ready = JSON.parse(await (await folder.getEntry("ready.json")).read());
  } catch (_) { throw Error("마스크 읽기 모듈이 연결되지 않았습니다. Premiere의 컨트롤 표면 설정을 확인하세요."); }
  if (ready.protocol !== 1 || !ready.session || !ready.copyAvailable || now() - ready.updatedAt > 3000)
    throw Error("마스크 읽기 모듈이 연결되지 않았습니다. Premiere의 컨트롤 표면 설정을 확인하세요.");
  const id = now().toString(36) + "-" + Math.random().toString(36).slice(2);
  const name = "request-" + id + ".json", resultName = "result-" + id + ".json";
  let file;
  try {
    file = await folder.createFile(name, { overwrite: false });
    await file.write(JSON.stringify({ protocol: 1, session: ready.session, id, deadline: now() + 2500, operation: "copyMask", source }));
    const deadline = now() + 3500;
    while (now() < deadline) {
      let reply;
      try { reply = JSON.parse(await (await folder.getEntry(resultName)).read()); } catch (_) {}
      if (reply) {
        if (reply.id !== id || reply.session !== ready.session) throw Error("마스크 읽기 응답이 일치하지 않습니다. 클립을 다시 선택하세요.");
        if (!reply.clipboardRestored || !reply.clipboardVerified) throw Error(reply.message || "클립보드 복원을 확인하지 못했습니다. 다시 시도하기 전에 클립보드를 확인하세요.");
        if (!reply.ok) throw Error(reply.message || "타임라인에서 비디오 클립을 다시 선택하세요.");
        if (reply.format !== "com.adobe.dvaui.pproae/exchange/trackitem" || typeof reply.xml !== "string" || !reply.xml.length)
          throw Error("타임라인에서 비디오 클립을 다시 선택하세요.");
        return { xml: reply.xml, clipboardRestored: true, clipboardVerified: true, requestId: id };
      }
      await pause(40);
    }
    throw Error("마스크 읽기 응답이 없습니다. 타임라인에서 클립을 다시 선택하세요.");
  } finally {
    if (file) try { await file.delete(); } catch (_) {}
    try { await (await folder.getEntry(resultName)).delete(); } catch (_) {}
  }
}
function read(uxp, source, options) {
  const next = pending.then(() => request(uxp, source, options));
  pending = next.catch(() => {});
  return next;
}
module.exports = { read, BRIDGE_URL, bridgeURL };
