import assert from 'node:assert/strict';
import test from 'node:test';

import {
    extractGrokResponseText,
    isGrokImageModerationRejection,
    stripGrokCitations,
} from '../dist/GrokResponse.js';

test('strips current xAI inline citations while preserving the answer', () => {
    const response = '50 MW can power roughly 40,000 homes.[[1]](https://example.com/one)[[2]](https://example.com/two)';

    assert.equal(stripGrokCitations(response), '50 MW can power roughly 40,000 homes.');
});

test('strips a citation-only response instead of leaking links to Discord', () => {
    const response = '[[1]](https://www.eia.gov/example)[[2]](https://example.com/two)[[3]](https://example.com/three)';

    assert.equal(stripGrokCitations(response), '');
});

test('continues to strip the previous single-bracket citation format', () => {
    const response = 'Useful answer [1](https://example.com/one) [2][3]';

    assert.equal(stripGrokCitations(response), 'Useful answer');
});

test('collects every assistant output_text block from a Responses API payload', () => {
    const completion = {
        output: [
            { type: 'web_search_call', role: 'tool', content: 'ignored' },
            {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'First part.' }],
            },
            {
                type: 'message',
                role: 'assistant',
                content: [
                    { type: 'reasoning', text: 'ignored' },
                    { type: 'output_text', text: 'Second part.' },
                ],
            },
        ],
    };

    assert.equal(extractGrokResponseText(completion, false), 'First part.\n\nSecond part.');
});

test('recognizes xAI image moderation rejections', () => {
    assert.equal(isGrokImageModerationRejection(
        400,
        '{"code":"imagine:content-moderated","error":"Generated image rejected by content moderation."}',
    ), true);
    assert.equal(isGrokImageModerationRejection(500, 'content-moderated'), false);
    assert.equal(isGrokImageModerationRejection(400, 'invalid image'), false);
});
