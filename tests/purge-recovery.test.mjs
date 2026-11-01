import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Collection } from 'discord.js';
import { createPurgeHandler } from '../dist/Purge.js';
import { createFilePurgeCheckpointStore, migrateLegacyPurgeCheckpoint } from '../dist/PurgeCheckpoint.js';

const target = '882322615346270268';
const guildId = '891069801173237800';
const collect = items => new Collection(items.map(item => [item.id, item]));
const base = () => ({ version: 1, invokingChannelId: '2', channels: {}, state: {
    runId: 'saved-run', guildId, userId: target, deleted: 0, failures: 0,
    scanned: 0, skipped: 0, pages: 0, phase: 'scanning_messages',
} });
function storage(t) {
    const dir = mkdtempSync(join(tmpdir(), 'purge-recovery-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return { dir, store: createFilePurgeCheckpointStore(dir) };
}
function fixture(entries = [{ id: '300', author: target }, { id: '200', author: target }]) {
    const inventory = [...entries];
    const fetched = [];
    const replies = [];
    const room = {
        id: '2', isTextBased: () => true, isThread: () => false,
        permissionsFor: () => ({ has: () => true }),
        send: async payload => { replies.push(payload.content); return { edit: async () => {} }; },
        messages: { fetch: async ({ before }) => {
            fetched.push(before);
            return collect(inventory.filter(item => !before || BigInt(item.id) < BigInt(before)).slice(0, 2).map(item => ({
                id: item.id, author: { id: item.author }, delete: async () => {
                    inventory.splice(inventory.indexOf(item), 1);
                },
            })));
        } },
    };
    const completed = { ...room, id: '1', messages: { fetch: async () => { throw new Error('Completed channel was rescanned'); } } };
    const guild = { id: guildId, members: { me: {} }, channels: {
        fetch: async id => id ? room : collect([completed, room]),
        fetchActiveThreads: async () => ({ threads: collect([]) }),
    } };
    const msg = { author: { id: target }, guild, channel: room, reply: room.send };
    return { inventory, fetched, replies, msg, client: { user: { id: '9000' }, guilds: { fetch: async () => guild } } };
}

test('checkpoint files are private, atomic, reloadable, and validate their guild', t => {
    const { dir, store } = storage(t);
    store.save(base());
    const file = join(dir, `${guildId}.json`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const reloaded = createFilePurgeCheckpointStore(dir);
    assert.deepEqual(reloaded.list(), [base()]);
    assert.throws(() => store.load('../escape'));
    writeFileSync(file, '{incomplete');
    assert.throws(() => reloaded.load(guildId));
    assert.equal(readFileSync(file, 'utf8'), '{incomplete');
    const mismatch = base(); mismatch.state.guildId = '123';
    writeFileSync(file, JSON.stringify(mismatch));
    assert.throws(() => reloaded.load(guildId), /guild/);
    store.remove(guildId);
    assert.deepEqual(store.list(), []);
});

test('legacy migration rewinds the in-flight page and never trusts its oldest-message cursor', () => {
    const state = { ...base().state, scanned: 1, channelId: '2', before: '300', deleted: 4454 };
    const events = [{ ...state, before: '500' }, { ...state, before: '400' }, state,
        { ...state, runId: 'other-run', before: '350' }, { ...state, channelId: 'other', before: '350' }];
    const saved = migrateLegacyPurgeCheckpoint(state, events);
    assert.equal(saved.channels['2'].before, '400');
    assert.equal(saved.state.deleted, 4454);
    assert.equal(saved.state.runId, state.runId);
    assert.equal(migrateLegacyPurgeCheckpoint(state, []).channels['2'].before, undefined);
    assert.throws(() => migrateLegacyPurgeCheckpoint({ ...state, scanned: 2 }, events));
});

test('resume uses completed-page cursors, skips finished channels, and preserves run identity and counts', async t => {
    const { store } = storage(t);
    const saved = base();
    saved.channels = { '1': { done: true }, '2': { done: false, before: '400' } };
    Object.assign(saved.state, { before: '100', channelId: '2', deleted: 7, scanned: 2 });
    store.save(saved);
    const f = fixture([{ id: '500', author: target }, { id: '390', author: 'other' },
        { id: '380', author: target }, { id: '370', author: target }]);
    const events = [];
    const snapshots = [];
    const recording = { ...store, save: value => { snapshots.push(JSON.parse(JSON.stringify(value))); store.save(value); } };
    await createPurgeHandler(async () => {}, Date.now, (event, state) => events.push({ event, ...state }), 30000, recording)(f.msg);
    assert.deepEqual(f.fetched, ['400', '380', '370']);
    assert.deepEqual(f.inventory.map(item => item.id), ['500', '390']);
    assert.equal(events.at(-1).deleted, 9);
    assert.equal(events.at(-1).scanned, 2);
    assert.equal(events.at(-1).runId, 'saved-run');
    assert.equal(events[0].event, 'resumed');
    assert.match(f.replies[0], /resumed from its saved position/);
    assert.equal(snapshots.find(value => value.state.deleted === 8).channels['2'].before, '400');
    assert.deepEqual(store.list(), []);
});

test('startup recovery retries unavailable Discord, prevents duplicates, and does not replay completed jobs', async t => {
    const { store } = storage(t);
    const saved = base(); saved.channels['1'] = { done: true }; store.save(saved);
    const f = fixture();
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    const events = [];
    const purge = createPurgeHandler(async () => {}, Date.now, (event, state) => {
        events.push(event); if (event === 'finished') finish(state);
    }, 30000, store);
    await purge.resumePending({ guilds: { fetch: async () => { throw new Error('Offline'); } } });
    assert.equal(store.list().length, 1);
    assert.equal(purge.status()[0].phase, 'waiting_to_resume');
    await Promise.all([purge.resumePending(f.client), purge.resumePending(f.client)]);
    const final = await finished;
    assert.equal(final.deleted, 2);
    assert.equal(events.filter(event => event === 'resumed').length, 1);
    await purge.resumePending(f.client);
    assert.equal(events.filter(event => event === 'resumed').length, 1);
});

test('a saved purge cannot be overwritten by another allowed user or resumed for a removed user', async t => {
    const { store } = storage(t);
    store.save(base());
    const f = fixture();
    const purge = createPurgeHandler(async () => {}, Date.now, () => {}, 30000, store);
    await purge({ ...f.msg, author: { id: '354701063955152898' } });
    assert.match(f.replies[0], /Another user has a saved purge/);
    assert.equal(f.fetched.length, 0);
    const saved = base(); saved.state.userId = '111111111111111111'; store.save(saved);
    await purge.resumePending({ guilds: { fetch: () => { throw new Error('Must not fetch'); } } });
    assert.equal(store.load(guildId).state.userId, saved.state.userId);
    assert.equal(f.fetched.length, 0);
});

test('checkpoint failures stop further deletion and leave the previous cursor safe to replay', async t => {
    const { store } = storage(t);
    const f = fixture();
    const saved = base(); saved.channels['1'] = { done: true }; store.save(saved);
    const broken = { ...store, save: value => {
        if (value.state.deleted) throw new Error('Disk full');
        store.save(value);
    } };
    const events = [];
    await createPurgeHandler(async () => {}, Date.now, event => events.push(event), 30000, broken)(f.msg);
    assert.deepEqual(f.inventory.map(item => item.id), ['200']);
    assert.equal(store.load(guildId).channels['2'].before, undefined);
    assert.ok(events.includes('checkpoint_error'));
    await createPurgeHandler(async () => {}, Date.now, () => {}, 30000, store)(f.msg);
    assert.deepEqual(f.inventory, []);
    assert.deepEqual(store.list(), []);
});

test('an initial checkpoint failure prevents all history reads and deletes', async () => {
    const f = fixture();
    const broken = { load: () => undefined, list: () => [], save: () => { throw new Error('Disk full'); } };
    await createPurgeHandler(async () => {}, Date.now, () => {}, 30000, broken)(f.msg);
    assert.equal(f.fetched.length, 0);
    assert.equal(f.inventory.length, 2);
});

test('recovery does not resurrect a job completed while another guild lookup was pending', async t => {
    const { store } = storage(t);
    store.save(base());
    const other = base(); other.state.guildId = '991069801173237800'; store.save(other);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const fetched = [];
    const purge = createPurgeHandler(async () => {}, Date.now, () => {}, 30000, store);
    const recovery = purge.resumePending({ guilds: { fetch: async id => {
        fetched.push(id); await gate; throw new Error('Offline');
    } } });
    store.remove(other.state.guildId);
    release();
    await recovery;
    assert.deepEqual(fetched, [guildId]);
});

test('a killed process automatically resumes its unfinished page in a fresh process', { timeout: 10000 }, async t => {
    const { dir, store } = storage(t);
    const inventoryFile = join(dir, 'inventory.json');
    writeFileSync(inventoryFile, JSON.stringify(['300', '200', '100']));
    const launch = mode => {
        const child = spawn(process.execPath, ['tests/fixtures/purge-crash-worker.mjs', dir, mode],
            { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        child.stderr.on('data', chunk => process.stderr.write(chunk));
        t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
        return child;
    };
    const first = launch('interrupt');
    const [ready] = await once(first, 'message');
    assert.equal(ready.deleted, 1);
    const saved = store.load(guildId);
    assert.equal(saved.state.deleted, 1);
    assert.equal(saved.channels['2'].before, undefined);
    const exit = once(first, 'exit'); first.kill('SIGKILL'); await exit;
    const second = launch('resume');
    const [finished] = await once(second, 'message');
    assert.equal(finished.event, 'finished');
    assert.equal(finished.runId, saved.state.runId);
    assert.equal(finished.deleted, 2);
    assert.deepEqual(JSON.parse(readFileSync(inventoryFile, 'utf8')), ['100']);
    assert.deepEqual(store.list(), []);
    await once(second, 'exit');
});
