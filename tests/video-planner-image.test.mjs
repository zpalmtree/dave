import assert from 'node:assert/strict';
import test from 'node:test';
import { randomFillSync } from 'node:crypto';
import { createCanvas, loadImage } from 'canvas';
import { anthropicPlannerImage } from '../dist/VideoPlannerImage.js';
import { requestPlannerResponse } from '../dist/VideoFrontierPlanner.js';

const encodedLimit = 4 * 1024 * 1024;
const imageUrl = (bytes, mime = 'image/png') => `data:${mime};base64,${bytes.toString('base64')}`;

test('small planner images retain their bytes, MIME type, and transparency', async () => {
    const canvas = createCanvas(16, 8);
    for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
        const bytes = canvas.toBuffer(mime);
        assert.deepEqual(await anthropicPlannerImage(imageUrl(bytes, mime)), {
            type: 'image', source: { type: 'base64', media_type: mime, data: bytes.toString('base64') },
        });
    }
});

test('oversized transparent references use a lossless preview without changing the source', async () => {
    const canvas = createCanvas(20, 10);
    canvas.getContext('2d').fillRect(0, 0, 5, 5);
    const original = Buffer.concat([canvas.toBuffer('image/png'), Buffer.alloc(12 * 1024 * 1024)]);
    const url = imageUrl(original);
    const { source } = await anthropicPlannerImage(url);
    assert.equal(source.media_type, 'image/png');
    assert.ok(source.data.length < encodedLimit);
    const decoded = await loadImage(Buffer.from(source.data, 'base64'));
    const preview = createCanvas(decoded.width, decoded.height);
    const ctx = preview.getContext('2d');
    ctx.drawImage(decoded, 0, 0);
    assert.equal(ctx.getImageData(19, 9, 1, 1).data[3], 0);
    assert.equal(imageUrl(original), url);
});

test('Opus requests bound every large reference and reuse previews across transient retries', async t => {
    const canvas = createCanvas(2304, 1536);
    const ctx = canvas.getContext('2d');
    const pixels = ctx.createImageData(canvas.width, canvas.height);
    randomFillSync(pixels.data);
    for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = 255;
    ctx.putImageData(pixels, 0, 0);
    const original = canvas.toBuffer('image/png');
    const url = imageUrl(original);
    assert.ok(url.length > 10 * 1024 * 1024, 'fixture must reproduce the provider limit failure');
    const input = [{ role: 'user', content: [
        { type: 'input_text', text: 'Animate these references.' },
        { type: 'input_image', image_url: url },
        { type: 'input_image', image_url: url },
    ] }];
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (_url, request) => {
        const body = JSON.parse(request.body);
        requests.push(body);
        for (const part of body.messages[0].content.slice(1)) {
            assert.ok(part.source.data.length <= encodedLimit);
            assert.equal(part.source.media_type, 'image/jpeg');
            const preview = await loadImage(Buffer.from(part.source.data, 'base64'));
            assert.ok(preview.width <= 2048 && preview.height <= 2048);
            assert.ok(Math.abs(preview.width / preview.height - 1.5) < 0.01);
        }
        return requests.length === 1
            ? { ok: false, status: 503, json: async () => ({ error: { message: 'Try again' } }) }
            : { ok: true, json: async () => ({ stop_reason: 'end_turn',
                content: [{ type: 'text', text: '{"ok":true}' }],
                usage: { input_tokens: 100, output_tokens: 5 } }) };
    });
    const result = await requestPlannerResponse({ model: 'claude-opus-5-5', input },
        AbortSignal.timeout(30_000), 'test', {});
    assert.equal(result.output_text, '{"ok":true}');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].messages, requests[1].messages);
    assert.equal(input[0].content[1].image_url, url);
    assert.equal(imageUrl(original), url);
});

test('invalid oversized image fails locally before provider requests', async t => {
    const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected network request'); });
    await assert.rejects(requestPlannerResponse({ model: 'claude-opus-5-5', input: [{ role: 'user',
        content: [{ type: 'input_image', image_url: imageUrl(Buffer.alloc(4 * 1024 * 1024)) }],
    }] }, AbortSignal.timeout(5000), 'test', {}));
    assert.equal(fetch.mock.callCount(), 0);
});
