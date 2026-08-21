import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AI_MODELS,
    AI_REQUEST_TIMEOUTS,
    OPENAI_FINE_TUNED_MODELS,
} from '../dist/AIModels.js';

test('uses the audited production model for each provider capability', () => {
    assert.deepEqual(AI_MODELS, {
        claudeChat: 'claude-opus-5',
        openAIChat: 'gpt-5.6-sol',
        openAITranscription: 'gpt-transcribe',
        openAIImage: 'gpt-image-2',
        geminiChat: 'gemini-3.7-flash',
        geminiImage: 'gemini-3-pro-image',
        grokChat: 'grok-4.6',
        grokSummary: 'grok-4.5-latest',
        grokImage: 'grok-imagine-image-2.0',
        gabChat: 'arya',
    });
});

test('allows Grok Image 2.0 enough time to finish rendering', () => {
    assert.equal(AI_REQUEST_TIMEOUTS.grokImage, 180_000);
});

test('keeps custom personalities pinned to their trained fine-tunes', () => {
    assert.match(OPENAI_FINE_TUNED_MODELS.davinciV4, /^ft:gpt-3\.5-turbo-1106:/);
    assert.match(OPENAI_FINE_TUNED_MODELS.fitQuoteV19, /^ft:gpt-3\.5-turbo-1106:/);
    assert.match(OPENAI_FINE_TUNED_MODELS.slugQuoteV2, /^ft:gpt-3\.5-turbo-1106:/);
    assert.match(OPENAI_FINE_TUNED_MODELS.bugglesV41, /^ft:gpt-4o-2024-08-06:/);
});
