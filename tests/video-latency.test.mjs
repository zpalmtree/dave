import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VideoBroker } from '../dist/VideoBroker.js';

async function fixture(options = {}) {
    const root = mkdtempSync(join(tmpdir(), 'video-latency-'));
    const broker = new VideoBroker({ host: '127.0.0.1', port: 0, dbPath: join(root, 'queue.db'),
        resultsDir: join(root, 'results'), botToken: 'bot', workerToken: 'worker',
        recoveryEnabled: true, preplanQueuedJobs: true, ...options });
    await broker.start();
    const submit = async (number) => {
        const response = await fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/jobs`, {
            method: 'POST', headers: { authorization: 'Bearer bot', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'minimax', prompt: 'A duck waves.', requester_id: '1', origin_bot_id: '2',
                channel_id: '3', command_message_id: String(number), status_message_id: String(number + 100) }),
        });
        assert.equal(response.status, 201);
        return (await response.json()).job.id;
    };
    return { broker, submit, async close() { broker.worker = null; await broker.stop(); rmSync(root, { recursive: true, force: true }); } };
}

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

function prepared() {
    return { plan: { intent: 'A duck waves.', generation_notice: '', keyframe: { recommended: false },
        segments: [{ target_seconds: 5, shots: [] }] },
        contract: { prompt: 'A duck waves.', use_source_images: false, analysis: {} },
        contract_hash: 'a'.repeat(64), prompt: 'A duck waves.', notice: '' };
}

test('recovery prepares a queued job while another renders and shares the in-flight plan with its worker', async () => {
    const entered = deferred(), finish = deferred();
    let calls = 0;
    const f = await fixture({ recoveryPlanner: async () => { calls++; entered.resolve(); await finish.promise; return prepared(); } });
    try {
        const current = await f.submit(1), next = await f.submit(2);
        await f.broker.run("UPDATE video_jobs SET status='running' WHERE public_id=?", [current]);
        f.broker.worker = { id: 'worker', currentJob: current, ready: false, capabilities: ['minimax'],
            sourceAudioVersion: 1, videoEditVersion: 4, recoveryVersion: 3, lastHeartbeat: Date.now(),
            socket: { close() {}, terminate() {} } };
        await f.broker.scheduleNextQueuedPreparation();
        await entered.promise;
        const row = await f.broker.get('SELECT * FROM video_jobs WHERE public_id=?', [next]);
        const fromWorker = f.broker.prepareRecoveryJob(row, true);
        finish.resolve();
        assert.deepEqual(await fromWorker, { prepared: prepared() });
        assert.equal(calls, 1);
        const saved = await f.broker.get('SELECT recovery_json FROM video_jobs WHERE public_id=?', [next]);
        assert.equal(JSON.parse(saved.recovery_json).prepared.contract_hash, 'a'.repeat(64));
    } finally { finish.resolve(); await f.close(); }
});

test('concurrent opening fallback persistence preserves the newest checkpoint', async () => {
    const f = await fixture();
    try {
        const id = await f.submit(3);
        const imageState = {}, checkpointState = {};
        const saveImage = f.broker.recoveryPersister(id, imageState);
        const saveCheckpoint = f.broker.recoveryPersister(id, checkpointState);
        checkpointState.checkpoint = { scenes: { 0: { video_accepted: 'verified' } } };
        imageState.local_openings = { 1: { local_image_required: true } };
        await Promise.all([saveCheckpoint(), saveImage()]);
        const state = JSON.parse((await f.broker.get('SELECT recovery_json FROM video_jobs WHERE public_id=?', [id])).recovery_json);
        assert.deepEqual(state, { ...checkpointState, ...imageState });
    } finally { await f.close(); }
});

test('repeated admissions sum within a snapshot while replaying it stays idempotent', async () => {
    const f = await fixture();
    try {
        const id = await f.submit(4);
        const row = await f.broker.get('SELECT * FROM video_jobs WHERE public_id=?', [id]);
        const metrics = { schema_version: 1, model: 'minimax', generator_model: 'h3', total_seconds: 400,
            output: {}, gpu: {}, environment: {}, flags: {}, spans: [70, 250, 179].map(duration_seconds => ({
                source: 'worker', name: 'gpu_queue_wait', duration_seconds })) };
        await f.broker.storeWorkerMetrics(row, metrics);
        await f.broker.storeWorkerMetrics(row, metrics);
        const spans = await f.broker.all('SELECT duration_seconds FROM video_job_spans WHERE job_public_id=?', [id]);
        assert.deepEqual(spans, [{ duration_seconds: 499 }]);
        assert.equal((await f.broker.get('SELECT gpu_queue_wait_seconds FROM video_jobs WHERE public_id=?', [id])).gpu_queue_wait_seconds, 499);
    } finally { await f.close(); }
});

test('identical provider attempt numbers from different scenes retain separate timings', async () => {
    const f = await fixture();
    try {
        const id = await f.submit(5);
        const row = await f.broker.get('SELECT * FROM video_jobs WHERE public_id=?', [id]);
        const first = f.broker.providerHooks(row), second = f.broker.providerHooks(row);
        const attempt = { stage: 'keyframe_review', provider: 'test', model: 'test', attempt: 1,
            outcome: 'accepted', durationSeconds: 12 };
        await first.onAttempt(attempt);
        await second.onAttempt({ ...attempt, durationSeconds: 20 });
        await first.onAttempt(attempt);
        const timing = await f.broker.get('SELECT COUNT(*) n, SUM(duration_seconds) seconds FROM video_provider_attempt_metrics WHERE job_public_id=?', [id]);
        assert.deepEqual(timing, { n: 2, seconds: 32 });
    } finally { await f.close(); }
});

test('provider timing migration preserves existing rows and its lookup index', async () => {
    const { default: sqlite3 } = await import('sqlite3');
    const root = mkdtempSync(join(tmpdir(), 'video-latency-migration-'));
    const dbPath = join(root, 'old.db');
    const db = new sqlite3.Database(dbPath);
    await new Promise((resolve, reject) => db.exec(`CREATE TABLE video_provider_attempt_metrics (
        job_public_id TEXT NOT NULL, stage TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        attempt INTEGER NOT NULL, outcome TEXT NOT NULL, service_tier TEXT, duration_seconds REAL NOT NULL,
        detail TEXT, recorded_at INTEGER NOT NULL, PRIMARY KEY(job_public_id, stage, provider, model, attempt));
        CREATE INDEX video_provider_attempt_metrics_job_idx ON video_provider_attempt_metrics(job_public_id, recorded_at);
        INSERT INTO video_provider_attempt_metrics VALUES('old', 'review', 'test', 'test', 1, 'success', NULL, 42, NULL, 1);`,
    error => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    const f = await fixture({ dbPath });
    try {
        assert.deepEqual(await f.broker.get('SELECT invocation_id, duration_seconds FROM video_provider_attempt_metrics'),
            { invocation_id: 'legacy', duration_seconds: 42 });
        assert.ok(await f.broker.get("SELECT name FROM sqlite_master WHERE type='index' AND name='video_provider_attempt_metrics_job_idx'"));
    } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});
