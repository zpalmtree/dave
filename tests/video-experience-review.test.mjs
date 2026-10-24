import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFinalVideoRatings, sanitizeFinalVideoPacket, finalVideoProgress } from '../scripts/video-cost-ab-final-review.mjs';
import { createFinalReviewServer } from '../scripts/serve-video-audio-review.mjs';
import { EXPERIENCE_REVIEW_PAGE } from '../scripts/video-experience-review-ui.mjs';

const fixture = () => ({schema_version:1,blinded:true,rubric:['creative','identity','audio'],pairs:[{
    pair_id:'private-case',prompt:'A painted car',videos:[{label:'A',video_path:'/private/control.mp4'},{label:'B',video_path:'/private/candidate.mp4'}],
    preferred:null,overall:{A:null,B:null},dimension_preferences:{creative:null,identity:null,audio:null},material_failure:{A:false,B:false},notes:'',
}]});
const ratedPayload = packet => { const p=sanitizeFinalVideoPacket(packet);return {...p,pairs:p.pairs.map(pair=>({...pair,preferred:'B',dimension_preferences:{creative:'B',identity:'na',audio:'tie'},notes:'Beautiful movement; music is a tie.'}))}; };

test('experience ratings round-trip without numeric scores and do not expose private paths or arm labels',()=>{
    const packet=fixture(),publicPacket=sanitizeFinalVideoPacket(packet);
    assert.doesNotMatch(JSON.stringify(publicPacket),/private-case|control|candidate|private\//);
    const saved=applyFinalVideoRatings(packet,ratedPayload(packet));
    assert.deepEqual(finalVideoProgress(saved),{complete:1,total:1});
    assert.deepEqual(sanitizeFinalVideoPacket(saved).pairs[0].dimension_preferences,{creative:'B',identity:'na',audio:'tie'});
    assert.equal(saved.pairs[0].videos[0].video_path,'/private/control.mp4');
});
test('incomplete dimensions remain drafts and malformed or omitted completed choices fail',()=>{
    const packet=fixture(),payload=ratedPayload(packet);
    for(const key of ['creative','identity','audio']) {
        const missing=structuredClone(payload);missing.pairs[0].dimension_preferences[key]=null;
        assert.throws(()=>applyFinalVideoRatings(packet,missing),/requires creative/);
        missing.pairs[0].preferred=null;
        assert.equal(finalVideoProgress(applyFinalVideoRatings(packet,missing)).complete,0);
    }
    payload.pairs[0].dimension_preferences.audio='na';
    assert.throws(()=>applyFinalVideoRatings(packet,payload),/Invalid audio/);
    assert.throws(()=>sanitizeFinalVideoPacket({...packet,rubric:['audio']}),/Unknown/);
});
test('legacy numeric-score requirement cannot be bypassed with extra dimension fields',()=>{
    const packet=fixture();delete packet.rubric;
    const payload=ratedPayload(packet);
    assert.throws(()=>applyFinalVideoRatings(packet,payload),/requires both overall/);
    payload.pairs[0].overall={A:6,B:7};
    assert.equal(finalVideoProgress(applyFinalVideoRatings(packet,payload)).complete,1);
    assert.equal(sanitizeFinalVideoPacket(packet).rubric,undefined);
});
test('appending a ready pair rejects stale membership rather than overwriting ratings',()=>{
    const packet=fixture(),payload=ratedPayload(packet);
    packet.pairs.push({...structuredClone(packet.pairs[0]),pair_id:'second'});
    assert.throws(()=>applyFinalVideoRatings(packet,payload),/packet changed/);
    const fresh=sanitizeFinalVideoPacket(packet);payload.fingerprint=fresh.fingerprint;
    const saved=applyFinalVideoRatings(packet,payload);
    assert.equal(saved.pairs.length,2);assert.equal(saved.pairs[0].preferred,'B');assert.equal(saved.pairs[1].preferred,null);
});
test('review HTTP flow authenticates status, serves custom UI, and persists experience choices',async()=>{
    const root=await mkdtemp(join(tmpdir(),'video-experience-'));let review;
    try{
        await mkdir(join(root,'human-review'));
        const path=join(root,'human-review/final-videos.json');await writeFile(path,JSON.stringify(fixture()));
        const statusPath=join(root,'progress.json');await writeFile(statusPath,JSON.stringify({planned_pairs:4,ready_pairs:1}));
        review=await createFinalReviewServer({runDirectory:root,port:0,page:EXPERIENCE_REVIEW_PAGE,statusPath});
        const url=path=>{const u=new URL(review.url);u.pathname=path;return u};
        assert.equal((await fetch(new URL('/api/status',review.url))).status,403);
        assert.deepEqual(await (await fetch(url('/api/status'))).json(),{planned_pairs:4,ready_pairs:1});
        assert.match(await (await fetch(url('/'))).text(),/Character consistency/);
        const payload=ratedPayload(fixture());
        assert.equal((await fetch(url('/api/final'),{method:'POST',body:JSON.stringify(payload)})).status,403);
        const response=await fetch(url('/api/final'),{method:'POST',headers:{'x-review-token':review.token},body:JSON.stringify(payload)});
        assert.equal(response.status,200);assert.equal((await response.json()).pairs[0].preferred,'B');
        assert.equal(JSON.parse(await readFile(path)).pairs[0].dimension_preferences.identity,'na');
    }finally{await review?.close();await rm(root,{recursive:true,force:true})}
});

test('music rubric saves style, coherence and audio choices without inventing visual ratings',()=>{
    const packet=fixture();packet.rubric=['genre','coherence','audio'];
    packet.pairs[0].dimension_preferences={genre:null,coherence:null,audio:null};
    const payload=sanitizeFinalVideoPacket(packet);
    payload.pairs[0].preferred='B';payload.pairs[0].dimension_preferences={genre:'B',coherence:'tie',audio:'A'};
    const saved=applyFinalVideoRatings(packet,payload);
    assert.deepEqual(finalVideoProgress(saved),{complete:1,total:1});
    assert.deepEqual(sanitizeFinalVideoPacket(saved).pairs[0].dimension_preferences,{genre:'B',coherence:'tie',audio:'A'});
    delete payload.pairs[0].dimension_preferences.coherence;
    assert.throws(()=>applyFinalVideoRatings(packet,payload),/requires genre, coherence and audio/);
    payload.pairs[0].dimension_preferences.coherence='na';
    assert.throws(()=>applyFinalVideoRatings(packet,payload),/Invalid coherence/);
    assert.throws(()=>sanitizeFinalVideoPacket({...packet,rubric:['genre','audio','coherence']}),/Unknown/);
});

test('score timing rubric requires timing, restraint and fit, with no genre or visual votes',()=>{
    const packet=fixture();packet.rubric=['timing','restraint','audio'];
    packet.pairs[0].dimension_preferences={timing:null,restraint:null,audio:null};
    const payload=sanitizeFinalVideoPacket(packet);
    payload.pairs[0].preferred='A';payload.pairs[0].dimension_preferences={timing:'A',restraint:'B',audio:'tie'};
    const saved=applyFinalVideoRatings(packet,payload);
    assert.deepEqual(finalVideoProgress(saved),{complete:1,total:1});
    assert.deepEqual(sanitizeFinalVideoPacket(saved).pairs[0].dimension_preferences,{timing:'A',restraint:'B',audio:'tie'});
    delete payload.pairs[0].dimension_preferences.restraint;
    assert.throws(()=>applyFinalVideoRatings(packet,payload),/requires timing, restraint and audio/);
    payload.pairs[0].dimension_preferences.restraint='na';
    assert.throws(()=>applyFinalVideoRatings(packet,payload),/Invalid restraint/);
});

test('absolute soundtrack acceptability is required, independent of preference, and survives save', async()=>{
    const packet=fixture();packet.require_acceptability=true;
    packet.pairs[0].acceptability={A:null,B:null};
    const payload=ratedPayload(packet);
    assert.equal(sanitizeFinalVideoPacket(packet).require_acceptability,true);
    assert.throws(()=>applyFinalVideoRatings(packet,payload),/acceptability for both/);
    payload.pairs[0].acceptability={A:'unacceptable',B:'unacceptable'};
    const saved=applyFinalVideoRatings(packet,payload);
    assert.equal(saved.pairs[0].preferred,'B');
    assert.deepEqual(saved.pairs[0].acceptability,{A:'unacceptable',B:'unacceptable'});
    assert.deepEqual(finalVideoProgress(saved),{complete:1,total:1});
    const incomplete=structuredClone(saved);incomplete.pairs[0].acceptability.B=null;
    assert.equal(finalVideoProgress(incomplete).complete,0);
    payload.pairs[0].acceptability.A='tie';
    assert.throws(()=>applyFinalVideoRatings(packet,payload),/acceptability/);
    const legacy=fixture();
    assert.notEqual(sanitizeFinalVideoPacket(legacy).fingerprint,sanitizeFinalVideoPacket({...legacy,require_acceptability:true}).fingerprint);
    assert.equal(sanitizeFinalVideoPacket(legacy).require_acceptability,undefined);
    assert.equal(finalVideoProgress(applyFinalVideoRatings(legacy,ratedPayload(legacy))).complete,1);
});

test('whole-video shareability has a distinct fingerprint and survives sanitizing',()=>{
 const packet=fixture();packet.require_acceptability=true;
 const before=sanitizeFinalVideoPacket(packet);packet.acceptability_scope='video';
 const after=sanitizeFinalVideoPacket(packet);
 assert.equal(after.acceptability_scope,'video');assert.notEqual(after.fingerprint,before.fingerprint);
 packet.acceptability_scope='unknown';assert.throws(()=>sanitizeFinalVideoPacket(packet),/scope/);
});
