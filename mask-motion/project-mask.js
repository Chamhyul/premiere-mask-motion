"use strict";
const {gunzip}=require('./deflate.js'),{Flat}=require('./prmf.js');
function utf8(bytes){
  const chars=[];
  for(let i=0;i<bytes.length;){const a=bytes[i++];let cp,n,min;
    if(a<128){cp=a;n=0;min=0;}else if(a>=194&&a<=223){cp=a&31;n=1;min=128;}else if(a>=224&&a<=239){cp=a&15;n=2;min=2048;}else if(a>=240&&a<=244){cp=a&7;n=3;min=65536;}else throw Error('프로젝트 UTF-8 인코딩 오류');
    for(let j=0;j<n;j++){const b=bytes[i++];if(b===undefined||(b&192)!==128)throw Error('잘린 프로젝트 UTF-8');cp=cp*64+(b&63);}
    if(cp<min||cp>0x10ffff||(cp>=0xd800&&cp<=0xdfff))throw Error('잘못된 프로젝트 UTF-8 문자');chars.push(String.fromCodePoint(cp));
  }return chars.join('');
}
function entities(s){return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,x)=>x[0]==='#'?String.fromCodePoint(x[1].toLowerCase()==='x'?parseInt(x.slice(2),16):Number(x.slice(1))):({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[x]);}
function xml(input) {
  const text=typeof input==='string'?input:utf8(gunzip(input));if(text.length>32*1024*1024||/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('지원하지 않는 XML 선언');
  const root={tag:'root',attrs:{},children:[],text:''},stack=[root];let count=0;
  for(const part of text.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[^>]+>|[^<]+/g)||[]){
    if(part.startsWith('<?')||part.startsWith('<!--'))continue;
    if(part.startsWith('<![CDATA[')){stack[stack.length-1].text+=part.slice(9,-3);continue;}
    if(part.startsWith('</')){const tag=part.slice(2,-1).trim();if(stack.length<2||stack.pop().tag!==tag)throw Error('프로젝트 XML 구조 불일치');continue;}
    if(part[0]==='<'){const tag=/^<([\w.:-]+)/.exec(part);if(!tag||++count>1000000)throw Error('지원하지 않는 프로젝트 XML');const node={tag:tag[1],attrs:{},children:[],text:''};for(const a of part.matchAll(/([\w.:-]+)="([^"]*)"/g))node.attrs[a[1]]=entities(a[2]);stack[stack.length-1].children.push(node);if(!part.endsWith('/>'))stack.push(node);}
    else stack[stack.length-1].text+=entities(part);
  }
  if(stack.length!==1||root.children.length!==1||root.children[0].tag!=='PremiereData')throw Error('Premiere XML 파일이 아닙니다.');return root.children[0];
}
const children=(n,tag)=>n?n.children.filter(c=>c.tag===tag):[];
function at(n,path){for(const tag of path.split('/'))n=children(n,tag)[0];return n;}
const text=(n,path,fallback='')=>{const e=at(n,path);return e?e.text.trim():fallback;};
function base64(s){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',clean=s.replace(/\s/g,'');if(!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)||clean.length%4)throw Error('잘못된 마스크 base64');const out=[];let b=0,n=0;for(const c of clean){if(c==='=')break;b=(b<<6)|alphabet.indexOf(c);n+=6;if(n>=8){n-=8;out.push((b>>n)&255);}}return new Uint8Array(out);}
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function maskStorage(bytes) {
  const f=new Flat(bytes),root=f.root();
  const identity=f.pointer(f.field(root,0)),id=f.string(f.field(identity,5));
  if(!GUID.test(id))throw Error('잘못된 오브젝트 마스크 ID');
  // Premiere omits the schema defaults: 30 fps frame duration and media time 0.
  function storage(t){const id=f.pointer(f.field(t,1)),guid=f.string(f.field(id,0));if(!GUID.test(guid))throw Error('잘못된 마스크 파일 ID');return {id:guid,step:f.i64(f.field(t,2),8467200000),start:f.i64(f.field(t,3),0)};}
  const list=f.field(root,1),seed=f.field(root,2);return {id,segments:list?f.vector(list).map(storage):[],seed:seed?storage(f.pointer(seed)):null};
}
function maskContext(input,sequenceGuid,source) {
  const root=xml(input),ids=new Map(),uids=new Map(),hashes=new Map();
  function visit(n){if(n.attrs.BinaryHash&&n.text.trim())hashes.set(n.attrs.BinaryHash,n.text.trim());for(const c of n.children)visit(c);}visit(root);
  for(const e of root.children){if(e.attrs.ObjectID)ids.set(e.attrs.ObjectID,e);if(e.attrs.ObjectUID)uids.set(e.attrs.ObjectUID,e);}
  const ref=n=>n&&(ids.get(n.attrs.ObjectRef)||uids.get(n.attrs.ObjectURef));
  let candidates;
  if(typeof input==='string') {
    // A copied clip has no Sequence, and its timeline start may be rebased.
    // Require exactly one video item and match its source in-point and duration.
    candidates=root.children.filter(e=>e.tag==='VideoClipTrackItem');
    if(candidates.length!==1)throw Error('타임라인에서 비디오 클립 하나를 다시 선택하세요.');
    const item=candidates[0],sub=ref(at(item,'ClipTrackItem/SubClip')),clip=ref(at(sub,'Clip'));
    const start=text(item,'ClipTrackItem/TrackItem/Start','0'),end=text(item,'ClipTrackItem/TrackItem/End','0');
    if(text(sub,'Name')!==source.name||text(clip,'Clip/InPoint','0')!==source.inPoint||BigInt(end)-BigInt(start)!==BigInt(source.end)-BigInt(source.start))
      throw Error('복사된 클립과 선택한 클립이 다릅니다. 타임라인에서 클립을 다시 선택하세요.');
  } else {
  const seq=uids.get(sequenceGuid);if(!seq||seq.tag!=='Sequence')throw Error('저장된 프로젝트에 현재 시퀀스가 없습니다. 추적 후 프로젝트를 저장하세요.');
  const groups=children(at(seq,'TrackGroups'),'TrackGroup').map(g=>ref(at(g,'Second'))),group=groups.find(g=>g&&g.tag==='VideoTrackGroup');
  const track=children(at(group,'TrackGroup/Tracks'),'Track').find(t=>Number(t.attrs.Index)===source.track),tr=ref(track);
  candidates=children(at(tr,'ClipTrack/ClipItems/TrackItems'),'TrackItem').map(ref).filter(Boolean).filter(item=>{
    if(item.tag!=='VideoClipTrackItem')return false;const sub=ref(at(item,'ClipTrackItem/SubClip')),clip=ref(at(sub,'Clip'));
    return text(sub,'Name')===source.name&&text(item,'ClipTrackItem/TrackItem/Start','0')===source.start&&text(item,'ClipTrackItem/TrackItem/End')===source.end&&text(clip,'Clip/InPoint','0')===source.inPoint;
  });
  if(candidates.length!==1)throw Error('선택 클립과 저장된 프로젝트가 일치하지 않습니다. 프로젝트 저장 후 다시 측정하세요.');
  }
  const chain=ref(at(candidates[0],'SelectionComponents')),holders=children(at(chain,'ComponentChain/Components'),'Component').map(ref),masks=[];
  for(const holder of holders){if(text(holder,'MatchName')!=='AE.ADBE AEMask2')continue;for(const child of children(at(holder,'SubComponents'),'SubComponent')){const m=ref(child);if(m&&text(m,'MatchName')==='AE.ADBE AEMask2')masks.push(m);}}
  return {masks,ref,hashes};
}
function describeMask(mask,ref,hashes){
  const params=children(at(mask,'Component/Params'),'Param'),param=i=>ref(params.find(p=>Number(p.attrs.Index)===i));
  const p=param(8),value=at(p,'StartKeyframeValue');if(!value)throw Error('마스크 데이터가 없습니다.');
  const storage=maskStorage(base64(value.text.trim()||hashes.get(value.attrs.BinaryHash)||''));
  return {id:storage.id,name:text(mask,'Component/InstanceName','오브젝트 마스크'),storage,param};
}
function listMasks(input,sequenceGuid,source){
  const {masks,ref,hashes}=maskContext(input,sequenceGuid,source);
  const list=masks.map(mask=>{const m=describeMask(mask,ref,hashes);return {id:m.id,name:m.name,tracked:!!(m.storage.seed&&m.storage.segments.length)};});
  if(new Set(list.map(mask=>mask.id)).size!==list.length)throw Error('중복된 마스크 ID가 있어 안전하게 선택할 수 없습니다.');
  return list;
}
function findMask(input,sequenceGuid,source,maskId){
  const {masks,ref,hashes}=maskContext(input,sequenceGuid,source),descriptions=masks.map(mask=>describeMask(mask,ref,hashes));
  if(!maskId&&descriptions.length!==1)throw Error('마스크가 여러 개입니다. 마스크 목록을 읽고 측정할 마스크 하나를 선택하세요.');
  const matches=maskId?descriptions.filter(mask=>mask.id===maskId):descriptions;
  if(matches.length>1)throw Error('중복된 마스크 ID가 있어 안전하게 선택할 수 없습니다.');
  const chosen=matches[0];
  if(!chosen)throw Error('선택한 마스크가 클립에 없습니다. 마스크 목록을 다시 읽으세요.');
  const {param,storage}=chosen;
  // Limit this first integration to static, identity mask transforms.
  const expected={11:null,12:'1:1',13:'100.',14:'100.',16:'0.',17:null};
  for(const [i,value]of Object.entries(expected)){const p=param(Number(i));if(!p||at(p,'Keyframes'))throw Error('마스크 변형 애니메이션은 아직 지원하지 않습니다.');if(value!==null&&text(p,'StartKeyframe').split(',')[1]!==value)throw Error('마스크 크기·회전 변형은 아직 지원하지 않습니다.');}
  if(text(param(11),'StartKeyframe')!==text(param(17),'StartKeyframe'))throw Error('마스크 위치 변형은 아직 지원하지 않습니다.');
  if(!storage.seed||!storage.segments.length)throw Error('마스크 추적을 완료한 뒤 클립을 다시 선택하세요.');
  return {id:chosen.id,name:chosen.name,storage};
}
module.exports={findMask,listMasks,maskStorage,xml};
