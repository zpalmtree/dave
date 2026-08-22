import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
