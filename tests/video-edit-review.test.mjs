import assert from 'node:assert/strict';
import test from 'node:test';
import { validateEditReview } from '../dist/VideoEditReview.js';
test('subject edit review fails closed on missing, string-valued or malformed decisions', () => {
    for (const result of [undefined, {}, {accepted:'true',reason:'ok'}, {accepted:true,reason:''},
        {accepted:true,reason:'x'.repeat(801)}, {accepted:1,reason:'ok'}]) {
        assert.throws(() => validateEditReview(result));
    }
    assert.deepEqual(validateEditReview({accepted:false,reason:' Wrong performer. '}), {accepted:false,reason:'Wrong performer.'});
});

test('still usability and finished motion receive distinct review contracts with the same evidence', async t => {
    const { reviewVideoEdit, EDIT_STILL_REVIEW_INSTRUCTION, EDIT_REVIEW_INSTRUCTION } = await import('../dist/VideoEditReview.js');
    const requests = [], usage = [];
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        assert.match(String(input), /generativelanguage.googleapis.com/);
        const body = JSON.parse(init.body);
        requests.push(body);
        const phase = JSON.parse(body.contents[0].parts[0].text).phase;
        return new Response(JSON.stringify({
            candidates: [{content: {parts: [{text: JSON.stringify({accepted: phase === 'still', reason: phase === 'still'
                ? 'Recognizable replacement with a different hand gesture.' : 'The output stayed frozen instead of following the source action.'})}]}}],
            usageMetadata: {promptTokenCount: 10, candidatesTokenCount: 10},
        }), {status: 200, headers: {'content-type':'application/json'}});
    });
    const image = text => ({bytes: Buffer.from(text), mimeType:'image/png'});
    const sample = {source:image('source'), edited:image('edited'), mask:image('mask')};
    const still = await reviewVideoEdit('the character', image('identity'), [sample], 'still', {onUsage: event=>usage.push(event)});
    const motion = await reviewVideoEdit('the character', image('identity'), [sample], 'motion', {onUsage: event=>usage.push(event)});
    assert.equal(still.accepted, true);
    assert.equal(motion.accepted, false, 'Still acceptance must not bypass the completed-animation decision.');
    assert.equal(requests[0].systemInstruction.parts[0].text, EDIT_STILL_REVIEW_INSTRUCTION);
    assert.equal(requests[1].systemInstruction.parts[0].text, EDIT_REVIEW_INSTRUCTION);
    assert.notEqual(EDIT_STILL_REVIEW_INSTRUCTION, EDIT_REVIEW_INSTRUCTION);
    for (const request of requests) assert.deepEqual(request.contents[0].parts.filter(part=>part.inlineData)
        .map(part=>Buffer.from(part.inlineData.data,'base64').toString()), ['identity','source','edited','mask']);
    assert.deepEqual(usage.map(event=>event.stage), ['video_edit_still_review','video_edit_motion_review']);
});

test('motion review transmits ordered neighboring evidence beyond the old four-frame limit', async t => {
    const { reviewVideoEdit } = await import('../dist/VideoEditReview.js');
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (_input, init) => {
        requests.push(JSON.parse(init.body));
        return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({
            accepted:false,reason:'The replacement changes shape across consecutive source frames.'})}]}}]}),
            {status:200,headers:{'content-type':'application/json'}});
    });
    const image = {bytes:Buffer.from('image'),mimeType:'image/png'};
    const samples = [0,1,2,11,12,13,14,35].map(frame=>({source:image,edited:image,mask:image,frame}));
    assert.equal((await reviewVideoEdit('the cat',image,samples,'motion')).accepted,false);
    const labels=requests[0].contents[0].parts.filter(part=>part.text?.startsWith('Sample')).map(part=>part.text);
    assert.deepEqual(labels,samples.map((sample,index)=>`Sample ${index+1} (source frame ${sample.frame}): SOURCE`));
    await assert.rejects(reviewVideoEdit('the cat',image,samples,'still'),/number/);
    await assert.rejects(reviewVideoEdit('the cat',image,Array(17).fill(samples[0]),'motion'),/number/);
    assert.equal(requests.length,1);
});
