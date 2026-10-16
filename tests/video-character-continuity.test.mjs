import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VideoBroker } from '../dist/VideoBroker.js';
import { approvedRecoveryContract, recoveryHash, VIDEO_RECOVERY_VERSION } from '../dist/VideoRecovery.js';
import { checkVideoCharacterContinuity, decodeContinuityImage, validateContinuityDecision } from '../dist/VideoCharacterContinuity.js';
import { config } from '../dist/Config.js';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=';

test('continuity leaves room for reasoning and JSON, and rejects incomplete provider decisions', async () => {
    const originalFetch = globalThis.fetch, originalKey = config.geminiApiKey;
    const requests = [], budgets = [], usage = [], attempts = [];
    const decision = { action: 'continue', identity_description: 'Same man in the flag shirt.',
        reason: 'The face and brown irises match.', restore_face: false };
    let finishReason = 'STOP';
    let answer = JSON.stringify(decision);
    config.geminiApiKey = 'test-key';
    globalThis.fetch = async (_url, options) => {
        const request = JSON.parse(options.body);
        requests.push(request);
        // a53dbc37 used 1962 reasoning tokens and returned only 69 answer tokens.
        const fits = request.generationConfig.maxOutputTokens >= 1962 + 1200;
        return new Response(JSON.stringify({ candidates: [{ finishReason: fits ? finishReason : 'MAX_TOKENS',
            content: { role: 'model', parts: [{ text: fits ? answer : '{"action":"continue","identity_description":"' }] } }],
            usageMetadata: { promptTokenCount: 4139, thoughtsTokenCount: 1962, candidatesTokenCount: fits ? 1200 : 69 },
        }), { headers: { 'content-type': 'application/json' } });
    };
    const run = () => checkVideoCharacterContinuity({ segments: [{}, {}] }, 1,
        [decodeContinuityImage(image)], decodeContinuityImage(image), {
            beforeRequest: value => budgets.push(value), onUsage: value => usage.push(value),
            onAttempt: value => attempts.push(value),
        });
    try {
        assert.deepEqual(await run(), decision);
        assert.equal(requests[0].generationConfig.thinkingConfig.thinkingLevel, 'LOW');
        assert.equal(budgets[0].maxOutputTokens, requests[0].generationConfig.maxOutputTokens);
        assert.equal(usage[0].outcome, 'success');
        finishReason = 'MAX_TOKENS';
        // Even syntactically valid JSON must not hide an incomplete generation.
        await assert.rejects(run(), /incomplete decision \(MAX_TOKENS; 1962 thinking tokens/);
        assert.equal(usage[1].outcome, 'error');
        assert.equal(usage[1].outputTokens, 3162);
        assert.match(attempts[1].detail, /MAX_TOKENS/);
        finishReason = 'STOP';
        answer = '{"action":"continue","identity_description":"';
        await assert.rejects(run(), SyntaxError);
        assert.equal(usage[2].outcome, 'error');
        assert.equal(attempts[2].outcome, 'error');
        assert.equal(requests.length, 3, 'No hidden retry loop or acceptance of broken JSON.');
    } finally {
        globalThis.fetch = originalFetch;
        config.geminiApiKey = originalKey;
    }
});

test('continuity decisions reject missing identity, invalid actions, and unbounded images', () => {
    assert.throws(() => validateContinuityDecision({ action: 'reanchor', reason: 'Hidden', identity_description: '' }));
    assert.throws(() => validateContinuityDecision({ action: 'approve', reason: 'Good', identity_description: 'Duck' }));
    assert.throws(() => validateContinuityDecision(null));
    assert.equal(validateContinuityDecision({ action: 'continue', reason: 'No recurring cast', identity_description: '' }).action, 'continue');
    assert.equal(decodeContinuityImage(image).mimeType, 'image/png');
    for (const invalid of [null, 'https://example.com/image.png', 'data:image/png;base64,?', 'x'.repeat(6 * 1024 * 1024 + 1)]) {
        assert.throws(() => decodeContinuityImage(invalid));
    }
});

for (const hasSource of [true, false]) test(`boundary recovery preserves ${hasSource ? 'uploaded' : 'generated'} identity and caches checks`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'video-continuity-'));
    const segment = (visual, transition) => ({ transition, title: 'Explorer', target_seconds: 5,
        music: 'N/A', shots: [{ visual, camera: 'Medium', audio: 'Wind', dialogue: [], duration_seconds: 5 }] });
    const plan = { intent: 'An explorer returns from fog.', continuity_bible: 'The same blonde explorer in a red coat.',
        keyframe: { recommended: false, prompt: 'Explorer by a lake' },
        prompt_analysis: { frontier_handling: { disposition: 'fulfill' }, dialogue_contract: { mode: 'none', lines: [] } },
        segments: [segment('The explorer disappears into fog.', 'start'), segment('The explorer emerges from fog and waves.', 'continue')] };
    const contract = approvedRecoveryContract(plan, 'explorer returns');
    const prepared = { plan, contract, contract_hash: recoveryHash(contract), prompt: contract.prompt, notice: '' };
    let calls = 0;
    let fail = false;
    let generated;
    let drifted = false;
    let refuse = false;
    let restores = 0;
    const broker = new VideoBroker({ host: '127.0.0.1', port: 0, dbPath: join(directory, 'queue.sqlite3'),
        resultsDir: join(directory, 'results'), botToken: 'bot', workerToken: 'worker',
        recoveryEnabled: true, preplanQueuedJobs: false, recoveryPlanner: async () => structuredClone(prepared),
        characterContinuityChecker: async (actualPlan, index, anchors, frame) => {
            calls++;
            if (fail) throw new Error('Vision temporarily unavailable');
            assert.equal(index, 1);
            assert.equal(actualPlan.segments[1].transition, 'continue');
            assert.equal(anchors.length, 1);
            assert.deepEqual(anchors[0].data, decodeContinuityImage(image).data);
            assert.ok(frame.data.length);
            return drifted ? { action: 'continue', identity_description: 'Same blonde explorer.', reason: 'Eyes shut mid-blink.', restore_face: true }
                : { action: 'reanchor', identity_description: 'Same blonde explorer, narrow face and red coat.', reason: 'Only fog is visible.' };
        },
        continuityRestoreGenerator: async (frame, original, identity) => {
            restores++;
            if (refuse) throw new Error('The image provider declined.');
            assert.deepEqual(original.bytes, decodeContinuityImage(image).data);
            assert.match(identity, /blonde explorer/);
            return { bytes: decodeContinuityImage(image).data, mimeType: 'image/png', provider: 'test', model: 'test' };
        },
        keyframeGenerator: async (actualPlan, references) => {
            generated = { plan: actualPlan, references };
            return { bytes: decodeContinuityImage(image).data, mimeType: 'image/png', provider: 'test', model: 'test' };
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
        if (hasSource) {
            const source = join(directory, 'original.png');
            writeFileSync(source, decodeContinuityImage(image).data);
            await broker.run("UPDATE video_jobs SET source_image_path=?, source_image_mime='image/png' WHERE public_id=?", [source, id]);
        }
        const request = async (operation, body = {}) => {
            const response = await fetch(`${base}/v1/worker/jobs/${id}/recovery/${operation}`, { method: 'POST',
                headers: { authorization: 'Bearer worker', 'content-type': 'application/json', 'x-video-lease-id': 'lease' },
                body: JSON.stringify({ contract_hash: prepared.contract_hash, ...body }) });
            return { status: response.status, body: await response.json() };
        };
        assert.equal((await request('plan')).status, 200);
        const payload = { segment_index: 1, frame: image, ...(!hasSource ? { identity_anchor: image } : {}) };
        assert.equal((await request('continuity', { ...payload, segment_index: 0 })).status, 503);
        assert.equal((await request('continuity', { ...payload, contract_hash: 'wrong' })).status, 409);
        assert.equal(calls, 0);
        const checked = await request('continuity', payload);
        assert.equal(checked.status, 200);
        assert.equal(checked.body.action, 'reanchor');
        assert.deepEqual((await request('continuity', payload)).body, checked.body);
        assert.equal(calls, 1, 'Identical boundary check is persisted and reused.');
        assert.equal((await request('image', { segment_index: 1, ...(!hasSource ? { identity_anchor: image } : {}) })).status, 200);
        assert.equal(generated.references.length, 1);
        assert.deepEqual(generated.references[0].bytes, decodeContinuityImage(image).data);
        assert.match(generated.plan.keyframe.prompt, /Same blonde explorer/);
        assert.match(generated.plan.keyframe.prompt, /earliest recognizable instant/);
        // Different frame content invalidates the decision; outages never approve it.
        fail = true;
        const nextFrame = 'data:image/png;base64,' + Buffer.concat([decodeContinuityImage(image).data, Buffer.from('different')]).toString('base64');
        assert.equal((await request('continuity', { ...payload, frame: nextFrame })).status, 503);
        assert.equal(calls, 2);
        assert.deepEqual((await request('continuity', payload)).body, checked.body);
        assert.equal(calls, 2);
        assert.equal(restores, 0, 'A reanchor never asks for a restored face.');
        // A recognizable but drifted face comes back redrawn from the original, once.
        fail = false;
        drifted = true;
        const frames = [1, 2].map(n => 'data:image/png;base64,' + Buffer.concat([decodeContinuityImage(image).data, Buffer.from(`drift${n}`)]).toString('base64'));
        const restored = await request('continuity', { ...payload, frame: frames[0] });
        assert.equal(restored.body.action, 'continue');
        assert.equal(restored.body.restored_frame, image);
        assert.deepEqual((await request('continuity', { ...payload, frame: frames[0] })).body, restored.body);
        assert.equal(restores, 1);
        // A refused redraw continues on the rendered frame and is not billed again.
        refuse = true;
        const declined = await request('continuity', { ...payload, frame: frames[1] });
        assert.equal(declined.status, 200);
        assert.equal(declined.body.action, 'continue');
        assert.equal(declined.body.restored_frame, undefined);
        assert.equal((await request('continuity', { ...payload, frame: frames[1] })).body.restored_frame, undefined);
        assert.equal(restores, 2);
    } finally {
        broker.worker = null;
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});
