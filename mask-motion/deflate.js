"use strict";
// Bounded RFC 1951/gzip reader for saved Premiere projects. No Node-only APIs.
const ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
const LB = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const LE = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const DB = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577,32769,49153];
const DE = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13,14,14];
function huffman(lengths) {
  const counts = Array(16).fill(0), next = Array(16).fill(0), table = new Map();
  for (const n of lengths) { if (n < 0 || n > 15) throw Error("잘못된 Huffman 길이"); if (n) counts[n]++; }
  let code = 0, max = 0;
  for (let n = 1; n <= 15; n++) { code = (code + counts[n-1]) * 2; next[n] = code; if (code + counts[n] > 2 ** n) throw Error("잘못된 Huffman 트리"); }
  lengths.forEach((n, sym) => { if (!n) return; let c = next[n]++, r = 0; for (let i = 0; i < n; i++) { r = r * 2 + (c & 1); c >>>= 1; } table.set(n * 65536 + r, sym); max = Math.max(max,n); });
  return bits => { for (let n=1; n<=max; n++) { const value = table.get(n*65536 + (bits & (2**n-1))); if (value !== undefined) return [value,n]; } throw Error("Huffman 데이터를 읽을 수 없습니다."); };
}
function crc32(b) { let c = 0xffffffff; for (const v of b) { c ^= v; for (let i=0;i<8;i++) c=(c>>>1)^((c&1)?0xedb88320:0); } return (c^0xffffffff)>>>0; }
function gunzip(input) {
  const b=input instanceof Uint8Array?input:new Uint8Array(input), v=new DataView(b.buffer,b.byteOffset,b.byteLength);
  if (b.length<18 || b[0]!==31 || b[1]!==139 || b[2]!==8 || (b[3]&224)) throw Error("gzip 프로젝트 파일이 아닙니다.");
  const size=v.getUint32(b.length-4,true); if (!size || size>64000000) throw Error("프로젝트 XML 크기가 지원 범위를 벗어납니다.");
  let p=10; const end=b.length-8;
  if (b[3]&4) { if(p+2>end) throw Error("잘린 gzip 헤더"); const n=v.getUint16(p,true); p+=2+n; }
  for (const flag of [8,16]) if(b[3]&flag) { while(p<end && b[p++]); }
  if (b[3]&2) { if(p+2>end || (crc32(b.subarray(0,p))&65535)!==v.getUint16(p,true)) throw Error("gzip 헤더 CRC 불일치"); p+=2; }
  if(p>=end) throw Error("잘린 gzip 데이터");
  let bits=0, count=0, dst=0; const out=new Uint8Array(size);
  function read(n) { while(count<n) { if(p>=end) throw Error("잘린 DEFLATE 데이터"); bits|=b[p++]<<count;count+=8; } const r=bits&(2**n-1);bits>>>=n;count-=n;return r; }
  function sym(dec) { while(count<15 && p<end) { bits|=b[p++]<<count;count+=8; } const [s,n]=dec(bits);if(n>count)throw Error("잘린 Huffman 데이터");read(n);return s; }
  let final=0;
  do {
    final=read(1); const kind=read(2);
    if(kind===0) { const skip=count%8;read(skip);const n=read(16),inv=read(16);if((n^inv)!==65535||dst+n>size)throw Error("잘못된 비압축 블록");for(let i=0;i<n;i++)out[dst++]=read(8);continue; }
    if(kind===3)throw Error("지원하지 않는 DEFLATE 블록");
    let ll,dd;
    if(kind===1) { ll=huffman([...Array(144).fill(8),...Array(112).fill(9),...Array(24).fill(7),...Array(8).fill(8)]);dd=huffman(Array(32).fill(5)); }
    else {
      const nl=read(5)+257,nd=read(5)+1,nc=read(4)+4,cl=Array(19).fill(0),lens=[];
      for(let i=0;i<nc;i++)cl[ORDER[i]]=read(3);const cd=huffman(cl);
      while(lens.length<nl+nd) { const s=sym(cd); if(s<16)lens.push(s);else { const n=s===16?read(2)+3:s===17?read(3)+3:read(7)+11;if(s===16&&!lens.length)throw Error("잘못된 반복 코드");const value=s===16?lens[lens.length-1]:0;for(let i=0;i<n;i++)lens.push(value); } }
      if(lens.length!==nl+nd || !lens[256])throw Error("잘못된 동적 Huffman 블록");ll=huffman(lens.slice(0,nl));dd=huffman(lens.slice(nl));
    }
    while(true) { const s=sym(ll);if(s===256)break;if(s<256){if(dst>=size)throw Error("DEFLATE 출력 초과");out[dst++]=s;continue;}if(s>285)throw Error("잘못된 길이 코드");const n=LB[s-257]+read(LE[s-257]),d=sym(dd);if(d>29)throw Error("잘못된 거리 코드");const distance=DB[d]+read(DE[d]);if(distance>dst||dst+n>size)throw Error("DEFLATE 참조 범위 초과");for(let i=0;i<n;i++){out[dst]=out[dst-distance];dst++;} }
  }while(!final);
  if(dst!==size||crc32(out)!==v.getUint32(b.length-8,true))throw Error("프로젝트 gzip 크기 또는 CRC가 일치하지 않습니다.");
  return out;
}
module.exports={gunzip,huffman,ORDER,LB,LE,DB,DE};
