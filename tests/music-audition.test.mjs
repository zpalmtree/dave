import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMusicAuditionServer,validateMusicReview} from '../scripts/serve-music-audition.mjs';

const ready=()=>({status:'ready',stage:'Ready',brief:'Quiet acoustic cafe music',seconds:20,fingerprint:'frozen-input-hashes',clips:{A:'/private/ace.wav',B:'/private/music3.wav'}});
test('absolute usability supports neither and rejects stale or incomplete reviews',()=>{
 for(const choice of ['A','B','both','neither'])assert.equal(validateMusicReview(ready(),{fingerprint:ready().fingerprint,choice,notes:''}).choice,choice);
 for(const value of [{choice:'tie',notes:''},{choice:'neither',notes:null},{choice:'A',notes:'x'.repeat(4001)}])assert.throws(()=>validateMusicReview(ready(),{fingerprint:ready().fingerprint,...value}));
 assert.throws(()=>validateMusicReview(ready(),{fingerprint:'old',choice:'A',notes:''}),/changed/);
 assert.throws(()=>validateMusicReview({...ready(),status:'generating'},{fingerprint:ready().fingerprint,choice:'A',notes:''}),/not ready/);
 const state={...ready(),collectPreference:true};
 for(const preference of ['A','B','tie',null])assert.equal(validateMusicReview(state,{fingerprint:state.fingerprint,choice:'neither',preference,notes:''}).preference,preference);
 assert.throws(()=>validateMusicReview(state,{fingerprint:state.fingerprint,choice:'both',preference:'bad',notes:''}),/preference/);
});

test('collection routes audio and votes to the selected case without leaking paths or crossing reviews',async()=>{
 const root=await mkdtemp(join(tmpdir(),'music-batch-'));let app;
 try{
  const auditions=[];
  for(const id of ['cafe-1','car-1']){
   const dir=join(root,id);await mkdir(dir);const state={...ready(),fingerprint:id,clips:{A:join(dir,'A.wav'),B:join(dir,'B.wav')}};
   for(const path of Object.values(state.clips))await writeFile(path,id);
   await writeFile(join(dir,'state.json'),JSON.stringify(state));auditions.push({id,title:id,runDirectory:dir});
  }
  app=await createMusicAuditionServer({auditions,port:0});
  const url=(path,id)=>{const u=new URL(app.url);u.pathname=path;if(id)u.searchParams.set('case',id);return u};
  assert.equal((await(await fetch(url('/api/state'))).json()).fingerprint,'cafe-1');
  assert.equal(await(await fetch(url('/audio/A','car-1'))).text(),'car-1');
  const post=(id,fingerprint)=>fetch(url('/api/review',id),{method:'POST',headers:{'x-review-token':app.token},body:JSON.stringify({fingerprint,choice:'both',notes:''})});
  assert.equal((await post('car-1','cafe-1')).status,400);
  assert.equal((await post('car-1','car-1')).status,200);
  assert.equal((await(await fetch(url('/api/state','cafe-1'))).json()).review,null);
  const collection=await(await fetch(url('/api/collection','car-1'))).json();
  assert.equal(collection.current,'car-1');assert.deepEqual(collection.auditions.map(c=>c.reviewed),[false,true]);
  assert.doesNotMatch(JSON.stringify(collection),/runDirectory|music-batch-|fingerprint|clips/);
  assert.equal((await fetch(url('/api/state','../../private'))).status,404);
  assert.equal((await fetch(new URL('/api/collection',app.url))).status,403);
 }finally{await app?.close();await rm(root,{recursive:true,force:true})}
});

test('audition authenticates requests, hides composer paths, serves ranges and persists rejection',async()=>{
 const root=await mkdtemp(join(tmpdir(),'music-audition-'));let server;
 try{
  const state={...ready(),fullTracks:true,collectPreference:true};const audio=Buffer.from('RIFF-test-audio-payload');
  for(const label of ['A','B']){state.clips[label]=join(root,label+'.wav');await writeFile(state.clips[label],audio)}
  await writeFile(join(root,'state.json'),JSON.stringify(state));
  server=await createMusicAuditionServer({runDirectory:root,port:0});
  const url=path=>{const u=new URL(server.url);u.pathname=path;return u};
  assert.equal((await fetch(new URL('/api/state',server.url))).status,403);
  const publicState=await(await fetch(url('/api/state'))).json();
  assert.doesNotMatch(JSON.stringify(publicState),/private|ace\.wav|music3|music-audition-/);
  assert.equal(publicState.clips.length,2);
  assert.equal(publicState.fullTracks,true);assert.equal(publicState.collectPreference,true);
  const range=await fetch(url('/audio/A'),{headers:{range:'bytes=2-5'}});
  assert.equal(range.status,206);assert.equal(await range.text(),audio.subarray(2,6).toString());
  assert.equal((await fetch(url('/audio/A'),{headers:{range:'bytes=999-'}})).status,416);
  const payload={fingerprint:state.fingerprint,choice:'neither',preference:'B',notes:'Neither meets the quality bar.'};
  assert.equal((await fetch(url('/api/review'),{method:'POST',body:JSON.stringify(payload)})).status,403);
  const saved=await fetch(url('/api/review'),{method:'POST',headers:{'x-review-token':server.token},body:JSON.stringify(payload)});
  assert.equal(saved.status,200);assert.equal((await saved.json()).choice,'neither');
  assert.equal(JSON.parse(await readFile(join(root,'review.json'),'utf8')).choice,'neither');
  assert.equal(JSON.parse(await readFile(join(root,'review.json'),'utf8')).preference,'B');
  assert.equal((await(await fetch(url('/api/state'))).json()).review.choice,'neither');
  await writeFile(join(root,'state.json'),JSON.stringify({...state,status:'generating',fingerprint:'new'}));
  const pending=await(await fetch(url('/api/state'))).json();assert.equal(pending.clips.length,0);assert.equal(pending.review,null);
  assert.equal((await fetch(url('/audio/A'))).status,404);
 }finally{await server?.close();await rm(root,{recursive:true,force:true})}
});
