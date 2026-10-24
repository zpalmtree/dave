import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUsageSample, advanceUsageWatch } from '../dist/CodexUsageWatch.js';
import { readCodexUsage } from '../scripts/codex-usage-watch.mjs';

const at = 1800000000;
const response = (used = 60, count = 0) => ({ accountId: 'private-account-id',
    rateLimits: { limitId: 'codex', planType: 'pro', primary: {
        usedPercent: used, windowDurationMins: 10080, resetsAt: at + 86400,
    } }, rateLimitResetCredits: { availableCount: count,
        credits: Array.from({ length: count }, (_, i) => ({ id: `credit-${i}`, status: 'available' })) } });
const sample = (seconds, used = 60, count = 0) => parseUsageSample(response(used, count), at + seconds);
const start = (value = sample(0)) => advanceUsageWatch(undefined, value);
const sequence = (...samples) => samples.reduce((state, value) => advanceUsageWatch(state, value), undefined);

test('startup baselines silently; two fresh reads confirm a surprise reset exactly once', () => {
    const first = advanceUsageWatch(start(), sample(60, 0));
    assert.equal(first.events.length, 0);
    assert.deepEqual(first.candidate.types, ['regular']);
    const confirmed = advanceUsageWatch(JSON.parse(JSON.stringify(first)), sample(120, 1));
    assert.equal(confirmed.events.length, 1);
    assert.equal(confirmed.events[0].reset_type, 'regular');
    assert.equal(confirmed.events[0].announced_at, new Date((at + 60) * 1000).toISOString());
    assert.match(confirmed.events[0].text, /monitored.*account/);
    assert.equal(advanceUsageWatch(confirmed, sample(180, 2)).events.length, 1);
    assert.doesNotMatch(JSON.stringify(confirmed.events), /private-account-id|usedPercent|credit-0/);
});

test('normal rollover, near-boundary rollover, noise, and unconfirmed transient drops are silent', () => {
    for (const resetsAt of [at + 60, at + 180]) {
        const old = sample(0); old.windows.primary.resetsAt = resetsAt;
        assert.equal(sequence(old, sample(60, 0), sample(120, 0)).events.length, 0);
    }
    assert.equal(sequence(sample(0, 3), sample(60, 0), sample(120, 0)).events.length, 0);
    assert.equal(sequence(sample(0), sample(60, 0), sample(120, 60)).events.length, 0);
});

test('account, plan, window changes and stale samples rebaseline without alerts', () => {
    for (const mutate of [s => { s.account = 'other'; }, s => { s.plan = 'plus'; },
        s => { s.windows.primary.minutes = 300; }, s => { s.at += 600; }]) {
        const changed = sample(60, 0); mutate(changed);
        assert.equal(advanceUsageWatch(start(), changed).candidate, undefined);
    }
    assert.equal(sequence(sample(0), sample(60, 0), sample(700, 0)).events.length, 0);
    assert.equal(sequence(sample(0), sample(60, 0), sample(61, 0)).events.length, 0);
});

test('personal credit consumption, including replacement grants, cannot trigger usage reset alerts', () => {
    assert.equal(sequence(sample(0, 60, 1), sample(60, 0, 0), sample(120, 0, 0)).events.length, 0);
    assert.equal(sequence(sample(0, 60, 1), sample(60, 0, 1), sample(120, 0, 0)).events.length, 0);
    const changed = sample(60, 0, 1); changed.credits.ids = ['replacement'];
    assert.equal(sequence(sample(0, 60, 1), changed, { ...changed, at: at + 120 }).events.length, 0);
    const unknown = sample(0); unknown.credits = null;
    assert.equal(sequence(unknown, sample(60, 0), sample(120, 0)).events.length, 0);
    const partial = sample(0, 60, 1); partial.credits.ids = null;
    assert.equal(sequence(partial, sample(60, 0, 1), sample(120, 0, 1)).events.length, 0);
});

test('unchanged complete credit inventory permits a genuine early usage reset', () => {
    assert.equal(sequence(sample(0, 60, 1), sample(60, 0, 1), sample(120, 1, 1)).events.length, 1);
});

test('new reset credits require confirmation; a startup inventory and disappearing credit are silent', () => {
    assert.equal(start(sample(0, 60, 2)).events.length, 0);
    const state = sequence(sample(0), sample(60, 60, 1), sample(120, 60, 1));
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].reset_type, 'banked');
    assert.equal(sequence(sample(0), sample(60, 60, 1), sample(120)).events.length, 0);
});

test('multi-bucket response selects Codex; missing credits and capped detail rows stay unknown', () => {
    const value = response();
    value.rateLimitsByLimitId = { codex: { ...value.rateLimits, primary: { ...value.rateLimits.primary, usedPercent: 12 } } };
    value.rateLimitResetCredits = null;
    assert.equal(parseUsageSample(value, at).windows.primary.used, 12);
    assert.equal(parseUsageSample(value, at).credits, null);
    value.rateLimitResetCredits = { availableCount: 3, credits: [{ id: 'one', status: 'available' }] };
    assert.equal(parseUsageSample(value, at).credits.ids, null);
    for (const invalid of [{}, { ...response(), accountId: null },
        { ...response(), rateLimitResetCredits: { availableCount: -1 } }]) {
        assert.throws(() => parseUsageSample(invalid, at));
    }
});

test('RPC reader initializes, reads limits without a model turn, and handles failure and timeout', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-usage-rpc-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const fake = join(directory, 'codex');
    await writeFile(fake, `#!${process.execPath}
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}}));
 else if(m.method==='account/rateLimits/read') console.log(JSON.stringify({id:m.id,result:${JSON.stringify(response())}}));
 else if(m.method!=='initialized') process.exit(2);
});
`, { mode: 0o700 });
    const result = await readCodexUsage(fake, 3000);
    assert.equal(result.windows.primary.used, 60);
    assert.notEqual(result.account, 'private-account-id');
    await assert.rejects(readCodexUsage(join(directory, 'missing'), 1000), /Could not start/);
    await writeFile(fake, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
    await assert.rejects(readCodexUsage(fake, 100), /timed out/);
});
