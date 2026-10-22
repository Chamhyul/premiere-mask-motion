"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const live=require('../live-mask.js');
test('bridge paths follow Windows profiles without assuming a drive, account name or TEMP path',()=>{
 assert.equal(live.bridgeURL({platform:()=> 'win32',homedir:()=> 'D:\\Users\\한글 이름'}),'file:/D:/Users/한글 이름/.mask-tracker/bridge');
 assert.equal(live.bridgeURL({platform:()=> 'win10',homedir:()=> '\\\\server\\profiles\\name'}),'file://server/profiles/name/.mask-tracker/bridge');
 assert.equal(live.bridgeURL({platform:()=> 'darwin'}),live.BRIDGE_URL);
 assert.throws(()=>live.bridgeURL({platform:()=> 'win32',homedir:()=> 'relative'}),/사용자 폴더/);
});
function bridge(reply={ok:true,clipboardRestored:true,clipboardVerified:true,xml:'<PremiereData/>',format:'com.adobe.dvaui.pproae/exchange/trackitem'}){
 let clock=1000,request;const files=new Map(),deleted=[];
 files.set('ready.json',JSON.stringify({protocol:1,session:'session',updatedAt:1000,copyAvailable:true}));
 const entry=name=>({read:async()=>{if(!files.has(name))throw Error('missing');return files.get(name);},delete:async()=>{files.delete(name);deleted.push(name);}});
 const folder={getEntry:async name=>entry(name),createFile:async name=>({...entry(name),write:async text=>{files.set(name,text);request=JSON.parse(text);if(reply)files.set('result-'+request.id+'.json',JSON.stringify({id:request.id,session:'session',...reply}));}})};
 return {uxp:{storage:{localFileSystem:{getEntryWithUrl:async url=>{assert.equal(url,live.BRIDGE_URL);return folder;}}}},options:{os:{platform:()=> 'darwin'},now:()=>clock,pause:async ms=>{clock+=ms;}},files,deleted,get request(){return request;}};
}
test('live reply is accepted only after clipboard restoration and request matching',async()=>{
 const f=bridge();const r=await live.read(f.uxp,{name:'video'},f.options);
 assert.equal(r.xml,'<PremiereData/>');assert.equal(r.clipboardVerified,true);
 assert.deepEqual(f.request.source,{name:'video'});assert.equal(f.request.operation,'copyMask');
 assert.equal(f.deleted.length,2);assert.deepEqual([...f.files.keys()],['ready.json']);
});
test('unrestored clipboard, stale sessions, and wrong clipboard formats never expose XML',async()=>{
 for(const patch of [{clipboardRestored:false},{clipboardVerified:false},{session:'other'},{format:'text/plain'},{ok:false,message:'타임라인에서 클립을 다시 선택하세요.'}]){
  const f=bridge({ok:true,clipboardRestored:true,clipboardVerified:true,xml:'private',format:'com.adobe.dvaui.pproae/exchange/trackitem',...patch});
  await assert.rejects(live.read(f.uxp,{},f.options));assert.equal(f.deleted.length,2);
 }
});
test('unavailable helper never reads a saved project or writes a request',async()=>{
 const f=bridge();f.files.set('ready.json',JSON.stringify({protocol:1,session:'s',updatedAt:-10000,copyAvailable:true}));
 await assert.rejects(live.read(f.uxp,{},f.options),/컨트롤 표면/);assert.equal(f.request,undefined);
});
test('timeout cleans up the request and does not block the next transaction',async()=>{
 const f=bridge(null);await assert.rejects(live.read(f.uxp,{},f.options),/응답이 없습니다/);
 assert.ok(f.deleted.some(x=>x.startsWith('request-')));
 const next=bridge();assert.ok((await live.read(next.uxp,{},next.options)).clipboardRestored);
});
