import test from 'node:test';
import assert from 'node:assert/strict';

import { createVideoEditStill, videoEditStillPrompt, videoEditStillWithEffects } from '../dist/VideoKeyframeProvider.js';
import { inflateSync } from 'node:zlib';
import { createCanvas, loadImage } from 'canvas';
import { config } from '../dist/Config.js';
import { VideoUsagePersistenceError } from '../dist/VideoUsage.js';

const sourceCanvas = createCanvas(160, 90);
const frame = { bytes: sourceCanvas.toBuffer('image/png'), mimeType: 'image/png' };
const replacement = { bytes: Buffer.from('replacement'), mimeType: 'image/png' };

async function withImageEdits(respond, run) {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async (input, init) => {
        requests += 1;
        const [status, body] = await respond(requests, String(input), init);
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

test('the preferred editor gets one retry before switching editors', async () => {
    const attempts = [];
    const recovered = await withImageEdits(count => (count === 1 ? refused : repainted),
        () => createVideoEditStill(frame, replacement, 'the woman', 'meximutt',
            { onAttempt: value => attempts.push([value.attempt, value.outcome]) }));
    assert.equal(recovered.result.bytes.toString(), 'repainted');
    assert.deepEqual(attempts, [[1, 'error'], [2, 'success']]);

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

const geminiImage = (bytes = frame.bytes, mimeType = 'image/png') => [200, {
    candidates: [{ content: { parts: [{ inlineData: { mimeType, data: bytes.toString('base64') } }] } }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 1690,
        candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1680 }] },
}];

for (const isolated of [false, true]) test(`Gemini gets the original frame, identity and edit prompt (isolated=${isolated})`, async () => {
    const attempts = [], usage = [], reservations = [];
    let originalPrompt;
    const { result, error, requests } = await withImageEdits((_count, url, init) => {
        if (url.includes('api.openai.com')) {
            originalPrompt = init.body.get('prompt');
            return refused;
        }
        assert.match(url, /generativelanguage.googleapis.com/);
        const body = JSON.parse(init.body);
        const parts = body.contents[0].parts;
        assert.deepEqual(parts.filter(part => part.inlineData).map(part => part.inlineData),
            [frame, replacement].map(image => ({ mimeType: image.mimeType, data: image.bytes.toString('base64') })));
        assert.equal(parts.at(-1).text, originalPrompt);
        assert.doesNotMatch(JSON.stringify(parts), /FRAME-ZERO|Generate one new|visual references only/);
        assert.equal(body.generationConfig.imageConfig.aspectRatio, '16:9');
        assert.equal(body.safetySettings, undefined, 'Use normal provider safeguards.');
        return geminiImage();
    }, () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt', {
        isolated, attemptOffset: 6, onAttempt: event => attempts.push(event),
        onUsage: event => usage.push(event), beforeRequest: event => reservations.push(event),
    }));
    assert.equal(error, undefined);
    assert.equal(result.provider, 'gemini');
    assert.equal(result.mimeType, 'image/png');
    assert.equal((await loadImage(result.bytes)).width, 160);
    assert.equal(requests, 3);
    assert.deepEqual(attempts.map(event => [event.stage, event.provider, event.attempt, event.outcome]), [
        ['video_edit_still', 'openai', 7, 'error'], ['video_edit_still', 'openai', 8, 'error'],
        ['video_edit_still', 'google', 9, 'success'],
    ]);
    assert.deepEqual(usage.map(event => [event.stage, event.provider, event.attempt, event.images]),
        [['video_edit_still', 'google', 9, 1]]);
    assert.deepEqual(reservations.map(event => event.stage), Array(3).fill('video_edit_still'));
});

test('an outage goes directly to Gemini and JPEG output remains usable for effect metadata', async () => {
    const { result, error, requests } = await withImageEdits((_count, url) => url.includes('api.openai.com')
        ? [503, { error: { message: 'Service unavailable' } }]
        : geminiImage(sourceCanvas.toBuffer('image/jpeg'), 'image/jpeg'),
    () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt'));
    assert.equal(error, undefined);
    assert.equal(requests, 2);
    assert.equal(result.mimeType, 'image/png');
    assert.ok(videoEditStillWithEffects(result, 'blue light').bytes.includes(Buffer.from('video_edit_effects')));
});

test('all editors failing leaves the job failed, and missing Gemini configuration preserves the original error', async t => {
    const failed = await withImageEdits((_count, url) => url.includes('api.openai.com') ? refused
        : [200, { promptFeedback: { blockReason: 'SAFETY' } }],
    () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt'));
    assert.match(failed.error.message, /prompt_block=SAFETY/);
    assert.equal(failed.requests, 3);
    const saved = config.geminiApiKey;
    config.geminiApiKey = '';
    t.after(() => { config.geminiApiKey = saved; });
    const unavailable = await withImageEdits(() => refused,
        () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt'));
    assert.equal(unavailable.error.code, 'moderation');
    assert.equal(unavailable.requests, 2);
});

test('empty or corrupt fallback images never reach animation', async () => {
    for (const response of [[200, { candidates: [] }], geminiImage(Buffer.from('not an image'))]) {
        const { error, result } = await withImageEdits((_count, url) => url.includes('api.openai.com') ? refused : response,
            () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt'));
        assert.ok(error);
        assert.equal(result, undefined);
    }
});

test('cancellation and accounting failures do not dispatch fallback requests', async () => {
    const controller = new AbortController();
    const cancelled = await withImageEdits(() => { controller.abort(); return refused; },
        () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt', { abortSignal: controller.signal }));
    assert.equal(cancelled.requests, 1);
    assert.ok(cancelled.error);
    const alreadyCancelled = await withImageEdits(() => repainted,
        () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt', { abortSignal: controller.signal }));
    assert.equal(alreadyCancelled.requests, 0);
    for (const hook of ['beforeRequest', 'onUsage', 'onAttempt']) {
        const { error, requests } = await withImageEdits(() => repainted,
            () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt', {
                [hook]: () => { throw new Error('Accounting is unavailable'); },
            }));
        assert.ok(error instanceof VideoUsagePersistenceError);
        assert.equal(requests, hook === 'beforeRequest' ? 0 : 1);
    }
});

test('the alternate editor respects the generation deadline', async t => {
    const realNow = Date.now;
    let elapsed = 0;
    t.mock.method(Date, 'now', () => realNow() + elapsed);
    const { error, requests } = await withImageEdits(() => {
        elapsed = 270_001;
        return refused;
    }, () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt'));
    assert.equal(error.code, 'moderation');
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
