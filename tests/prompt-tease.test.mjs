import assert from 'node:assert/strict';
import test from 'node:test';

import {
    PROMPT_TEASES,
    classifyPromptTease,
    parseSexualPromptClassification,
    pickPromptTease,
} from '../dist/PromptTease.js';

test('parses only the classifier JSON boolean', () => {
    assert.equal(parseSexualPromptClassification('{"sexual":true}'), true);
    assert.equal(parseSexualPromptClassification('{"sexual":false}'), false);
    assert.equal(parseSexualPromptClassification('{"sexual":"true"}'), null);
    assert.equal(parseSexualPromptClassification('true'), null);
});

test('selects a bounded random tease', () => {
    assert.deepEqual(PROMPT_TEASES, ['Pervert.']);
    assert.equal(pickPromptTease(() => 0), PROMPT_TEASES[0]);
    assert.equal(pickPromptTease(() => 0.9999), PROMPT_TEASES.at(-1));
    assert.equal(pickPromptTease(() => 1), PROMPT_TEASES.at(-1));
});

test('returns a tease only for a positive fast-model classification', async () => {
    const seen = [];
    const positive = await classifyPromptTease('show her armpits', {
        generate: async (prompt, signal) => {
            seen.push({ prompt, aborted: signal.aborted });
            return { text: '{"sexual":true}' };
        },
        random: () => 0,
    });
    const negative = await classifyPromptTease('a bowl of oranges', {
        generate: async () => ({ text: '{"sexual":false}' }),
    });

    assert.deepEqual(seen, [{ prompt: 'show her armpits', aborted: false }]);
    assert.equal(positive, 'Pervert.');
    assert.equal(negative, null);
});

test('fails open when classification exceeds its latency budget', async () => {
    const started = Date.now();
    const result = await classifyPromptTease('an erotic request', {
        generate: async () => new Promise(() => {}),
        timeoutMs: 10,
    });
    assert.equal(result, null);
    assert.ok(Date.now() - started < 250);
});
