import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryMusic } from '../dist/VideoMusic.js';
const brief = { purpose: 'Support scene', style: 'Restrained acoustic folk', caption:
    '### Global Metadata\n' + 'Acoustic guitar carries a relaxed steady pulse. '.repeat(16) +
    '\n### Vocal Details\nEntirely instrumental, no singing or speech.\n### Arrangement\n[Intro] ' +
    'Alternate bass notes and a short answering melody, leaving space between phrases. '.repeat(10) +
    '[Instrumental] Develop the motif with one answering phrase. [Outro] Resolve softly.' };
const state = () => ({ prepared: { contract_hash: 'contract', plan: { sound_mix: { music: 'instrumental' } } } });
const body = { preview: Buffer.from('video').toString('base64'), video_seconds: 12 };
const job = id => ({ public_id: id, prompt: 'An amusing little scene' });
const edit = { music: 'edited', reason: 'Use answering phrase', scene_events: [{time: 2, description: 'Reveal'}],
    music_events: [{time: 5, description: 'Answer'}], vocal_regions: [],
    cues: [{start: 2, end: 5, source_start: 5, gain_db: 0, fade_in: .2, fade_out: .2, reason: 'Answer reveal'}] };

test('production shares brief/editor, caches first results, bills both stages and rejects stale media', async () => {
    const value = state(), requests = [], usages = [], attempts = [];
    let saves = 0;
    const client = { models: { generateContent: async r => { requests.push(r); return {text: JSON.stringify(requests.length === 1 ? brief : edit),
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, thoughtsTokenCount: 3 } }; } } };
    const hooks = { beforeRequest: r => assert.equal(r.maxOutputTokens,6000), onUsage: u => usages.push(u), onAttempt: a => attempts.push(a) };
    const run = (op, data=body) => recoveryMusic(op,job('cache'),value,data,async()=>{saves++},hooks,client);
    const first = await run('music-brief');
    assert.equal(first.spec.caption,brief.caption); assert.equal(first.spec.seconds,40);
    assert.deepEqual(await run('music-brief'),first); assert.equal(requests.length,1);
    const data = {...body,score: Buffer.from('score').toString('base64'),score_seconds: 40};
    assert.deepEqual((await run('music-edit',data)).edit,edit);
    assert.equal((await run('music-edit',data)).status,'ready'); assert.equal(requests.length,2);
    assert.deepEqual(usages.map(u=>u.stage),['music-brief','music-edit']);
    assert.equal(usages[0].outputTokens,13);assert.equal(attempts.length,2);assert.equal(saves,4);
    assert.ok(!JSON.stringify(value).includes(body.preview));
    await assert.rejects(run('music-brief',{...body,video_seconds:13}),/inputs changed/);
});

test('constraints bypass inference even before evidence decoding', async () => {
    for (const change of [{prompt:'no music'}, {source_audio_path:'song'}, {source_video_path:'video'}]) {
        const result=await recoveryMusic('music-brief',{...job('bypass'),...change},state(),{},async()=>{throw Error('persist')});
        assert.equal(result.status,'bypassed');
    }
    const value=state();value.prepared.plan.sound_mix.music='none';
    assert.equal((await recoveryMusic('music-edit',job('none'),value,{},async()=>{})).status,'bypassed');
});

test('provider or repeated vocal-overlap failure preserves original audio and is not repurchased', async () => {
    const value=state();value['music-brief']={result:{status:'ready'}};let calls=0;
    const bad={...edit,vocal_regions:[{start:6,end:7,description:'Shout'}]};
    const client={models:{generateContent:async()=>{calls++;return {text:JSON.stringify(bad)}}}};
    const data={...body,score:Buffer.from('score').toString('base64'),score_seconds:40};
    const run=()=>recoveryMusic('music-edit',job('vocals'),value,data,async()=>{}, {},client);
    assert.equal((await run()).status,'bypassed');assert.equal(calls,2);
    await run();assert.equal(calls,2);
    const failing=state();
    const offline={models:{generateContent:async()=>{throw Error('offline')}}};
    assert.equal((await recoveryMusic('music-brief',job('offline'),failing,body,async()=>{}, {},offline)).status,'bypassed');
});

test('concurrent duplicate requests share one paid call; interrupted pending records do not retry', async () => {
    let calls=0, release;
    const wait=new Promise(r=>{release=r});
    const client={models:{generateContent:async()=>{calls++;await wait;return {text:JSON.stringify(brief)}}}};
    const value=state();
    const first=recoveryMusic('music-brief',job('parallel'),value,body,async()=>{}, {},client);
    await new Promise(r=>setTimeout(r,10));
    const second=recoveryMusic('music-brief',job('parallel'),structuredClone(value),body,async()=>{}, {},client);
    release();assert.deepEqual(await first,await second);assert.equal(calls,1);
    delete value['music-brief'].result;
    assert.equal((await recoveryMusic('music-brief',job('parallel'),value,body,async()=>{}, {},client)).status,'bypassed');
});
