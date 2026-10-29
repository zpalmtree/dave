import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VideoGenerationService } from '../dist/VideoGeneration.js';

test('a regenerated video is posted as a new reply, leaving the earlier delivery alone, without duplicates', async () => {
    const service = new VideoGenerationService({ user: { id: 'bot' } });
    const job = { id: 'd8572423-test', model: 'minimax', prompt: 'A duck waves.', result_path: '/tmp/replacement.mp4',
        channel_id: 'channel', status_message_id: '100', command_message_id: '50',
        delivery_message_id: '123', delivery_revision: 1, delivered_revision: 0 };
    const earlier = { id: '123', content: 'Minimax video **d8572423** is ready.', author: { id: 'bot' },
        edit: () => assert.fail('The earlier delivery must keep its video') };
    let reply = null;
    const command = { reply: async payload => {
        reply = { id: '200', content: payload.content, author: { id: 'bot' }, payload };
        return reply;
    } };
    const channel = { isTextBased: () => true, messages: { fetch: async input => {
        if (input === '123') return earlier;
        if (input === '200' && reply) return reply;
        if (input === '50') return command;
        assert.deepEqual(input, { limit: 100 });
        return { find: predicate => [earlier, reply].filter(Boolean).find(predicate) };
    } }, send: () => assert.fail('The new delivery replies to the command') };
    assert.equal(await service.postDelivery(job, { channel }), reply);
    assert.equal(reply.payload.files[0].attachment, '/tmp/replacement.mp4');
    const first = reply;
    assert.equal(await service.postDelivery(job, { channel }), first, 'A lost acknowledgement does not post twice.');
    assert.equal(await service.postDelivery({ ...job, delivery_message_id: '200', delivered_revision: 1 }, { channel }), first);
    channel.messages.fetch = async () => { throw new Error('temporary Discord outage'); };
    await assert.rejects(service.postDelivery(job, { channel }), /temporary Discord outage/);
});

test('a ready video with a deleted progress message replies to the command and retries acknowledgement without duplicates', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'video-delivery-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const resultPath = join(directory, 'result.mp4');
    await writeFile(resultPath, 'test video');
    const job = { id: 'd8572423-test', status: 'ready', model: 'minimax', prompt: 'A duck waves.',
        channel_id: 'channel', status_message_id: 'deleted', command_message_id: 'command',
        result_path: resultPath, delivery_revision: 0, delivered_revision: 0 };
    let posted;
    let sends = 0;
    let acknowledgements = 0;
    let collectorStopped = false;
    let commandReplies = 0;
    const channel = {
        isTextBased: () => true,
        messages: { fetch: async input => {
            if (input === 'deleted') throw Object.assign(new Error('Unknown Message'), { code: 10008 });
            if (input === 'command') return { reply: async payload => {
                commandReplies++;
                return channel.send(payload);
            } };
            assert.deepEqual(input, { limit: 100 });
            return { find: predicate => posted && predicate(posted) ? posted : undefined };
        } },
        send: async payload => {
            sends++;
            assert.equal(payload.files[0].attachment, resultPath);
            assert.equal(payload.content, 'Video **d8572423** complete.');
            posted = { id: 'delivery', content: payload.content, author: { id: 'bot' } };
            return posted;
        },
    };
    const service = new VideoGenerationService({ user: { id: 'bot' }, channels: { fetch: async id => {
        assert.equal(id, 'channel');
        return channel;
    } } });
    service.acknowledge = async (deliveredJob, endpoint, duration, messageId) => {
        assert.equal(deliveredJob.id, job.id);
        assert.equal(endpoint, 'delivered');
        assert.equal(messageId, 'delivery');
        assert.ok(duration >= 0);
        if (++acknowledgements === 1) throw new Error('temporary broker outage');
    };
    service.cancellationCollectors.set(job.id, { ended: false, stop: () => { collectorStopped = true; } });
    service.rendered.set(job.id, 'old status');
    await assert.rejects(service.updateJob(job), /temporary broker outage/);
    await service.updateJob(job);
    assert.equal(sends, 1);
    assert.equal(commandReplies, 1);
    assert.equal(acknowledgements, 2);
    assert.equal(collectorStopped, true);
    assert.equal(service.rendered.has(job.id), false);
});

test('an unavailable delivery channel leaves the job unacknowledged for retry', async () => {
    const service = new VideoGenerationService({ user: { id: 'bot' }, channels: { fetch: async () => null } });
    service.acknowledge = () => assert.fail('Unavailable deliveries must not be acknowledged');
    await assert.rejects(service.postDelivery({ id: 'job', channel_id: 'missing' }, null), /delivery channel is unavailable/);
});

for (const content of ['Minimax video **d8572423** is ready.', 'Video **d8572423** complete.']) {
    test(`delivery retries recognize existing message: ${content}`, async () => {
        const service = new VideoGenerationService({ user: { id: 'bot' } });
        const existing = { id: '200', content, author: { id: 'bot' } };
        const job = { id: 'd8572423-test', status_message_id: '100' };
        const channel = { messages: { fetch: async () => ({ find: predicate => [
            { ...existing, id: '100' },
            { ...existing, author: { id: 'other-user' } },
            existing,
        ].find(predicate) }) } };
        assert.equal(await service.postDelivery(job, { channel }), existing);
    });
}

test('delivery falls back to the channel if the original command was deleted', async () => {
    const service = new VideoGenerationService({ user: { id: 'bot' } });
    const job = { id: 'd8572423-test', model: 'minimax', prompt: 'A duck waves.',
        result_path: '/tmp/result.mp4', command_message_id: 'deleted' };
    const sent = { id: '200' };
    const channel = { messages: { fetch: async input => {
        if (input === 'deleted') throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        return { find: () => undefined };
    } }, send: async payload => {
        assert.equal(payload.content, 'Video **d8572423** complete.');
        return sent;
    } };
    assert.equal(await service.postDelivery(job, { channel }), sent);
});
