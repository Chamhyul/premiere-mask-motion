"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const core=require('../core.js');
function fixture(segments=['old','continued'],seed='seed'){
  const frame=(ticks,x)=>({ticks:String(ticks),full:[100,100],x,y:.5});
  const files={
    old:{frames:[frame(0,.1),frame(10,.11),frame(20,.12),frame(30,.13),frame(40,.14)]},
    continued:{frames:[frame(20,.7),frame(30,.71),frame(40,.72),frame(50,.73)]},
    seed:{frames:[frame(30,.9)]}
  },reads=[],decoded=[];
  const storage=id=>({id,step:'10',start:files[id].frames[0].ticks});
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../mask-source.js'),'utf8'),{module,require:name=>{
    if(name==='./core.js')return core;
    if(name==='./edge-motion.js')return require('../edge-motion.js');
    if(name==='./project-mask.js')return {findMask:()=>({id:'mask',name:'01',storage:{segments:segments.map(storage),seed:storage(seed)}})};
    if(name==='./prmf.js')return {index:id=>files[id],decodeFrame:(file,frame)=>{decoded.push(frame);return {x:frame.x,y:frame.y,area:100,clipped:false};}};
    throw Error(name);
  }});
  const context={projectGuid:'project',sequenceGuid:'sequence',size:{width:100,height:100},frameTicks:'10',source:{start:'100',end:'160',inPoint:'0',speed:1,reversed:false}};
  const read=async name=>{const id=name.replace(/\.prmf$/,'');reads.push(id);return id;};
  return {files,reads,decoded,context,run:(options={})=>module.exports.readTracking(new Uint8Array(),context,read,{maskId:'mask',...options})};
}
test('continued tracking replaces overlapping frames, retains old coverage, and preserves the seed',async()=>{
  const f=fixture(),result=await f.run();
  assert.deepEqual(Array.from(result.samples,s=>s.ticks),['100','110','120','130','140','150']);
  assert.deepEqual(Array.from(result.samples,s=>s.x),[.1,.11,.7,.9,.72,.73]);
  assert.equal(f.decoded.length,7,'one reference scan plus each output frame');
});
test('project segment order determines priority even when the last retrack starts earlier',async()=>{
  const f=fixture(['continued','old']),result=await f.run();
  assert.deepEqual(Array.from(result.samples,s=>s.x),[.1,.11,.12,.9,.14,.73]);
});
test('repeated references read one file once without treating references as corrupt frames',async()=>{
  const f=fixture(['old','old','continued']);await f.run();
  assert.deepEqual(f.reads,['old','continued','seed']);
});
test('ambiguous duplicate timestamps within one file still fail',async()=>{
  const f=fixture();f.files.continued.frames.push({...f.files.continued.frames[0],x:.8});
  await assert.rejects(f.run(),/파일 안에 중복된 프레임/);
});
test('missing tracking frames are outside mask coverage rather than held to the clip end',async()=>{
  const f=fixture();f.files.continued.frames.pop();
  const result=await f.run();
  assert.equal(result.samples.length,5);assert.equal(result.recovery.held,0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.ranges)),[{startTicks:'100',endTicks:'150'}]);
});

test('a mask tracked only inside a longer source has no leading or trailing application samples',async()=>{
  const f=fixture(['continued'],'seed');f.context.source.end='220';
  const result=await f.run();
  assert.deepEqual(Array.from(result.samples,s=>s.ticks),['120','130','140','150']);
  assert.deepEqual(JSON.parse(JSON.stringify(result.ranges)),[{startTicks:'120',endTicks:'160'}]);
});
test('missing interior frames split coverage without filling the gap',async()=>{
  const f=fixture();f.files.old.frames=f.files.old.frames.filter(s=>s.ticks!=='20');
  f.files.continued.frames=f.files.continued.frames.filter(s=>s.ticks!=='20');
  const result=await f.run();
  assert.deepEqual(Array.from(result.samples,s=>s.ticks),['100','110','130','140','150']);
  assert.deepEqual(JSON.parse(JSON.stringify(result.ranges)),[{startTicks:'100',endTicks:'120'},{startTicks:'130',endTicks:'160'}]);
  assert.equal(result.recovery.held,0);
});

test('sampling keeps coverage boundaries and maps media time after trimming and moving',async()=>{
 const f=fixture(['continued'],'seed');
 f.context.source={...f.context.source,start:'200',end:'300',inPoint:'10'};
 const result=await f.run({step:3});
 assert.deepEqual(Array.from(result.samples,s=>s.ticks),['210','240']);
 assert.deepEqual(JSON.parse(JSON.stringify(result.ranges)),[{startTicks:'210',endTicks:'250'}]);
});
