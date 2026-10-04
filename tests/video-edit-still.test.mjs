import test from 'node:test';
import assert from 'node:assert/strict';

import { createVideoEditStill, videoEditStillPrompt } from '../dist/VideoKeyframeProvider.js';

const frame = { bytes: Buffer.from('frame'), mimeType: 'image/png' };
const replacement = { bytes: Buffer.from('replacement'), mimeType: 'image/png' };

async function withImageEdits(respond, run) {
    const originalFetch = globalThis.fetch;
    const prompts = [];
    globalThis.fetch = async (_url, options) => {
        const prompt = options.body.get('prompt');
        prompts.push(prompt);
        const [status, body] = respond(prompt, prompts.length);
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    };
    try {
        return { result: await run(), prompts };
    } catch (error) {
        return { error, prompts };
    } finally {
        globalThis.fetch = originalFetch;
    }
}

const refused = [400, { error: { code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' } }];
const repainted = [200, { data: [{ b64_json: Buffer.from('repainted').toString('base64') }] }];

test('the repaint names grounded effects only when there are some', () => {
    const plain = videoEditStillPrompt('bull-headed person in suit', 'meximutt');
    assert.doesNotMatch(plain, /beam|Image 1 also shows/);
    const kept = videoEditStillPrompt('bull-headed person in suit', 'meximutt', 'two light beams from its eyes');
    assert.match(kept, /Image 1 also shows two light beams from its eyes; keep them exactly as they look/);
    assert.match(kept, /from the same place on the replacement/);
});

test('a refused effects repaint is retried, then falls back to the plain prompt', async () => {
    const attempts = [];
    const { result, prompts } = await withImageEdits(
        prompt => (prompt.includes('Image 1 also shows') ? refused : repainted),
        () => createVideoEditStill(frame, replacement, 'the bull', 'meximutt', 'two light beams from its eyes',
            { onAttempt: value => attempts.push([value.attempt, value.outcome]) }));
    assert.equal(result.bytes.toString(), 'repainted');
    assert.deepEqual(prompts.map(prompt => prompt.includes('Image 1 also shows')), [true, true, false]);
    assert.deepEqual(attempts, [[1, 'error'], [2, 'error'], [3, 'success']]);
});

test('a refusal is retried once before the worker falls back to H3', async () => {
    const recovered = await withImageEdits((_prompt, count) => (count === 1 ? refused : repainted),
        () => createVideoEditStill(frame, replacement, 'the woman', 'meximutt'));
    assert.equal(recovered.result.bytes.toString(), 'repainted');
    assert.equal(recovered.prompts.length, 2);
    const exhausted = await withImageEdits(() => refused,
        () => createVideoEditStill(frame, replacement, 'the woman', 'meximutt'));
    assert.equal(exhausted.error?.code, 'moderation');
    assert.equal(exhausted.prompts.length, 2);
});

test('provider errors other than refusals are not retried', async () => {
    const { error, prompts } = await withImageEdits(() => [500, { error: { message: 'Server error' } }],
        () => createVideoEditStill(frame, replacement, 'the bull', 'meximutt', 'two light beams from its eyes'));
    assert.equal(error?.code, 'provider_error');
    assert.equal(prompts.length, 1);
});
