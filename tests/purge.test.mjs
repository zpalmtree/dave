import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, Collection, PermissionFlagsBits } from 'discord.js';
import { createPurgeHandler } from '../dist/Purge.js';

const target = '882322615346270268';
const collection = values => new Collection(values.map(value => [value.id, value]));
const handler = () => createPurgeHandler(async () => {});

function channel(id, pages = [], permitted = true) {
    const requests = [];
    return {
        id, type: ChannelType.GuildText, requests,
        isTextBased: () => true,
        isThread: () => false,
        permissionsFor: () => ({ has: () => permitted }),
        messages: { fetch: async options => {
            requests.push(options);
            const page = pages.shift();
            if (page instanceof Error) throw page;
            return collection(page ?? []);
        } },
    };
}

function message(id, author, deleted, fails = false) {
    return { id, author: { id: author }, delete: async () => {
        if (fails) throw new Error('Deletion forbidden');
        deleted.push(id);
    } };
}

function invocation(channels, { user = target, active = [], guildId = 'guild' } = {}) {
    return {
        author: { id: user }, channel: channels[0],
        replies: [], edits: [],
        async reply(payload) {
            this.replies.push(payload.content);
            return { edit: async payload => { this.edits.push(payload.content); } };
        },
        guild: {
            id: guildId, members: { me: {} },
            channels: {
                fetch: async () => collection(channels),
                fetchActiveThreads: async () => ({ threads: collection(active) }),
            },
        },
    };
}

test('new authorized user purges only their own messages across channels and all history pages', async () => {
    const deleted = [];
    const first = channel('first', [
        [message('200', target, deleted), message('150', 'someone-else', deleted)],
        [message('100', target, deleted)],
    ]);
    const second = channel('second', [[message('300', target, deleted)]]);
    await handler()(invocation([first, second]));
    assert.deepEqual(deleted, ['200', '100', '300']);
    assert.deepEqual(first.requests.map(r => r.before), [undefined, '150', '100']);
    assert.equal(first.requests[0].limit, 100);
});

test('unauthorized users and DMs never fetch or delete anything; existing authorized users still work', async () => {
    const room = channel('room');
    await handler()(invocation([room], { user: 'not-allowed' }));
    await handler()({ ...invocation([room]), guild: null });
    assert.equal(room.requests.length, 0);
    for (const user of ['354701063955152898', '901540415176597534', '1231731968064880692']) {
        await handler()(invocation([room], { user }));
    }
    assert.equal(room.requests.length, 3);
});

test('skips inaccessible channels and continues after fetch and deletion failures', async () => {
    const deleted = [];
    const hidden = channel('hidden', [[message('500', target, deleted)]], false);
    const broken = channel('broken', [[message('400', target, deleted)], new Error('Lost access')]);
    const working = channel('working', [[message('300', target, deleted, true), message('200', target, deleted)]]);
    await handler()(invocation([hidden, broken, working]));
    assert.equal(hidden.requests.length, 0);
    assert.equal(broken.requests.length, 2);
    assert.deepEqual(deleted, ['400', '200']);
});

test('scans active, paginated archived public/private threads and forum posts once', async () => {
    const deleted = [];
    const thread = (id, timestamp) => Object.assign(
        channel(id, [[message(String(Number(id) + 1000), target, deleted)]]),
        { archiveTimestamp: timestamp, isThread: () => true },
    );
    const active = thread('10', 400);
    const publicOne = thread('20', 300);
    const publicTwo = thread('30', 200);
    const privateOne = thread('40', 100);
    const room = channel('room');
    const requests = [];
    room.threads = { fetchArchived: async options => {
        requests.push(options);
        if (options.type === 'private') return { threads: collection([privateOne]), hasMore: false };
        return options.before
            ? { threads: collection([publicTwo]), hasMore: false }
            : { threads: collection([active, publicOne]), hasMore: true };
    } };
    const forumPost = thread('50', 100);
    const forum = { ...channel('forum'), type: ChannelType.GuildForum, isTextBased: () => false,
        threads: { fetchArchived: async options => {
            assert.equal(options.type, 'public');
            return { threads: collection([forumPost]), hasMore: false };
        } },
    };
    await handler()(invocation([room, forum], { active: [active] }));
    assert.deepEqual(deleted, ['1010', '1020', '1030', '1040', '1050']);
    assert.equal(requests[1].before.getTime(), 300);
    assert.equal(requests[2].fetchAll, true);
    assert.equal(active.requests.length, 2);
});

test('uses joined private archives and snowflake cursors without ManageThreads', async () => {
    const room = channel('room');
    room.permissionsFor = () => ({ has: flags => flags !== PermissionFlagsBits.ManageThreads });
    const thread = Object.assign(channel('20'), { archiveTimestamp: 100 });
    const requests = [];
    room.threads = { fetchArchived: async options => {
        requests.push(options);
        return options.type === 'private' && !options.before
            ? { threads: collection([thread]), hasMore: true }
            : { threads: collection([]), hasMore: false };
    } };
    await handler()(invocation([room]));
    assert.equal(requests[1].fetchAll, false);
    assert.equal(requests[2].before, '20');
});

test('blocks overlapping guild purges and releases the guard after a listing failure', async () => {
    const purge = handler();
    const msg = invocation([channel('room')]);
    let release;
    let calls = 0;
    msg.guild.channels.fetch = () => {
        calls++;
        return new Promise((_, reject) => { release = () => reject(new Error('Guild unavailable')); });
    };
    const running = purge(msg);
    await new Promise(resolve => setImmediate(resolve));
    await purge(msg);
    assert.equal(calls, 1);
    release();
    await running;
    msg.guild.channels.fetch = async () => { calls++; return collection([]); };
    await purge(msg);
    assert.equal(calls, 2);
});

test('continues regular channels when thread discovery fails and stops nonadvancing history', async () => {
    const deleted = [];
    const entry = message('10', target, deleted);
    const room = channel('room', [[entry], [entry]]);
    room.threads = { fetchArchived: async () => { throw new Error('Forbidden'); } };
    const msg = invocation([room]);
    msg.guild.channels.fetchActiveThreads = async () => { throw new Error('Forbidden'); };
    await handler()(msg);
    assert.deepEqual(deleted, ['10']);
    assert.equal(room.requests.length, 2);
});

test('acknowledges first, starts in the invoking channel, updates progress, and reports completion', async () => {
    const deleted = [];
    const other = channel('other', [[message('300', target, deleted)]]);
    const current = channel('current', [[message('200', target, deleted)]]);
    const msg = invocation([other, current]);
    msg.channel = current;
    const fetch = current.messages.fetch;
    current.messages.fetch = options => {
        assert.match(msg.replies[0], /Purge started/);
        assert.equal(other.requests.length, 0);
        return fetch(options);
    };
    let time = 0;
    await createPurgeHandler(async () => { time += 16000; }, () => time)(msg);
    assert.deepEqual(deleted, ['200', '300']);
    assert.equal(current.requests.length, 2);
    assert.ok(msg.edits.some(text => text.startsWith('Purge is running.')));
    assert.match(msg.edits.at(-1), /Purge finished\. 2 messages deleted; 2 channels\/threads checked/);
});

test('status and invalid arguments never start a purge', async () => {
    const room = channel('room');
    const msg = invocation([room]);
    const purge = handler();
    await purge(msg, ' STATUS ');
    await purge(msg, 'anything-else');
    assert.equal(room.requests.length, 0);
    assert.equal(msg.replies[0], 'No purge is running in this server.');
    assert.match(msg.replies[1], /no arguments/);
});

test('status and repeat invocations report an active purge without starting another', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const purge = createPurgeHandler(() => gate);
    const deleted = [];
    const msg = invocation([channel('room', [[message('100', target, deleted)]])]);
    const running = purge(msg);
    await new Promise(resolve => setImmediate(resolve));
    await purge(msg, 'status');
    await purge(msg);
    assert.match(msg.replies[1], /Purge is running\. 0 messages deleted/);
    assert.match(msg.replies[2], /already running/);
    assert.equal(msg.channel.requests.length, 1);
    release();
    await running;
    assert.deepEqual(deleted, ['100']);
});

test('reports permission skips and individual deletion errors accurately', async () => {
    const deleted = [];
    const msg = invocation([
        channel('hidden', [], false),
        channel('room', [[message('200', target, deleted, true), message('100', target, deleted)]]),
    ]);
    await handler()(msg);
    assert.match(msg.edits.at(-1), /1 messages deleted; 1 channels\/threads checked; 1 skipped for missing permissions; 1 errors/);
});

test('failed acknowledgments and progress edits do not stop deletion or strand the lock', async () => {
    const deleted = [];
    const msg = invocation([channel('room', [[message('100', target, deleted)]])]);
    msg.reply = async () => { throw new Error('Cannot send'); };
    const purge = handler();
    await purge(msg);
    msg.channel.messages.fetch = async () => collection([]);
    msg.reply = async () => ({ edit: async () => { throw new Error('Cannot edit'); } });
    await purge(msg);
    assert.deepEqual(deleted, ['100']);
    const check = invocation([channel('room')]);
    await purge(check, 'status');
    assert.equal(check.replies[0], 'No purge is running in this server.');
});
