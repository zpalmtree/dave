import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { VideoBroker } from '../dist/VideoBroker.js';
import {
    formatQwenImageStatus,
    parseQwenImageArgs,
    qwenImageReferencesFromMessages,
} from '../dist/QwenImage.js';

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

async function startBroker(t) {
    const directory = mkdtempSync(join(tmpdir(), 'dave-qwen-image-'));
    const broker = new VideoBroker({
        host: '127.0.0.1', port: 0,
        dbPath: join(directory, 'queue.sqlite3'), resultsDir: join(directory, 'results'),
        botToken: 'bot-secret', workerToken: 'worker-secret', preplanQueuedJobs: false,
        sourceImageDownloader: async (descriptor, target) => {
            mkdirSync(target, { recursive: true });
            const path = join(target, 'source.png');
            writeFileSync(path, `reference:${descriptor.name}`);
            return { path, mimeType: 'image/png', bytes: 10 };
        },
    });
    await broker.start();
    const sockets = [];
    t.after(async () => {
        await Promise.all(sockets.map(socket => socket.readyState === WebSocket.CLOSED
            ? undefined
            : new Promise(resolve => {
                socket.once('close', resolve);
                socket.close();
            })));
        await new Promise(resolve => setTimeout(resolve, 50));
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${broker.listeningPort()}`;
    const bot = async (path, body) => {
        const response = await fetch(base + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { authorization: 'Bearer bot-secret', 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
    };
    const connect = async (hello = {}) => {
        const socket = new WebSocket(`ws://127.0.0.1:${broker.listeningPort()}/v1/worker`, {
            headers: { authorization: 'Bearer worker-secret' },
        });
        sockets.push(socket);
        const take = socketInbox(socket);
        await new Promise((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', reject);
        });
        socket.send(JSON.stringify({
            type: 'hello', protocol: 1, worker_id: 'desktop', capabilities: ['minimax'],
            current_job: null, image_models: ['qwenimage', 'qwenedit'], ...hello,
        }));
        await take(value => value.type === 'hello_ack');
        return { socket, take, send: value => socket.send(JSON.stringify(value)) };
    };
    const worker = async (path, init) => fetch(base + path, {
        ...init,
        headers: { authorization: 'Bearer worker-secret', ...(init.headers || {}) },
    });
    return { bot, connect, worker };
}

let messageCounter = 0;
function imageRequest(overrides = {}) {
    messageCounter += 1;
    return {
        model: 'qwenimage', prompt: 'A lighthouse at dawn', requester_id: 'user-1', origin_bot_id: 'bot-1',
        channel_id: 'channel-1', command_message_id: `command-${messageCounter}`,
        status_message_id: `status-${messageCounter}`, ...overrides,
    };
}

function videoRequest() {
    messageCounter += 1;
    return {
        model: 'minimax', prompt: 'A video', requester_id: 'user-2', origin_bot_id: 'bot-1',
        channel_id: 'channel-1', command_message_id: `video-${messageCounter}`, status_message_id: `vstatus-${messageCounter}`,
    };
}

async function uploadResult(worker, job, bytes = Buffer.from('png-bytes')) {
    return worker(`/v1/worker/image-jobs/${job.id}/result`, {
        method: 'PUT',
        headers: {
            'content-type': 'image/png',
            'content-length': String(bytes.length),
            'x-content-sha256': createHash('sha256').update(bytes).digest('hex'),
            'x-video-lease': job.lease_id,
        },
        body: bytes,
    });
}

test('image jobs lease ahead of queued videos and deliver the uploaded image', async t => {
    const { bot, connect, worker } = await startBroker(t);
    assert.equal((await bot('/v1/jobs', videoRequest())).status, 201);
    const submitted = await bot('/v1/image-jobs', imageRequest({
        model: 'qwenedit', prompt: 'Add a hat', aspect: '9:16', fast: true, prompt_tease: 'Pervert.',
        references: [{ url: 'https://cdn.discordapp.com/attachments/1/2/a.png', mime_type: 'image/png', bytes: 10, name: 'a.png' }],
    }));
    assert.equal(submitted.status, 201);
    assert.equal(submitted.body.job.queue_position, 1);

    const desktop = await connect();
    const lease = await desktop.take(value => value.type === 'image_job');
    assert.deepEqual(
        { ...lease.job, lease_id: undefined },
        { id: submitted.body.job.id, model: 'qwenedit', prompt: 'Add a hat', aspect: '9:16', fast: true, reference_count: 1, lease_id: undefined },
    );
    const stale = await worker(`/v1/worker/image-jobs/${lease.job.id}/reference?index=0`, {
        method: 'POST', headers: { 'x-video-lease': 'wrong' },
    });
    assert.equal(stale.status, 409);
    const reference = await worker(`/v1/worker/image-jobs/${lease.job.id}/reference?index=0`, {
        method: 'POST', headers: { 'x-video-lease': lease.job.lease_id },
    });
    assert.equal(await reference.text(), 'reference:a.png');

    // The video waits until the image job finishes.
    await assert.rejects(desktop.take(value => value.type === 'job', 300));

    assert.equal((await uploadResult(worker, lease.job)).status, 200);
    desktop.send({ type: 'image_event', event: 'complete', job_id: lease.job.id, lease_id: lease.job.lease_id, runtime_seconds: 12.5 });
    desktop.send({ type: 'ready' });
    const video = await desktop.take(value => value.type === 'job');
    assert.equal(video.job.model, 'minimax');

    const [ready] = (await bot('/v1/bots/bot-1/image-jobs')).body.jobs;
    assert.equal(ready.status, 'ready');
    assert.equal(ready.prompt_tease, 'Pervert.');
    assert.equal(ready.runtime_seconds, 12.5);
    assert.equal(readFileSync(ready.result_path, 'utf8'), 'png-bytes');
    await bot(`/v1/image-jobs/${ready.id}/notified`, {});
    assert.deepEqual((await bot('/v1/bots/bot-1/image-jobs')).body.jobs, []);
});

test('image submissions are validated and limited per user', async t => {
    const { bot } = await startBroker(t);
    assert.equal((await bot('/v1/image-jobs', imageRequest({ model: 'qwenedit' }))).status, 400);
    assert.equal((await bot('/v1/image-jobs', imageRequest({ aspect: '5:4' }))).status, 400);
    assert.equal((await bot('/v1/image-jobs', imageRequest({ fast: true }))).status, 400);
    assert.equal((await bot('/v1/image-jobs', imageRequest({ prompt: '  ' }))).status, 400);
    const request = imageRequest();
    assert.equal((await bot('/v1/image-jobs', request)).status, 201);
    const duplicate = await bot('/v1/image-jobs', request);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal((await bot('/v1/image-jobs', imageRequest())).status, 201);
    assert.equal((await bot('/v1/image-jobs', imageRequest())).status, 201);
    assert.equal((await bot('/v1/image-jobs', imageRequest())).status, 409);
    assert.equal((await bot('/v1/image-jobs', imageRequest({ is_admin: true }))).status, 201);
});

test('a worker without image support never receives image jobs', async t => {
    const { bot, connect } = await startBroker(t);
    assert.equal((await bot('/v1/image-jobs', imageRequest())).status, 201);
    assert.equal((await bot('/v1/jobs', videoRequest())).status, 201);
    const legacy = await connect({ image_models: undefined });
    const lease = await legacy.take(value => value.type === 'job' || value.type === 'image_job');
    assert.equal(lease.type, 'job');
});

test('interrupted image jobs retry once, then fail with the worker error', async t => {
    const { bot, connect } = await startBroker(t);
    const submitted = await bot('/v1/image-jobs', imageRequest());
    let desktop = await connect();
    const first = await desktop.take(value => value.type === 'image_job');
    desktop.socket.close();
    await new Promise(resolve => desktop.socket.once('close', resolve));
    await new Promise(resolve => setTimeout(resolve, 100));
    const [requeued] = (await bot('/v1/bots/bot-1/image-jobs')).body.jobs;
    assert.equal(requeued.status, 'queued');

    desktop = await connect();
    const second = await desktop.take(value => value.type === 'image_job');
    assert.equal(second.job.id, first.job.id);
    assert.notEqual(second.job.lease_id, first.job.lease_id);
    desktop.send({ type: 'image_event', event: 'complete', job_id: second.job.id, lease_id: first.job.lease_id });
    desktop.send({
        type: 'image_event', event: 'failed', job_id: second.job.id, lease_id: second.job.lease_id,
        error: 'Failed while generating the image: out of memory', retryable: true,
    });
    desktop.send({ type: 'ready' });
    await new Promise(resolve => setTimeout(resolve, 100));
    const [failed] = (await bot('/v1/bots/bot-1/image-jobs')).body.jobs;
    assert.equal(failed.id, submitted.body.job.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /out of memory/);
    assert.match(formatQwenImageStatus(failed), /Failed: Failed while generating the image: out of memory/);
});

test('a reconnecting worker keeps its in-flight image job only with the current lease', async t => {
    const { bot, connect } = await startBroker(t);
    await bot('/v1/image-jobs', imageRequest());
    const desktop = await connect();
    const lease = await desktop.take(value => value.type === 'image_job');
    // A second connection replaces the first without it going offline first.
    const resumed = await connect({ current_image_job: { id: lease.job.id, lease_id: lease.job.lease_id } });
    await assert.rejects(resumed.take(value => value.type === 'image_cancel', 300));
    assert.equal((await bot('/v1/bots/bot-1/image-jobs')).body.jobs[0].status, 'running');

    const stale = await connect({ current_image_job: { id: lease.job.id, lease_id: 'old-lease' } });
    await stale.take(value => value.type === 'image_cancel' && value.job_id === lease.job.id);
});

test('qwen image arguments and attachments are parsed like the other image commands', () => {
    assert.deepEqual(parseQwenImageArgs('  a duck  '), { prompt: 'a duck' });
    assert.deepEqual(parseQwenImageArgs('--aspect 9:16 a tall duck'), { prompt: 'a tall duck', aspect: '9:16' });
    assert.deepEqual(parseQwenImageArgs('--ar=16:9 a wide duck'), { prompt: 'a wide duck', aspect: '16:9' });
    assert.deepEqual(parseQwenImageArgs('--fast --aspect 1:1 a duck'), { prompt: 'a duck', aspect: '1:1', fast: true });
    assert.deepEqual(parseQwenImageArgs('--aspect 1:1 --fast a duck'), { prompt: 'a duck', aspect: '1:1', fast: true });
    assert.deepEqual(parseQwenImageArgs('--faster duck'), { prompt: '--faster duck' });
    assert.throws(() => parseQwenImageArgs('--aspect 5:4 a duck'), /Aspect must be one of/);

    const attachment = (name, contentType, size = 100) => [name, { url: `https://cdn.discordapp.com/${name}`, name, contentType, size }];
    const command = { attachments: new Map([attachment('a.png', 'image/png'), attachment('notes.txt', 'text/plain')]) };
    const reply = { attachments: new Map([attachment('b.jpg', null)]) };
    assert.deepEqual(qwenImageReferencesFromMessages([command, reply]).map(value => [value.name, value.mime_type]), [
        ['a.png', 'image/png'],
        ['b.jpg', 'image/jpeg'],
    ]);
    assert.deepEqual(qwenImageReferencesFromMessages([{ attachments: new Map() }, null]), []);
    assert.throws(() => qwenImageReferencesFromMessages([{ attachments: new Map([attachment('a.gif', 'image/gif')]) }]), /PNG, JPEG, or WebP/);
    const four = { attachments: new Map(['a', 'b', 'c', 'd'].map(name => attachment(`${name}.png`, 'image/png'))) };
    assert.throws(() => qwenImageReferencesFromMessages([four]), /at most 3/);

    const queued = { model: 'qwenimage', status: 'queued', queue_position: 2, video_rendering: true, worker_online: true };
    assert.equal(formatQwenImageStatus(queued), '**Qwen Image 2.1** · Queued behind 1 image; waiting for the current video render to finish.');
    assert.equal(formatQwenImageStatus({ ...queued, worker_online: false }), '**Qwen Image 2.1** · Queued; the desktop worker is offline.');
    assert.equal(formatQwenImageStatus({ model: 'qwenedit', status: 'running', stage: 'Generating' }), '**Qwen-Image-Edit-2511** · Generating…');
    assert.equal(formatQwenImageStatus({ model: 'qwenedit', fast: true, status: 'running', stage: 'Generating' }), '**Qwen-Image-Edit-2511 (fast)** · Generating…');
});
