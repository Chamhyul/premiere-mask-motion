"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { projectFolder } = require("../project-access.js");
test("current project paths resolve directly on macOS and Windows without a folder picker", async () => {
  const urls = [], folder = { isFolder: true };
  const uxp = { storage: { localFileSystem: {
    getEntryWithUrl: async url => { urls.push(url); return folder; },
    getFolder: async () => { throw Error("must never open a picker"); }
  } } };
  assert.equal(await projectFolder(uxp, "/Users/editor/project files/demo.prproj"), folder);
  assert.equal(await projectFolder(uxp, "C:\\work\\demo.prproj"), folder);
  assert.deepEqual(urls, ["file:/Users/editor/project files", "file:/C:/work"]);
});
test("unsaved and relative project paths do not attempt disk access", async () => {
  const uxp = { storage: { localFileSystem: { getEntryWithUrl: () => { throw Error("unexpected IO"); } } } };
  for (const path of ["", undefined, "untitled.prproj", "/work/not-a-project"]) await assert.rejects(projectFolder(uxp, path), /먼저 저장/);
});
test("direct-path failures propagate and never fall back to a picker", async () => {
  const uxp = { storage: { localFileSystem: { getEntryWithUrl: async () => { throw Error("access denied"); } } } };
  await assert.rejects(projectFolder(uxp, "/work/demo.prproj"), /access denied/);
});
