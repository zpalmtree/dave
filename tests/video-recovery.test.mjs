import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VideoBroker } from '../dist/VideoBroker.js';
import { approvedRecoveryContract, recoveryHash, repairVideoTiming, recoverySpeechMatches } from '../dist/VideoRecovery.js';
import { prepareRecoveryPlan } from '../dist/VideoRecoveryService.js';
import { FrontierPlannerRejectedError } from '../dist/VideoFrontierPlanner.js';

function plan(text = 'We made it home.') {
    return { intent: 'Two adult explorers return home.', continuity_bible: 'The same explorers.',
        prompt_analysis: { frontier_handling: { disposition: 'fulfill', reason_code: 'none' },
            dialogue_contract: { mode: 'verbatim', lines: [{ text, verbatim: true }] },
            subjects: ['two adult explorers'], actions: ['return home'] },
        keyframe: { recommended: true, prompt: 'Two explorers at home.' },
        segments: [{ title: 'Home', transition: 'start', target_seconds: 5,
            shots: [{ duration_seconds: 5, visual: 'Both explorers arrive home and wave.', camera: 'Wide',
                audio: 'Wind', dialogue: [{ speaker_id: 'explorer', language: 'English', delivery: 'natural', text }] }] }] };
}

test('timing repair preserves long dialogue, beat order, keyframe indexes, and is idempotent', () => {
    const text = Array.from({ length: 45 }, (_, i) => `word${i}`).join(' ');
    const value = plan(text);
    value.segments.push(structuredClone(plan('Welcome back.').segments[0]));
    value.segments[1].transition = 'cut';
    value.segment_keyframes = [{ segment_index: 2, prompt: 'Second scene' }];
    repairVideoTiming(value, 15, 5);
    const spoken = value.segments.flatMap(s => s.shots.flatMap(shot => shot.dialogue.map(line => line.text))).join(' ');
    assert.equal(spoken, `${text} Welcome back.`);
    assert.ok(value.segments.every(s => s.target_seconds <= 15));
    assert.equal(value.segment_keyframes[0].segment_index, value.segments.length);
    const before = structuredClone(value);
    repairVideoTiming(value, 15, 5);
    assert.deepEqual(value, before);
});

test('contract cannot approve omitted dialogue, bypassed quality, or policy rejection', () => {
    const value = plan();
    assert.doesNotThrow(() => approvedRecoveryContract(value, 'explorers return'));
    value.segments[0].shots[0].dialogue = [];
    assert.throws(() => approvedRecoveryContract(value, 'explorers return'), /dialogue/);
    value.prompt_analysis.frontier_handling.disposition = 'reject';
    assert.throws(() => approvedRecoveryContract(value, 'explorers return'), /approved story/);
    assert.throws(() => approvedRecoveryContract({ ...plan(), quality_gate_bypassed: true }, 'explorers'), /preserves/);
});

test('timing repair reserves speech time within a shot even when the whole segment has enough time', () => {
    const value = plan('Everything is fake, even the little war happening down by the feeder.');
    const speaking = value.segments[0].shots[0];
    speaking.duration_seconds = 2;
    value.segments[0].shots.unshift({ ...speaking, duration_seconds: 10, dialogue: [] });
    value.segments[0].target_seconds = 12;
    repairVideoTiming(value, 15, 5);
    const repaired = value.segments.flatMap(s => s.shots).find(s => s.dialogue.length);
    assert.ok(repaired.duration_seconds > 6);
    assert.equal(repaired.dialogue[0].text, speaking.dialogue[0].text);
    assert.equal(value.segments[1].transition, 'cut');
});

test('speech verification tolerates punctuation but rejects missing lines and silent audio', () => {
    assert.equal(recoverySpeechMatches('We made it home!', 'We made it home.'), true);
    assert.equal(recoverySpeechMatches('We made it home.', ''), false);
    assert.equal(recoverySpeechMatches('We made it home.', 'We made it.'), false);
    assert.equal(recoverySpeechMatches('', 'Invented speech'), false);
    assert.equal(recoverySpeechMatches('Just stop feeding the khat squirrels and wait for them to surrender.',
        'Just stop feeding the caught squirrels and wait for them to surrender.'), true);
});

test('speech verification accepts Spanish vowel accents without accepting missing or changed words', () => {
    const expected = 'mae Luis libereme, necesito cotizar mae, saqueme de aqui';
    const transcript = 'Mae, Luis, libéreme, necesito cotizar, mae, sáqueme de aquí.';
    assert.equal(recoverySpeechMatches(expected, transcript), true);
    assert.equal(recoverySpeechMatches(transcript, expected), true);
    assert.equal(recoverySpeechMatches(expected, transcript.normalize('NFD')), true);
    assert.equal(recoverySpeechMatches('Sí, está aquí.', 'Si, esta aqui.'), true);
    assert.equal(recoverySpeechMatches('El pingüino llegó.', 'El pinguino llego.'), true);
    assert.equal(recoverySpeechMatches(expected, 'Mae Luis libéreme'), false);
    assert.equal(recoverySpeechMatches(expected, 'Mae Luis'), false);
    assert.equal(recoverySpeechMatches(expected, ''), false);
    assert.equal(recoverySpeechMatches('Sáqueme de aquí.', 'Déjeme aquí.'), false);
    assert.equal(recoverySpeechMatches('Un año.', 'Un ano.'), false);
});

test('approved dialogue may add Spanish accents while preserving the authored text', () => {
    const value = plan('mae Luis libereme, necesito cotizar mae, saqueme de aqui');
    const text = 'Mae, Luis, libéreme, necesito cotizar, mae, sáqueme de aquí.';
    value.segments[0].shots[0].dialogue[0].text = text;
    const contract = approvedRecoveryContract(value, 'John pleads at the bars');
    assert.equal(contract.segments[0].shots[0].dialogue[0].text, text);
    assert.equal(value.segments[0].shots[0].dialogue[0].text, text);
});

test('timing repair fits several turns without packing an oversized split into the previous turn', () => {
    const value = plan('Please listen carefully while I explain what happened last night.');
    const long = Array.from({length: 70}, (_, index) => `word${index}`).join(' ');
    value.segments[0].shots[0].dialogue.push({speaker_id: 'other', text: long});
    const original = value.segments[0].shots[0].dialogue.map(line => line.text).join(' ');
    repairVideoTiming(value, 15, 5);
    assert.equal(value.segments.flatMap(s => s.shots.flatMap(shot => shot.dialogue.map(line => line.text))).join(' '), original);
    for (const segment of value.segments) {
        const turns = segment.shots.flatMap(shot => shot.dialogue);
        const words = turns.map(line => line.text).join(' ').split(/\s+/).length;
        assert.ok(words / (140 / 60) + turns.length * 0.3 + 1.25 <= segment.target_seconds);
    }
});

test('technical planning failure retries the same brief once; policy rejection first changes the brief', async () => {
    let calls = 0;
    await prepareRecoveryPlan({ prompt: 'explorers', model: 'minimax', requester: 'test', sources: [], options: {},
        planner: async prompt => { assert.equal(prompt, 'explorers'); if (++calls === 1) throw new Error('timeout'); return plan(); } });
    assert.equal(calls, 2);
    const prompts = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ status: 'completed', output_text: JSON.stringify({
        prompt: 'Two adult explorers share a friendly reunion.', notice: 'Adapted to a non-explicit reunion.', use_source_images: false,
    }) }), { status: 200, headers: { 'content-type': 'application/json' } });
    try {
        const result = await prepareRecoveryPlan({ prompt: 'A declined brief', model: 'minimax', requester: 'test', sources: [], options: {},
            planner: async prompt => { prompts.push(prompt); if (prompts.length === 1) throw new FrontierPlannerRejectedError('provider_policy', 'declined'); return plan(); } });
        assert.equal(prompts.length, 2);
        assert.notEqual(prompts[0], prompts[1]);
        assert.equal(result.contract.use_source_images, false);
        assert.match(result.notice, /Adapted/);
    } finally { globalThis.fetch = originalFetch; }
});

test('broker persists recovery and requires every scene review for the matching contract/output', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'video-recovery-'));
    const value = plan();
    const contract = approvedRecoveryContract(value, 'explorers return');
    const prepared = { plan: value, contract, contract_hash: recoveryHash(contract), prompt: contract.prompt, notice: 'Adapted to a friendly reunion.' };
    const broker = new VideoBroker({ host: '127.0.0.1', port: 0, dbPath: join(directory, 'queue.sqlite3'),
        resultsDir: join(directory, 'results'), botToken: 'bot', workerToken: 'worker',
        recoveryEnabled: true, preplanQueuedJobs: false, recoveryPlanner: async () => prepared,
        keyframeGenerator: async (scenePlan, _references, options) => {
            assert.equal(options.reviewPurpose, 'recovery-scene');
            assert.equal(scenePlan.recovery_request, contract.prompt);
            return { bytes: Buffer.from('fixture'), mimeType: 'image/png', provider: 'test', model: 'test' };
        },
        frontierPlanner: async () => { throw new Error('Legacy planning must not run before approval.'); },
        recoveryReviewer: async (_contract, _segment, body) => ({ acceptable: body.frames[0].endsWith('YQ=='), permitted: true, issues: [] }) });
    await broker.start();
    try {
        const submitted = await fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/jobs`, {
            method: 'POST', headers: { authorization: 'Bearer bot', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'minimax', prompt: 'explorers return', requester_id: '1', origin_bot_id: '2',
                channel_id: '3', command_message_id: '4', status_message_id: '5' }),
        });
        const response = await submitted.json();
        assert.equal(submitted.status, 201, JSON.stringify(response));
        const id = response.job.id;
        const initial = await fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/jobs/${id}/prepare`, {
            method: 'POST', headers: { authorization: 'Bearer bot', 'content-type': 'application/json' }, body: '{}',
        });
        assert.equal(initial.status, 200);
        let leased = false;
        broker.worker = { id: 'old-worker', currentJob: null, ready: true, capabilities: ['minimax'],
            recoveryVersion: 1, lastHeartbeat: Date.now(), scheduler: { available: false },
            socket: { send() { leased = true; }, close() {}, terminate() {} } };
        await broker.dispatchNext();
        assert.equal(leased, false, 'A storyboard-capable legacy worker must not receive new work');
        // Use a leased worker directly so these HTTP integration assertions don't
        // depend on websocket scheduling or real GPU availability.
        broker.worker = { id: 'test-worker', currentJob: id, leaseId: 'lease', ready: false,
            capabilities: ['minimax'], recoveryVersion: 2, lastHeartbeat: Date.now(),
            scheduler: { available: false }, socket: { send() {}, close() {}, terminate() {} } };
        await broker.run("UPDATE video_jobs SET status='running', worker_id='test-worker', lease_token='lease', recovery_version=2 WHERE public_id=?", [id]);
        const request = async (operation, body = {}) => {
            const result = await fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/worker/jobs/${id}/recovery/${operation}`, {
                method: 'POST', headers: { authorization: 'Bearer worker', 'content-type': 'application/json', 'x-video-lease-id': 'lease' },
                body: JSON.stringify({ contract_hash: prepared.contract_hash, ...body }),
            });
            return { status: result.status, body: await result.json() };
        };
        assert.equal((await request('plan')).status, 200);
        assert.equal((await request('image', { segment_index: 0 })).status, 200);
        assert.equal((await request('checkpoint', { checkpoint: { scenes: { '0': { video_attempts: 1 } } } })).status, 200);
        assert.equal((await request('plan')).body.checkpoint.scenes['0'].video_attempts, 1);
        const hash = 'a'.repeat(64), resultHash = 'b'.repeat(64);
        const quality = { format: 'generated', result_sha256: resultHash, artifacts: [{ sha256: hash }] };
        assert.equal((await request('quality', quality)).status, 503);
        assert.equal((await request('review', { segment_index: 0, kind: 'video', artifact_sha256: hash,
            frames: ['data:image/jpeg;base64,YQ=='] })).body.acceptable, true);
        assert.equal((await request('quality', quality)).status, 200);
        assert.equal((await request('quality', { ...quality, format: 'storyboard' })).status, 503);
        assert.equal((await request('review', { segment_index: 0, kind: 'storyboard', artifact_sha256: hash })).status, 503);
        assert.equal((await request('quality', { ...quality, contract_hash: 'c'.repeat(64) })).status, 409);
        await broker.run("UPDATE video_jobs SET result_path='result.mp4', result_sha256=? WHERE public_id=?", ['c'.repeat(64), id]);
        await assert.rejects(broker.handleWorkerMessage({ type: 'event', event: 'complete', job_id: id,
            lease_id: 'lease', runtime_seconds: 5 }), /exact output/);
        await broker.run("UPDATE video_jobs SET result_path='result.mp4', result_sha256=?, error='old error' WHERE public_id=?", [resultHash, id]);
        const notice = 'Adapted to a friendly reunion. An alternate video renderer recovered the scene.';
        await broker.handleWorkerMessage({ type: 'event', event: 'complete', job_id: id, lease_id: 'lease', runtime_seconds: 5, generation_notice: notice });
        const row = await broker.get('SELECT status,error FROM video_jobs WHERE public_id=?', [id]);
        assert.deepEqual(row, { status: 'ready', error: null });
        const stored = await broker.get('SELECT planner_json FROM video_jobs WHERE public_id=?', [id]);
        assert.equal(JSON.parse(stored.planner_json).generation_notice, notice);
        // A temporary service failure retains the same approved plan/checkpoint
        // and releases the worker, instead of delivering a terminal error.
        broker.worker.currentJob = id;
        await broker.run("UPDATE video_jobs SET status='running' WHERE public_id=?", [id]);
        await broker.handleWorkerMessage({ type: 'event', event: 'failed', job_id: id, lease_id: 'lease',
            error: 'review service unavailable', retryable: true });
        const deferred = await broker.get('SELECT status,error,recovery_next_at,recovery_json FROM video_jobs WHERE public_id=?', [id]);
        assert.equal(deferred.status, 'queued');
        assert.equal(deferred.error, null);
        assert.ok(deferred.recovery_next_at > Date.now() / 1000);
        assert.equal(JSON.parse(deferred.recovery_json).checkpoint.scenes['0'].video_attempts, 1);
        broker.worker = null;
        await broker.run("UPDATE video_jobs SET status='delivered', delivery_message_id='123456' WHERE public_id=?", [id]);
        const botRequest = async (endpoint, body) => fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/jobs/${id}/${endpoint}`, {
            method: 'POST', headers: { authorization: 'Bearer bot', 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        assert.equal((await botRequest('regenerate', { planner_guidance: 'Meximutt plays the explorer.' })).status, 200);
        const regenerated = await broker.get('SELECT status,delivery_message_id,delivery_revision,delivered_revision,recovery_json,planner_json,planner_guidance FROM video_jobs WHERE public_id=?', [id]);
        assert.deepEqual(regenerated, { status: 'queued', delivery_message_id: '123456', delivery_revision: 1,
            delivered_revision: 0, recovery_json: null, planner_json: null, planner_guidance: 'Meximutt plays the explorer.' });
        assert.equal((await botRequest('regenerate', {})).status, 409);
        await broker.run("UPDATE video_jobs SET status='ready' WHERE public_id=?", [id]);
        await botRequest('delivered', { revision: 0, message_id: '123456' });
        assert.equal((await broker.get('SELECT status FROM video_jobs WHERE public_id=?', [id])).status, 'ready');
        await botRequest('delivered', { revision: 1, message_id: '123456' });
        assert.deepEqual(await broker.get('SELECT status,delivered_revision,delivery_message_id FROM video_jobs WHERE public_id=?', [id]),
            { status: 'delivered', delivered_revision: 1, delivery_message_id: '123456' });
    } finally { broker.worker = null; await broker.stop(); rmSync(directory, { recursive: true, force: true }); }
});
