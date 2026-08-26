import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import {
    VideoBroker,
    duplicateVideoTerminalEventMatches,
    videoFailureDisposition,
} from '../dist/VideoBroker.js';
import { FrontierPlannerRejectedError } from '../dist/VideoFrontierPlanner.js';

function socketInbox(socket) {
    const queue = [];
    const waiters = [];
    socket.on('message', raw => {
        const value = JSON.parse(raw.toString());
        const index = waiters.findIndex(waiter => waiter.predicate(value));
        if (index >= 0) {
            const [waiter] = waiters.splice(index, 1);
            clearTimeout(waiter.timeout);
            waiter.resolve(value);
        } else {
            queue.push(value);
        }
    });
    return (predicate, timeoutMs = 2000) => {
        const index = queue.findIndex(predicate);
        if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
        return new Promise((resolve, reject) => {
            const waiter = { predicate, resolve, reject, timeout: null };
            waiter.timeout = setTimeout(() => {
                const pending = waiters.indexOf(waiter);
                if (pending >= 0) waiters.splice(pending, 1);
                reject(new Error('Timed out waiting for WebSocket message.'));
            }, timeoutMs);
            waiters.push(waiter);
        });
    };
}

test('video failure policy waits on readiness and suppresses identical render retries', () => {
    assert.equal(
        videoFailureDisposition('Timed out waiting for ComfyUI readiness.', true, 0, 0, null),
        'wait-readiness',
    );
    assert.equal(
        videoFailureDisposition('Timed out waiting for ComfyUI readiness.', true, 0, 6, null),
        'fail',
    );
    assert.equal(videoFailureDisposition('Sampler crashed.', true, 0, 0, null), 'retry');
    assert.equal(videoFailureDisposition('Sampler crashed.', true, 1, 0, 'Sampler crashed.'), 'fail');
    assert.equal(videoFailureDisposition('Invalid screenplay.', false, 0, 0, null), 'fail');
});

test('terminal replay acknowledgements cover retry and pause requeues without accepting stale leases', () => {
    const base = { lease_token: 'lease-1', error: null, stage: null };
    assert.equal(duplicateVideoTerminalEventMatches({
        event: 'failed', lease_id: 'lease-1', error: 'ComfyUI timed out',
    }, {
        ...base, status: 'queued', error: 'ComfyUI timed out', stage: 'Waiting for GPU/Comfy readiness',
    }), true);
    assert.equal(duplicateVideoTerminalEventMatches({
        event: 'cancelled', lease_id: 'lease-1', reason: 'pause',
    }, {
        ...base, status: 'queued', stage: 'Paused for desktop use',
    }), true);
    assert.equal(duplicateVideoTerminalEventMatches({
        event: 'failed', lease_id: 'stale-lease', error: 'ComfyUI timed out',
    }, {
        ...base, status: 'queued', error: 'ComfyUI timed out',
    }), false);
});

test('broker keeps the measured end-to-end runtime on the completed job', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-video-runtime-'));
    const broker = new VideoBroker({
        host: '127.0.0.1',
        port: 0,
        dbPath: join(directory, 'queue.sqlite3'),
        resultsDir: join(directory, 'results'),
        botToken: 'bot-secret',
        workerToken: 'worker-secret',
        heartbeatTimeoutMs: 5000,
        frontierPlanner: async () => ({
            intent: 'A measured two-part test.',
            generation_notice: 'The screenplay was truncated for this test.',
            continuity_bible: 'Test continuity.',
            keyframe: {
                recommended: false,
                reason: 'No frame needed.',
                prompt: 'Test frame.',
                motion_contract: {
                    subject_orientation: 'Forward.',
                    gaze_direction: 'Forward.',
                    travel_direction: 'Forward.',
                    camera_relation: 'Behind.',
                    first_second_action: 'Move.',
                },
            },
            segments: [
                { target_seconds: 7.292, shots: [] },
                { target_seconds: 7.292, shots: [] },
            ],
        }),
    });
    await broker.start();
    const base = `http://127.0.0.1:${broker.listeningPort()}`;
    const botFetch = async (path, init = {}) => {
        const response = await fetch(base + path, {
            ...init,
            headers: {
                authorization: 'Bearer bot-secret',
                'content-type': 'application/json',
                ...(init.headers || {}),
            },
        });
        return { status: response.status, body: await response.json() };
    };

    let socket;
    try {
        const submitted = await botFetch('/v1/jobs', {
            method: 'POST',
            body: JSON.stringify({
                model: 'minimax',
                prompt: 'Runtime tracking test',
                requester_id: 'runtime-user',
                origin_bot_id: 'bot-1',
                channel_id: 'channel-1',
                command_message_id: 'runtime-message',
                status_message_id: 'runtime-status',
            }),
        });
        assert.equal(submitted.status, 201);
        socket = new WebSocket(`ws://127.0.0.1:${broker.listeningPort()}/v1/worker`, {
            headers: { authorization: 'Bearer worker-secret' },
        });
        const take = socketInbox(socket);
        await new Promise((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', reject);
        });
        socket.send(JSON.stringify({
            type: 'hello',
            protocol: 1,
            worker_id: 'runtime-worker',
            capabilities: ['minimax'],
            current_job: null,
        }));
        await take(value => value.type === 'hello_ack');
        const lease = await take(value => value.type === 'job');
        const bytes = Buffer.from('valid-enough-test-video-payload');
        const digest = createHash('sha256').update(bytes).digest('hex');
        const upload = await fetch(`${base}/v1/worker/jobs/${lease.job.id}/result`, {
            method: 'PUT',
            headers: {
                authorization: 'Bearer worker-secret',
                'content-type': 'video/mp4',
                'content-length': String(bytes.length),
                'x-content-sha256': digest,
            },
            body: bytes,
        });
        assert.equal(upload.status, 200);
        const metrics = await fetch(`${base}/v1/worker/jobs/${lease.job.id}/metrics`, {
            method: 'PUT',
            headers: {
                authorization: 'Bearer worker-secret',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                schema_version: 1,
                model: 'minimax',
                generator_model: 'h3',
                total_seconds: 65.625,
                output: {
                    duration_seconds: 7.292,
                    width: 1280,
                    height: 720,
                    fps: 24,
                    segment_count: 1,
                    bytes: bytes.length,
                    source_image: true,
                },
                gpu: {
                    name: 'NVIDIA GeForce RTX 5090',
                    driver_version: 'test-driver',
                    vram_total_mb: 32607,
                    vram_peak_mb: 30000,
                    vram_average_mb: 28000,
                    vram_free_min_mb: 900,
                    utilization_average_percent: 96,
                    utilization_peak_percent: 100,
                    power_average_watts: 410,
                    temperature_peak_c: 73,
                    pcie_link_width_min: 8,
                    pcie_link_width_max: 8,
                    hardware_slowdown_samples: 0,
                    thermal_slowdown_samples: 0,
                    power_brake_slowdown_samples: 0,
                    samples: 60,
                },
                environment: {
                    worker_sha256: 'a'.repeat(64),
                    generator_sha256: 'b'.repeat(64),
                    python_version: '3.test',
                    comfy_aimdo_version: '0.4.14',
                    warm_model_before: null,
                    warm_model_after: 'h3',
                },
                flags: { quality: 'final' },
                spans: [
                    { source: 'worker', name: 'generator_process', duration_seconds: 55 },
                    { source: 'worker', name: 'result_upload', duration_seconds: 2 },
                    { source: 'comfy', name: 'Initializing sampler', segment_index: 1, duration_seconds: 40 },
                ],
            }),
        });
        assert.equal(metrics.status, 200);
        socket.send(JSON.stringify({
            type: 'event',
            event: 'complete',
            job_id: lease.job.id,
            runtime_seconds: 65.625,
        }));
        const completed = await eventually(
            () => botFetch('/v1/users/runtime-user/jobs'),
            value => value.body.jobs[0].status === 'ready',
        );
        assert.equal(completed.body.jobs[0].runtime_seconds, 65.625);
        const delivered = await botFetch(`/v1/jobs/${lease.job.id}/delivered`, {
            method: 'POST',
            body: JSON.stringify({ duration_seconds: 1.25 }),
        });
        assert.equal(delivered.status, 200);
        const stats = await botFetch('/v1/stats?model=minimax');
        assert.equal(stats.status, 200);
        assert.equal(stats.body.samples, 1);
        assert.equal(stats.body.models[0].model, 'minimax');
        assert.equal(stats.body.models[0].total_seconds.median, 65.625);
        assert.equal(stats.body.models[0].phases.generator, 55);
        assert.equal(stats.body.models[0].phases.discord_delivery, 1.25);
        assert.equal(stats.body.models[0].gpu.vram_peak_average_mb, 30000);
        assert.equal(stats.body.models[0].gpu.vram_free_minimum_mb, 900);
        assert.equal(stats.body.models[0].gpu.temperature_peak_c, 73);
        assert.equal(stats.body.models[0].latest_environment.comfy_aimdo_version, '0.4.14');
        assert.equal(stats.body.models[0].cold_starts, 1);
        assert.equal(stats.body.models[0].bottlenecks[0].name, 'generator_process');
        const learned = await botFetch('/v1/jobs', {
            method: 'POST',
            body: JSON.stringify({
                model: 'minimax',
                prompt: 'Sparse runtime estimate test',
                requester_id: 'runtime-user-2',
                origin_bot_id: 'bot-1',
                channel_id: 'channel-1',
                command_message_id: 'runtime-message-2',
                status_message_id: 'runtime-status-2',
            }),
        });
        assert.equal(learned.status, 201);
        assert.equal(learned.body.job.estimate_low_seconds, 49);
        assert.equal(learned.body.job.estimate_high_seconds, 115);
        assert.equal(learned.body.job.estimate_ready, false);
        const beforeReservation = await botFetch(`/v1/jobs/${learned.body.job.id}/prepare`, {
            method: 'POST',
            body: '{}',
        });
        assert.equal(beforeReservation.status, 200);
        assert.equal(beforeReservation.body.job.estimate_ready, true);
        assert.equal(beforeReservation.body.job.estimate_low_seconds, 57);
        assert.equal(beforeReservation.body.job.estimate_high_seconds, 197);
        socket.send(JSON.stringify({ type: 'ready', warm_model: 'h3' }));
        const learnedLease = await take(value => value.type === 'job');
        assert.equal(learnedLease.job.id, learned.body.job.id);
        const submittedAt = Math.floor(Date.now() / 1000) - 120;
        socket.send(JSON.stringify({
            type: 'event', event: 'gpu_queue', job_id: learned.body.job.id,
            state: 'queued', submitted_at: submittedAt,
            stage: 'Waiting for GPU queue admission',
        }));
        const waitingForGpu = await eventually(
            () => botFetch('/v1/users/runtime-user-2/jobs'),
            value => value.body.jobs[0].gpu_queue_state === 'queued',
        );
        assert.equal(waitingForGpu.body.jobs[0].expected_finish_at, null);
        const admittedAt = Math.floor(Date.now() / 1000);
        socket.send(JSON.stringify({
            type: 'event', event: 'gpu_queue', job_id: learned.body.job.id,
            state: 'admitted', submitted_at: submittedAt, admitted_at: admittedAt,
            queue_wait_seconds: admittedAt - submittedAt,
            stage: 'GPU admitted; planning screenplay',
        }));
        await eventually(
            () => botFetch('/v1/users/runtime-user-2/jobs'),
            value => value.body.jobs[0].gpu_queue_state === 'admitted',
        );
        const prepared = await botFetch(`/v1/jobs/${learned.body.job.id}/prepare`, {
            method: 'POST',
            body: '{}',
        });
        assert.equal(prepared.status, 200);
        assert.equal(prepared.body.job.estimate_ready, true);
        assert.equal(prepared.body.job.estimate_low_seconds, 57);
        assert.equal(prepared.body.job.estimate_high_seconds, 197);
        assert.equal(prepared.body.job.initial_estimate_low_seconds, 57);
        assert.equal(prepared.body.job.initial_estimate_high_seconds, 197);
        assert.ok(prepared.body.job.initial_estimate_recorded_at > 0);
        assert.equal(prepared.body.job.planned_intent, 'A measured two-part test.');
        assert.equal(
            prepared.body.job.generation_notice,
            'The screenplay was truncated for this test.',
        );
        assert.equal(
            prepared.body.job.expected_finish_at - prepared.body.job.expected_start_at,
            127,
        );
        assert.equal(prepared.body.job.expected_start_at, admittedAt);
        assert.equal(prepared.body.job.gpu_queue_wait_seconds, admittedAt - submittedAt);
        socket.send(JSON.stringify({
            type: 'event',
            event: 'plan',
            job_id: learned.body.job.id,
            stage: 'Screenplay ready',
            estimate_low_seconds: 500,
            estimate_high_seconds: 900,
        }));
        const stableEstimate = await eventually(
            () => botFetch('/v1/users/runtime-user-2/jobs'),
            value => value.body.jobs[0].status === 'planning',
        );
        assert.equal(stableEstimate.body.jobs[0].estimate_low_seconds, 57);
        assert.equal(stableEstimate.body.jobs[0].estimate_high_seconds, 197);
        const otherRequester = await botFetch('/v1/jobs', {
            method: 'POST',
            body: JSON.stringify({
                model: 'minimax',
                prompt: 'Another requester queue test',
                requester_id: 'runtime-user-3',
                origin_bot_id: 'bot-1',
                channel_id: 'channel-1',
                command_message_id: 'runtime-message-3',
                status_message_id: 'runtime-status-3',
            }),
        });
        assert.equal(otherRequester.status, 201);
        const queue = await botFetch('/v1/queue');
        assert.equal(queue.status, 200);
        assert.deepEqual(
            new Set(queue.body.jobs.map(job => job.requester_id)),
            new Set(['runtime-user-2', 'runtime-user-3']),
        );
    } finally {
        if (socket) socket.close();
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});

async function eventually(callback, predicate, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await callback();
        if (predicate(value)) return value;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for broker state.');
}

test('source-image download does not hold the enqueue write lock', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-video-source-lock-'));
    let releaseDownload;
    let announceDownload;
    const downloadStarted = new Promise(resolve => { announceDownload = resolve; });
    const downloadReleased = new Promise(resolve => { releaseDownload = resolve; });
    const broker = new VideoBroker({
        host: '127.0.0.1', port: 0,
        dbPath: join(directory, 'queue.sqlite3'), resultsDir: join(directory, 'results'),
        botToken: 'bot-secret', workerToken: 'worker-secret',
        sourceImageDownloader: async (_descriptor, targetDirectory) => {
            announceDownload();
            await downloadReleased;
            mkdirSync(targetDirectory, { recursive: true });
            const path = join(targetDirectory, 'source.png');
            writeFileSync(path, Buffer.from('source'));
            return { path, mimeType: 'image/png', bytes: 6 };
        },
    });
    await broker.start();
    const base = `http://127.0.0.1:${broker.listeningPort()}`;
    const submit = (message, source_image) => fetch(`${base}/v1/jobs`, {
        method: 'POST',
        headers: { authorization: 'Bearer bot-secret', 'content-type': 'application/json' },
        body: JSON.stringify({
            model: 'minimax', prompt: message, requester_id: message,
            origin_bot_id: 'bot-1', channel_id: 'channel-1',
            command_message_id: message, status_message_id: `status-${message}`,
            ...(source_image ? { source_image } : {}),
        }),
    });
    try {
        const slow = submit('slow-source', {
            url: 'https://cdn.discordapp.com/attachments/1/2/source.png',
            mime_type: 'image/png', bytes: 6, name: 'source.png',
        });
        await downloadStarted;
        const fast = await Promise.race([
            submit('fast-no-source'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('enqueue remained locked')), 500)),
        ]);
        assert.equal(fast.status, 201);
        releaseDownload();
        assert.equal((await slow).status, 201);
    } finally {
        releaseDownload?.();
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('broker preserves an interrupted job at the front while paused', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-video-broker-'));
    const broker = new VideoBroker({
        host: '127.0.0.1',
        port: 0,
        dbPath: join(directory, 'queue.sqlite3'),
        resultsDir: join(directory, 'results'),
        botToken: 'bot-secret',
        workerToken: 'worker-secret',
        heartbeatTimeoutMs: 5000,
    });
    await broker.start();
    const base = `http://127.0.0.1:${broker.listeningPort()}`;
    const botFetch = async (path, init = {}) => {
        const response = await fetch(base + path, {
            ...init,
            headers: {
                authorization: 'Bearer bot-secret',
                'content-type': 'application/json',
                ...(init.headers || {}),
            },
        });
        return { status: response.status, body: await response.json() };
    };

    let socket;
    try {
        const submitted = await botFetch('/v1/jobs', {
            method: 'POST',
            body: JSON.stringify({
                model: 'minimax',
                prompt: 'A test race',
                requester_id: 'user-1',
                origin_bot_id: 'bot-1',
                channel_id: 'channel-1',
                command_message_id: 'message-1',
                status_message_id: 'status-1',
            }),
        });
        assert.equal(submitted.status, 201);
        assert.equal(submitted.body.job.queue_position, 1);
        assert.equal(submitted.body.job.worker_online, false);
        assert.equal(submitted.body.job.expected_start_at, null);
        const jobId = submitted.body.job.id;

        socket = new WebSocket(`ws://127.0.0.1:${broker.listeningPort()}/v1/worker`, {
            headers: { authorization: 'Bearer worker-secret' },
        });
        const take = socketInbox(socket);
        await new Promise((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', reject);
        });
        socket.send(JSON.stringify({
            type: 'hello',
            protocol: 1,
            worker_id: 'test-worker',
            capabilities: ['ltx', 'minimax'],
            current_job: null,
        }));
        await take(value => value.type === 'hello_ack');
        const firstLease = await take(value => value.type === 'job');
        assert.equal(firstLease.job.id, jobId);

        socket.send(JSON.stringify({
            type: 'event',
            event: 'plan',
            job_id: jobId,
            stage: 'Planning screenplay',
        }));
        const planning = await eventually(
            () => botFetch('/v1/users/user-1/jobs'),
            value => value.body.jobs[0].status === 'planning',
        );
        assert.equal(planning.body.jobs[0].estimate_low_seconds, 600);
        assert.equal(planning.body.jobs[0].estimate_high_seconds, 1800);

        const paused = await botFetch('/v1/control/pause', {
            method: 'POST',
            body: JSON.stringify({ seconds: 60, actor_id: 'owner' }),
        });
        assert.equal(paused.status, 200);
        const cancel = await take(value => value.type === 'cancel');
        assert.equal(cancel.job_id, jobId);
        assert.equal(cancel.reason, 'pause');

        socket.close();
        await eventually(
            () => botFetch('/v1/control'),
            value => value.body.worker_online === false,
        );
        socket = new WebSocket(`ws://127.0.0.1:${broker.listeningPort()}/v1/worker`, {
            headers: { authorization: 'Bearer worker-secret' },
        });
        const takeReconnected = socketInbox(socket);
        await new Promise((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', reject);
        });
        socket.send(JSON.stringify({
            type: 'hello',
            protocol: 1,
            worker_id: 'test-worker',
            capabilities: ['ltx', 'minimax'],
            current_job: jobId,
        }));
        const repeatedCancel = await takeReconnected(value => value.type === 'cancel');
        assert.equal(repeatedCancel.reason, 'pause');
        await takeReconnected(value => value.type === 'hello_ack');

        socket.send(JSON.stringify({ type: 'event', event: 'cancelled', job_id: jobId, reason: 'pause' }));
        socket.send(JSON.stringify({ type: 'ready' }));
        const duringPause = await eventually(
            () => botFetch('/v1/users/user-1/jobs'),
            value => value.body.jobs[0].status === 'queued',
        );
        assert.equal(duringPause.body.jobs[0].status, 'queued');
        assert.equal(duringPause.body.jobs[0].queue_position, 1);
        assert.ok(duringPause.body.jobs[0].paused_until);
        assert.equal(duringPause.body.jobs[0].expected_start_at, null);
        assert.equal(duringPause.body.jobs[0].expected_finish_at, null);

        const second = await botFetch('/v1/jobs', {
            method: 'POST',
            body: JSON.stringify({
                model: 'ltx',
                prompt: 'A second queued test',
                requester_id: 'user-2',
                origin_bot_id: 'bot-1',
                channel_id: 'channel-1',
                command_message_id: 'message-2',
                status_message_id: 'status-2',
            }),
        });
        assert.equal(second.status, 201);
        const shortCancel = await botFetch(`/v1/jobs/${second.body.job.id.slice(0, 8)}/cancel`, {
            method: 'POST',
            body: JSON.stringify({ requester_id: 'owner', is_admin: true }),
        });
        assert.deepEqual(shortCancel.body, { ok: true });
        await assert.rejects(() => takeReconnected(value => value.type === 'job', 150), /Timed out/);

        await botFetch('/v1/control/resume', { method: 'POST', body: '{}' });
        const resumed = await takeReconnected(value => value.type === 'job');
        assert.equal(resumed.job.id, jobId);
        socket.send(JSON.stringify({
            type: 'event',
            event: 'failed',
            job_id: jobId,
            error: 'permanent test failure',
            retryable: false,
        }));
        socket.send(JSON.stringify({ type: 'ready' }));
        const finished = await eventually(
            () => botFetch('/v1/users/user-1/jobs'),
            value => value.body.jobs[0].status === 'failed',
        );
        assert.equal(finished.body.jobs[0].status, 'failed');
    } finally {
        if (socket) socket.close();
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('broker unloads an idle worker when paused and after reconnecting while paused', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-video-idle-pause-'));
    const broker = new VideoBroker({
        host: '127.0.0.1',
        port: 0,
        dbPath: join(directory, 'queue.sqlite3'),
        resultsDir: join(directory, 'results'),
        botToken: 'bot-secret',
        workerToken: 'worker-secret',
        heartbeatTimeoutMs: 5000,
    });
    await broker.start();
    const base = `http://127.0.0.1:${broker.listeningPort()}`;
    const botFetch = async (path, init = {}) => {
        const response = await fetch(base + path, {
            ...init,
            headers: {
                authorization: 'Bearer bot-secret',
                'content-type': 'application/json',
                ...(init.headers || {}),
            },
        });
        return { status: response.status, body: await response.json() };
    };

    let socket;
    try {
        const connectWorker = async () => {
            const worker = new WebSocket(`ws://127.0.0.1:${broker.listeningPort()}/v1/worker`, {
                headers: { authorization: 'Bearer worker-secret' },
            });
            const take = socketInbox(worker);
            await new Promise((resolve, reject) => {
                worker.once('open', resolve);
                worker.once('error', reject);
            });
            worker.send(JSON.stringify({
                type: 'hello',
                protocol: 1,
                worker_id: 'test-worker',
                capabilities: ['ltx', 'minimax'],
                current_job: null,
            }));
            await take(value => value.type === 'hello_ack');
            return { worker, take };
        };

        let connected = await connectWorker();
        socket = connected.worker;
        const paused = await botFetch('/v1/control/pause', {
            method: 'POST',
            body: JSON.stringify({ seconds: 60, actor_id: 'owner' }),
        });
        assert.equal(paused.status, 200);
        const firstUnload = await connected.take(value => value.type === 'unload');
        assert.equal(firstUnload.reason, 'pause');

        socket.close();
        await eventually(
            () => botFetch('/v1/control'),
            value => value.body.worker_online === false,
        );
        connected = await connectWorker();
        socket = connected.worker;
        const reconnectUnload = await connected.take(value => value.type === 'unload');
        assert.equal(reconnectUnload.reason, 'pause');
    } finally {
        if (socket) socket.close();
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('broker may reuse a warm model once without starving the oldest queued job', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-video-affinity-'));
    const broker = new VideoBroker({
        host: '127.0.0.1',
        port: 0,
        dbPath: join(directory, 'queue.sqlite3'),
        resultsDir: join(directory, 'results'),
        botToken: 'bot-secret',
        workerToken: 'worker-secret',
        heartbeatTimeoutMs: 5000,
    });
    await broker.start();
    const base = `http://127.0.0.1:${broker.listeningPort()}`;
    const botFetch = async (path, init = {}) => {
        const response = await fetch(base + path, {
            ...init,
            headers: {
                authorization: 'Bearer bot-secret',
                'content-type': 'application/json',
                ...(init.headers || {}),
            },
        });
        return { status: response.status, body: await response.json() };
    };
    const submit = async (model, requester, message) => {
        const response = await botFetch('/v1/jobs', {
            method: 'POST',
            body: JSON.stringify({
                model,
                prompt: `${model} affinity test`,
                requester_id: requester,
                origin_bot_id: 'bot-1',
                channel_id: 'channel-1',
                command_message_id: message,
                status_message_id: `status-${message}`,
            }),
        });
        assert.equal(response.status, 201);
        return response.body.job;
    };

    let socket;
    try {
        const oldest = await submit('ltx', 'user-ltx', 'message-ltx');
        const warm = await submit('minimax', 'user-h3-a', 'message-h3-a');
        const nextWarm = await submit('minimaxfast', 'user-h3-b', 'message-h3-b');
        socket = new WebSocket(`ws://127.0.0.1:${broker.listeningPort()}/v1/worker`, {
            headers: { authorization: 'Bearer worker-secret' },
        });
        const take = socketInbox(socket);
        await new Promise((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', reject);
        });
        socket.send(JSON.stringify({
            type: 'hello',
            protocol: 1,
            worker_id: 'test-worker',
            capabilities: ['ltx', 'minimax', 'minimaxfast'],
            current_job: null,
            warm_model: 'h3',
        }));
        await take(value => value.type === 'hello_ack');
        const reused = await take(value => value.type === 'job');
        assert.equal(reused.job.id, warm.id);

        const waiting = await botFetch('/v1/users/user-ltx/jobs');
        assert.equal(waiting.body.jobs[0].queue_position, 1);
        assert.equal(waiting.body.jobs[0].expected_start_at, null);

        socket.send(JSON.stringify({
            type: 'event',
            event: 'failed',
            job_id: warm.id,
            error: 'finish affinity test',
            retryable: false,
        }));
        socket.send(JSON.stringify({ type: 'ready', warm_model: 'h3' }));
        const fairnessLease = await take(value => value.type === 'job');
        assert.equal(fairnessLease.job.id, oldest.id);
        assert.notEqual(fairnessLease.job.id, nextWarm.id);
    } finally {
        if (socket) socket.close();
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('broker prepares the next screenplay and keyframe before gpuq admission', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-video-preplan-'));
    const plannerCalls = [];
    const keyframeCalls = [];
    const broker = new VideoBroker({
        host: '127.0.0.1',
        port: 0,
        dbPath: join(directory, 'queue.sqlite3'),
        resultsDir: join(directory, 'results'),
        botToken: 'bot-secret',
        workerToken: 'worker-secret',
        heartbeatTimeoutMs: 5000,
        preplanQueuedJobs: true,
        frontierPlanner: async prompt => {
            plannerCalls.push(prompt);
            return {
                intent: prompt,
                continuity_bible: `${prompt} continuity`,
                keyframe: {
                    recommended: true,
                    reason: 'test',
                    prompt: `${prompt} opening frame`,
                    motion_contract: {
                        subject_orientation: 'right',
                        gaze_direction: 'right',
                        travel_direction: 'right',
                        camera_relation: 'side view',
                        first_second_action: 'continue right',
                    },
                },
                segments: [{
                    title: 'Opening', transition: 'start', target_seconds: 5, music: 'N/A',
                    shots: [{
                        duration_seconds: 5, visual: `${prompt} begins`, camera: 'wide', audio: 'room tone', dialogue: [],
                    }],
                }, {
                    title: 'New location', transition: 'cut', target_seconds: 5, music: 'N/A',
                    shots: [{
                        duration_seconds: 5, visual: `${prompt} continues elsewhere`, camera: 'medium', audio: 'room tone', dialogue: [],
                    }],
                }],
            };
        },
        keyframeGenerator: async plan => {
            keyframeCalls.push(`${plan.intent}:${plan.segments?.[0]?.transition || 'none'}`);
            return {
                bytes: Buffer.from(`keyframe:${plan.intent}`),
                mimeType: 'image/png',
                provider: 'test-provider',
                model: 'test-image-model',
            };
        },
    });
    await broker.start();
    const base = `http://127.0.0.1:${broker.listeningPort()}`;
    const botFetch = async (path, init = {}) => fetch(base + path, {
        ...init,
        headers: {
            authorization: 'Bearer bot-secret',
            'content-type': 'application/json',
            ...(init.headers || {}),
        },
    });
    const workerFetch = (path, init = {}) => fetch(base + path, {
        method: 'POST',
        ...init,
        headers: {
            authorization: 'Bearer worker-secret',
            'content-type': 'application/json',
            ...(init.headers || {}),
        },
    });
    const submit = async (prompt, message) => {
        const response = await botFetch('/v1/jobs', {
            method: 'POST',
            body: JSON.stringify({
                model: 'minimax',
                prompt,
                requester_id: `user-${message}`,
                origin_bot_id: 'bot-1',
                channel_id: 'channel-1',
                command_message_id: message,
                status_message_id: `status-${message}`,
            }),
        });
        assert.equal(response.status, 201);
        return (await response.json()).job;
    };

    let socket;
    try {
        socket = new WebSocket(`ws://127.0.0.1:${broker.listeningPort()}/v1/worker`, {
            headers: { authorization: 'Bearer worker-secret' },
        });
        const take = socketInbox(socket);
        await new Promise((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', reject);
        });
        socket.send(JSON.stringify({
            type: 'hello',
            protocol: 1,
            worker_id: 'test-worker',
            capabilities: ['minimax'],
            current_job: null,
        }));
        await take(value => value.type === 'hello_ack');

        const first = await submit('First render', 'message-1');
        const firstLease = await take(value => value.type === 'job');
        assert.equal(firstLease.job.id, first.id);
        const second = await submit('Prepared while busy', 'message-2');
        await eventually(
            async () => ({ plannerCalls: [...plannerCalls], keyframeCalls: [...keyframeCalls] }),
            value => value.plannerCalls.includes('Prepared while busy')
                && value.keyframeCalls.includes('Prepared while busy:start')
                && value.keyframeCalls.includes('Prepared while busy:cut'),
        );

        socket.send(JSON.stringify({
            type: 'event',
            event: 'failed',
            job_id: first.id,
            error: 'finish first test',
            retryable: false,
        }));
        socket.send(JSON.stringify({ type: 'ready' }));
        const secondLease = await take(value => value.type === 'job');
        assert.equal(secondLease.job.id, second.id);
        socket.send(JSON.stringify({
            type: 'event', event: 'gpu_queue', job_id: second.id,
            state: 'admitted', submitted_at: Math.floor(Date.now() / 1000),
            admitted_at: Math.floor(Date.now() / 1000), queue_wait_seconds: 0,
        }));
        const planResponse = await workerFetch(`/v1/worker/jobs/${second.id}/plan`);
        assert.equal(planResponse.status, 200);
        assert.equal((await planResponse.json()).cached, true);
        const frameResponse = await workerFetch(`/v1/worker/jobs/${second.id}/keyframe`);
        assert.equal(frameResponse.status, 200);
        assert.equal(frameResponse.headers.get('x-video-keyframe-provider'), 'test-provider');
        assert.equal(frameResponse.headers.get('x-video-keyframe-cached'), 'true');
        const segmentFrameResponse = await workerFetch(
            `/v1/worker/jobs/${second.id}/keyframe?segment=2&aspect=16:9`,
        );
        assert.equal(segmentFrameResponse.status, 200);
        assert.equal(segmentFrameResponse.headers.get('x-video-keyframe-cached'), 'true');
        assert.equal(plannerCalls.filter(prompt => prompt === 'Prepared while busy').length, 1);
        assert.equal(keyframeCalls.filter(value => value.startsWith('Prepared while busy:')).length, 2);
    } finally {
        if (socket) socket.close();
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('broker caches an explicit frontier rejection so the desktop consistently plans locally', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-video-frontier-rejection-'));
    let plannerCalls = 0;
    let referenceResolverCalls = 0;
    let keyframeCalls = 0;
    const broker = new VideoBroker({
        host: '127.0.0.1', port: 0,
        dbPath: join(directory, 'queue.sqlite3'), resultsDir: join(directory, 'results'),
        botToken: 'bot-secret', workerToken: 'worker-secret',
        frontierPlanner: async () => {
            plannerCalls += 1;
            throw new FrontierPlannerRejectedError('provider_policy');
        },
        keyframeReferenceResolver: async plan => {
            referenceResolverCalls += 1;
            assert.equal(
                plan.keyframe.reference_requirements[0].search_query,
                'Gigachad meme character face',
            );
            return [{
                label: 'Gigachad character',
                kind: 'character',
                visualFactsToPreserve: 'Angular face and exaggerated jawline.',
                bytes: Buffer.from('gigachad-reference'),
                mimeType: 'image/png',
                sourceUrl: 'https://images.example/gigachad.png',
                contextUrl: 'https://example.com/gigachad',
            }];
        },
        keyframeGenerator: async (_plan, references) => {
            keyframeCalls += 1;
            assert.equal(references.length, 1);
            assert.equal(references[0].label, 'Gigachad character');
            return {
                bytes: Buffer.from('local-reference-keyframe'),
                mimeType: 'image/png',
                provider: 'test-provider',
                model: 'test-image-model',
            };
        },
    });
    await broker.start();
    const base = `http://127.0.0.1:${broker.listeningPort()}`;
    let socket;
    try {
        socket = new WebSocket(`ws://127.0.0.1:${broker.listeningPort()}/v1/worker`, {
            headers: { authorization: 'Bearer worker-secret' },
        });
        const take = socketInbox(socket);
        await new Promise((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', reject);
        });
        socket.send(JSON.stringify({
            type: 'hello', protocol: 1, worker_id: 'rejection-worker',
            capabilities: ['minimaxfast'], current_job: null,
        }));
        await take(value => value.type === 'hello_ack');
        const submitted = await fetch(`${base}/v1/jobs`, {
            method: 'POST',
            headers: { authorization: 'Bearer bot-secret', 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'minimaxfast', prompt: 'Gigachad walks confidently into a gym.',
                requester_id: 'rejection-user', origin_bot_id: 'bot-1', channel_id: 'channel-1',
                command_message_id: 'rejection-message', status_message_id: 'rejection-status',
            }),
        });
        assert.equal(submitted.status, 201);
        const job = (await submitted.json()).job;
        const lease = await take(value => value.type === 'job');
        assert.equal(lease.job.id, job.id);
        const requestPlan = () => fetch(`${base}/v1/worker/jobs/${job.id}/plan`, {
            method: 'POST',
            headers: { authorization: 'Bearer worker-secret', 'content-type': 'application/json' },
            body: '{}',
        });
        const first = await requestPlan();
        assert.equal(first.status, 502);
        const firstBody = await first.json();
        assert.equal(firstBody.fallback, 'local');
        assert.equal(firstBody.disposition, 'reject');
        assert.equal(firstBody.reason_code, 'provider_policy');
        const cached = await requestPlan();
        assert.equal(cached.status, 502);
        const cachedBody = await cached.json();
        assert.equal(cachedBody.fallback, 'local');
        assert.equal(cachedBody.disposition, 'reject');
        assert.equal(cachedBody.reason_code, 'provider_policy');
        assert.equal(plannerCalls, 1);
        assert.equal(lease.job.has_source_image, false);

        const localPlan = {
            intent: 'Gigachad walks confidently into a gym.',
            continuity_bible: 'Keep Gigachad recognizable throughout.',
            keyframe: {
                recommended: true,
                reason: 'The named character needs a stable identity anchor.',
                prompt: 'Gigachad at the entrance of a gym, ready to walk forward.',
                reference_requirements: [{
                    label: 'Gigachad character',
                    kind: 'character',
                    search_query: 'Gigachad meme character face',
                    visual_facts_to_preserve: 'Angular face and exaggerated jawline.',
                }],
                motion_contract: {
                    subject_orientation: 'Facing into the gym.',
                    gaze_direction: 'Looking into the gym.',
                    travel_direction: 'Forward into the gym.',
                    camera_relation: 'Front-side three-quarter tracking view.',
                    first_second_action: 'Continue stepping through the entrance.',
                },
            },
            segments: [{
                title: 'Entrance',
                transition: 'start',
                target_seconds: 5,
                music: 'N/A',
                shots: [{
                    duration_seconds: 5,
                    visual: 'Gigachad walks confidently into the gym.',
                    camera: 'Track beside him without crossing the axis.',
                    audio: 'Gym room tone, footsteps, and a door hinge.',
                    dialogue: [],
                }],
            }],
        };
        const uploaded = await fetch(`${base}/v1/worker/jobs/${job.id}/local-plan`, {
            method: 'POST',
            headers: { authorization: 'Bearer worker-secret', 'content-type': 'application/json' },
            body: JSON.stringify({ plan: localPlan }),
        });
        assert.equal(uploaded.status, 200);
        assert.equal((await uploaded.json()).planner_model, 'hauhaucs-qwen3.8:27b-q4kp-mtp');

        const stored = await requestPlan();
        assert.equal(stored.status, 200);
        const storedBody = await stored.json();
        assert.equal(storedBody.cached, true);
        assert.equal(storedBody.planner_model, 'hauhaucs-qwen3.8:27b-q4kp-mtp');
        assert.equal(
            storedBody.plan.keyframe.reference_requirements[0].label,
            'Gigachad character',
        );
        const frame = await fetch(`${base}/v1/worker/jobs/${job.id}/keyframe`, {
            method: 'POST',
            headers: { authorization: 'Bearer worker-secret', 'content-type': 'application/json' },
            body: '{}',
        });
        assert.equal(frame.status, 200);
        assert.equal(frame.headers.get('x-video-keyframe-provider'), 'test-provider');
        assert.equal(referenceResolverCalls, 1);
        assert.equal(keyframeCalls, 1);
    } finally {
        if (socket) socket.close();
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('broker serves a cached frontier frame and gives a user attachment precedence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-video-keyframe-'));
    const generatedBytes = Buffer.from('generated-keyframe');
    const derivedBytes = Buffer.from('derived-segment-keyframe');
    const attachedBytes = Buffer.from('attached-keyframe');
    let keyframeCalls = 0;
    let referenceResolverCalls = 0;
    let segmentContractPlannerCalls = 0;
    const plannerSawSource = [];
    const derivedAspects = [];
    const plan = {
        intent: 'test',
        continuity_bible: 'test continuity',
        keyframe: {
            recommended: true,
            reason: 'identity anchor',
            prompt: 'three racers',
            reference_requirements: [{
                label: 'Racer identity',
                kind: 'identity',
                search_query: 'racer portrait',
                visual_facts_to_preserve: 'Distinctive face.',
            }],
            motion_contract: {
                subject_orientation: 'right',
                gaze_direction: 'right',
                travel_direction: 'right',
                camera_relation: 'rear three-quarter',
                first_second_action: 'accelerate right',
            },
        },
    };
    const segmentContracts = [{
        segment_index: 2,
        prompt: 'The same racer waits below the podium steps before the celebration begins.',
        motion_contract: {
            subject_orientation: 'The racer faces the podium steps.',
            gaze_direction: 'The racer looks toward the top step.',
            travel_direction: 'The racer will move forward and upward.',
            camera_relation: 'Low frontal view from the podium side.',
            first_second_action: 'The racer takes the first step toward the podium.',
        },
    }];
    plan.segments = [{
        title: 'Opening', transition: 'start', target_seconds: 5, music: 'N/A', shots: [{
            duration_seconds: 5, visual: 'A racer waits at the starting line.',
            camera: 'Rear three-quarter view.', audio: 'Track ambience.', dialogue: [],
        }],
    }, {
        title: 'Podium', transition: 'cut', target_seconds: 5, music: 'N/A', shots: [{
            duration_seconds: 5, visual: 'The same racer celebrates on the podium.',
            camera: 'Low frontal view.', audio: 'Crowd cheers.', dialogue: [],
        }],
    }];
    const broker = new VideoBroker({
        host: '127.0.0.1',
        port: 0,
        dbPath: join(directory, 'queue.sqlite3'),
        resultsDir: join(directory, 'results'),
        botToken: 'bot-secret',
        workerToken: 'worker-secret',
        heartbeatTimeoutMs: 5000,
        frontierPlanner: async (_prompt, _model, _requester, sourceImage) => {
            plannerSawSource.push(Boolean(sourceImage));
            return structuredClone(plan);
        },
        segmentContractPlanner: async () => {
            segmentContractPlannerCalls += 1;
            return segmentContracts;
        },
        keyframeGenerator: async (planned, references, options) => {
            keyframeCalls += 1;
            if (planned.keyframe.reason.startsWith('Preserve the recurring cast')) {
                assert.equal(references.length, 1);
                assert.equal(references[0].label, 'Recurring cast identity from frame zero');
                assert.deepEqual(references[0].bytes, attachedBytes);
                assert.match(planned.keyframe.prompt, /waits below the podium steps/i);
                assert.equal(
                    planned.keyframe.motion_contract.first_second_action,
                    'The racer takes the first step toward the podium.',
                );
                derivedAspects.push(options.aspectRatio);
                return {
                    bytes: derivedBytes,
                    mimeType: 'image/png',
                    provider: 'derived-provider',
                    model: 'derived-image-model',
                };
            }
            assert.equal(references.length, 1);
            assert.equal(references[0].label, 'Racer identity');
            return {
                bytes: generatedBytes,
                mimeType: 'image/png',
                provider: 'test-provider',
                model: 'test-image-model',
            };
        },
        keyframeReferenceResolver: async () => {
            referenceResolverCalls += 1;
            return [{
                label: 'Racer identity',
                kind: 'identity',
                visualFactsToPreserve: 'Distinctive face.',
                bytes: Buffer.from('reference'),
                mimeType: 'image/png',
                sourceUrl: 'https://images.example/racer.png',
                contextUrl: 'https://example.com/racer',
            }];
        },
        sourceImageDownloader: async (_descriptor, targetDirectory) => {
            mkdirSync(targetDirectory, { recursive: true });
            const path = join(targetDirectory, 'source.png');
            writeFileSync(path, attachedBytes);
            return { path, mimeType: 'image/png', bytes: attachedBytes.length };
        },
    });
    await broker.start();
    const base = `http://127.0.0.1:${broker.listeningPort()}`;
    const botFetch = async (path, init = {}) => {
        const response = await fetch(base + path, {
            ...init,
            headers: {
                authorization: 'Bearer bot-secret',
                'content-type': 'application/json',
                ...(init.headers || {}),
            },
        });
        return { status: response.status, body: await response.json() };
    };
    const workerFetch = (path, init = {}) => fetch(base + path, {
        method: 'POST',
        ...init,
        headers: {
            authorization: 'Bearer worker-secret',
            'content-type': 'application/json',
            ...(init.headers || {}),
        },
    });

    let socket;
    try {
        const first = await botFetch('/v1/jobs', {
            method: 'POST',
            body: JSON.stringify({
                model: 'ltx',
                prompt: 'A generated-frame test',
                requester_id: 'user-1',
                origin_bot_id: 'bot-1',
                channel_id: 'channel-1',
                command_message_id: 'message-1',
                status_message_id: 'status-1',
            }),
        });
        assert.equal(first.status, 201);
        assert.equal(first.body.job.has_source_image, false);
        socket = new WebSocket(`ws://127.0.0.1:${broker.listeningPort()}/v1/worker`, {
            headers: { authorization: 'Bearer worker-secret' },
        });
        const take = socketInbox(socket);
        await new Promise((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', reject);
        });
        socket.send(JSON.stringify({
            type: 'hello',
            protocol: 1,
            worker_id: 'test-worker',
            capabilities: ['ltx', 'minimax'],
            current_job: null,
        }));
        await take(value => value.type === 'hello_ack');
        const firstLease = await take(value => value.type === 'job');
        assert.equal(firstLease.job.id, first.body.job.id);
        assert.equal(firstLease.job.has_source_image, false);

        const firstPlan = await workerFetch(`/v1/worker/jobs/${first.body.job.id}/plan`);
        assert.equal(firstPlan.status, 200);
        const firstFrame = await workerFetch(`/v1/worker/jobs/${first.body.job.id}/keyframe`);
        assert.equal(firstFrame.status, 200);
        assert.equal(firstFrame.headers.get('x-video-keyframe-provider'), 'test-provider');
        assert.deepEqual(Buffer.from(await firstFrame.arrayBuffer()), generatedBytes);
        const cachedFrame = await workerFetch(`/v1/worker/jobs/${first.body.job.id}/keyframe`);
        assert.equal(cachedFrame.status, 200);
        assert.deepEqual(Buffer.from(await cachedFrame.arrayBuffer()), generatedBytes);
        assert.equal(keyframeCalls, 1);
        assert.equal(referenceResolverCalls, 1);

        socket.send(JSON.stringify({
            type: 'event',
            event: 'failed',
            job_id: first.body.job.id,
            error: 'finish first test',
            retryable: false,
        }));
        socket.send(JSON.stringify({ type: 'ready' }));
        await eventually(
            () => botFetch('/v1/users/user-1/jobs'),
            value => value.body.jobs[0].status === 'failed',
        );

        const second = await botFetch('/v1/jobs', {
            method: 'POST',
            body: JSON.stringify({
                model: 'minimax',
                prompt: 'Animate my supplied frame',
                requester_id: 'user-2',
                origin_bot_id: 'bot-1',
                channel_id: 'channel-1',
                command_message_id: 'message-2',
                status_message_id: 'status-2',
                source_image: {
                    url: 'https://cdn.discordapp.com/attachments/1/2/frame.png',
                    mime_type: 'image/png',
                    bytes: attachedBytes.length,
                    name: 'frame.png',
                },
            }),
        });
        assert.equal(second.status, 201);
        assert.equal(second.body.job.has_source_image, true);
        const secondLease = await take(value => value.type === 'job');
        assert.equal(secondLease.job.id, second.body.job.id);
        assert.equal(secondLease.job.has_source_image, true);
        const secondPlan = await workerFetch(`/v1/worker/jobs/${second.body.job.id}/plan`);
        assert.equal(secondPlan.status, 200);
        const suppliedFrame = await workerFetch(`/v1/worker/jobs/${second.body.job.id}/keyframe`);
        assert.equal(suppliedFrame.status, 200);
        assert.equal(suppliedFrame.headers.get('x-video-keyframe-provider'), 'user-attachment');
        assert.deepEqual(Buffer.from(await suppliedFrame.arrayBuffer()), attachedBytes);
        const derivedFrame = await workerFetch(
            `/v1/worker/jobs/${second.body.job.id}/keyframe?segment=2&aspect=3:4`,
        );
        assert.equal(derivedFrame.status, 200);
        assert.equal(derivedFrame.headers.get('x-video-keyframe-provider'), 'derived-provider');
        assert.equal(derivedFrame.headers.get('x-video-keyframe-segment'), '2');
        assert.deepEqual(Buffer.from(await derivedFrame.arrayBuffer()), derivedBytes);
        const cachedDerivedFrame = await workerFetch(
            `/v1/worker/jobs/${second.body.job.id}/keyframe?segment=2&aspect=3:4`,
        );
        assert.equal(cachedDerivedFrame.status, 200);
        assert.equal(cachedDerivedFrame.headers.get('x-video-keyframe-cached'), 'true');
        assert.deepEqual(Buffer.from(await cachedDerivedFrame.arrayBuffer()), derivedBytes);
        assert.deepEqual(plannerSawSource, [false, true]);
        assert.deepEqual(derivedAspects, ['3:4']);
        assert.equal(keyframeCalls, 2);
        assert.equal(referenceResolverCalls, 1);
        assert.equal(segmentContractPlannerCalls, 2);
        socket.send(JSON.stringify({
            type: 'event',
            event: 'failed',
            job_id: second.body.job.id,
            error: 'finish second test',
            retryable: false,
        }));
        socket.send(JSON.stringify({ type: 'ready' }));
        await eventually(
            () => botFetch('/v1/users/user-2/jobs'),
            value => value.body.jobs[0].status === 'failed',
        );
        const closed = new Promise(resolve => socket.once('close', resolve));
        socket.close();
        await closed;
        socket = null;
    } finally {
        if (socket) socket.close();
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('worker GPU-reset safety signal pauses dispatch and preserves failed-attempt telemetry', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-video-gpu-reset-'));
    const broker = new VideoBroker({
        host: '127.0.0.1',
        port: 0,
        dbPath: join(directory, 'queue.sqlite3'),
        resultsDir: join(directory, 'results'),
        botToken: 'bot-secret',
        workerToken: 'worker-secret',
        heartbeatTimeoutMs: 5000,
    });
    await broker.start();
    const base = `http://127.0.0.1:${broker.listeningPort()}`;
    const botFetch = async (path, init = {}) => {
        const response = await fetch(base + path, {
            ...init,
            headers: {
                authorization: 'Bearer bot-secret',
                'content-type': 'application/json',
                ...(init.headers || {}),
            },
        });
        return { status: response.status, body: await response.json() };
    };
    let socket;
    try {
        const submitted = await botFetch('/v1/jobs', {
            method: 'POST',
            body: JSON.stringify({
                model: 'minimax',
                prompt: 'GPU reset circuit-breaker test',
                requester_id: 'safety-user',
                origin_bot_id: 'bot-1',
                channel_id: 'channel-1',
                command_message_id: 'safety-message',
                status_message_id: 'safety-status',
            }),
        });
        assert.equal(submitted.status, 201);
        socket = new WebSocket(`ws://127.0.0.1:${broker.listeningPort()}/v1/worker`, {
            headers: { authorization: 'Bearer worker-secret' },
        });
        const take = socketInbox(socket);
        await new Promise((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', reject);
        });
        socket.send(JSON.stringify({
            type: 'hello',
            protocol: 1,
            worker_id: 'safety-worker',
            capabilities: ['minimax'],
            current_job: null,
        }));
        await take(value => value.type === 'hello_ack');
        const lease = await take(value => value.type === 'job');
        socket.send(JSON.stringify({
            type: 'event',
            event: 'failed',
            job_id: lease.job.id,
            error: 'Windows reset the NVIDIA GPU driver during generation.',
            retryable: true,
            safety_pause_seconds: 3600,
            metrics: {
                schema_version: 1,
                model: 'minimax',
                generator_model: 'h3',
                total_seconds: 130.76,
                gpu: {
                    name: 'NVIDIA GeForce RTX 5090',
                    driver_version: '610.47',
                    vram_total_mb: 32607,
                    vram_peak_mb: 32500,
                    vram_free_min_mb: 107,
                    temperature_peak_c: 73,
                    samples: 120,
                },
                environment: {
                    python_version: '3.13.14',
                    comfy_aimdo_version: '0.4.13',
                    warm_model_before: 'h3',
                    warm_model_after: null,
                },
                flags: { quality: 'final' },
                failure: {
                    kind: 'nvidia_driver_reset',
                    event_count: 170,
                    event_ids: [13, 14, 153],
                    latest_utc: '2026-08-23T05:52:15.297Z',
                },
                spans: [],
            },
        }));
        socket.send(JSON.stringify({ type: 'ready', warm_model: null }));
        const unload = await take(value => value.type === 'unload');
        assert.equal(unload.reason, 'safety-pause');
        const paused = await eventually(
            () => botFetch('/v1/queue'),
            value => value.body.state.paused_until && value.body.jobs[0]?.status === 'queued',
        );
        assert.equal(paused.body.jobs[0].stage, 'Paused after GPU driver reset');
        assert.equal(paused.body.jobs[0].error, 'Windows reset the NVIDIA GPU driver during generation.');
        await assert.rejects(() => take(value => value.type === 'job', 150), /Timed out/);

        const resumed = await botFetch('/v1/control/resume', { method: 'POST', body: '{}' });
        assert.equal(resumed.status, 200);
        const retry = await take(value => value.type === 'job');
        assert.equal(retry.job.id, lease.job.id);
        socket.send(JSON.stringify({
            type: 'event',
            event: 'failed',
            job_id: retry.job.id,
            error: 'finish test',
            retryable: false,
        }));
        socket.send(JSON.stringify({ type: 'ready' }));
        await eventually(
            () => botFetch('/v1/users/safety-user/jobs'),
            value => value.body.jobs[0].status === 'failed',
        );
    } finally {
        if (socket) socket.close();
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('broker exposes attributed provider usage once and acknowledges it per origin bot', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-video-usage-'));
    const broker = new VideoBroker({
        host: '127.0.0.1',
        port: 0,
        dbPath: join(directory, 'queue.sqlite3'),
        resultsDir: join(directory, 'results'),
        botToken: 'bot-secret',
        workerToken: 'worker-secret',
        frontierPlanner: async (prompt, _model, _requester, _source, options) => {
            await options.onUsage({
                stage: 'prompt_analysis',
                attempt: 1,
                outcome: 'success',
                provider: 'openai',
                model: 'gpt-5.6-sol',
                serviceTier: 'priority',
                inputTokens: 1000,
                outputTokens: 100,
            });
            return {
                intent: prompt,
                continuity_bible: 'usage test',
                keyframe: { recommended: false, reference_requirements: [] },
                segments: [{ target_seconds: 5, shots: [] }],
            };
        },
    });
    await broker.start();
    const base = `http://127.0.0.1:${broker.listeningPort()}`;
    const botFetch = async (path, init = {}) => {
        const response = await fetch(base + path, {
            ...init,
            headers: {
                authorization: 'Bearer bot-secret',
                'content-type': 'application/json',
                ...(init.headers || {}),
            },
        });
        return { status: response.status, body: await response.json() };
    };
    let socket;
    try {
        socket = new WebSocket(`ws://127.0.0.1:${broker.listeningPort()}/v1/worker`, {
            headers: { authorization: 'Bearer worker-secret' },
        });
        const take = socketInbox(socket);
        await new Promise((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', reject);
        });
        socket.send(JSON.stringify({
            type: 'hello', protocol: 1, worker_id: 'usage-worker',
            capabilities: ['minimaxfast'], current_job: null,
        }));
        await take(value => value.type === 'hello_ack');
        const submitted = await botFetch('/v1/jobs', {
            method: 'POST',
            body: JSON.stringify({
                model: 'minimaxfast',
                prompt: 'Usage outbox test',
                requester_id: 'usage-user',
                origin_bot_id: 'bot-usage',
                channel_id: 'usage-channel',
                guild_id: 'usage-guild',
                command_message_id: 'usage-message',
                status_message_id: 'usage-status',
            }),
        });
        assert.equal(submitted.status, 201);
        const lease = await take(value => value.type === 'job');
        assert.equal(lease.job.id, submitted.body.job.id);
        const now = Math.floor(Date.now() / 1000);
        socket.send(JSON.stringify({
            type: 'event', event: 'gpu_queue', job_id: lease.job.id,
            state: 'admitted', submitted_at: now, admitted_at: now, queue_wait_seconds: 0,
        }));
        const prepared = await botFetch(`/v1/jobs/${submitted.body.job.id}/prepare`, {
            method: 'POST', body: '{}',
        });
        assert.equal(prepared.status, 200);
        const otherGuild = await botFetch('/v1/jobs', {
            method: 'POST',
            body: JSON.stringify({
                model: 'minimaxfast', prompt: 'Other server job', requester_id: 'other-user',
                origin_bot_id: 'bot-usage', channel_id: 'other-channel', guild_id: 'other-guild',
                command_message_id: 'other-message', status_message_id: 'other-status',
            }),
        });
        assert.equal(otherGuild.status, 201);
        const scopedQueue = await botFetch('/v1/queue?guild_id=usage-guild');
        assert.deepEqual(scopedQueue.body.jobs.map(job => job.id), [submitted.body.job.id]);
        const isolated = await botFetch('/v1/bots/some-other-bot/usage-events');
        assert.deepEqual(isolated.body.events, []);
        const pending = await botFetch('/v1/bots/bot-usage/usage-events');
        assert.equal(pending.body.events.length, 1);
        assert.equal(pending.body.events[0].user_id, 'usage-user');
        assert.equal(pending.body.events[0].command, 'minimaxfast');
        assert.equal(pending.body.events[0].service_tier, 'priority');
        assert.equal(pending.body.events[0].input_tokens, 1000);
        assert.ok(pending.body.events[0].cost > 0);
        const acknowledged = await botFetch('/v1/bots/bot-usage/usage-events/ack', {
            method: 'POST',
            body: JSON.stringify({ event_ids: [pending.body.events[0].event_id] }),
        });
        assert.equal(acknowledged.status, 200);
        const empty = await botFetch('/v1/bots/bot-usage/usage-events');
        assert.deepEqual(empty.body.events, []);
    } finally {
        if (socket) socket.close();
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('dispatch drain leaves an active render running and blocks the next lease', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-video-drain-'));
    const broker = new VideoBroker({
        host: '127.0.0.1', port: 0,
        dbPath: join(directory, 'queue.sqlite3'), resultsDir: join(directory, 'results'),
        botToken: 'bot-secret', workerToken: 'worker-secret',
        frontierPlanner: async prompt => ({
            intent: prompt, continuity_bible: 'drain test',
            keyframe: { recommended: false, reference_requirements: [] },
            segments: [{ target_seconds: 5, shots: [] }],
        }),
    });
    await broker.start();
    const base = `http://127.0.0.1:${broker.listeningPort()}`;
    const botFetch = async (path, init = {}) => {
        const response = await fetch(base + path, {
            ...init,
            headers: { authorization: 'Bearer bot-secret', 'content-type': 'application/json' },
        });
        return { status: response.status, body: await response.json() };
    };
    let socket;
    try {
        socket = new WebSocket(`ws://127.0.0.1:${broker.listeningPort()}/v1/worker`, {
            headers: { authorization: 'Bearer worker-secret' },
        });
        const take = socketInbox(socket);
        await new Promise((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', reject);
        });
        socket.send(JSON.stringify({
            type: 'hello', protocol: 1, worker_id: 'drain-worker',
            capabilities: ['minimaxfast'], current_job: null,
        }));
        await take(value => value.type === 'hello_ack');
        const submitted = await botFetch('/v1/jobs', {
            method: 'POST',
            body: JSON.stringify({
                model: 'minimaxfast', prompt: 'Active drain test', requester_id: 'drain-user',
                origin_bot_id: 'bot-1', channel_id: 'channel-1', guild_id: 'guild-1',
                command_message_id: 'drain-message', status_message_id: 'drain-status',
            }),
        });
        const lease = await take(value => value.type === 'job');
        assert.equal(lease.job.id, submitted.body.job.id);
        const now = Math.floor(Date.now() / 1000);
        socket.send(JSON.stringify({
            type: 'event', event: 'gpu_queue', job_id: lease.job.id,
            state: 'admitted', submitted_at: now - 30, admitted_at: now,
            queue_wait_seconds: 30,
        }));
        socket.send(JSON.stringify({
            type: 'event', event: 'plan', job_id: lease.job.id,
            estimate_low_seconds: 120, estimate_high_seconds: 240,
            stage: 'Screenplay ready',
        }));
        const estimated = await eventually(
            () => botFetch('/v1/users/drain-user/jobs'),
            value => value.body.jobs[0].estimate_ready
                && value.body.jobs[0].expected_finish_at !== null,
        );
        assert.equal(estimated.body.jobs[0].dispatch_paused, false);
        const drained = await botFetch('/v1/control/drain', {
            method: 'POST', body: JSON.stringify({ actor_id: 'deploy-test' }),
        });
        assert.equal(drained.body.state.dispatch_paused, true);
        assert.equal(drained.body.state.current_job, lease.job.id);
        assert.equal(drained.body.state.worker_busy, true);
        const stillEstimated = await botFetch('/v1/users/drain-user/jobs');
        assert.equal(stillEstimated.body.jobs[0].dispatch_paused, true);
        assert.equal(stillEstimated.body.jobs[0].estimate_ready, true);
        assert.ok(stillEstimated.body.jobs[0].expected_finish_at > 0);
    } finally {
        if (socket) socket.close();
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('desktop reserves gpuq during gaming, anchors ETA to admission, and fences terminal events', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-video-gpuq-'));
    const broker = new VideoBroker({
        host: '127.0.0.1', port: 0,
        dbPath: join(directory, 'queue.sqlite3'), resultsDir: join(directory, 'results'),
        botToken: 'bot-secret', workerToken: 'worker-secret',
    });
    await broker.start();
    const base = `http://127.0.0.1:${broker.listeningPort()}`;
    const botFetch = async (path, init = {}) => {
        const response = await fetch(base + path, {
            ...init,
            headers: { authorization: 'Bearer bot-secret', 'content-type': 'application/json' },
        });
        return { status: response.status, body: await response.json() };
    };
    let socket;
    try {
        const submitted = await botFetch('/v1/jobs', {
            method: 'POST',
            body: JSON.stringify({
                model: 'minimaxfast', prompt: 'Coordinator gate test', requester_id: 'gpuq-user',
                origin_bot_id: 'bot-1', channel_id: 'channel-1', guild_id: 'guild-1',
                command_message_id: 'gpuq-message', status_message_id: 'gpuq-status',
            }),
        });
        socket = new WebSocket(`ws://127.0.0.1:${broker.listeningPort()}/v1/worker`, {
            headers: { authorization: 'Bearer worker-secret' },
        });
        const take = socketInbox(socket);
        await new Promise((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', reject);
        });
        socket.send(JSON.stringify({
            type: 'hello', protocol: 1, worker_id: 'gpuq-worker',
            capabilities: ['minimaxfast'], current_job: null,
            scheduler: { available: true, mode: 'gaming', gaming_ready: true, health: 'healthy' },
        }));
        const hello = await take(value => value.type === 'hello_ack');
        assert.equal(hello.state.scheduler.mode, 'gaming');
        const lease = await take(value => value.type === 'job');
        assert.equal(lease.job.id, submitted.body.job.id);
        assert.match(lease.job.lease_id, /^[0-9a-f-]{36}$/);
        const submittedAt = Math.floor(Date.now() / 1000) - 90;
        socket.send(JSON.stringify({
            type: 'event', event: 'gpu_queue', job_id: lease.job.id,
            state: 'queued', submitted_at: submittedAt,
            stage: 'Waiting for GPU queue admission',
        }));
        const waiting = await eventually(
            () => botFetch(`/v1/users/gpuq-user/jobs`),
            value => value.body.jobs[0].gpu_queue_state === 'queued',
        );
        assert.equal(waiting.body.jobs[0].expected_start_at, null);
        assert.equal(waiting.body.jobs[0].expected_finish_at, null);

        const admittedAt = Math.floor(Date.now() / 1000);
        socket.send(JSON.stringify({
            type: 'event', event: 'gpu_queue', job_id: lease.job.id,
            state: 'admitted', submitted_at: submittedAt, admitted_at: admittedAt,
            queue_wait_seconds: admittedAt - submittedAt,
        }));
        socket.send(JSON.stringify({
            type: 'event', event: 'plan', job_id: lease.job.id,
            estimate_low_seconds: 120, estimate_high_seconds: 240,
            stage: 'Screenplay ready',
        }));
        const estimated = await eventually(
            () => botFetch(`/v1/users/gpuq-user/jobs`),
            value => value.body.jobs[0].gpu_queue_state === 'admitted'
                && value.body.jobs[0].estimate_ready,
        );
        assert.equal(estimated.body.jobs[0].expected_start_at, admittedAt);
        assert.equal(estimated.body.jobs[0].gpu_queue_wait_seconds, admittedAt - submittedAt);
        assert.equal(estimated.body.jobs[0].expected_finish_at, admittedAt + 180);

        socket.send(JSON.stringify({
            type: 'event', event: 'failed', event_id: 'stale-event',
            job_id: lease.job.id, lease_id: 'wrong-lease', error: 'must be ignored', retryable: false,
        }));
        await assert.rejects(() => take(value => value.type === 'event_ack', 150), /Timed out/);
        socket.send(JSON.stringify({
            type: 'event', event: 'failed', event_id: 'current-event',
            job_id: lease.job.id, lease_id: lease.job.lease_id, error: 'expected test failure', retryable: false,
        }));
        const acknowledgement = await take(value => value.type === 'event_ack');
        assert.equal(acknowledgement.event_id, 'current-event');
        const terminal = await eventually(
            () => botFetch(`/v1/users/gpuq-user/jobs`),
            value => value.body.jobs[0].status === 'failed',
        );
        assert.equal(terminal.body.jobs[0].error, 'expected test failure');
        socket.send(JSON.stringify({
            type: 'event', event: 'failed', event_id: 'current-event',
            job_id: lease.job.id, lease_id: lease.job.lease_id,
            error: 'must not be applied twice', retryable: false,
        }));
        const duplicateAcknowledgement = await take(value => value.type === 'event_ack');
        assert.equal(duplicateAcknowledgement.event_id, 'current-event');
        const unchanged = await botFetch(`/v1/users/gpuq-user/jobs`);
        assert.equal(unchanged.body.jobs[0].error, 'expected test failure');
    } finally {
        if (socket) socket.close();
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});
