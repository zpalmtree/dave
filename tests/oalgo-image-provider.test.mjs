import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeOalgoSourceImages, VideoBroker } from '../dist/VideoBroker.js';
import { createFrontierVideoKeyframe } from '../dist/VideoKeyframeProvider.js';
import { parseOalgoImageProvider, handleOalgoVideo } from '../dist/VideoGeneration.js';
import { VideoUsagePersistenceError, videoUsageCost } from '../dist/VideoUsage.js';
import { config } from '../dist/Config.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
// Transport fixtures deliberately distinguish identity, scene and edit target.
const JPEG = Buffer.concat([Buffer.from([255,216,255,224]), Buffer.from('mock-jpeg-target')]);
const references = [
    { label:'Identity',kind:'identity',bytes:PNG,mimeType:'image/png',visualFactsToPreserve:'Original identity',sourceUrl:'test',contextUrl:'test' },
    { label:'Scene',kind:'object',bytes:Buffer.concat([PNG,Buffer.from('scene')]),mimeType:'image/png',visualFactsToPreserve:'Original subjects',sourceUrl:'test',contextUrl:'test' },
];
const plan = { intent:'Add the character once',keyframe:{prompt:'Preserve both originals.'},segments:[] };
const options = { reviewPurpose:'source-composite',requireIdentityPreservation:true,sourceCompositeProvider:'grok',aspectRatio:'1:1' };
const response = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const imageResponse = (bytes=JPEG,ticks=800000000) => response({data:[{b64_json:bytes.toString('base64')}],...(ticks===null?{}:{usage:{cost_in_usd_ticks:ticks}})});
const verdict = (acceptable=true) => response({model:'gpt-5.6-sol',output_text:JSON.stringify({acceptable,best_effort_worthy:acceptable,identity_preserved:true,
    issues:acceptable?[]:['Restore the original scene subject.'],correction_prompt:'Keep the scene subject visible beside OALGO.'}),usage:{input_tokens:100,output_tokens:20}});
async function mocked(callback,run){
    const originalFetch=globalThis.fetch, originalKey=config.grokApiKey;
    config.grokApiKey='test-key';globalThis.fetch=callback;
    try{return await run();}finally{globalThis.fetch=originalFetch;config.grokApiKey=originalKey;}
}

test('OALGO provider option is explicit, leading-only and removed from the creative prompt',()=>{
    assert.deepEqual(parseOalgoImageProvider('hello'),{prompt:'hello'});
    assert.deepEqual(parseOalgoImageProvider('--image-provider grok hello'),{provider:'grok',prompt:'hello'});
    assert.deepEqual(parseOalgoImageProvider('--image-provider=Sunburst hello\nworld'),{provider:'sunburst',prompt:'hello\nworld'});
    assert.deepEqual(parseOalgoImageProvider('--image-provider grok'),{provider:'grok',prompt:''});
    assert.deepEqual(parseOalgoImageProvider('say "--image-provider grok"'),{prompt:'say "--image-provider grok"'});
    for(const bad of ['--image-provider','--image-provider=','--image-provider other','--image-provider grok --image-provider sunburst'])assert.throws(()=>parseOalgoImageProvider(bad));
});

test('explicit provider without an attachment gives an actionable error before starting a job',async()=>{
    const replies=[];
    await handleOalgoVideo({attachments:new Map(),reply:async text=>replies.push(text)},'--image-provider grok hello');
    assert.equal(replies.length,1);assert.match(replies[0],/attached or replied-to image/);
});

test('Grok repair preserves original authority, carries JPEG MIME, and records exact image charges',async()=>{
    const images=[],reviews=[],usage=[],attempts=[];
    const result=await mocked(async(url,init)=>{
        const body=JSON.parse(init.body);
        if(String(url)==='https://api.x.ai/v1/images/edits'){
            images.push(body);return imageResponse(images.length===1?JPEG:PNG,images.length===1?800000000:900000000);
        }
        assert.equal(String(url),'https://api.openai.com/v1/responses');reviews.push(body);return verdict(reviews.length===2);
    },()=>createFrontierVideoKeyframe(plan,references,{...options,onUsage:e=>usage.push(e),onAttempt:e=>attempts.push(e)}));
    assert.equal(result.reviewStatus,'accepted');assert.equal(result.provider,'xai');assert.equal(result.mimeType,'image/png');
    assert.equal(images.length,2);assert.equal(reviews.length,2);
    assert.equal(images[0].model,'grok-imagine-image-2.0');assert.equal(images[0].quality,'medium');assert.equal(images[0].resolution,'1k');
    assert.equal(images[0].aspect_ratio,'1:1');assert.equal(images[0].images.length,2);assert.equal(images[1].images.length,3);
    assert.deepEqual(images[1].images.slice(0,2),images[0].images);
    assert.equal(images[1].images[2].url,'data:image/jpeg;base64,'+JPEG.toString('base64'));
    assert.match(images[1].prompt,/EDIT TARGET in place/);
    assert.match(images[1].prompt,/not an identity reference/);
    assert.equal(reviews[0].input[0].content.filter(v=>v.type==='input_image')[0].image_url,images[1].images[2].url);
    for(const review of reviews)assert.deepEqual(review.input[0].content.filter(v=>v.type==='input_image').slice(1).map(v=>v.image_url),images[0].images.map(v=>v.url));
    const costs=usage.filter(e=>e.stage==='keyframe_candidate_grok');
    assert.deepEqual(costs.map(videoUsageCost),[.08,.09]);assert.ok(costs.every(e=>e.provider==='xai'&&!e.usageMissing));
    assert.equal(attempts.filter(e=>e.stage==='keyframe_candidate_grok').length,2);
});

test('Grok moderation is billed once and never triggers repair or another provider',async()=>{
    for(const error of ['Generated image rejected by content moderation.',{code:'content-moderated',message:'Rejected'}]){
        const usage=[];let calls=0;
        await mocked(async url=>{calls++;assert.equal(String(url),'https://api.x.ai/v1/images/edits');return response({error,usage:{cost_in_usd_ticks:800000000}},400);},
            ()=>assert.rejects(createFrontierVideoKeyframe(plan,references,{...options,onUsage:e=>usage.push(e)}),e=>e.code==='moderation'));
        assert.equal(calls,1);assert.equal(usage.length,1);assert.equal(usage[0].images,0);assert.equal(usage[0].outcome,'error');assert.equal(videoUsageCost(usage[0]),.08);
    }
});

test('required reviewer outage rejects a saved Grok image without another image charge',async()=>{
    let images=0,reviews=0;
    await mocked(async url=>{if(String(url).includes('/images/edits')){images++;return imageResponse();}reviews++;throw new Error('Reviewer unavailable');},
        ()=>assert.rejects(createFrontierVideoKeyframe(plan,references,options),e=>e.code==='review_unavailable'));
    assert.equal(images,1);assert.equal(reviews,2);
});

test('Grok cancellation propagates and records missing usage without retrying',async()=>{
    const controller=new AbortController(),usage=[],attempts=[];let calls=0;
    await mocked(async(url,init)=>{calls++;controller.abort();assert.equal(init.signal.aborted,true);throw new Error('aborted');},
        ()=>assert.rejects(createFrontierVideoKeyframe(plan,references,{...options,abortSignal:controller.signal,onUsage:e=>usage.push(e),onAttempt:e=>attempts.push(e)}),e=>e.code==='timeout'));
    assert.equal(calls,1);assert.equal(usage[0].usageMissing,true);assert.equal(usage[0].costOverride,undefined);assert.equal(attempts[0].outcome,'cancelled');
});

test('missing Grok pricing is marked unknown and accounting failures stop paid retries',async()=>{
    const usage=[];
    await mocked(async url=>String(url).includes('/images/edits')?imageResponse(PNG,null):verdict(),
        ()=>createFrontierVideoKeyframe(plan,references,{...options,onUsage:e=>usage.push(e)}));
    const image=usage.find(e=>e.stage==='keyframe_candidate_grok');assert.equal(image.usageMissing,true);assert.throws(()=>videoUsageCost(image),/Unknown video usage price/);
    let calls=0;
    await mocked(async()=>{calls++;return imageResponse();},()=>assert.rejects(createFrontierVideoKeyframe(plan,references,{...options,
        onUsage:()=>{throw new VideoUsagePersistenceError('ledger offline');}}),VideoUsagePersistenceError));
    assert.equal(calls,1);
});

test('unsupported Grok image bytes fail before visual review',async()=>{
    let calls=0;
    await mocked(async()=>{calls++;return imageResponse(Buffer.from('not an image'));},()=>assert.rejects(createFrontierVideoKeyframe(plan,references,options),e=>e.code==='provider_error'));
    assert.equal(calls,1);
});

test('unselected OALGO compositor still uses the production Sunburst request',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'oalgo-default-'));writeFileSync(join(dir,'identity.png'),PNG);writeFileSync(join(dir,'scene.png'),PNG);
    const source=path=>({path,mimeType:'image/png',bytes:PNG.length});let calls=0;
    try{await mocked(async(url,init)=>{
        if(String(url)==='https://api.openai.com/v1/images/edits'){calls++;assert.equal(init.body.get('model'),'gpt-image-2.5-sunburst');assert.equal(init.body.get('quality'),'high');assert.equal(init.body.getAll('image[]').length,2);return imageResponse(PNG);}
        assert.equal(String(url),'https://api.openai.com/v1/responses');return verdict();
    },()=>composeOalgoSourceImages(source(join(dir,'identity.png')),source(join(dir,'scene.png')),'hello',{}));assert.equal(calls,1);}
    finally{rmSync(dir,{recursive:true,force:true});}
});

test('broker validates provider before downloads and passes the selection to composition',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'oalgo-provider-broker-')),providers=[];let downloads=0;
    const broker=new VideoBroker({host:'127.0.0.1',port:0,dbPath:join(directory,'db.sqlite3'),resultsDir:join(directory,'results'),botToken:'bot',workerToken:'worker',preplanQueuedJobs:false,
        sourceImageDownloader:async(_,target)=>{downloads++;mkdirSync(target,{recursive:true});const path=join(target,'source.png');writeFileSync(path,PNG);return {path,mimeType:'image/png',bytes:PNG.length};},
        sourceImageComposer:async(base,attached,prompt,hooks,provider)=>{providers.push(provider);await hooks.onUsage({stage:'keyframe_candidate_grok',attempt:1,outcome:'success',provider:'xai',model:'grok-imagine-image-2.0',images:1,costOverride:.08,rawUsage:{cost_in_usd_ticks:800000000}});return {bytes:JPEG,mimeType:'image/jpeg',provider:'xai',model:'grok-imagine-image-2.0'};}});
    await broker.start();let sequence=0;
    const submit=async extra=>{const n=++sequence;const response=await fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/jobs`,{method:'POST',headers:{authorization:'Bearer bot','content-type':'application/json'},body:JSON.stringify({model:'minimax',prompt:'hello',requester_id:'user-'+n,origin_bot_id:'bot',channel_id:'channel',command_message_id:'message-'+n,status_message_id:'status-'+n,source_image:{preset:'oalgo'},source_image_composite:{url:'https://cdn.discordapp.com/attachments/1/2/scene.png',mime_type:'image/png',bytes:PNG.length,name:'scene.png'},...extra})});return {status:response.status,body:await response.json()};};
    try{
        for(const value of ['other',null,false])assert.equal((await submit({source_image_provider:value})).status,400);
        assert.equal((await submit({source_image_provider:'grok',source_image_composite:null})).status,400);
        assert.equal((await submit({source_image_provider:'grok',model:'ltx'})).status,400);assert.equal(downloads,0);
        const chosen=await submit({source_image_provider:'grok'});assert.equal(chosen.status,201);
        const job=await broker.get('SELECT source_image_path,source_image_mime FROM video_jobs WHERE public_id=?',[chosen.body.job.id]);
        assert.equal(job.source_image_mime,'image/jpeg');assert.deepEqual(readFileSync(job.source_image_path),JPEG);
        assert.equal((await submit({})).status,201);assert.deepEqual(providers,['grok','sunburst']);
        const usage=await broker.get('SELECT provider,model,cost FROM video_usage_events LIMIT 1');assert.equal(usage.provider,'xai');assert.equal(usage.cost,.08);
    }finally{await broker.stop();rmSync(directory,{recursive:true,force:true});}
});
