"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),zlib=require('node:zlib'),fs=require('node:fs'),path=require('node:path');
const {gunzip}=require('../deflate.js'),prmf=require('../prmf.js'),source=require('../mask-source.js');
const fixture=name=>fs.readFileSync(path.join(__dirname,'fixtures',name));
test('omitted scalar defaults require an explicit fallback and never hide invalid offsets',()=>{
  const f=new prmf.Flat(new Uint8Array(8));
  assert.equal(f.i64(null,0),'0');
  assert.equal(f.i64(null,8467200000),'8467200000');
  assert.throws(()=>f.i64(null),/범위 초과/);
  assert.throws(()=>f.i64(1,0),/범위 초과/);
  assert.throws(()=>f.i64(undefined,0),/범위 초과/);
});
test('30 fps masks starting at media time zero preserve omitted metadata defaults',()=>{
  const {maskStorage}=require('../project-mask.js');
  assert.deepEqual(maskStorage(fixture('zero-time-mask-storage.bin')),{id:'11111111-1111-4111-8111-111111111111',segments:[{id:'22222222-2222-4222-8222-222222222222',step:'8467200000',start:'0'}],seed:{id:'33333333-3333-4333-8333-333333333333',step:'8467200000',start:'0'}});
  assert.throws(()=>maskStorage(fixture('zero-time-mask-storage.bin').subarray(0,64)));
});
test('a PRMF frame at media time zero decodes the actual demo circle',()=>{
  const f=prmf.index(fixture('zero-time-circle.prmf'));
  assert.equal(f.frames.length,1);
  assert.equal(f.frames[0].ticks,'0');
  const result=prmf.decodeFrame(f,f.frames[0]);
  assert.ok(Math.hypot(result.x*1920-450,result.y*1080-540)<4);
  assert.ok(Math.abs(result.area-Math.PI*318**2)<3000);
});
test('project gzip reader matches zlib across stored, fixed, and dynamic blocks',()=>{
  const expected=Buffer.from('한글 프로젝트 XML & mask '.repeat(2000));
  for(const options of [{level:0},{strategy:zlib.constants.Z_FIXED},{level:9}])assert.deepEqual(Buffer.from(gunzip(zlib.gzipSync(expected,options))),expected);
});
test('project gzip rejects damaged payloads, CRC, size, and truncation',()=>{
  const good=zlib.gzipSync(Buffer.from('Premiere mask data '.repeat(100)));
  for(const i of [12,good.length-8,good.length-4]){const bad=Buffer.from(good);bad[i]^=127;assert.throws(()=>gunzip(bad));}
  assert.throws(()=>gunzip(good.subarray(0,-5)));
});
test('PRMF parser rejects unrelated and truncated files without allocating raster data',()=>{
  for(const b of [Buffer.alloc(0),Buffer.alloc(32),Buffer.from('prmf')])assert.throws(()=>prmf.index(b));
});
test('UXP-compatible project XML reader preserves Unicode and rejects invalid UTF-8 and entities',()=>{
  const {xml}=require('../project-mask.js');
  const tree=xml(zlib.gzipSync(Buffer.from('<PremiereData><Name>한글 😀 &amp; 마스크</Name></PremiereData>')));
  assert.equal(tree.children[0].text,'한글 😀 & 마스크');
  assert.throws(()=>xml(zlib.gzipSync(Buffer.from([0xc0,0xaf]))),/UTF-8/);
  assert.throws(()=>xml(zlib.gzipSync(Buffer.from('<!DOCTYPE PremiereData><PremiereData/>'))),/선언/);
});
// Opt-in host fixture. Never copy a user's project or mask data into a release.
test('saved single-mask fixture covers every trimmed sequence frame and plans the target path', {skip:!process.env.MASKMOTION_TEST_PROJECT},async()=>{
  const file=process.env.MASKMOTION_TEST_PROJECT,context=JSON.parse(process.env.MASKMOTION_TEST_CONTEXT),project=fs.readFileSync(file),dir=file.replace(/\.prproj$/i,'')+' Masks';
  const {listMasks}=require('../project-mask.js'),masks=listMasks(project,context.sequenceGuid,context.source),options={maskId:context.maskId||masks[0].id};
  const data=await source.readTracking(project,context,async name=>fs.readFileSync(path.join(dir,name)),options);
  const core=require('../core.js'),expected=core.clipSampleTimes(context.source.start,context.source.end,context.frameTicks,1);
  assert.deepEqual(data.samples.map(s=>s.ticks),expected);assert.ok(data.samples.length>2);
  const first=data.samples[0],last=data.samples.at(-1);assert.ok(Math.hypot(last.x-first.x,last.y-first.y)>.01);
  assert.equal(core.planKeys(data.samples,{start:context.source.start,end:context.source.end,inPoint:'0'},{x:.5,y:.5}).length,expected.length);
  await assert.rejects(source.readTracking(project,context,async()=>{throw Error('missing mask');},options),/missing mask/);
  const trimmed={...context,source:{...context.source,inPoint:String(BigInt(context.source.inPoint)+BigInt(context.frameTicks))}};
  await assert.rejects(source.readTracking(project,trimmed,async name=>fs.readFileSync(path.join(dir,name)),options),/일치하지 않습니다/);
  await assert.rejects(source.readTracking(project,context,async name=>fs.readFileSync(path.join(dir,name)),{maskId:'missing-mask'}),/선택한 마스크가/);
  if(masks.length>1){
    await assert.rejects(source.readTracking(project,context,async name=>fs.readFileSync(path.join(dir,name))),/마스크가 여러 개/);
    const second=await source.readTracking(project,context,async name=>fs.readFileSync(path.join(dir,name)),{maskId:masks.find(mask=>mask.id!==options.maskId).id});
    assert.notEqual(data.maskId,second.maskId);assert.equal(second.samples.length,data.samples.length);
    assert.ok(data.maskFiles.every(file=>!second.maskFiles.includes(file)));
    assert.ok(Math.hypot(data.samples[0].x-second.samples[0].x,data.samples[0].y-second.samples[0].y)>.01);
  }
});
test('native absent-mask sentinel is empty rather than a corrupt GDeflate stream',()=>{
 const file={depth:1,bytes:new Uint8Array([0])},entry={offset:0,bytes:1,rect:[0,0,1280,720],full:[1280,720]};
 assert.equal(prmf.decodeFrame(file,entry,{raster:true}).area,0);
 assert.throws(()=>prmf.decodeFrame(file,entry),/MASK_EMPTY/);
 assert.throws(()=>prmf.decodeFrame(file,{...entry,rect:[0,0,20,20]},{raster:true}),/GDeflate/);
 assert.throws(()=>prmf.decodeFrame({...file,bytes:new Uint8Array([1])},entry,{raster:true}),/GDeflate/);
});
