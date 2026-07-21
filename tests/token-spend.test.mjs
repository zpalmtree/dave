import assert from 'node:assert/strict';
import test from 'node:test';

import {
    estimateTokenSpendCost,
    resolveModelPricing,
} from '../dist/TokenSpend.js';

test('resolves pricing for exact model ids', () => {
    const pricing = resolveModelPricing('claude-fable-5');
    assert.ok(pricing);
    assert.equal(pricing.input, 10);
    assert.equal(pricing.output, 50);
});

test('resolves pricing for versioned model ids by longest prefix', () => {
    assert.ok(resolveModelPricing('grok-4.5-latest'));
    assert.ok(resolveModelPricing('grok-imagine-image-quality-latest'));
    assert.ok(resolveModelPricing('gpt-5.5-2026-01-01'));
});

test('returns undefined pricing for unknown models', () => {
    assert.equal(resolveModelPricing('some-new-model'), undefined);
});

test('estimates claude cost from input and output tokens', () => {
    const cost = estimateTokenSpendCost({
        model: 'claude-fable-5',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
    });

    assert.equal(cost, 60);
});

test('includes cache reads, cache writes and web searches in claude cost', () => {
    const cost = estimateTokenSpendCost({
        model: 'claude-fable-5',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
        webSearches: 2,
    });

    assert.equal(cost, 1 + 12.5 + 0.02);
});

test('prices images per unit', () => {
    const cost = estimateTokenSpendCost({
        model: 'grok-imagine-image-quality-latest',
        images: 2,
    });

    assert.ok(Math.abs(cost - 0.14) < 1e-9);
});

test('unknown models cost zero but do not throw', () => {
    const cost = estimateTokenSpendCost({
        model: 'some-new-model',
        inputTokens: 5000,
        outputTokens: 5000,
    });

    assert.equal(cost, 0);
});

test('missing token counts are treated as zero', () => {
    assert.equal(estimateTokenSpendCost({ model: 'claude-fable-5' }), 0);
});
