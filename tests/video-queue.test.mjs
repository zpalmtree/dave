import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
    formatGlobalVideoQueueJob,
    globalVideoQueueChunks,
    globalVideoQueueEmbeds,
    handleVideoQueue,
} from '../dist/VideoGeneration.js';

const discordJob = {
    id: '12345678-1234-1234-1234-123456789abc',
    model: 'minimax', prompt: 'A dog sings.', status: 'ready',
    requester_id: '354701063955152898', origin_bot_id: '446154284514541579',
    channel_id: '483470443001413675', guild_id: null,
    command_message_id: '483470443001413676', status_message_id: '483470443001413677',
    worker_online: true, estimate_low_seconds: 60, estimate_high_seconds: 120,
};
const internalJob = {
    ...discordJob, id: '2fbb5fa9-6a42-4568-9f4c-c7391a74bef5',
    requester_id: 'source-fidelity-review', origin_bot_id: 'source-fidelity-review',
    channel_id: 'source-fidelity-review', command_message_id: 'source-fidelity-review',
    status_message_id: 'source-fidelity-review', prompt: 'Internal review prompt.',
};

test('queue omits completed internal renders but preserves Discord delivery and active work', () => {
    assert.deepEqual(globalVideoQueueEmbeds([internalJob], null, 3900, true), []);
    assert.deepEqual(globalVideoQueueChunks([internalJob], null), ['The server video queue is empty.']);
    const embeds = globalVideoQueueEmbeds([internalJob, discordJob], null, 3900, true);
    assert.equal(embeds[0].title, 'Video queue · 1 job');
    assert.match(embeds[0].description, /Ready for delivery/);
    assert.match(embeds[0].description, /354701063955152898/);
    assert.doesNotMatch(embeds[0].description, /Internal review|Sending|unknown requester/);

    // A real requester alone does not give an internal render a delivery destination.
    for (const key of ['requester_id', 'origin_bot_id', 'channel_id', 'command_message_id', 'status_message_id']) {
        assert.deepEqual(globalVideoQueueEmbeds([{ ...discordJob, [key]: 'review' }], null), []);
    }
    for (const status of ['queued', 'planning', 'running', 'uploading']) {
        const active = globalVideoQueueEmbeds([{ ...internalJob, status }], null, 3900, true);
        assert.equal(active[0].title, 'Video queue · 1 job');
        assert.match(active[0].description, /internal job/);
    }
    assert.match(formatGlobalVideoQueueJob({ ...discordJob, status: 'uploading' }, null), /\*\*Sending\*\*/);
    for (const status of ['delivered', 'failed', 'cancelled']) {
        assert.deepEqual(globalVideoQueueEmbeds([{ ...discordJob, status }], null), []);
    }
});

test('queue command replies empty for internal results and counts mixed queues correctly', async t => {
    let jobs = [internalJob];
    const server = createServer((req, res) => {
        assert.equal(req.url, '/v1/queue');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jobs, state: { paused_until: null } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const previous = {
        VIDEO_BROKER_URL: process.env.VIDEO_BROKER_URL,
        VIDEO_BROKER_BOT_TOKEN: process.env.VIDEO_BROKER_BOT_TOKEN,
    };
    process.env.VIDEO_BROKER_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.VIDEO_BROKER_BOT_TOKEN = 'test-token';
    t.after(async () => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await new Promise(resolve => server.close(resolve));
    });
    const replies = [];
    const message = {
        channel: { id: '483470443001413675' }, author: { id: 'moderator' },
        member: { permissions: { has: () => true } },
        reply: async payload => replies.push(payload),
    };
    await handleVideoQueue(message, '');
    assert.deepEqual(replies, ['The server video queue is empty.']);
    replies.length = 0;
    jobs = [internalJob, discordJob];
    await handleVideoQueue(message, '');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].embeds[0].title, 'Video queue · 1 job');
    assert.match(replies[0].embeds[0].description, /Ready for delivery/);
    assert.doesNotMatch(replies[0].embeds[0].description, /Internal review/);
    assert.deepEqual(replies[0].allowedMentions, { parse: [], repliedUser: false });
});
