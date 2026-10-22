"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),edge=require('../edge-motion.js'),core=require('../core.js');
function shape(cx,cy,type='circle'){
 const w=160,h=100,alpha=new Uint8Array(w*h);let mass=0,sx=0,sy=0,l=w,r=-1,t=h,b=-1;
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
 const dx=x+.5-cx,dy=y+.5-cy,inside=type==='circle'?dx*dx+dy*dy<=20**2:type==='square'?Math.abs(dx)<=20&&Math.abs(dy)<=20:dy>=-20&&dy<=20&&Math.abs(dx)<=(dy+20)/2;
 if(inside){alpha[y*w+x]=255;mass++;sx+=x+.5;sy+=y+.5;l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}}
 return {alpha,rect:[0,0,w,h],full:[w,h],bounds:mass?{left:l,right:r,top:t,bottom:b}:null,area:mass,x:sx/mass/w,y:sy/mass/h};
}
for(const type of ['circle','square','triangle'])test(type+' silhouette recovers translation across left/right/top/bottom and corners',()=>{
 const ref=shape(80,50,type);
 for(const [x,y] of [[5,50],[155,50],[80,5],[80,95],[5,5],[-7,50]]){
 const cur=shape(x,y,type),result=edge.match(ref,cur);assert.ok(result,type+' '+[x,y]);
 // Triangle's centroid is offset from its bounding box centre.
 assert.ok(Math.hypot((result.x-ref.x)*160-(x-80),(result.y-ref.y)*100-(y-50))<=3,[type,x,y,JSON.stringify(result)].join(' '));}
});
test('empty and incompatible masks are rejected for recovery',()=>{
 const ref=shape(80,50);assert.equal(edge.match(ref,shape(-21,50)),null);
 assert.equal(edge.match(ref,shape(5,50,'triangle')),null);
});
test('short gaps interpolate by ticks; long gaps and open ends hold with explicit ranges',()=>{
 const frame='8467200000',samples=Array.from({length:70},(_,i)=>({ticks:String(BigInt(frame)*BigInt(i)),quality:'unknown'}));
 for(const [i,x] of [[2,.1],[10,.2],[60,.8]])samples[i]={...samples[i],quality:'measured',x,y:.5};
 const r=edge.finish(samples,frame);assert.equal(samples[0].quality,'held');assert.equal(samples[5].quality,'interpolated');assert.equal(samples[35].quality,'held');assert.equal(samples[69].quality,'held');assert.equal(samples[5].x,.1375);assert.ok(r.held>0&&r.interpolated>0&&r.ranges.length>0);
});
test('no trustworthy motion cannot produce a successful held-only trajectory',()=>assert.throws(()=>edge.finish([{quality:'unknown',ticks:'0'},{quality:'unknown',ticks:'1'}],'1'),/不足|부족/));
test('out-of-image coordinates require an explicit recovery quality and bounded values',()=>{
 const d={format:'MaskMotion',version:1,projectGuid:'p',sequenceGuid:'s',source:{start:'0',end:'20'},size:{width:160,height:100},frameTicks:'10',samples:[{ticks:'0',x:-.1,y:.5,quality:'estimated'},{ticks:'10',x:1.1,y:.5,quality:'interpolated'}]};assert.equal(core.validateTracking(d),d);d.samples[0].quality='measured';assert.throws(()=>core.validateTracking(d));d.samples[0].quality='estimated';d.samples[0].x=-2;assert.throws(()=>core.validateTracking(d));
});

for(const type of ['circle','square','triangle'])test(type+' continues estimating the final visible sliver on all four edges',()=>{
 const ref=shape(80,50,type);
 for(const [x,y] of [[-19,50],[179,50],[80,-19],[80,119]]){
  const cur=shape(x,y,type);if(!cur.area)continue;
  assert.ok(cur.area/ref.area<.08);
  const found=edge.match(ref,cur);assert.ok(found,type+' '+[x,y]);
  assert.ok(Math.hypot((found.x-ref.x)*160-(x-80),(found.y-ref.y)*100-(y-50))<=4,JSON.stringify({type,x,y,found}));
 }
});
