import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUsageFeed, pollResetObservations, planResetAlerts, resetNotification, deliverResetAlerts, saveResetState, validateState } from '../dist/CodexResetWatch.js';

const settings = { botUserId: '123', channelId: '746507379310461010' };
const observation = (id, overrides = {}) => ({ id: `usage-${id}`, reset_type: 'regular', announced_at: '2026-10-15T06:28:13.000Z', text: 'Reset complete', source: { type: 'account_observed' }, ...overrides });
const tracker = (id, type = 'x_post') => ({ ...observation(id), id, source: { type } });
const baseline = () => planResetAlerts(undefined, settings, [observation('old')]);

test('startup baselines history; later observations alert once, in chronological order', () => {
    const initial = baseline();
    assert.deepEqual(initial.pending, []);
    const events = [observation('later', { announced_at: '2026-10-16T00:00:00Z' }), observation('earlier', { reset_type: 'banked' }), observation('old')];
    const state = planResetAlerts(initial, settings, events);
    assert.deepEqual(state.pending.map(item => item.reset.id), ['usage-earlier', 'usage-later']);
    assert.deepEqual(planResetAlerts({ ...state, pending: [] }, settings, events).pending, []);
});

test('migration discards queued tracker announcements and drops before delivery', async () => {
    const direct = observation('pending');
    const legacy = { ...baseline(), trackerInitialized: true, recentDrops: [tracker('past')],
        seen: ['announced:scheduled', 'dropped:past', 'dropped:usage-pending'],
        pending: [
            { phase: 'announced', reset: { ...tracker('scheduled'), status: 'scheduled', scheduled_for: null } },
            { phase: 'dropped', reset: tracker('unreliable', 'observed') },
            { phase: 'dropped', reset: direct },
        ] };
    const sent = [];
    const saved = [];
    const result = await pollResetObservations(legacy, settings, {
        // Even with a missing feed, old API alerts must not escape the outbox.
        save: async state => { saved.push(JSON.parse(JSON.stringify(state))); },
        send: async message => { sent.push(message); },
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0].embeds[0].title, /monitored account/);
    assert.deepEqual(saved[0].pending, [{ phase: 'dropped', reset: direct }]);
    assert.deepEqual(result.seen, ['dropped:usage-pending']);
    assert.deepEqual(result.pending, []);
    assert.equal('recentDrops' in result, false);
    assert.equal('trackerInitialized' in result, false);
    assert.equal(legacy.pending.length, 3);
});

test('old tracker history no longer suppresses fresh account observations', () => {
    const previous = { ...baseline(), recentDrops: [tracker('same-time')] };
    const state = planResetAlerts(previous, settings, [observation('one'), observation('two')]);
    assert.deepEqual(state.pending.map(item => item.reset.id), ['usage-one', 'usage-two']);
});

test('persistent outbox survives restart and failed delivery; checkpoints each successful message', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-reset-watch-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.json');
    const state = planResetAlerts(baseline(), settings, [observation('one'), observation('two')]);
    const save = () => saveResetState(path, state);
    await save();
    let sent = 0;
    await assert.rejects(deliverResetAlerts(state, async () => {
        if (++sent === 2) throw new Error('Discord unavailable');
    }, save), /Discord unavailable/);
    const restored = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(restored.pending.map(item => item.reset.id), ['usage-two']);
    await pollResetObservations(restored, settings, { send: async () => {}, save: next => saveResetState(path, next) });
    const delivered = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(delivered.pending, []);
    assert.deepEqual(planResetAlerts(delivered, settings, [observation('one'), observation('two')]).pending, []);
});

test('missing feed does not initialize; first valid feed baselines without historical pings', async () => {
    let saves = 0;
    const deps = { save: async () => { saves++; }, send: async () => { assert.fail('Unexpected delivery'); } };
    assert.equal(await pollResetObservations(undefined, settings, deps), undefined);
    assert.equal(saves, 0);
    const state = await pollResetObservations(undefined, settings, { ...deps, observations: [observation('old')] });
    assert.deepEqual(state.seen, ['dropped:usage-old']);
    assert.deepEqual(state.pending, []);
    assert.equal(saves, 1);
});

test('state cannot be sent to a different destination or by a different bot', () => {
    for (const changed of [{ ...settings, channelId: '456' }, { ...settings, botUserId: '789' }]) {
        assert.throws(() => validateState(baseline(), changed), /destination/);
    }
    assert.throws(() => validateState({}, settings), /Invalid/);
});

test('account feed rejects malformed and public tracker events', () => {
    const event = observation('a');
    const feed = events => ({ version: 1, updatedAt: event.announced_at, events });
    assert.deepEqual(readUsageFeed(feed([event])), [event]);
    for (const invalid of [{}, feed([tracker('external')]), feed([observation('bad', { announced_at: 'invalid' })]),
        feed([observation('bad', { id: 'not-usage' })])]) {
        assert.throws(() => readUsageFeed(invalid), /Invalid/);
    }
    assert.throws(() => planResetAlerts(baseline(), settings, [tracker('external')]), /Invalid/);
});

test('notifications ping only the codex role and keep account-specific evidence', () => {
    for (const reset_type of ['regular', 'banked']) {
        const message = resetNotification({ phase: 'dropped', reset: observation('a', { reset_type, text: '@everyone ' + '*'.repeat(5000) }) });
        assert.equal(message.content, '<@&1560349689025532064>');
        assert.deepEqual(message.allowedMentions, { parse: [], roles: ['1560349689025532064'] });
        assert.match(message.embeds[0].title, /monitored account/);
        assert.match(message.embeds[0].title, reset_type === 'banked' ? /reset credit/ : /usage reset/);
        assert.match(message.embeds[0].footer.text, /confirmed twice/);
        assert.equal(message.embeds[0].url, 'https://chatgpt.com/codex/settings/usage');
        assert.ok(message.embeds[0].description.length <= 1800);
        assert.equal(message.embeds[0].fields, undefined);
    }
    assert.throws(() => resetNotification({ phase: 'dropped', reset: tracker('external') }), /Only confirmed/);
    assert.throws(() => resetNotification({ phase: 'announced', reset: observation('a') }), /Only confirmed/);
});

test('save failures prevent delivery and leave previous state intact', async () => {
    const initial = baseline();
    await assert.rejects(pollResetObservations(initial, settings, {
        observations: [observation('live')],
        save: async () => { throw new Error('disk full'); },
        send: async () => { assert.fail('Must persist before delivery'); },
    }), /disk full/);
    assert.deepEqual(initial, baseline());
});
