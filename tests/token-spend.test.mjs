import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sqlite3 from 'sqlite3';

import {
    estimateTokenSpendCost,
    initTokenSpend,
    recordExternalTokenSpend,
    resolveModelPricing,
} from '../dist/TokenSpend.js';
import { createTablesIfNeeded, selectQuery } from '../dist/Database.js';
import { formatCompactNumber, formatUsdCost, pluralize } from '../dist/Utilities.js';

test('resolves pricing for exact model ids', () => {
    const pricing = resolveModelPricing('claude-opus-5');
    assert.ok(pricing);
    assert.equal(pricing.input, 5);
    assert.equal(pricing.output, 25);
});

test('resolves pricing for versioned model ids by longest prefix', () => {
    assert.ok(resolveModelPricing('grok-4.5-latest'));
    assert.ok(resolveModelPricing('grok-4.6-2026-08-01'));
    assert.ok(resolveModelPricing('grok-imagine-image-2.0'));
    assert.ok(resolveModelPricing('gpt-5.6-sol-2026-08-01'));
});

test('returns undefined pricing for unknown models', () => {
    assert.equal(resolveModelPricing('some-new-model'), undefined);
});

test('estimates claude cost from input and output tokens', () => {
    const cost = estimateTokenSpendCost({
        model: 'claude-opus-5',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
    });

    assert.equal(cost, 30);
});

test('includes cache reads, cache writes and web searches in claude cost', () => {
    const cost = estimateTokenSpendCost({
        model: 'claude-opus-5',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
        webSearches: 2,
    });

    assert.equal(cost, 0.5 + 6.25 + 0.02);
});

test('prices images per unit', () => {
    const cost = estimateTokenSpendCost({
        model: 'grok-imagine-image-2.0',
        images: 2,
    });

    assert.ok(Math.abs(cost - 0.12) < 1e-9);
});

test('prices transcription audio by duration', () => {
    const cost = estimateTokenSpendCost({
        model: 'gpt-transcribe',
        audioSeconds: 120,
    });

    assert.equal(cost, 0.009);
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
    assert.equal(estimateTokenSpendCost({ model: 'claude-opus-5' }), 0);
});

test('provider reported cost overrides the pricing table estimate', () => {
    const cost = estimateTokenSpendCost({
        model: 'grok-imagine-image-2.0',
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

test('imports external video usage idempotently with full attribution', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-token-spend-'));
    const db = new sqlite3.Database(join(directory, 'tokens.sqlite3'));
    try {
        await createTablesIfNeeded(db);
        initTokenSpend(db);
        const context = {
            userId: 'video-user', channelId: 'video-channel', guildId: 'video-guild', command: 'minimaxfast',
        };
        const usage = {
            model: 'gpt-5.6-sol', inputTokens: 1200, outputTokens: 300,
            images: 1, webSearches: 2, costOverride: 0.123,
        };
        const metadata = {
            eventId: 'video-job:prompt-analysis:1', sourceJobId: 'video-job',
            stage: 'prompt_analysis', attempt: 1, serviceTier: 'priority', outcome: 'success',
        };
        await recordExternalTokenSpend(context, usage, metadata);
        await recordExternalTokenSpend(context, usage, metadata);
        const rows = await selectQuery('SELECT * FROM token_usage', db);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].command, 'minimaxfast');
        assert.equal(rows[0].user_id, 'video-user');
        assert.equal(rows[0].images, 1);
        assert.equal(rows[0].web_searches, 2);
        assert.equal(rows[0].service_tier, 'priority');
        assert.equal(rows[0].cost, 0.123);
    } finally {
        await new Promise(resolve => db.close(resolve));
        rmSync(directory, { recursive: true, force: true });
    }
});
