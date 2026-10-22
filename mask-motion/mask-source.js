"use strict";
const core=require('./core.js'),projectMask=require('./project-mask.js'),prmf=require('./prmf.js'),edge=require('./edge-motion.js');
async function readTracking(projectBytes,context,readMask,options={}) {
  const {source,size,frameTicks,sequenceGuid,projectGuid}=context;
  if(source.speed!==1||source.reversed)throw Error('마스크 직접 측정은 정방향 100% 속도 클립만 지원합니다.');
  const mask=projectMask.findMask(projectBytes,sequenceGuid,source,options.maskId),entries=new Map(),files=new Map();
  for(const segment of [...mask.storage.segments,mask.storage.seed]){
    if(segment.step!==String(frameTicks))throw Error('마스크와 시퀀스의 프레임 간격이 다릅니다.');
    let file=files.get(segment.id);if(!file){
      file=prmf.index(await readMask(segment.id+'.prmf'));
      if(new Set(file.frames.map(frame=>frame.ticks)).size!==file.frames.length)throw Error('마스크 추적 파일 안에 중복된 프레임이 있습니다.');
      files.set(segment.id,file);
    }
    for(const frame of file.frames){
      if(frame.full[0]!==size.width||frame.full[1]!==size.height)throw Error('원본 마스크와 시퀀스 해상도가 다릅니다.');
      // Premiere 26.5 displays the later stored segment on an overlap (verified
      // against its black-and-white mask view). Preserve project vector order,
      // including backward retracking; the explicit seed is applied last.
      entries.set(frame.ticks,{file,frame});
    }
  }
  const allTimes=core.clipSampleTimes(source.start,source.end,frameTicks),samples=[],ranges=[];
  // Missing PRMF entries are outside this mask's tracked coverage. Empty but
  // stored frames remain inside coverage for edge recovery.
  for(const t of allTimes){
    const media=String(BigInt(source.inPoint)+BigInt(t)-BigInt(source.start));
    if(!entries.has(media))continue;
    const end=String(BigInt(t)+BigInt(frameTicks)<BigInt(source.end)?BigInt(t)+BigInt(frameTicks):BigInt(source.end));
    const last=ranges[ranges.length-1];
    if(last&&last.endTicks===t)last.endTicks=end;
    else ranges.push({startTicks:t,endTicks:end});
  }
  const step=options.step||1;
  if(!Number.isInteger(step)||step<1||step>60)throw Error('분석 간격은 1–60프레임이어야 합니다.');
  const times=[];
  for(const range of ranges){
    const covered=allTimes.filter(t=>BigInt(t)>=BigInt(range.startTicks)&&BigInt(t)<BigInt(range.endTicks));
    times.push(...covered.filter((t,i)=>i%step===0||i===covered.length-1));
  }
  const entryAt=t=>entries.get(String(BigInt(source.inPoint)+BigInt(t)-BigInt(source.start)));
  // Find a complete reference even if the clip starts with a clipped mask.
  let reference=null;
  for(let i=0;i<times.length;i++){
    if(options.cancelled&&options.cancelled())throw Error('측정을 중지했습니다.');
    const e=entryAt(times[i]);if(e){const r=prmf.decodeFrame(e.file,e.frame,{raster:true});if(r.area&&!r.clipped){reference=r;break;}}
    if(options.yieldFrame&&i%8===0)await options.yieldFrame();
  }
  // Source media time and sequence time differ after trimming or moving a clip.
  for(let i=0;i<times.length;i++){
    if(options.cancelled&&options.cancelled())throw Error('측정을 중지했습니다.');
    const media=String(BigInt(source.inPoint)+BigInt(times[i])-BigInt(source.start)),entry=entries.get(media);
    let result={quality:'unknown',reason:entry?'empty':'missing'};
    if(entry){
      const r=prmf.decodeFrame(entry.file,entry.frame,{raster:true});
      if(r.area&&!r.clipped){reference=r;result={x:r.x,y:r.y,quality:'measured'};}
      else if(r.area&&reference){const found=edge.match(reference,r);if(found)result=found;else result.reason='low-confidence';}
    }
    samples.push({ticks:times[i],...result});
    if(options.sampleProgress)options.sampleProgress({completed:i+1,total:times.length});
    if(options.yieldFrame&&i%8===0)await options.yieldFrame();
  }
  const recovery={estimated:0,interpolated:0,held:0,ranges:[]};
  for(const range of ranges){
    const first=samples.findIndex(s=>BigInt(s.ticks)>=BigInt(range.startTicks));
    const part=samples.filter(s=>BigInt(s.ticks)>=BigInt(range.startTicks)&&BigInt(s.ticks)<BigInt(range.endTicks));
    const result=edge.finish(part,frameTicks,1);
    for(const key of ['estimated','interpolated','held'])recovery[key]+=result[key];
    recovery.ranges.push(...result.ranges.map(r=>({...r,firstFrame:r.firstFrame+first,lastFrame:r.lastFrame+first})));
  }
  return core.validateTracking({ranges,recovery,format:'MaskMotion',version:1,method:typeof projectBytes==='string'?'live-object-mask-centroid-experimental':'saved-object-mask-centroid-experimental',capturedAt:new Date().toISOString(),projectGuid,sequenceGuid,source,size,frameTicks:String(frameTicks),maskId:mask.id,maskName:mask.name,maskFiles:[...files.keys()],samples});
}
module.exports={readTracking};
