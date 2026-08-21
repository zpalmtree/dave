import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCImageGenerationTool } from '../dist/CImageGeneration.js';

test('requests transparent PNG output from GPT Image 2', () => {
    assert.deepEqual(buildCImageGenerationTool('jpeg', true, 3), {
        type: 'image_generation',
        model: 'gpt-image-2',
        moderation: 'low',
        output_format: 'png',
        background: 'transparent',
        partial_images: 3,
    });
});

test('keeps compressed JPEG output for ordinary GPT Image 2 requests', () => {
    assert.deepEqual(buildCImageGenerationTool('jpeg', false, 3), {
        type: 'image_generation',
        model: 'gpt-image-2',
        moderation: 'low',
        output_format: 'jpeg',
        output_compression: 50,
        partial_images: 3,
    });
});
