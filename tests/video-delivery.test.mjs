import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VideoGenerationService } from '../dist/VideoGeneration.js';

test('regeneration replaces the original message attachment and retries lookup outages without posting duplicates', async () => {
    const service = new VideoGenerationService({ user: { id: 'bot' } });
    const job = { id: 'd8572423-test', model: 'minimax', prompt: 'A duck waves.', result_path: '/tmp/replacement.mp4',
        delivery_message_id: '123', delivery_revision: 1, delivered_revision: 0 };
    let edited;
    const existing = { edit: async payload => { edited = payload; return existing; } };
    const channel = { isTextBased: () => true, messages: { fetch: async id => { assert.equal(id, '123'); return existing; } },
        send: () => assert.fail('Replacement must edit the existing message') };
    assert.equal(await service.postDelivery(job, { channel }), existing);
    assert.deepEqual(edited.attachments, []);
    assert.equal(edited.files[0].attachment, '/tmp/replacement.mp4');
    assert.deepEqual(edited.allowedMentions, { parse: [] });
    edited = null;
    await service.postDelivery({ ...job, delivered_revision: 1 }, { channel });
    assert.equal(edited, null);
    channel.messages.fetch = async () => { throw new Error('temporary Discord outage'); };
    await assert.rejects(service.postDelivery(job, { channel }), /temporary Discord outage/);
});

test('a ready video with a deleted progress message posts without a reply and retries acknowledgement without duplicates', async t => {
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
    const channel = {
        isTextBased: () => true,
        messages: { fetch: async input => {
            if (input === 'deleted') throw Object.assign(new Error('Unknown Message'), { code: 10008 });
            assert.deepEqual(input, { limit: 100 }, 'Must not fetch the command to reply');
            return { find: predicate => posted && predicate(posted) ? posted : undefined };
        } },
        send: async payload => {
            sends++;
            assert.equal(payload.files[0].attachment, resultPath);
            assert.equal(payload.reply, undefined);
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
    assert.equal(acknowledgements, 2);
    assert.equal(collectorStopped, true);
    assert.equal(service.rendered.has(job.id), false);
});

test('an unavailable delivery channel leaves the job unacknowledged for retry', async () => {
    const service = new VideoGenerationService({ user: { id: 'bot' }, channels: { fetch: async () => null } });
    service.acknowledge = () => assert.fail('Unavailable deliveries must not be acknowledged');
    await assert.rejects(service.postDelivery({ id: 'job', channel_id: 'missing' }, null), /delivery channel is unavailable/);
});
