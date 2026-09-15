import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCImageGenerationTool } from '../dist/CImageGeneration.js';

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
