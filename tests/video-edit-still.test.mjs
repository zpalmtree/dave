import test from 'node:test';
import assert from 'node:assert/strict';

import { createVideoEditStill, videoEditStillPrompt, videoEditStillWithEffects } from '../dist/VideoKeyframeProvider.js';
import { inflateSync } from 'node:zlib';

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

test('each shot of a clip numbers its own repaint attempts', async () => {
    const attempts = [];
    await withImageEdits(count => (count === 1 ? refused : repainted),
        () => createVideoEditStill(frame, replacement, 'the woman', 'meximutt',
            { attemptOffset: 4, onAttempt: value => attempts.push(value.attempt) }));
    assert.deepEqual(attempts, [5, 6]);
});

test('the repaint keeps the subject\'s headwear without naming any garment', () => {
    const prompt = videoEditStillPrompt('the woman in the foreground', 'Meximutt');
    assert.match(prompt, /wears anything on its head in Image 1, the replacement wears the same thing/);
    // Listing religious garments got frames of bareheaded real people refused.
    assert.doesNotMatch(prompt, /hijab|veil|turban|headscarf/i);
});

test('provider errors other than refusals are not retried', async () => {
    const { error, requests } = await withImageEdits(() => [500, { error: { message: 'Server error' } }],
        () => createVideoEditStill(frame, replacement, 'the bull', 'meximutt'));
    assert.equal(error?.code, 'provider_error');
    assert.equal(requests, 1);
});

// A 1x1 PNG: signature, IHDR, IDAT and IEND.
const onePixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

function chunks(png) {
    const found = [];
    for (let offset = 8; offset < png.length;) {
        const length = png.readUInt32BE(offset);
        found.push({ type: png.toString('latin1', offset + 4, offset + 8),
            data: png.subarray(offset + 8, offset + 8 + length) });
        offset += 12 + length;
    }
    return found;
}

test('the still carries grounded effects to the worker as PNG text', () => {
    const still = { bytes: onePixel, mimeType: 'image/png', provider: 'openai', model: 'gpt-image-test' };
    const labeled = videoEditStillWithEffects(still, ' glowing light beams from the eyes\u2014both ');
    const found = chunks(labeled.bytes);
    assert.deepEqual(found.map(chunk => chunk.type), ['IHDR', 'IDAT', 'tEXt', 'IEND']);
    assert.equal(found[2].data.toString('latin1'), 'video_edit_effects\0glowing light beams from the eyesboth');
    assert.equal(inflateSync(found[1].data).length, 4, 'the image data is untouched');
    assert.equal(videoEditStillWithEffects(still, ''), still);
    const jpeg = { ...still, mimeType: 'image/jpeg', bytes: Buffer.from('jpeg') };
    assert.equal(videoEditStillWithEffects(jpeg, 'beams'), jpeg);
});
