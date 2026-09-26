import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VideoBroker } from '../dist/VideoBroker.js';
import { recoveryVideoProgress, recoveryCheckpointProgress } from '../dist/VideoProgress.js';
import { formatGlobalVideoQueueJob, globalVideoQueueEmbeds } from '../dist/VideoGeneration.js';

function recoveryState(durations = [5, 10, 10, 15, 10, 10]) {
    return {
        prepared: { prompt: 'A six-scene story.', contract_hash: 'contract',
            contract: { prompt: 'A six-scene story.', use_source_images: false },
            plan: { segments: durations.map(target_seconds => ({ target_seconds })) } },
        checkpoint: { scenes: { 0: { video_accepted: 'first' }, 1: { video_accepted: 'second' },
            2: { video_accepted: 'third' }, 3: { video_attempts: 1, render_interrupted: true } } },
    };
}

function legacyRow(state = recoveryState()) {
    return { recovery_version: 3, recovery_json: JSON.stringify(state), status: 'running',
        progress: 0.98, progress_scope: 'job', segment_index: 1, segment_count: 1, segment_progress: 0.9 };
}

test('recovery maps the stuck 98% and 1/1 to duration-weighted progress across six scenes', () => {
    const row = legacyRow();
    const progress = recoveryVideoProgress(row);
    assert.equal(progress.segment_index, 4);
    assert.equal(progress.segment_count, 6);
    assert.equal(progress.segment_progress, 0.9);
    assert.ok(progress.progress > 0.62 && progress.progress < 0.64);
    assert.equal(recoveryVideoProgress({ ...row, ...progress }).progress, progress.progress,
        'Normalizing a stored global sample again must not double-scale it');
    assert.equal(recoveryVideoProgress({ ...row, recovery_version: 0 }), null);
    assert.equal(recoveryVideoProgress({ ...row, status: 'delivered' }), null);
});

test('checkpoints reset stale heartbeats at scene boundaries and retries, and reserve delivery progress', () => {
    const state = recoveryState();
    let row = legacyRow(state);
    row = { ...row, ...recoveryVideoProgress(row) };
    state.checkpoint.scenes[3].video_accepted = 'fourth';
    state.checkpoint.scenes[4] = { video_attempts: 1, render_interrupted: true };
    const boundary = recoveryCheckpointProgress(row, state);
    assert.equal(boundary.segment_index, 5);
    assert.equal(boundary.segment_progress, null);
    row = { ...row, ...boundary, recovery_json: JSON.stringify(state) };
    const heartbeat = { type: 'heartbeat', segment_progress: 1, progress: 0.98, segment_count: 1, segment_index: 1 };
    assert.equal(recoveryVideoProgress(row, heartbeat).progress, boundary.progress);
    const started = recoveryVideoProgress(row, { ...heartbeat, type: 'event', stage: 'Generating H3 segment 1/1' });
    assert.equal(started.segment_progress, 0);
    row = { ...row, ...started };
    const sampled = recoveryVideoProgress(row, { ...heartbeat, segment_progress: 0.5 });
    assert.ok(sampled.progress > boundary.progress);
    row = { ...row, ...sampled };
    state.checkpoint.scenes[4].video_attempts = 2;
    const retry = recoveryCheckpointProgress(row, state);
    assert.equal(retry.segment_progress, null);
    assert.equal(retry.progress, boundary.progress, 'A failed attempt is not completed work');
    state.checkpoint.scenes[4].video_accepted = 'fifth';
    state.checkpoint.scenes[5] = { video_accepted: 'sixth' };
    row.recovery_json = JSON.stringify(state);
    assert.equal(recoveryVideoProgress(row).progress, 0.98);
    assert.equal(recoveryVideoProgress({ ...row, status: 'uploading' }).progress, 0.99);
});

test('broker repairs a live legacy job, preserves it across restart, and projects the waiting job from full progress', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'video-progress-'));
    const options = { host: '127.0.0.1', port: 0, dbPath: join(directory, 'queue.sqlite3'),
        resultsDir: join(directory, 'results'), botToken: 'bot', workerToken: 'worker',
        recoveryEnabled: true, preplanQueuedJobs: false };
    let broker = new VideoBroker(options);
    await broker.start();
    const request = async (path, body, worker = false) => {
        const response = await fetch(`http://127.0.0.1:${broker.listeningPort()}${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { authorization: `Bearer ${worker ? 'worker' : 'bot'}`, 'content-type': 'application/json',
                ...(worker ? { 'x-video-lease-id': 'lease' } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const result = await response.json();
        assert.ok(response.ok, JSON.stringify(result));
        return result;
    };
    const setWorker = id => { broker.worker = { id: 'desktop', currentJob: id, leaseId: 'lease', ready: false,
        capabilities: ['minimax'], recoveryVersion: 3, lastHeartbeat: Date.now(),
        scheduler: { available: false }, socket: { send() {}, close() {}, terminate() {} } }; };
    try {
        const jobs = [];
        for (let index = 0; index < 2; index++) {
            jobs.push((await request('/v1/jobs', { model: 'minimax', prompt: 'A six-scene story.',
                requester_id: '1', origin_bot_id: '2', channel_id: '3',
                command_message_id: String(index), status_message_id: `status-${index}` })).job.id);
        }
        const id = jobs[0], state = recoveryState();
        const now = Math.floor(Date.now() / 1000);
        setWorker(id);
        await broker.run(`UPDATE video_jobs SET status='running', worker_id='desktop', lease_token='lease',
            recovery_version=3, recovery_json=?, progress=0.98, progress_scope='job', segment_index=1,
            segment_count=1, segment_progress=0.9, started_at=?, gpu_admitted_at=?, gpu_queue_state='admitted',
            estimate_low_seconds=300, estimate_high_seconds=600 WHERE public_id=?`,
        [JSON.stringify(state), now - 2400, now - 2200, id]);
        const queue = () => request('/v1/queue');
        let view = (await queue()).jobs.find(job => job.id === id);
        assert.equal(view.segment_index, 4);
        assert.equal(view.segment_count, 6);
        assert.ok(view.progress < 0.65);
        assert.ok(view.expected_finish_at > now + 900, 'Measured pace must not predict completion in 30 seconds');
        const waiting = (await queue()).jobs.find(job => job.id === jobs[1]);
        assert.ok(waiting.expected_start_at >= view.expected_finish_at);
        const heartbeat = { type: 'heartbeat', job_id: id, progress: 0.98, progress_scope: 'job',
            segment_index: 1, segment_count: 1, segment_progress: 0.95 };
        await broker.handleWorkerMessage(heartbeat);
        view = (await queue()).jobs.find(job => job.id === id);
        assert.equal(view.segment_progress, 0.95);
        assert.ok(view.progress < 0.65, 'A heartbeat must not restore the old 98% floor');
        await broker.handleWorkerMessage({ type: 'event', event: 'plan', job_id: id,
            estimate_low_seconds: 300, estimate_high_seconds: 600 });
        view = (await queue()).jobs.find(job => job.id === id);
        assert.equal(view.estimate_low_seconds, 1260);
        assert.equal(view.estimate_high_seconds, 2520);
        assert.equal(view.status, 'running');
        await broker.stop();
        broker = new VideoBroker(options);
        await broker.start();
        setWorker(id);
        view = (await queue()).jobs.find(job => job.id === id);
        assert.equal(view.segment_index, 4);
        assert.equal(view.segment_progress, 0.95);
        state.checkpoint.scenes[3].video_accepted = 'fourth';
        state.checkpoint.scenes[4] = { video_attempts: 1, render_interrupted: true };
        await request(`/v1/worker/jobs/${id}/recovery/checkpoint`, { contract_hash: 'contract', checkpoint: state.checkpoint }, true);
        await broker.handleWorkerMessage(heartbeat);
        view = (await queue()).jobs.find(job => job.id === id);
        assert.equal(view.segment_index, 5);
        assert.equal(view.segment_progress, null, 'Previous-scene heartbeats must stay fenced after the checkpoint');
        await broker.handleWorkerMessage({ ...heartbeat, type: 'event', event: 'progress',
            stage: 'Generating H3 segment 1/1', segment_progress: 0 });
        await broker.handleWorkerMessage({ ...heartbeat, type: 'event', event: 'progress',
            stage: 'Sampling 50%', segment_progress: 0.5 });
        view = (await queue()).jobs.find(job => job.id === id);
        assert.equal(view.segment_index, 5);
        assert.equal(view.segment_count, 6);
        assert.equal(view.segment_progress, 0.5);
        assert.ok(view.progress > 0.73 && view.progress < 0.74);
        const embed = globalVideoQueueEmbeds([view], null)[0];
        assert.match(embed.description, /segment 5\/6/);
        assert.match(embed.description, /ETA ~.+ from this check/);
        assert.doesNotMatch(embed.description, /<t:/);
        assert.match(formatGlobalVideoQueueJob({ ...view, expected_finish_at: now - 60 }, null),
            /ETA being recalculated/);
        assert.match(embed.footer.text, /Snapshot at command time/);
        assert.ok(Number.isFinite(Date.parse(embed.timestamp)));
    } finally {
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});
