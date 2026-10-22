"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const {findUpdate:findReleaseUpdate, createChecker, CHECK_INTERVAL, API_URL} = require("../updates.js");
const findUpdate = (releases, current="0.3.2-beta.1") => findReleaseUpdate(releases,current);
const release = (tag_name, extra = {}) => ({tag_name,draft:false,prerelease:false,...extra});
test("release comparison includes beta upgrades and compares numeric identifiers correctly", () => {
  assert.equal(findUpdate([release("v0.3.2-beta.1")]), null);
  assert.equal(findUpdate([release("v0.3.2-beta.2",{prerelease:true})]).version, "0.3.2-beta.2");
  assert.equal(findUpdate([release("v0.3.2-beta.10"),release("v0.3.2-beta.9")]).version,"0.3.2-beta.10");
  assert.equal(findUpdate([release("v0.3.2")]).version,"0.3.2");
  assert.equal(findUpdate([release("v0.10.0"),release("v0.9.0")]).version,"0.10.0");
  assert.equal(findUpdate([release("v0.4.0-beta.1",{prerelease:true})],"0.3.2"),null);
});
test("drafts, older versions, malformed tags and API-provided destinations cannot trigger unsafe navigation", () => {
  assert.equal(findUpdate([release("v9.0.0",{draft:true}),release("v0.1.0"),release("<script>"),release("v0.4.0-beta.01")]),null);
  assert.equal(findUpdate({message:"rate limit"}),null);
  assert.equal(findUpdate([release("v0.4.0",{html_url:"https://example.com/untrusted"})]).url,"https://github.com/Chamhyul/premiere-mask-tracker/releases/tag/v0.4.0");
});
test("checks are shared, throttled for an hour and refreshed afterwards", async () => {
  let calls=0,time=0;
  const checker=createChecker(async url=>{assert.equal(url,API_URL);calls++;return {ok:true,json:async()=>[release("v1.0.1")]};},{now:()=>time});
  const [a,b]=await Promise.all([checker.check(),checker.check()]);
  assert.equal(a.version,"1.0.1"); assert.deepEqual(a,b); assert.equal(calls,1);
  await checker.check(); assert.equal(calls,1);
  time=CHECK_INTERVAL; await checker.check(); assert.equal(calls,2);
});
test("network errors, rate limiting and timeouts stay silent and preserve a known update", async () => {
  let time=0,fail=false;
  const checker=createChecker(async()=>{if(fail)throw Error("offline");return {ok:true,json:async()=>[release("v1.0.1")]};},{now:()=>time});
  await checker.check(); fail=true;time=CHECK_INTERVAL;
  assert.equal((await checker.check()).version,"1.0.1");
  assert.equal(await createChecker(async()=>({ok:false})).check(),null);
  assert.equal(await createChecker(()=>new Promise(()=>{}),{timeoutMs:5}).check(),null);
});
