import assert from 'node:assert/strict';
import test from 'node:test';
import { VideoGenerationService } from '../dist/VideoGeneration.js';

test('regeneration replaces the original message attachment and retries lookup outages without posting duplicates', async () => {
    const service = new VideoGenerationService({ user: { id: 'bot' } });
    const job = { id: 'd8572423-test', model: 'minimax', prompt: 'A duck waves.', result_path: '/tmp/replacement.mp4',
        delivery_message_id: '123', delivery_revision: 1, delivered_revision: 0 };
    let edited;
    const existing = { edit: async payload => { edited = payload; return existing; } };
    const channel = { messages: { fetch: async id => { assert.equal(id, '123'); return existing; } },
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
