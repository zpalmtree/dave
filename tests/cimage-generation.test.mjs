import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildCImageGenerationTool,
    generateCImageWithFallback,
} from '../dist/CImageGeneration.js';

test('requests transparent PNG output from GPT Image 2.5 Flare', () => {
    assert.deepEqual(buildCImageGenerationTool('jpeg', true), {
        type: 'image_generation',
        model: 'gpt-image-2.5-flare',
        moderation: 'low',
        output_format: 'png',
        background: 'transparent',
    });
});

test('keeps compressed JPEG output for ordinary GPT Image 2.5 Flare requests', () => {
    assert.deepEqual(buildCImageGenerationTool('jpeg', false), {
        type: 'image_generation',
        model: 'gpt-image-2.5-flare',
        moderation: 'low',
        output_format: 'jpeg',
        output_compression: 50,
    });
});

test('uses Sunburst for reference-image edits and preserves output settings', () => {
    assert.deepEqual(buildCImageGenerationTool('jpeg', true, true), {
        type: 'image_generation',
        model: 'gpt-image-2.5-sunburst',
        moderation: 'low',
        output_format: 'png',
        background: 'transparent',
    });
    assert.deepEqual(buildCImageGenerationTool('jpeg', false, true), {
        type: 'image_generation',
        model: 'gpt-image-2.5-sunburst',
        moderation: 'low',
        output_format: 'jpeg',
        output_compression: 50,
    });
});

test('successful Flare generation makes only one request', async () => {
    const tool = buildCImageGenerationTool('jpeg', false);
    const calls = [];
    const image = { result: 'generated-image' };
    const result = await generateCImageWithFallback(tool, async request => {
        calls.push(request);
        return image;
    });
    assert.equal(result, image);
    assert.deepEqual(calls, [tool]);
});

test('Flare server errors fall back once to Sunburst without losing output settings', async t => {
    t.mock.method(console, 'warn', () => {});
    for (const transparent of [false, true]) {
        for (const status of [500, 502, 503, 504]) {
            const tool = buildCImageGenerationTool('jpeg', transparent);
            const calls = [];
            const image = { result: 'fallback-image' };
            const result = await generateCImageWithFallback(tool, async request => {
                calls.push(request);
                if (calls.length === 1) throw Object.assign(new Error('Server error'), { status });
                return image;
            });
            assert.equal(result, image);
            assert.deepEqual(calls, [tool, { ...tool, model: 'gpt-image-2.5-sunburst' }]);
            assert.equal(tool.model, 'gpt-image-2.5-flare');
        }
    }
});

test('invalid requests, access failures, rate limits, and connection errors do not switch models', async () => {
    for (const status of [400, 401, 403, 404, 429, undefined]) {
        const error = Object.assign(new Error('Request failed'), { status });
        let calls = 0;
        await assert.rejects(generateCImageWithFallback(
            buildCImageGenerationTool('jpeg', false),
            async () => { calls++; throw error; },
        ), caught => caught === error);
        assert.equal(calls, 1);
    }
});

test('a failed Sunburst fallback returns its error without looping', async t => {
    t.mock.method(console, 'warn', () => {});
    const firstError = Object.assign(new Error('Flare unavailable'), { status: 500 });
    const fallbackError = Object.assign(new Error('Sunburst unavailable'), { status: 503 });
    let calls = 0;
    await assert.rejects(generateCImageWithFallback(
        buildCImageGenerationTool('jpeg', false),
        async () => { throw ++calls === 1 ? firstError : fallbackError; },
    ), caught => caught === fallbackError);
    assert.equal(calls, 2);
});

test('Sunburst edit failures are returned without another model attempt', async () => {
    const error = Object.assign(new Error('Sunburst unavailable'), { status: 500 });
    let calls = 0;
    await assert.rejects(generateCImageWithFallback(
        buildCImageGenerationTool('png', true, true),
        async () => { calls++; throw error; },
    ), caught => caught === error);
    assert.equal(calls, 1);
});
