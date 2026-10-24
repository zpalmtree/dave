import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { VideoBroker } from '../dist/VideoBroker.js';
import { VideoKeyframeError } from '../dist/VideoKeyframeProvider.js';
import { VideoUsagePersistenceError } from '../dist/VideoUsage.js';
import { VIDEO_IMAGE_ONLY_AUTO_PROMPT } from '../dist/VideoProtocol.js';

const portrait = Buffer.from('original-meximutt');
const scene = Buffer.from('meximutt-at-the-checkout');

async function fixture(t, generator, recoveryEnabled = false) {
    const directory = mkdtempSync(join(tmpdir(), 'oalgo-scene-broker-'));
    const plannedSources = [];
    const broker = new VideoBroker({ host: '127.0.0.1', port: 0,
        dbPath: join(directory, 'queue.sqlite3'), resultsDir: join(directory, 'results'),
        botToken: 'bot', workerToken: 'worker', preplanQueuedJobs: false, recoveryEnabled,
        sourceImageDownloader: async (_descriptor, target) => {
            mkdirSync(target, { recursive: true });
            const path = join(target, 'source.png'); writeFileSync(path, portrait);
            return { path, mimeType: 'image/png', bytes: portrait.length };
        },
        keyframeGenerator: generator,
        frontierPlanner: async (_prompt, _model, _requester, source) => {
            plannedSources.push(source.data);
            return { keyframe: { recommended: false }, segments: [] };
        },
        recoveryPlanner: async input => {
            assert.equal(input.requireOriginalFirstFrame, true);
            plannedSources.push(input.sources[0].data);
            return { plan: { keyframe: { recommended: false }, segments: [] }, contract: { analysis: {} }, notice: '' };
        },
    });
    await broker.start();
    t.after(async () => { await broker.stop(); rmSync(directory, { recursive: true, force: true }); });
    let sequence = 0;
    const submit = async (overrides = {}) => {
        const response = await fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/jobs`, {
            method: 'POST', headers: { authorization: 'Bearer bot', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'minimax', command_variant: 'oalgo', prompt: 'argues with a cashier',
                source_image: { preset: 'oalgo' }, source_image_scene: true,
                requester_id: 'user', is_admin: true, origin_bot_id: 'bot', channel_id: 'channel',
                command_message_id: `command-${++sequence}`, status_message_id: 'status', ...overrides }),
        });
        return { status: response.status, body: await response.json() };
    };
    return { broker, submit, plannedSources };
}

for (const recovery of [false, true]) test(`scene opening becomes frame zero with recovery=${recovery}`, async t => {
    let calls = 0;
    const { broker, submit, plannedSources } = await fixture(t, async (plan, references, options) => {
        calls++;
        assert.equal(plan.intent, 'argues with a cashier');
        assert.deepEqual(references.map(ref => ref.bytes), [portrait]);
        assert.equal(options.requireIdentityPreservation, true);
        assert.equal(options.reviewPurpose, 'character-opening');
        return { bytes: scene, mimeType: 'image/png', provider: 'test', model: 'test', reviewStatus: 'accepted' };
    }, recovery);
    const submitted = await submit();
    assert.equal(submitted.status, 201);
    const job = await broker.get('SELECT * FROM video_jobs WHERE public_id=?', [submitted.body.job.id]);
    assert.equal(job.source_image_composition, 'generated');
    assert.deepEqual(readFileSync(job.source_image_path), scene);
    // Preserve the original file for fallback/diagnostics; don't overwrite it.
    assert.deepEqual(readFileSync(join(broker.options.resultsDir, job.public_id, 'source.png')), portrait);
    if (recovery) await broker.prepareRecoveryJob(job, false);
    else await broker.ensurePlan(job);
    assert.deepEqual(plannedSources, [scene]);
    const duplicate = await submit({ command_message_id: 'command-1' });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(calls, 1, 'A repeated submission reuses the saved opening.');
});

for (const failure of [
    new VideoKeyframeError('identity_review', 'Changed face'),
    new VideoKeyframeError('review_unavailable', 'Review unavailable'),
    new VideoKeyframeError('timeout', 'Timed out'),
    new VideoKeyframeError('moderation', 'Declined'),
    new Error('Provider unavailable'),
    'best_effort', 'unreviewed', 'empty-image',
]) test(`scene opening falls back to the portrait: ${failure.message || failure}`, async t => {
    t.mock.method(console, 'warn', () => {});
    const { broker, submit } = await fixture(t, async () => {
        if (failure instanceof Error) throw failure;
        return { bytes: failure === 'empty-image' ? Buffer.alloc(0) : scene, mimeType: 'image/png',
            provider: 'test', model: 'test', reviewStatus: failure === 'empty-image' ? 'accepted' : failure };
    });
    const result = await submit();
    assert.equal(result.status, 201);
    const job = await broker.get('SELECT * FROM video_jobs WHERE public_id=?', [result.body.job.id]);
    assert.deepEqual(readFileSync(job.source_image_path), portrait);
    assert.equal(job.source_image_composition, null);
    const attempts = await broker.all("SELECT * FROM video_provider_attempt_metrics WHERE stage='scene_opening_fallback'");
    assert.equal(attempts.length, 1);
});

test('scene opening accounting failures are not hidden by portrait fallback', async t => {
    const { broker, submit } = await fixture(t, async () => { throw new VideoUsagePersistenceError('Accounting failed'); });
    assert.equal((await submit()).status, 400);
    assert.equal((await broker.all('SELECT * FROM video_jobs')).length, 0);
});

test('scene openings are restricted to text-only OALGO and preserve legacy requests', async t => {
    let calls = 0;
    const { submit } = await fixture(t, async () => { calls++; throw new Error('Unexpected generator'); });
    const attachment = { url: 'https://cdn.discordapp.com/attachments/1/2/scene.png', mime_type: 'image/png', bytes: 20 };
    for (const overrides of [
        { source_image: attachment },
        { source_image_composite: attachment },
        { source_image: { preset: 'argenmutt' }, command_variant: 'argenmutt' },
        { source_image_scene: 'true' },
        { prompt: VIDEO_IMAGE_ONLY_AUTO_PROMPT },
        { source_audio: { url: 'https://cdn.discordapp.com/attachments/1/2/song.wav', mime_type: 'audio/wav', bytes: 20, name: 'song.wav' } },
    ]) assert.equal((await submit(overrides)).status, 400);
    assert.equal((await submit({ source_image_scene: false })).status, 201);
    assert.equal((await submit({ source_image_scene: undefined })).status, 201);
    assert.equal(calls, 0);
});
