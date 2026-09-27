import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VideoBroker } from '../dist/VideoBroker.js';
import { VideoKeyframeError } from '../dist/VideoKeyframeProvider.js';
import { approvedRecoveryContract, recoveryHash, VIDEO_RECOVERY_VERSION } from '../dist/VideoRecovery.js';
import { decodeContinuityImage, validateOpeningIdentityDecision } from '../dist/VideoCharacterContinuity.js';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=';

test('opening identity requires a usable bounded correction only on rejection', () => {
    for (const value of [null, {}, { acceptable: false, correction: '' },
        { acceptable: 'true', correction: '' }, { acceptable: true, correction: 'x'.repeat(1201) }]) {
        assert.throws(() => validateOpeningIdentityDecision(value));
    }
    assert.deepEqual(validateOpeningIdentityDecision({ acceptable: true, correction: 'ignored' }),
        { acceptable: true, correction: '' });
});

async function fixture(run, { generatedAnchor = false, outage = false } = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'opening-identity-'));
    const plan = { intent: 'An explorer enters a cartoon room.', continuity_bible: 'The same blonde explorer in a red coat.',
        keyframe: { recommended: true, prompt: 'Explorer by a lake' },
        prompt_analysis: { frontier_handling: { disposition: 'fulfill' }, dialogue_contract: { mode: 'none', lines: [] } },
        segments: Array.from({ length: 3 }, (_, index) => ({ title: 'Explorer', transition: index ? 'cut' : 'start',
            target_seconds: 5, music: 'N/A', shots: [{ visual: 'The explorer waves.', camera: 'Medium',
                audio: 'Wind', dialogue: [], duration_seconds: 5 }] })) };
    const contract = approvedRecoveryContract(plan, plan.intent);
    const prepared = { plan, contract, contract_hash: recoveryHash(contract), prompt: contract.prompt, notice: '' };
    const checks = [], generations = [];
    const broker = new VideoBroker({ host: '127.0.0.1', port: 0, dbPath: join(directory, 'queue.sqlite3'),
        resultsDir: join(directory, 'results'), botToken: 'bot', workerToken: 'worker',
        recoveryEnabled: true, preplanQueuedJobs: false, recoveryPlanner: async () => structuredClone(prepared),
        openingIdentityChecker: async (actualPlan, index, anchors, frame, hooks) => {
            checks.push(index);
            assert.equal(anchors.length, generatedAnchor ? 1 : 2);
            assert.equal(actualPlan.segments[index].transition, 'cut');
            assert.ok(frame.data.length);
            if (outage) throw new Error('Vision unavailable');
            await hooks.onUsage?.({ stage: 'opening_identity', attempt: 1, outcome: 'success',
                provider: 'google', model: 'gemini-3.8-flash', inputTokens: 2100, outputTokens: 100 });
            return checks.length === 2
                ? { acceptable: true, correction: '' }
                : { acceptable: false, correction: 'Restore the original human face and body, replacing the fox.' };
        },
        keyframeGenerator: async (actualPlan, references) => {
            generations.push({ actualPlan, references });
            throw new VideoKeyframeError('moderation', 'Use local composition');
        } });
    await broker.start();
    try {
        const base = `http://127.0.0.1:${broker.listeningPort()}`;
        const response = await fetch(`${base}/v1/jobs`, { method: 'POST',
            headers: { authorization: 'Bearer bot', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'minimax', prompt: contract.prompt, requester_id: '1', origin_bot_id: '2',
                channel_id: '3', command_message_id: '4', status_message_id: '5' }) });
        const id = (await response.json()).job.id;
        broker.worker = { id: 'worker', currentJob: id, leaseId: 'lease', ready: false,
            capabilities: ['minimax'], recoveryVersion: VIDEO_RECOVERY_VERSION, lastHeartbeat: Date.now(),
            scheduler: { available: false }, socket: { send() {}, close() {}, terminate() {} } };
        await broker.run("UPDATE video_jobs SET status='running', worker_id='worker', lease_token='lease', recovery_version=? WHERE public_id=?", [VIDEO_RECOVERY_VERSION, id]);
        if (!generatedAnchor) {
            const source = join(directory, 'original.png');
            writeFileSync(source, decodeContinuityImage(image).data);
            await broker.run("UPDATE video_jobs SET source_image_path=?, source_image_mime='image/png', source_image_composite_path=?, source_image_composite_mime='image/png' WHERE public_id=?", [source, source, id]);
        }
        const request = async (operation, body = {}) => {
            const response = await fetch(`${base}/v1/worker/jobs/${id}/recovery/${operation}`, { method: 'POST',
                headers: { authorization: 'Bearer worker', 'content-type': 'application/json', 'x-video-lease-id': 'lease' },
                body: JSON.stringify({ contract_hash: prepared.contract_hash,
                    ...(generatedAnchor ? { identity_anchor: image } : {}), ...body }) });
            return { status: response.status, body: await response.json() };
        };
        assert.equal((await request('plan')).status, 200);
        await run({ request, checks, generations, broker, id });
    } finally {
        broker.worker = null;
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
}

for (const generatedAnchor of [false, true]) test(`local opening guard caches decisions and shares one repair across scenes (${generatedAnchor ? 'generated' : 'uploaded'} identity)`, async () => {
    await fixture(async ({ request, checks, generations, broker, id }) => {
        const payload = { segment_index: 1, kind: 'image', artifact_sha256: 'a'.repeat(64), frame: image };
        assert.equal((await request('review', payload)).status, 503, 'Unrequested reviews cannot spend tokens.');
        const directive = await request('image', { segment_index: 1 });
        assert.equal(directive.body.opening_identity_required, true);
        assert.match(directive.body.keyframe.prompt, /Picture 1 defines the original/);
        assert.match(directive.body.keyframe.prompt, /same blonde explorer/);
        if (!generatedAnchor) {
            assert.match(directive.body.keyframe.prompt, /Picture 2 supplies scene context/);
            assert.equal(generations[0].references[1].label, 'Attached scene context');
        }
        // Legacy/previously reviewed artifacts and videos retain the recording-only route.
        assert.equal((await request('review', { segment_index: 0, kind: 'image', artifact_sha256: 'c'.repeat(64) })).status, 200);
        assert.equal((await request('review', { segment_index: 1, kind: 'video', artifact_sha256: 'd'.repeat(64) })).status, 200);
        assert.equal(checks.length, 0);
        const rejected = await request('review', payload);
        assert.equal(rejected.body.acceptable, false);
        assert.equal(rejected.body.repair_allowed, true);
        assert.deepEqual(await request('review', payload), rejected);
        assert.equal(checks.length, 1);
        const accepted = await request('review', { ...payload, artifact_sha256: 'b'.repeat(64) });
        assert.equal(accepted.body.acceptable, true);
        assert.deepEqual(await request('review', payload), rejected, 'Both candidate decisions survive, not just the last one.');
        assert.equal(checks.length, 2);
        await request('image', { segment_index: 2 });
        const next = await request('review', { ...payload, segment_index: 2 });
        assert.equal(next.body.acceptable, false);
        assert.equal(next.body.repair_allowed, false, 'Another scene cannot spend a second corrective image.');
        const saved = JSON.parse((await broker.get('SELECT recovery_json FROM video_jobs WHERE public_id=?', [id])).recovery_json);
        assert.equal(saved.opening_identity_calls[1], 2);
        assert.equal(saved.opening_identity_calls[2], 1);
        assert.equal(Object.keys(saved.opening_identity).length, 3);
        const usage = await broker.all('SELECT stage, attempt FROM video_usage_events WHERE job_public_id=? ORDER BY stage, attempt', [id]);
        assert.deepEqual(usage, [
            { stage: 'opening_identity_2', attempt: 1 }, { stage: 'opening_identity_2', attempt: 2 },
            { stage: 'opening_identity_3', attempt: 1 },
        ], 'Every billed call is recorded separately; cache hits add no usage.');
        assert.equal((await request('review', { ...payload, artifact_sha256: 'e'.repeat(64) })).status, 422);
        assert.equal(checks.length, 3, 'A third candidate cannot trigger a third call in one scene.');
    }, { generatedAnchor });
});

test('identity service outages preserve the candidate and cap billed calls across requests', async () => {
    await fixture(async ({ request, checks }) => {
        await request('image', { segment_index: 1 });
        const body = { segment_index: 1, kind: 'image', artifact_sha256: 'a'.repeat(64), frame: image };
        assert.equal((await request('review', body)).status, 503);
        assert.equal((await request('review', body)).status, 503);
        const stopped = await request('review', body);
        assert.equal(stopped.status, 422);
        assert.equal(stopped.body.pending, false);
        assert.equal(checks.length, 2);
    }, { outage: true });
});
