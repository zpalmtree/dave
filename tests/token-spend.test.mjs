import assert from 'node:assert/strict';
import test from 'node:test';

import {
    estimateTokenSpendCost,
    resolveModelPricing,
} from '../dist/TokenSpend.js';
import { formatCompactNumber, formatUsdCost, pluralize } from '../dist/Utilities.js';

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

test('provider reported cost overrides the pricing table estimate', () => {
    const cost = estimateTokenSpendCost({
        model: 'grok-imagine-image-quality-latest',
        images: 1,
        costOverride: 0.09,
    });

    assert.equal(cost, 0.09);
});

test('cost override applies even for unknown models', () => {
    assert.equal(estimateTokenSpendCost({ model: 'some-new-model', costOverride: 0.5 }), 0.5);
});

test('shortens token counts for embed display', () => {
    assert.equal(formatCompactNumber(2885599), '2.89M');
    assert.equal(formatCompactNumber(1510382), '1.51M');
    assert.equal(formatCompactNumber(449262), '449K');
    assert.equal(formatCompactNumber(55150), '55.2K');
    assert.equal(formatCompactNumber(3214), '3.21K');
    assert.equal(formatCompactNumber(947), '947');
    assert.equal(formatCompactNumber(0), '0');
});

test('formats spend to two places with a sub-cent floor', () => {
    assert.equal(formatUsdCost(13.8898), '$13.89');
    assert.equal(formatUsdCost(6.3444), '$6.34');
    assert.equal(formatUsdCost(0.2746), '$0.27');
    assert.equal(formatUsdCost(0.01), '$0.01');
    assert.equal(formatUsdCost(0.004), '<$0.01');
    assert.equal(formatUsdCost(0), '$0.00');
});

test('pluralizes call counts', () => {
    assert.equal(pluralize(1, 'call'), 'call');
    assert.equal(pluralize(0, 'call'), 'calls');
    assert.equal(pluralize(75, 'call'), 'calls');
});
