import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { VideoBroker } from '../dist/VideoBroker.js';

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
                model: 'minimaxdraft',
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
            capabilities: ['minimaxdraft'],
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
        assert.ok(waiting.body.jobs[0].expected_start_at);

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

test('broker prepares a queued screenplay and keyframe while the GPU worker is busy', async () => {
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
                segments: [],
            };
        },
        keyframeGenerator: async plan => {
            keyframeCalls.push(plan.intent);
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
                && value.keyframeCalls.includes('Prepared while busy'),
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
        const planResponse = await workerFetch(`/v1/worker/jobs/${second.id}/plan`);
        assert.equal(planResponse.status, 200);
        assert.equal((await planResponse.json()).cached, true);
        const frameResponse = await workerFetch(`/v1/worker/jobs/${second.id}/keyframe`);
        assert.equal(frameResponse.status, 200);
        assert.equal(frameResponse.headers.get('x-video-keyframe-provider'), 'test-provider');
        assert.equal(plannerCalls.filter(prompt => prompt === 'Prepared while busy').length, 1);
        assert.equal(keyframeCalls.filter(prompt => prompt === 'Prepared while busy').length, 1);
    } finally {
        if (socket) socket.close();
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('broker serves a cached frontier frame and gives a user attachment precedence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-video-keyframe-'));
    const generatedBytes = Buffer.from('generated-keyframe');
    const attachedBytes = Buffer.from('attached-keyframe');
    let keyframeCalls = 0;
    const plannerSawSource = [];
    const plan = {
        intent: 'test',
        continuity_bible: 'test continuity',
        keyframe: {
            recommended: true,
            reason: 'identity anchor',
            prompt: 'three racers',
            motion_contract: {
                subject_orientation: 'right',
                gaze_direction: 'right',
                travel_direction: 'right',
                camera_relation: 'rear three-quarter',
                first_second_action: 'accelerate right',
            },
        },
        segments: [],
    };
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
            return plan;
        },
        keyframeGenerator: async () => {
            keyframeCalls += 1;
            return {
                bytes: generatedBytes,
                mimeType: 'image/png',
                provider: 'test-provider',
                model: 'test-image-model',
            };
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
        const secondPlan = await workerFetch(`/v1/worker/jobs/${second.body.job.id}/plan`);
        assert.equal(secondPlan.status, 200);
        const suppliedFrame = await workerFetch(`/v1/worker/jobs/${second.body.job.id}/keyframe`);
        assert.equal(suppliedFrame.status, 200);
        assert.equal(suppliedFrame.headers.get('x-video-keyframe-provider'), 'user-attachment');
        assert.deepEqual(Buffer.from(await suppliedFrame.arrayBuffer()), attachedBytes);
        assert.deepEqual(plannerSawSource, [false, true]);
        assert.equal(keyframeCalls, 1);
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
