import assert from 'node:assert/strict';
import test from 'node:test';

import {
    evaluateDialogueContract,
    normalizeSpeech,
} from '../scripts/video-render-dialogue-contract.mjs';

const strictContract = {
    required_phrases: ['Not today!'],
    allow_extra_speech: false,
    minimum_confirmations: 2,
    minimum_confirming_models: 2,
};

test('speech normalization ignores case and punctuation but preserves words', () => {
    assert.equal(normalizeSpeech('  NOT—today!! '), 'not today');
    assert.equal(normalizeSpeech("Don't stop."), "don't stop");
});

test('dialogue contract passes only after enough exact confirmations', () => {
    const result = evaluateDialogueContract(strictContract, [
        { model: 'a', run: 1, text: 'Not today!' },
        { model: 'b', run: 1, text: 'not today' },
        { model: 'a', run: 2, text: '' },
    ]);
    assert.equal(result.status, 'passed');
    assert.equal(result.confirmations, 2);
    assert.equal(result.exact_confirmations, 2);
});

test('dialogue contract blocks invented or duplicated words', () => {
    for (const text of ['Hey! Not today!', 'Not today! Not today!']) {
        const result = evaluateDialogueContract(strictContract, [
            { model: 'a', run: 1, text: 'Not today!' },
            { model: 'b', run: 1, text },
        ]);
        assert.equal(result.status, 'failed_extra_speech');
        assert.equal(result.extra_speech_observations[0].text, text);
    }
});

test('dialogue contract treats one positive observation as inconclusive', () => {
    const result = evaluateDialogueContract(strictContract, [
        { model: 'a', run: 1, text: '' },
        { model: 'a', run: 2, text: '' },
        { model: 'b', run: 1, text: 'Not today!' },
    ]);
    assert.equal(result.status, 'ambiguous_or_missing');
    assert.equal(result.confirmations, 1);
    assert.equal(result.blank_observations, 2);
});

test('dialogue contract does not mistake repeated runs for independent models', () => {
    const result = evaluateDialogueContract(strictContract, [
        { model: 'whisper-1', run: 1, text: 'Not today!' },
        { model: 'whisper-1', run: 2, text: 'Not today!' },
        { model: 'gpt-transcribe', run: 1, text: '' },
    ]);
    assert.equal(result.status, 'ambiguous_or_missing');
    assert.deepEqual(result.confirming_models, ['whisper-1']);
});
