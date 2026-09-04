import assert from 'node:assert/strict';
import test from 'node:test';

import { extractOpenAIResponseText } from '../dist/OpenAIResponse.js';

test('extracts assistant text without exposing a reasoning summary', () => {
    const response = {
        output: [
            {
                type: 'reasoning',
                summary: [{ type: 'summary_text', text: 'Private chain of thought.' }],
            },
            {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'The user-facing answer.' }],
            },
        ],
    };

    assert.equal(extractOpenAIResponseText(response), 'The user-facing answer.');
});

test('joins only output_text parts from assistant messages', () => {
    const response = {
        output: [
            {
                type: 'message',
                role: 'assistant',
                content: [
                    { type: 'reasoning', text: 'Hidden reasoning.' },
                    { type: 'output_text', text: 'First paragraph.' },
                    { type: 'output_text', text: 'Second paragraph.' },
                ],
            },
            {
                type: 'message',
                role: 'tool',
                content: [{ type: 'output_text', text: 'Hidden tool output.' }],
            },
        ],
    };

    assert.equal(
        extractOpenAIResponseText(response),
        'First paragraph.\n\nSecond paragraph.',
    );
});
