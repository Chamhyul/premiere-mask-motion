"use strict";
// Resolve only the current Premiere project's parent directory; never opens a picker.
async function projectFolder(uxp, projectPath) {
  const path = String(projectPath || "").replace(/\\/g, "/");
  if (!/\.prproj$/i.test(path) || !/^(\/|[a-z]:\/)/i.test(path)) throw Error("프로젝트를 먼저 저장하세요.");
  const parent = path.slice(0, path.lastIndexOf("/")) || "/";
  const entry = await uxp.storage.localFileSystem.getEntryWithUrl("file:" + (parent.startsWith("/") ? "" : "/") + parent);
  if (!entry || !entry.isFolder) throw Error("현재 프로젝트 폴더를 읽을 수 없습니다.");
  return entry;
}
module.exports = { projectFolder };
