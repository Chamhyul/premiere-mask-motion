"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const pm=require('../project-mask.js');
const storage=fs.readFileSync(path.join(__dirname,'fixtures/zero-time-mask-storage.bin')).toString('base64');
const source={name:'video.mp4',start:'100',end:'300',inPoint:'10'};
const xml=`<PremiereData><VideoClipTrackItem ObjectID="1"><ClipTrackItem><TrackItem><End>200</End></TrackItem><SubClip ObjectRef="2"/></ClipTrackItem><SelectionComponents ObjectRef="4"/></VideoClipTrackItem><SubClip ObjectID="2"><Name>video.mp4</Name><Clip ObjectRef="3"/></SubClip><VideoClip ObjectID="3"><Clip><InPoint>10</InPoint></Clip></VideoClip><VideoComponentChain ObjectID="4"><ComponentChain><Components><Component ObjectRef="5"/></Components></ComponentChain></VideoComponentChain><VideoFilterComponent ObjectID="5"><MatchName>AE.ADBE AEMask2</MatchName><SubComponents><SubComponent ObjectRef="6"/></SubComponents></VideoFilterComponent><VideoFilterComponent ObjectID="6"><MatchName>AE.ADBE AEMask2</MatchName><Component><InstanceName>Newest mask</InstanceName><Params><Param Index="8" ObjectRef="7"/></Params></Component></VideoFilterComponent><Param ObjectID="7"><StartKeyframeValue>${storage}</StartKeyframeValue></Param></PremiereData>`;
test('clipboard masks use live hierarchy and accept rebased clip timeline starts',()=>{
 assert.deepEqual(pm.listMasks(xml,'unused',source),[{id:'11111111-1111-4111-8111-111111111111',name:'Newest mask',tracked:true}]);
 assert.throws(()=>pm.listMasks(xml,'unused',{...source,name:'other.mp4'}),/선택한 클립이 다릅니다/);
 assert.throws(()=>pm.listMasks(xml,'unused',{...source,inPoint:'11'}));
 assert.throws(()=>pm.listMasks(xml,'unused',{...source,end:'301'}));
});
test('wrong focus and multiple copied clips cannot be treated as the selected clip',()=>{
 assert.throws(()=>pm.listMasks('<PremiereData/>','unused',source),/클립 하나/);
 assert.throws(()=>pm.listMasks(xml.replace('</PremiereData>','<VideoClipTrackItem/></PremiereData>'),'unused',source),/클립 하나/);
});
test('a valid copied clip without object masks has an empty list',()=>{
 assert.deepEqual(pm.listMasks(xml.replace('<Component ObjectRef="5"/>',''),'unused',source),[]);
});
