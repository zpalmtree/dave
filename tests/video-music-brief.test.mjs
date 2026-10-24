import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { musicSpec, validateMusicBrief, planMusicBrief } from '../scripts/plan-video-music-brief.mjs';

const brief=()=>({purpose:'Support the scene with a restrained groove.',style:'Acoustic folk',
    caption:'### Global Metadata\n'+('Clear acoustic guitar with a steady relaxed pulse. '.repeat(10))+
    '\n### Vocal Details\nEntirely instrumental, no vocals.\n### Arrangement\n[Intro] '+
    ('Alternate low bass notes beneath a short answering melody. '.repeat(8))+
    '[Instrumental] '+('Let each phrase breathe before the answering variation. '.repeat(6))+' [Outro] Resolve the final phrase.'});

test('native caption and instrumental-only lyrics reach the generation spec intact',()=>{
    const value=brief();const spec=musicSpec(value,{seed:123,seconds:40});
    assert.equal(spec.caption,value.caption);assert.equal(spec.lyrics,'[Intro]\n[Instrumental]\n[Outro]');
    assert.equal(spec.seed,123);assert.equal(spec.seconds,40);
    assert.throws(()=>validateMusicBrief({...value,caption:'A vague happy song'}),/200/);
    assert.throws(()=>validateMusicBrief({...value,caption:value.caption.replace('### Arrangement','Arrangement')}),/Missing/);
    assert.throws(()=>musicSpec(value,{seed:NaN,seconds:40}),/Invalid/);
});

test('brief stage caches the first result and honors explicit soundtrack constraints without inference',async()=>{
    const root=await mkdtemp(join(tmpdir(),'music-brief-'));
    try{
        const preview=join(root,'video.mp4');await writeFile(preview,'preview');let calls=0;
        const client={models:{generateContent:async()=>{calls++;return{text:JSON.stringify(brief())}}}};
        const options={client,model:'test',prompt:'A calm scene',preview,directory:join(root,'normal'),seed:9,seconds:40};
        const first=await planMusicBrief(options);assert.equal(first.status,'ready');assert.equal(calls,1);
        assert.deepEqual(await planMusicBrief(options),first);assert.equal(calls,1);
        await assert.rejects(planMusicBrief({...options,seed:10}),/inputs changed/);
        const silent=await planMusicBrief({...options,prompt:'No music',directory:join(root,'silent')});
        assert.equal(silent.status,'bypassed');assert.equal(calls,1);
        const supplied=await planMusicBrief({...options,preserveSourceAudio:true,directory:join(root,'source')});
        assert.equal(supplied.status,'bypassed');assert.equal(calls,1);
    }finally{await rm(root,{recursive:true,force:true})}
});
