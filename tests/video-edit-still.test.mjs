import test from 'node:test';
import assert from 'node:assert/strict';

import { createVideoEditStill } from '../dist/VideoKeyframeProvider.js';

const frame = { bytes: Buffer.from('frame'), mimeType: 'image/png' };
const replacement = { bytes: Buffer.from('replacement'), mimeType: 'image/png' };

async function withImageEdits(respond, run) {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
        requests += 1;
        const [status, body] = respond(requests);
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    };
    try {
        return { result: await run(), requests };
    } catch (error) {
        return { error, requests };
    } finally {
        globalThis.fetch = originalFetch;
    }
}

const refused = [400, { error: { code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' } }];
const repainted = [200, { data: [{ b64_json: Buffer.from('repainted').toString('base64') }] }];

test('a refused repaint is retried once before the worker falls back to H3', async () => {
    const attempts = [];
    const recovered = await withImageEdits(count => (count === 1 ? refused : repainted),
        () => createVideoEditStill(frame, replacement, 'the woman', 'meximutt',
            { onAttempt: value => attempts.push([value.attempt, value.outcome]) }));
    assert.equal(recovered.result.bytes.toString(), 'repainted');
    assert.deepEqual(attempts, [[1, 'error'], [2, 'success']]);
    const exhausted = await withImageEdits(() => refused,
        () => createVideoEditStill(frame, replacement, 'the woman', 'meximutt'));
    assert.equal(exhausted.error?.code, 'moderation');
    assert.equal(exhausted.requests, 2);
});

test('provider errors other than refusals are not retried', async () => {
    const { error, requests } = await withImageEdits(() => [500, { error: { message: 'Server error' } }],
        () => createVideoEditStill(frame, replacement, 'the bull', 'meximutt'));
    assert.equal(error?.code, 'provider_error');
    assert.equal(requests, 1);
});
