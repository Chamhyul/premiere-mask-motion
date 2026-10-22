"use strict";
const core=require('./core.js'), {huffman,ORDER,LB,LE,DB,DE}=require('./deflate.js');
// Experimental reader for the observed Premiere 26.5 PRMF v2/v3 formats.
// GDeflate uses 32 interleaved lanes; it is not ordinary DEFLATE.
function tile(input,target) {
  if(input.length<128 || target<1 || target>65536)throw Error('잘못된 GDeflate 타일');
  const v=new DataView(input.buffer,input.byteOffset,input.byteLength),buf=[],cnt=Array(32).fill(32),out=new Uint8Array(target);let cursor=128,dst=0;
  for(let i=0;i<32;i++)buf.push(BigInt(v.getUint32(i*4,true)));
  const peek=(i,n,shift=0)=>Number((buf[i]>>BigInt(shift))&((1n<<BigInt(n))-1n));
  function consume(ns,en=Array(32).fill(true)) {
    for(let i=0;i<32;i++)if(en[i]){if(ns[i]>cnt[i])throw Error('GDeflate 비트 범위 초과');buf[i]>>=BigInt(ns[i]);cnt[i]-=ns[i];}
    for(let i=0;i<32;i++)if(en[i]&&cnt[i]<32){if(cursor+4>input.length)throw Error('잘린 GDeflate 타일');buf[i]|=BigInt(v.getUint32(cursor,true))<<BigInt(cnt[i]);cnt[i]+=32;cursor+=4;}
  }
  function one(n){const x=peek(0,n);consume([n,...Array(31).fill(0)],[true,...Array(31).fill(false)]);return x;}
  let final=false,blocks=0;
  do {
    if(++blocks>1000)throw Error('GDeflate 블록 개수 초과');const header=peek(0,17),kind=(header>>1)&3;final=!!(header&1);one(3);
    if(kind===0){let size=one(16);if(dst+size>target)throw Error('타일 출력 초과');while(size){const n=Math.min(32,size),ns=Array(32).fill(0),en=Array(32).fill(false);for(let i=0;i<n;i++){out[dst+i]=peek(i,8);ns[i]=8;en[i]=true;}consume(ns,en);dst+=n;size-=n;}continue;}
    let ll,dd;
    if(kind===1){ll=huffman([...Array(144).fill(8),...Array(112).fill(9),...Array(24).fill(7),...Array(8).fill(8)]);dd=huffman(Array(32).fill(5));}
    else if(kind===2){
      const nl=((header>>3)&31)+257,nd=((header>>8)&31)+1,nc=((header>>13)&15)+4,cl=Array(19).fill(0),lens=[];one(14);
      let ns=Array(32).fill(0),en=Array(32).fill(false);for(let i=0;i<nc;i++){cl[ORDER[i]]=peek(i,3);ns[i]=3;en[i]=true;}consume(ns,en);const dec=huffman(cl);
      while(lens.length<nl+nd){ns=Array(32).fill(0);en=Array(32).fill(false);for(let i=0;i<32&&lens.length<nl+nd;i++){const [s,n]=dec(peek(i,15));let extra=0,repeat=1,value=s;if(s===16){if(!lens.length)throw Error('잘못된 GDeflate 반복');extra=2;repeat=3+peek(i,2,n);value=lens[lens.length-1];}else if(s===17){extra=3;repeat=3+peek(i,3,n);value=0;}else if(s===18){extra=7;repeat=11+peek(i,7,n);value=0;}for(let j=0;j<repeat;j++)lens.push(value);ns[i]=n+extra;en[i]=true;}consume(ns,en);}
      if(lens.length!==nl+nd||!lens[256])throw Error('잘못된 GDeflate Huffman 길이');ll=huffman(lens.slice(0,nl));dd=huffman(lens.slice(nl));
    }else throw Error('지원하지 않는 GDeflate 블록');
    function round(previous) {
      const symbols=Array(32).fill(0),values=Array(32).fill(0),ns=Array(32).fill(0),en=Array(32).fill(false);let end=null;
      for(let i=0;i<32;i++){
        const isDistance=previous[i];if(end!==null&&!isDistance)continue;const [s,n]=(isDistance?dd:ll)(peek(i,15));symbols[i]=s;let base,extra;
        if(isDistance){if(s>31)throw Error('잘못된 GDeflate 거리');base=DB[s];extra=DE[s];}
        else if(s<256){base=1;extra=0;}
        else if(s===256){base=0;extra=0;end=i;}
        else {if(s>285)throw Error('잘못된 GDeflate 길이');base=s===285?3:LB[s-257];extra=s===285?16:LE[s-257];}
        values[i]=base+peek(i,extra,n);ns[i]=n+extra;en[i]=true;
      }
      consume(ns,en);return {symbols,values,end};
    }
    function write(symbols,lengths,copies,distances) {
      for(let i=0;i<32;i++){const n=lengths[i];if(dst+n>target)throw Error('GDeflate 출력 초과');if(!n)continue;if(copies[i]){const d=distances[i];if(d<1||d>dst)throw Error('GDeflate 복사 범위 초과');for(let j=0;j<n;j++){out[dst]=out[dst-d];dst++;}}else{if(symbols[i]>255||n!==1)throw Error('잘못된 GDeflate 리터럴');out[dst++]=symbols[i];}}
    }
    let r=round(Array(32).fill(false)),symbols=r.symbols,lengths=r.values,end=r.end,copies=symbols.map(s=>s>256),rounds=0;
    while(end===null){if(++rounds>70000)throw Error('GDeflate 처리 상한 초과');r=round(copies);write(symbols,lengths,copies,r.values);end=r.end;lengths=r.values.map((n,i)=>copies[i]||(end!==null&&i>end)?0:n);symbols=r.symbols;copies=symbols.map(s=>s>256);}
    const distances=Array(32).fill(0),ns=Array(32).fill(0),en=Array(32).fill(false);
    for(let i=0;i<=end;i++)if(copies[i]){const [s,n]=dd(peek(i,15));if(s>31)throw Error('잘못된 거리');distances[i]=DB[s]+peek(i,DE[s],n);ns[i]=n+DE[s];en[i]=true;}consume(ns,en);write(symbols,lengths,copies,distances);
  }while(!final);
  if(dst!==target)throw Error('GDeflate 출력 크기 불일치');return out;
}
function decompress(b) {
  const v=new DataView(b.buffer,b.byteOffset,b.byteLength);if(b.length<12)throw Error('잘린 GDeflate 헤더');
  const count=v.getUint16(2,true),packed=v.getUint32(4,true),last=(packed>>>2)&0x3ffff;
  if(b[0]!==4||b[1]!==251||!count||(packed&3)!==1||last>65536||8+count*4>b.length)throw Error('지원하지 않는 GDeflate 형식');
  const size=(count-1)*65536+(last||65536);if(size>16000000)throw Error('마스크 래스터 크기 초과');const out=new Uint8Array(size),base=8+4*count;
  for(let i=0;i<count;i++){const start=i?v.getUint32(8+4*i,true):0,end=i+1<count?v.getUint32(12+4*i,true):start+v.getUint32(8,true);if(start>=end||base+end>b.length||(i+1===count&&base+end!==b.length))throw Error('잘못된 GDeflate 타일 범위');out.set(tile(b.subarray(base+start,base+end),i+1===count?(last||65536):65536),i*65536);}
  return out;
}
class Flat {
  constructor(input){this.b=input instanceof Uint8Array?input:new Uint8Array(input);this.v=new DataView(this.b.buffer,this.b.byteOffset,this.b.byteLength);}
  check(p,n){if(!Number.isSafeInteger(p)||p<0||p+n>this.b.length)throw Error('마스크 메타데이터 범위 초과');return p;}
  u8(p){return this.v.getUint8(this.check(p,1));}u16(p){return this.v.getUint16(this.check(p,2),true);}u32(p){return this.v.getUint32(this.check(p,4),true);}i32(p){return this.v.getInt32(this.check(p,4),true);}
  i64(p,fallback){if(p===null&&fallback!==undefined)return String(fallback);return String(this.v.getBigInt64(this.check(p,8),true));}u64(p){const n=Number(this.v.getBigUint64(this.check(p,8),true));if(!Number.isSafeInteger(n))throw Error('마스크 오프셋 초과');return n;}
  pointer(p){if(p==null)throw Error('필수 마스크 필드 누락');const t=p+this.u32(p);this.check(t,4);return t;}
  field(t,n){const vt=t-this.i32(t),len=this.u16(vt);this.check(vt,len);const off=6+n*2<=len?this.u16(vt+4+n*2):0;return off?t+off:null;}
  root(){return this.u32(0);}
  vector(p){const at=this.pointer(p),n=this.u32(at);if(n>core.MAX_SAMPLES)throw Error('마스크 항목 수 초과');this.check(at+4,n*4);return Array.from({length:n},(_,i)=>this.pointer(at+4+i*4));}
  string(p){const t=this.pointer(p),n=this.u32(t);this.check(t+4,n);return String.fromCharCode(...this.b.subarray(t+4,t+4+n));}
}
function index(input) {
  const f=new Flat(input);if(f.b.length<32||String.fromCharCode(...f.b.subarray(0,4))!=='prmf'||![2,3].includes(f.u32(4)))throw Error('지원하지 않는 PRMF 버전');
  const off=f.u64(8),size=f.u64(16),start=f.u64(24);if(start!==32||off<start||off+size!==f.b.length)throw Error('잘못된 PRMF 파일 범위');
  const m=new Flat(f.b.subarray(off)),root=m.root(),cfg=m.pointer(m.field(root,1)),depth=m.u8(m.field(cfg,1)),filter=m.u8(m.field(cfg,2));
  if(![1,8].includes(depth)||filter!==1)throw Error('지원하지 않는 마스크 픽셀 형식');
  const frames=m.vector(m.field(root,2)).map(t=>{
    const r=m.field(t,3),s=m.field(t,4),rect=Array.from({length:4},(_,i)=>m.i32(r+i*4)),full=[m.i32(s),m.i32(s+4)],offset=m.u64(m.field(t,2)),bytes=m.u32(m.field(t,6));
    const [x,y,w,h]=rect;if(!full.every(n=>n>0&&n<=32768)||w<1||h<1||w*h>16000000||x<0||y<0||x+w>full[0]||y+h>full[1]||offset<start||offset+bytes>off)throw Error('마스크 프레임 범위 초과');
    return {ticks:m.i64(m.field(t,1),0),rect,full,offset,bytes};
  });return {depth,frames,bytes:f.b};
}
function decodeFrame(file,entry,options={}) {
  // Observed on the native edge-return demo: an absent binary mask is a
  // single zero byte over the full canvas, not a GDeflate stream.
  if(file.depth===1&&entry.bytes===1&&file.bytes[entry.offset]===0&&entry.rect[0]===0&&entry.rect[1]===0&&entry.rect[2]===entry.full[0]&&entry.rect[3]===entry.full[1]){
    if(!options.raster)throw Error('MASK_EMPTY: 화면에 보이는 마스크가 없습니다.');
    return {x:null,y:null,area:0,bounds:null,clipped:false,alpha:new Uint8Array(0),rect:entry.rect,full:entry.full};
  }
  const raw=decompress(file.bytes.subarray(entry.offset,entry.offset+entry.bytes)),[x,y,w,h]=entry.rect,alpha=new Uint8Array(w*h);
  if(file.depth===8){if(raw.length!==alpha.length)throw Error('알파 래스터 크기 불일치');for(let i=0;i<raw.length;i++)alpha[i]=(raw[i]+(i>=w?alpha[i-w]:0))&255;}
  else {
    const stride=Math.ceil(w/4);if(raw.length!==stride*Math.ceil(h/2))throw Error('이진 래스터 크기 불일치');
    // Observed nibble-first 2x2 blocks; validate against host before release.
    const order=[4,5,0,1,6,7,2,3];for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++)alpha[yy*w+xx]=255*((raw[Math.floor(yy/2)*stride+Math.floor(xx/4)]>>order[(yy%2)*4+xx%4])&1);
  }
  // Padding avoids treating the crop boundary as the sequence boundary.
  const padded=new Uint8Array((w+2)*(h+2));for(let row=0;row<h;row++)padded.set(alpha.subarray(row*w,(row+1)*w),(row+1)*(w+2)+1);
  let m;try{m=core.measure({width:w+2,height:h+2,alpha:padded},{allowOpaque:true});}catch(error){if(options.raster&&String(error.message).startsWith("MASK_EMPTY:"))return {x:null,y:null,area:0,bounds:null,clipped:false,alpha,rect:entry.rect,full:entry.full};throw error;}const bounds={left:x+m.bounds.left-1,top:y+m.bounds.top-1,right:x+m.bounds.right-1,bottom:y+m.bounds.bottom-1};
  const clipped=bounds.left<=0||bounds.top<=0||bounds.right>=entry.full[0]-1||bounds.bottom>=entry.full[1]-1;
  if(clipped&&!options.raster)throw Error('MASK_CLIPPED: 마스크가 화면 가장자리에 닿았습니다.');
  return {...m,...(options.raster?{alpha,rect:entry.rect,full:entry.full,clipped}:{}),x:(x+m.x*(w+2)-1)/entry.full[0],y:(y+m.y*(h+2)-1)/entry.full[1],bounds,transparentFraction:1-m.area/(entry.full[0]*entry.full[1])};
}
module.exports={Flat,index,decodeFrame,decompress};
