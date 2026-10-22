"use strict";
// Match a visible silhouette against a fully visible reference, evaluating only
// pixels inside the image. Clipped pixels are unknown, never background evidence.
function match(reference, current) {
  const a=reference.bounds,b=current.bounds,[width,height]=current.full;
  if(!a||!b||current.area<=0||current.area/reference.area>1.25)return null;
  const xs=[],ys=[];
  if(b.left>0)xs.push(b.left-a.left);
  if(b.right<width-1)xs.push(b.right-a.right);
  if(b.top>0)ys.push(b.top-a.top);
  if(b.bottom<height-1)ys.push(b.bottom-a.bottom);
  if(b.left>0&&b.right<width-1)xs.push((b.left+b.right-a.left-a.right)/2);
  if(b.top>0&&b.bottom<height-1)ys.push((b.top+b.bottom-a.top-a.bottom)/2);
  if(!xs.length||!ys.length)return null;
  const pixel=(r,x,y)=>{const [rx,ry,w,h]=r.rect;x=Math.floor(x)-rx;y=Math.floor(y)-ry;return x>=0&&y>=0&&x<w&&y<h&&r.alpha[y*w+x]>=32;};
  const step=Math.max(1,Math.min(b.right-b.left+1,b.bottom-b.top+1,Math.ceil(Math.max(a.right-a.left+1,a.bottom-a.top+1,b.right-b.left+1,b.bottom-b.top+1)/48)));
  function score(dx,dy){
    const l=Math.max(0,Math.min(b.left,a.left+dx)),t=Math.max(0,Math.min(b.top,a.top+dy));
    const rr=Math.min(width-1,Math.max(b.right,a.right+dx)),bb=Math.min(height-1,Math.max(b.bottom,a.bottom+dy));
    let intersection=0,union=0;
    for(let y=t+.5;y<=bb+.5;y+=step)for(let x=l+.5;x<=rr+.5;x+=step){const p=pixel(reference,x-dx,y-dy),q=pixel(current,x,y);if(p||q)union++;if(p&&q)intersection++;}
    return union?intersection/union:0;
  }
  let best={score:-1};
  // A thin cap has a jittery bounding edge; search more finely and farther
  // rather than accepting a low-confidence silhouette match.
  const thin=current.area/reference.area<.08, radius=thin?16:4, increment=thin?1:2;
  // Unclipped sides supply translation candidates; local silhouette matching
  // tolerates segmentation jitter without a costly full-image search.
  for(const x of xs)for(const y of ys)for(let oy=-radius;oy<=radius;oy+=increment)for(let ox=-radius;ox<=radius;ox+=increment){
    const dx=x+ox,dy=y+oy,s=score(dx,dy);if(s>best.score)best={dx,dy,score:s};
  }
  if(best.score<.72)return null;
  return {x:reference.x+best.dx/width,y:reference.y+best.dy/height,confidence:best.score,quality:'estimated'};
}
function finish(samples,frameTicks,minFrames=2) {
  const good=samples.map((s,i)=>s.quality==='measured'||s.quality==='estimated'?i:-1).filter(i=>i>=0);
  if(good.length<minFrames)throw Error('움직임을 확인할 수 있는 마스크 프레임이 부족합니다. 대상을 화면 안에서 추적한 구간이 필요합니다.');
  const maxGapTicks=254016000000n; // one second, independent of frame rate
  let i=0;
  while(i<samples.length){
    if(samples[i].quality!=='unknown'){i++;continue;}
    const start=i;while(i<samples.length&&samples[i].quality==='unknown')i++;
    const before=start>0?samples[start-1]:null,after=i<samples.length?samples[i]:null;
    const short=before&&after&&BigInt(after.ticks)-BigInt(before.ticks)-BigInt(frameTicks)<=maxGapTicks;
    for(let j=start;j<i;j++){
      const s=samples[j];
      if(short){const p=Number(BigInt(s.ticks)-BigInt(before.ticks))/Number(BigInt(after.ticks)-BigInt(before.ticks));s.x=before.x+(after.x-before.x)*p;s.y=before.y+(after.y-before.y)*p;s.quality='interpolated';}
      else {const anchor=before||after;s.x=anchor.x;s.y=anchor.y;s.quality='held';}
    }
  }
  const ranges=[];
  for(let j=0;j<samples.length;j++){
    const s=samples[j];if(s.quality==='measured')continue;
    const last=ranges[ranges.length-1];
    if(last&&last.quality===s.quality&&last.lastFrame===j-1){last.lastFrame=j;last.endTicks=s.ticks;last.frames++;}
    else ranges.push({quality:s.quality,firstFrame:j,lastFrame:j,startTicks:s.ticks,endTicks:s.ticks,frames:1});
  }
  return {estimated:samples.filter(s=>s.quality==='estimated').length,interpolated:samples.filter(s=>s.quality==='interpolated').length,held:samples.filter(s=>s.quality==='held').length,ranges};
}
module.exports={match,finish};
