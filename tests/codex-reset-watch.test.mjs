import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSnapshot, planResetAlerts, resetNotification, deliverResetAlerts, saveResetState, validateState } from '../dist/CodexResetWatch.js';

const settings = { botUserId: '123', channelId: '746507379310461010' };
const reset = (id, overrides = {}) => ({ id, reset_type: 'regular', announced_at: '2026-10-15T06:28:13.000Z', text: 'Reset complete', source: { type: 'x_post', url: `https://x.com/thsottiaux/status/${id}` }, ...overrides });
const scheduled = id => ({ ...reset(id), status: 'scheduled', scheduled_for: '2026-10-15T07:00:00Z' });
const snapshot = (resets = [], upcoming = null) => ({ resets, scheduled: upcoming });
const baseline = () => planResetAlerts(undefined, settings, snapshot([reset('old')]));

test('startup baselines history but announces an outstanding scheduled reset once', () => {
    const view = snapshot([reset('old')], scheduled('new'));
    const state = planResetAlerts(undefined, settings, view);
    assert.deepEqual(state.pending.map(item => item.phase), ['announced']);
    assert.deepEqual(planResetAlerts({ ...state, pending: [] }, settings, view).pending, []);
});

test('same source ID transitions from announced to dropped, without repeating either', () => {
    const announced = planResetAlerts(baseline(), settings, snapshot([reset('old')], scheduled('new')));
    const dropped = planResetAlerts({ ...announced, pending: [] }, settings, snapshot([reset('new'), reset('old')]));
    assert.deepEqual(dropped.pending.map(item => [item.phase, item.reset.id]), [['dropped', 'new']]);
    assert.deepEqual(planResetAlerts({ ...dropped, pending: [] }, settings, snapshot([reset('new')])).pending, []);
});

test('elapsed ETA, withdrawn announcement and stale scheduled status never fabricate a drop', () => {
    const state = planResetAlerts(baseline(), settings, snapshot([reset('old')], scheduled('new')));
    for (const upcoming of [scheduled('new'), null]) {
        assert.deepEqual(planResetAlerts({ ...state, pending: [] }, settings, snapshot([reset('old')], upcoming)).pending, []);
    }
    const dropped = planResetAlerts(state, settings, snapshot([reset('new')]));
    assert.deepEqual(planResetAlerts({ ...dropped, pending: [] }, settings, snapshot([], scheduled('new'))).pending, []);
});

test('multiple executed resets during downtime are delivered chronologically, including observed banked credits', () => {
    const state = planResetAlerts(baseline(), settings, snapshot([
        reset('later', { announced_at: '2026-10-16T00:00:00Z' }),
        reset('observed-earlier', { reset_type: 'banked', source: { type: 'observed' } }),
    ]));
    assert.deepEqual(state.pending.map(item => item.reset.id), ['observed-earlier', 'later']);
    const message = resetNotification(state.pending[0]);
    assert.match(message.embeds[0].description, /Banked reset credit/);
    assert.equal(message.embeds[0].url, 'https://codex-resets.com');
});

test('all history pages are fetched; latest reset closes a status/history cache gap; forecasts ignored', async () => {
    const paths = [];
    const view = await readSnapshot(async path => {
        paths.push(path);
        if (path === '/status') return { data: { latest_reset: reset('latest'), scheduled_reset: null, active_watch: { level: 'strong' } } };
        if (path.includes('cursor=')) return { data: [reset('older')], pagination: { has_more: false, next_cursor: null } };
        return { data: [reset('old')], pagination: { has_more: true, next_cursor: 'next_page' } };
    });
    assert.equal(paths.length, 3);
    assert.match(paths[2], /cursor=next_page/);
    assert.deepEqual(view.resets.map(item => item.id), ['old', 'older', 'latest']);
    assert.equal(view.scheduled, null);
});

test('invalid status/history and repeated cursors fail without changing durable state', async () => {
    for (const page of [{}, { data: [{}], pagination: { has_more: false } }, { data: [], pagination: { has_more: true, next_cursor: 'loop' } }]) {
        await assert.rejects(readSnapshot(async path => path === '/status'
            ? { data: { latest_reset: null, scheduled_reset: null } } : page), /Invalid/);
    }
    await assert.rejects(readSnapshot(async () => ({ data: {} })), /Invalid/);
    await assert.rejects(readSnapshot(async () => ({ data: { latest_reset: null, scheduled_reset: { ...scheduled('x'), scheduled_for: 'bad date' } } })), /Invalid/);
});

test('persistent outbox survives restart and failed delivery; checkpoints each successful message', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-reset-watch-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.json');
    const state = planResetAlerts(baseline(), settings, snapshot([reset('one'), reset('two')]));
    const save = () => saveResetState(path, state);
    await save();
    let sent = 0;
    await assert.rejects(deliverResetAlerts(state, async () => {
        if (++sent === 2) throw new Error('Discord unavailable');
    }, save), /Discord unavailable/);
    const restored = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(restored.pending.map(item => item.reset.id), ['two']);
    await deliverResetAlerts(restored, async () => {}, () => saveResetState(path, restored));
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).pending, []);
    assert.deepEqual(planResetAlerts(restored, settings, snapshot([reset('one'), reset('two')])).pending, []);
});

test('state cannot be sent to a different destination or by a different bot', () => {
    for (const changed of [{ ...settings, channelId: '456' }, { ...settings, botUserId: '789' }]) {
        assert.throws(() => validateState(baseline(), changed), /destination/);
    }
    assert.throws(() => validateState({}, settings), /Invalid/);
});

test('notifications include source attribution, bounded text and no mentions', () => {
    const message = resetNotification({ phase: 'announced', reset: { ...scheduled('new'), text: '@everyone ' + '*'.repeat(5000) } });
    assert.deepEqual(message.allowedMentions, { parse: [] });
    assert.match(message.embeds[0].title, /announced/);
    assert.match(message.embeds[0].description, /Expected: <t:/);
    assert.match(message.embeds[0].description, /Data from Codex Resets/);
    assert.ok(message.embeds[0].description.length < 4096);
});
