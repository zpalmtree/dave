import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { pathToFileURL } from 'url';
import sqlite3 from 'sqlite3';
import { WebSocket, WebSocketServer } from 'ws';

import {
    ACTIVE_VIDEO_STATUSES,
    UNFINISHED_VIDEO_STATUSES,
    VIDEO_MAX_GLOBAL_JOBS,
    VIDEO_MAX_USER_JOBS,
    VIDEO_MODELS,
    VIDEO_PROMPT_MAX_LENGTH,
    VIDEO_PROTOCOL_VERSION,
    VIDEO_RESULT_MAX_BYTES,
    VideoJobStatus,
    VideoJobView,
    VideoModelId,
    VideoWorkerHello,
    isVideoModel,
} from './VideoProtocol.js';
import { loadVideoSettings } from './VideoSettings.js';
import { VIDEO_PLANNER_MODEL, createFrontierVideoPlan } from './VideoFrontierPlanner.js';

const ACTIVE_SQL = ACTIVE_VIDEO_STATUSES.map(status => `'${status}'`).join(',');
const UNFINISHED_SQL = UNFINISHED_VIDEO_STATUSES.map(status => `'${status}'`).join(',');

interface BrokerOptions {
    host: string;
    port: number;
    dbPath: string;
    resultsDir: string;
    botToken: string;
    workerToken: string;
    heartbeatTimeoutMs?: number;
}

interface WorkerConnection {
    socket: WebSocket;
    id: string;
    capabilities: VideoModelId[];
    lastHeartbeat: number;
    currentJob: string | null;
    ready: boolean;
}

interface JobRow {
    id: number;
    public_id: string;
    idempotency_key: string;
    model: VideoModelId;
    prompt: string;
    requester_id: string;
    origin_bot_id: string;
    channel_id: string;
    guild_id: string | null;
    command_message_id: string;
    status_message_id: string;
    status: VideoJobStatus;
    attempt: number;
    estimate_low_seconds: number;
    estimate_high_seconds: number;
    stage: string | null;
    progress: number | null;
    worker_id: string | null;
    lease_expires_at: number | null;
    result_path: string | null;
    result_sha256: string | null;
    result_bytes: number | null;
    error: string | null;
    created_at: number;
    updated_at: number;
    started_at: number | null;
    completed_at: number | null;
    delivered_at: number | null;
    notified_at: number | null;
    planner_json: string | null;
    planner_model: string | null;
}

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

function statusPlaceholders(values: readonly string[]): string {
    return values.map(() => '?').join(',');
}

function safeToken(actual: string, expected: string): boolean {
    if (!actual || !expected) return false;
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length
        && timingSafeEqual(actualBuffer, expectedBuffer);
}

function bearer(req: IncomingMessage): string {
    const header = req.headers.authorization || '';
    return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': payload.length,
        'cache-control': 'no-store',
    });
    res.end(payload);
}

async function readJson(req: IncomingMessage, maxBytes = 256 * 1024): Promise<any> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += buffer.length;
        if (length > maxBytes) throw new Error('Request body is too large.');
        chunks.push(buffer);
    }
    if (length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export class VideoBroker {
    private readonly options: BrokerOptions;
    private readonly db: sqlite3.Database;
    private readonly server = createServer((req, res) => void this.handleHttp(req, res));
    private readonly wsServer = new WebSocketServer({ noServer: true });
    private worker: WorkerConnection | null = null;
    private writeChain: Promise<unknown> = Promise.resolve();
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private cleanupTimer: NodeJS.Timeout | null = null;

    constructor(options: BrokerOptions) {
        this.options = options;
        mkdirSync(dirname(resolve(options.dbPath)), { recursive: true });
        mkdirSync(resolve(options.resultsDir), { recursive: true });
        this.db = new sqlite3.Database(options.dbPath);
        this.server.on('upgrade', (req, socket, head) => {
            const url = new URL(req.url || '/', 'http://localhost');
            if (url.pathname !== '/v1/worker' || !safeToken(bearer(req), this.options.workerToken)) {
                socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                socket.destroy();
                return;
            }
            this.wsServer.handleUpgrade(req, socket, head, ws => this.acceptWorker(ws));
        });
    }

    private run(sql: string, params: any[] = []): Promise<{ changes: number; lastID: number }> {
        return new Promise((resolvePromise, reject) => {
            this.db.run(sql, params, function (err) {
                if (err) reject(err);
                else resolvePromise({ changes: this.changes, lastID: this.lastID });
            });
        });
    }

    private get<T>(sql: string, params: any[] = []): Promise<T | undefined> {
        return new Promise((resolvePromise, reject) => {
            this.db.get(sql, params, (err, row) => err ? reject(err) : resolvePromise(row as T | undefined));
        });
    }

    private all<T>(sql: string, params: any[] = []): Promise<T[]> {
        return new Promise((resolvePromise, reject) => {
            this.db.all(sql, params, (err, rows) => err ? reject(err) : resolvePromise(rows as T[]));
        });
    }

    private withWriteLock<T>(callback: () => Promise<T>): Promise<T> {
        const result = this.writeChain.then(callback, callback);
        this.writeChain = result.then(() => undefined, () => undefined);
        return result;
    }

    async initialize(): Promise<void> {
        await this.run('PRAGMA journal_mode = WAL');
        await this.run('PRAGMA busy_timeout = 5000');
        await this.run(`CREATE TABLE IF NOT EXISTS video_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            public_id TEXT NOT NULL UNIQUE,
            idempotency_key TEXT NOT NULL UNIQUE,
            model TEXT NOT NULL,
            prompt TEXT NOT NULL,
            requester_id TEXT NOT NULL,
            origin_bot_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            guild_id TEXT,
            command_message_id TEXT NOT NULL,
            status_message_id TEXT NOT NULL,
            status TEXT NOT NULL,
            attempt INTEGER NOT NULL DEFAULT 0,
            estimate_low_seconds INTEGER NOT NULL,
            estimate_high_seconds INTEGER NOT NULL,
            stage TEXT,
            progress REAL,
            worker_id TEXT,
            lease_expires_at INTEGER,
            result_path TEXT,
            result_sha256 TEXT,
            result_bytes INTEGER,
            error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            started_at INTEGER,
            completed_at INTEGER,
            delivered_at INTEGER,
            notified_at INTEGER,
            planner_json TEXT,
            planner_model TEXT
        )`);
        const jobColumns = await this.all<{ name: string }>('PRAGMA table_info(video_jobs)');
        const columnNames = new Set(jobColumns.map(column => column.name));
        if (!columnNames.has('planner_json')) {
            await this.run('ALTER TABLE video_jobs ADD COLUMN planner_json TEXT');
        }
        if (!columnNames.has('planner_model')) {
            await this.run('ALTER TABLE video_jobs ADD COLUMN planner_model TEXT');
        }
        await this.run(`CREATE INDEX IF NOT EXISTS video_jobs_queue_idx
            ON video_jobs(status, id)`);
        await this.run(`CREATE INDEX IF NOT EXISTS video_jobs_origin_idx
            ON video_jobs(origin_bot_id, status, updated_at)`);
        await this.run(`CREATE TABLE IF NOT EXISTS video_control (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            paused_until INTEGER,
            updated_by TEXT,
            updated_at INTEGER NOT NULL
        )`);
        await this.run(
            `INSERT OR IGNORE INTO video_control(id, paused_until, updated_by, updated_at)
             VALUES(1, NULL, NULL, ?)`,
            [nowSeconds()],
        );
        await this.run(`CREATE TABLE IF NOT EXISTS video_runtime_samples (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            model TEXT NOT NULL,
            runtime_seconds REAL NOT NULL,
            recorded_at INTEGER NOT NULL
        )`);
    }

    async start(): Promise<void> {
        await this.initialize();
        await new Promise<void>((resolvePromise, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.options.port, this.options.host, () => resolvePromise());
        });
        this.heartbeatTimer = setInterval(() => void this.checkHeartbeat(), 5000);
        this.cleanupTimer = setInterval(() => void this.cleanupFiles(), 60 * 60 * 1000);
        console.log(`Video broker listening on ${this.options.host}:${this.options.port}`);
    }

    listeningPort(): number {
        const address = this.server.address();
        if (!address || typeof address === 'string') throw new Error('Video broker is not listening.');
        return address.port;
    }

    async stop(): Promise<void> {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);
        if (this.worker) this.worker.socket.close(1001, 'broker shutdown');
        await new Promise<void>(resolvePromise => this.server.close(() => resolvePromise()));
        await new Promise<void>((resolvePromise, reject) => this.db.close(err => err ? reject(err) : resolvePromise()));
    }

    private async control(): Promise<{ paused_until: number | null }> {
        const row = await this.get<{ paused_until: number | null }>(
            'SELECT paused_until FROM video_control WHERE id = 1',
        );
        const paused = row?.paused_until && row.paused_until > nowSeconds() ? row.paused_until : null;
        if (!paused && row?.paused_until) {
            await this.run(
                'UPDATE video_control SET paused_until = NULL, updated_at = ? WHERE id = 1',
                [nowSeconds()],
            );
        }
        return { paused_until: paused };
    }

    private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
        try {
            const url = new URL(req.url || '/', 'http://localhost');
            if (url.pathname === '/health' && req.method === 'GET') {
                writeJson(res, 200, { ok: true, protocol: VIDEO_PROTOCOL_VERSION });
                return;
            }
            if (url.pathname.startsWith('/v1/worker/')) {
                if (!safeToken(bearer(req), this.options.workerToken)) {
                    writeJson(res, 401, { error: 'Unauthorized.' });
                    return;
                }
                await this.handleWorkerHttp(req, res, url);
                return;
            }
            if (!safeToken(bearer(req), this.options.botToken)) {
                writeJson(res, 401, { error: 'Unauthorized.' });
                return;
            }
            await this.handleBotHttp(req, res, url);
        } catch (error) {
            console.error('Video broker HTTP error', error);
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
    }

    private async handleBotHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
        if (url.pathname === '/v1/jobs' && req.method === 'POST') {
            const body = await readJson(req);
            const result = await this.enqueue(body);
            writeJson(res, result.status, result.body);
            return;
        }
        const botJobs = /^\/v1\/bots\/([^/]+)\/jobs$/.exec(url.pathname);
        if (botJobs && req.method === 'GET') {
            const rows = await this.all<JobRow>(
                `SELECT * FROM video_jobs WHERE origin_bot_id = ?
                 AND (status IN (${ACTIVE_SQL}) OR (status IN ('ready','failed','cancelled') AND notified_at IS NULL))
                 ORDER BY id ASC`,
                [decodeURIComponent(botJobs[1])],
            );
            writeJson(res, 200, { jobs: await this.views(rows), state: await this.brokerState() });
            return;
        }
        const userJobs = /^\/v1\/users\/([^/]+)\/jobs$/.exec(url.pathname);
        if (userJobs && req.method === 'GET') {
            const rows = await this.all<JobRow>(
                'SELECT * FROM video_jobs WHERE requester_id = ? ORDER BY id DESC LIMIT 10',
                [decodeURIComponent(userJobs[1])],
            );
            writeJson(res, 200, { jobs: await this.views(rows), state: await this.brokerState() });
            return;
        }
        const cancel = /^\/v1\/jobs\/([0-9a-f-]+)\/cancel$/.exec(url.pathname);
        if (cancel && req.method === 'POST') {
            const body = await readJson(req);
            writeJson(res, 200, await this.cancelJob(cancel[1], String(body.requester_id || ''), Boolean(body.is_admin)));
            return;
        }
        const delivered = /^\/v1\/jobs\/([0-9a-f-]+)\/delivered$/.exec(url.pathname);
        if (delivered && req.method === 'POST') {
            await this.run(
                `UPDATE video_jobs SET status = 'delivered', delivered_at = ?, notified_at = ?, updated_at = ?
                 WHERE public_id = ? AND status = 'ready'`,
                [nowSeconds(), nowSeconds(), nowSeconds(), delivered[1]],
            );
            writeJson(res, 200, { ok: true });
            return;
        }
        const notified = /^\/v1\/jobs\/([0-9a-f-]+)\/notified$/.exec(url.pathname);
        if (notified && req.method === 'POST') {
            await this.run(
                'UPDATE video_jobs SET notified_at = ?, updated_at = ? WHERE public_id = ?',
                [nowSeconds(), nowSeconds(), notified[1]],
            );
            writeJson(res, 200, { ok: true });
            return;
        }
        if (url.pathname === '/v1/control' && req.method === 'GET') {
            writeJson(res, 200, await this.brokerState());
            return;
        }
        if (url.pathname === '/v1/control/pause' && req.method === 'POST') {
            const body = await readJson(req);
            const until = nowSeconds() + Math.max(60, Math.min(7 * 86400, Number(body.seconds) || 21600));
            await this.run(
                'UPDATE video_control SET paused_until = ?, updated_by = ?, updated_at = ? WHERE id = 1',
                [until, String(body.actor_id || ''), nowSeconds()],
            );
            if (this.worker?.currentJob) {
                await this.run(
                    `UPDATE video_jobs SET status = 'pausing', updated_at = ? WHERE public_id = ?`,
                    [nowSeconds(), this.worker.currentJob],
                );
                this.sendWorker({ type: 'cancel', job_id: this.worker.currentJob, reason: 'pause' });
            }
            writeJson(res, 200, { paused_until: until, state: await this.brokerState() });
            return;
        }
        if (url.pathname === '/v1/control/resume' && req.method === 'POST') {
            await this.run(
                'UPDATE video_control SET paused_until = NULL, updated_by = NULL, updated_at = ? WHERE id = 1',
                [nowSeconds()],
            );
            await this.dispatchNext();
            writeJson(res, 200, { state: await this.brokerState() });
            return;
        }
        writeJson(res, 404, { error: 'Not found.' });
    }

    private async enqueue(body: any): Promise<{ status: number; body: any }> {
        if (!isVideoModel(body.model)) return { status: 400, body: { error: 'Unknown video model.' } };
        const prompt = String(body.prompt || '').trim();
        if (!prompt || prompt.length > VIDEO_PROMPT_MAX_LENGTH) {
            return { status: 400, body: { error: `Prompt must be 1-${VIDEO_PROMPT_MAX_LENGTH} characters.` } };
        }
        const required = ['requester_id', 'origin_bot_id', 'channel_id', 'command_message_id', 'status_message_id'];
        if (required.some(key => !String(body[key] || '').trim())) {
            return { status: 400, body: { error: 'Missing Discord job identity.' } };
        }
        return this.withWriteLock(async () => {
            const existing = await this.get<JobRow>(
                'SELECT * FROM video_jobs WHERE idempotency_key = ?',
                [String(body.command_message_id)],
            );
            if (existing) return { status: 200, body: { job: (await this.views([existing]))[0], duplicate: true } };
            const global = await this.get<{ count: number }>(
                `SELECT COUNT(*) AS count FROM video_jobs WHERE status IN (${statusPlaceholders(UNFINISHED_VIDEO_STATUSES)})`,
                UNFINISHED_VIDEO_STATUSES,
            );
            if ((global?.count || 0) >= VIDEO_MAX_GLOBAL_JOBS) {
                return { status: 409, body: { error: `The video queue is full (${VIDEO_MAX_GLOBAL_JOBS} jobs).` } };
            }
            const user = await this.get<{ count: number }>(
                `SELECT COUNT(*) AS count FROM video_jobs WHERE requester_id = ?
                 AND status IN (${statusPlaceholders(UNFINISHED_VIDEO_STATUSES)})`,
                [String(body.requester_id), ...UNFINISHED_VIDEO_STATUSES],
            );
            if ((user?.count || 0) >= VIDEO_MAX_USER_JOBS) {
                return { status: 409, body: { error: `You already have ${VIDEO_MAX_USER_JOBS} unfinished video jobs.` } };
            }
            const estimate = await this.runtimeEstimate(body.model as VideoModelId);
            const publicId = randomUUID();
            const now = nowSeconds();
            await this.run(
                `INSERT INTO video_jobs(
                    public_id, idempotency_key, model, prompt, requester_id, origin_bot_id,
                    channel_id, guild_id, command_message_id, status_message_id, status,
                    estimate_low_seconds, estimate_high_seconds, created_at, updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [
                    publicId,
                    String(body.command_message_id),
                    body.model,
                    prompt,
                    String(body.requester_id),
                    String(body.origin_bot_id),
                    String(body.channel_id),
                    body.guild_id ? String(body.guild_id) : null,
                    String(body.command_message_id),
                    String(body.status_message_id),
                    'queued',
                    estimate.low,
                    estimate.high,
                    now,
                    now,
                ],
            );
            const row = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [publicId]);
            await this.dispatchNext();
            return { status: 201, body: { job: (await this.views([row!]))[0], duplicate: false } };
        });
    }

    private async runtimeEstimate(model: VideoModelId): Promise<{ low: number; high: number }> {
        const definition = VIDEO_MODELS[model];
        const rows = await this.all<{ runtime_seconds: number }>(
            `SELECT runtime_seconds FROM video_runtime_samples
             WHERE model = ? ORDER BY id DESC LIMIT 20`,
            [model],
        );
        const samples = rows
            .map(row => Number(row.runtime_seconds))
            .filter(value => Number.isFinite(value) && value > 0)
            .sort((a, b) => a - b);
        if (samples.length < 3) {
            return { low: definition.fallbackLowSeconds, high: definition.fallbackHighSeconds };
        }
        const percentile = (fraction: number) => samples[Math.min(
            samples.length - 1,
            Math.max(0, Math.round((samples.length - 1) * fraction)),
        )];
        const low = Math.max(60, Math.round(percentile(0.2) * 0.9));
        const high = Math.max(low + 60, Math.round(percentile(0.9) * 1.15));
        return { low, high };
    }

    private async refreshQueuedEstimates(model: VideoModelId): Promise<void> {
        const estimate = await this.runtimeEstimate(model);
        await this.run(
            `UPDATE video_jobs SET estimate_low_seconds = ?, estimate_high_seconds = ?, updated_at = ?
             WHERE model = ? AND status = 'queued'`,
            [estimate.low, estimate.high, nowSeconds(), model],
        );
    }

    private async cancelJob(id: string, requesterId: string, isAdmin: boolean): Promise<any> {
        const matches = await this.all<JobRow>(
            'SELECT * FROM video_jobs WHERE public_id LIKE ? ORDER BY id DESC LIMIT 2',
            [`${id}%`],
        );
        if (!matches.length) return { ok: false, error: 'Unknown video job.' };
        if (matches.length > 1) return { ok: false, error: 'That video job prefix is ambiguous.' };
        const row = matches[0];
        const publicId = row.public_id;
        if (!isAdmin && row.requester_id !== requesterId) {
            return { ok: false, error: 'That is not your video job.' };
        }
        if (['delivered', 'failed', 'cancelled'].includes(row.status)) {
            return { ok: false, error: `Job is already ${row.status}.` };
        }
        if (row.status === 'queued' || row.status === 'ready') {
            await this.run(
                `UPDATE video_jobs SET status = 'cancelled', error = 'Cancelled by request',
                 completed_at = ?, updated_at = ? WHERE public_id = ?`,
                [nowSeconds(), nowSeconds(), publicId],
            );
            return { ok: true };
        }
        await this.run(
            `UPDATE video_jobs SET status = 'cancelling', updated_at = ? WHERE public_id = ?`,
            [nowSeconds(), publicId],
        );
        this.sendWorker({ type: 'cancel', job_id: publicId, reason: 'user' });
        return { ok: true };
    }

    private async brokerState(): Promise<any> {
        const control = await this.control();
        const queued = await this.get<{ count: number }>(
            `SELECT COUNT(*) AS count FROM video_jobs WHERE status = 'queued'`,
        );
        return {
            worker_online: Boolean(this.worker),
            worker_busy: Boolean(this.worker?.currentJob),
            worker_id: this.worker?.id || null,
            current_job: this.worker?.currentJob || null,
            paused_until: control.paused_until,
            queued: queued?.count || 0,
        };
    }

    private async views(rows: JobRow[]): Promise<VideoJobView[]> {
        if (rows.length === 0) return [];
        const allActive = await this.all<JobRow>(
            `SELECT * FROM video_jobs WHERE status IN (${ACTIVE_SQL}) ORDER BY id ASC`,
        );
        const control = await this.control();
        const online = Boolean(this.worker);
        const canEstimate = online && !control.paused_until;
        const busy = Boolean(this.worker?.currentJob);
        const now = nowSeconds();
        let cursor = Math.max(now, control.paused_until || now);
        const projections = new Map<string, { position: number | null; start: number | null; finish: number | null }>();
        let queuePosition = 0;
        for (const row of allActive) {
            if (!canEstimate) {
                projections.set(row.public_id, { position: row.status === 'queued' ? ++queuePosition : null, start: null, finish: null });
                continue;
            }
            if (row.status === 'queued') {
                queuePosition += 1;
                const start = cursor;
                cursor += Math.max(1, row.estimate_high_seconds);
                projections.set(row.public_id, { position: queuePosition, start, finish: cursor });
            } else {
                const start = row.started_at || now;
                const finish = Math.max(now + 30, start + row.estimate_high_seconds);
                cursor = Math.max(cursor, finish);
                projections.set(row.public_id, { position: null, start, finish: cursor });
            }
        }
        return rows.map(row => {
            const projection = projections.get(row.public_id) || { position: null, start: null, finish: null };
            return {
                id: row.public_id,
                model: row.model,
                prompt: row.prompt,
                requester_id: row.requester_id,
                origin_bot_id: row.origin_bot_id,
                channel_id: row.channel_id,
                guild_id: row.guild_id,
                command_message_id: row.command_message_id,
                status_message_id: row.status_message_id,
                status: row.status,
                queue_position: projection.position,
                estimate_low_seconds: row.estimate_low_seconds,
                estimate_high_seconds: row.estimate_high_seconds,
                expected_start_at: projection.start,
                expected_finish_at: projection.finish,
                stage: row.stage,
                progress: row.progress,
                error: row.error,
                result_path: row.result_path,
                result_bytes: row.result_bytes,
                created_at: row.created_at,
                updated_at: row.updated_at,
                started_at: row.started_at,
                completed_at: row.completed_at,
                delivered_at: row.delivered_at,
                worker_online: online,
                worker_busy: busy,
                paused_until: control.paused_until,
            };
        });
    }

    private acceptWorker(socket: WebSocket): void {
        let initialized = false;
        let messageChain: Promise<void> = Promise.resolve();
        const helloTimeout = setTimeout(() => socket.close(1008, 'hello timeout'), 10000);
        socket.on('message', raw => {
            messageChain = messageChain.then(async () => {
                let message: any;
                try {
                    message = JSON.parse(raw.toString());
                } catch {
                    socket.close(1007, 'invalid JSON');
                    return;
                }
                if (!initialized) {
                    if (message.type !== 'hello') {
                        socket.close(1008, 'hello required');
                        return;
                    }
                    const hello = message as VideoWorkerHello;
                    if (hello.protocol !== VIDEO_PROTOCOL_VERSION || !hello.worker_id
                        || !Array.isArray(hello.capabilities)
                        || hello.capabilities.some(model => !isVideoModel(model))) {
                        socket.close(1008, 'incompatible worker');
                        return;
                    }
                    clearTimeout(helloTimeout);
                    if (this.worker && this.worker.socket !== socket) {
                        this.worker.socket.close(1012, 'replaced by worker reconnect');
                    }
                    this.worker = {
                        socket,
                        id: hello.worker_id,
                        capabilities: hello.capabilities,
                        lastHeartbeat: Date.now(),
                        currentJob: hello.current_job,
                        ready: !hello.current_job,
                    };
                    initialized = true;
                    await this.reconcileWorker(hello);
                    this.sendWorker({ type: 'hello_ack', protocol: VIDEO_PROTOCOL_VERSION, state: await this.brokerState() });
                    if (!hello.current_job) await this.dispatchNext();
                    return;
                }
                await this.handleWorkerMessage(message);
            }).catch(error => {
                console.error('Worker message failure', error);
                socket.close(1011, 'worker message failure');
            });
        });
        socket.on('close', () => {
            clearTimeout(helloTimeout);
            if (this.worker?.socket === socket) void this.markWorkerOffline();
        });
        socket.on('error', error => console.error('Video worker socket error', error));
    }

    private async reconcileWorker(hello: VideoWorkerHello): Promise<void> {
        if (hello.estimates) {
            for (const [model, estimate] of Object.entries(hello.estimates)) {
                if (!isVideoModel(model) || !estimate) continue;
                await this.run(
                    `UPDATE video_jobs SET estimate_low_seconds = ?, estimate_high_seconds = ?, updated_at = ?
                     WHERE status = 'queued' AND model = ?`,
                    [Math.max(1, estimate.low), Math.max(1, estimate.high), nowSeconds(), model],
                );
            }
        }
        if (hello.current_job) {
            const row = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [hello.current_job]);
            if (row && ACTIVE_VIDEO_STATUSES.includes(row.status)) {
                if (row.status === 'pausing' || row.status === 'cancelling') {
                    this.sendWorker({
                        type: 'cancel',
                        job_id: hello.current_job,
                        reason: row.status === 'pausing' ? 'pause' : 'user',
                    });
                    return;
                }
                await this.run(
                    `UPDATE video_jobs SET status = 'running', worker_id = ?, lease_expires_at = ?, updated_at = ?
                     WHERE public_id = ?`,
                    [hello.worker_id, nowSeconds() + 60, nowSeconds(), hello.current_job],
                );
                return;
            }
            this.sendWorker({
                type: 'cancel',
                job_id: hello.current_job,
                reason: row ? 'release' : 'orphan',
            });
            return;
        }
        const disconnected = await this.get<JobRow>(
            `SELECT * FROM video_jobs WHERE status = 'running_disconnected' ORDER BY id ASC LIMIT 1`,
        );
        if (disconnected) {
            await this.run(
                `UPDATE video_jobs SET status = 'queued', stage = 'Resuming after reconnect', progress = NULL,
                 worker_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE public_id = ?`,
                [nowSeconds(), disconnected.public_id],
            );
        }
    }

    private async handleWorkerMessage(message: any): Promise<void> {
        if (!this.worker) return;
        this.worker.lastHeartbeat = Date.now();
        if (message.type === 'heartbeat') {
            if (message.job_id && message.job_id === this.worker.currentJob) {
                await this.run(
                    `UPDATE video_jobs SET lease_expires_at = ?, stage = COALESCE(?, stage),
                     progress = COALESCE(?, progress), updated_at = ? WHERE public_id = ?`,
                    [
                        nowSeconds() + 60,
                        message.stage === undefined ? null : String(message.stage).slice(0, 255),
                        typeof message.progress === 'number' ? Math.min(1, Math.max(0, message.progress)) : null,
                        nowSeconds(),
                        message.job_id,
                    ],
                );
            }
            return;
        }
        if (message.type === 'ready') {
            this.worker.ready = true;
            this.worker.currentJob = null;
            await this.dispatchNext();
            return;
        }
        const jobId = String(message.job_id || '');
        if (!jobId || jobId !== this.worker.currentJob) return;
        if (message.type === 'event') {
            const event = String(message.event || '');
            if (event === 'plan') {
                await this.run(
                    `UPDATE video_jobs SET status = 'planning', stage = ?, estimate_low_seconds = ?,
                     estimate_high_seconds = ?, updated_at = ? WHERE public_id = ?`,
                    [
                        String(message.stage || 'Planning').slice(0, 255),
                        Math.max(1, Number(message.estimate_low_seconds) || 1),
                        Math.max(1, Number(message.estimate_high_seconds) || 1),
                        nowSeconds(),
                        jobId,
                    ],
                );
            } else if (event === 'progress') {
                await this.run(
                    `UPDATE video_jobs SET status = 'running', stage = ?, progress = ?, lease_expires_at = ?,
                     updated_at = ? WHERE public_id = ?`,
                    [
                        String(message.stage || 'Generating').slice(0, 255),
                        typeof message.progress === 'number' ? Math.min(1, Math.max(0, message.progress)) : null,
                        nowSeconds() + 60,
                        nowSeconds(),
                        jobId,
                    ],
                );
            } else if (event === 'uploading') {
                await this.run(
                    `UPDATE video_jobs SET status = 'uploading', stage = 'Uploading result', progress = NULL,
                     updated_at = ? WHERE public_id = ?`,
                    [nowSeconds(), jobId],
                );
            } else if (event === 'cancelled') {
                const row = await this.get<JobRow>('SELECT status FROM video_jobs WHERE public_id = ?', [jobId]);
                if (message.reason === 'release') {
                    this.worker.currentJob = null;
                    this.worker.ready = false;
                    return;
                }
                const pause = row?.status === 'pausing' || message.reason === 'pause';
                await this.run(
                    pause
                        ? `UPDATE video_jobs SET status = 'queued', stage = 'Paused for desktop use', progress = NULL,
                           worker_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE public_id = ?`
                        : `UPDATE video_jobs SET status = 'cancelled', stage = NULL, progress = NULL,
                           completed_at = ?, updated_at = ? WHERE public_id = ?`,
                    pause ? [nowSeconds(), jobId] : [nowSeconds(), nowSeconds(), jobId],
                );
                this.worker.currentJob = null;
                this.worker.ready = false;
            } else if (event === 'failed') {
                const row = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [jobId]);
                if (!row || !ACTIVE_VIDEO_STATUSES.includes(row.status)) {
                    this.worker.currentJob = null;
                    this.worker.ready = false;
                    return;
                }
                const retry = Boolean(message.retryable) && (row?.attempt || 0) < 2;
                await this.run(
                    retry
                        ? `UPDATE video_jobs SET status = 'queued', attempt = attempt + 1, stage = 'Retrying',
                           progress = NULL, worker_id = NULL, lease_expires_at = NULL, error = ?, updated_at = ?
                           WHERE public_id = ?`
                        : `UPDATE video_jobs SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
                           WHERE public_id = ?`,
                    retry
                        ? [String(message.error || 'Worker failure').slice(0, 2000), nowSeconds(), jobId]
                        : [String(message.error || 'Worker failure').slice(0, 2000), nowSeconds(), nowSeconds(), jobId],
                );
                this.worker.currentJob = null;
                this.worker.ready = false;
            } else if (event === 'complete') {
                const row = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [jobId]);
                if (!row || !ACTIVE_VIDEO_STATUSES.includes(row.status)) {
                    this.worker.currentJob = null;
                    this.worker.ready = false;
                    return;
                }
                if (!row?.result_path) throw new Error('Worker completed before uploading a result.');
                await this.run(
                    `UPDATE video_jobs SET status = 'ready', stage = 'Ready for Discord delivery', progress = 1,
                     completed_at = ?, updated_at = ? WHERE public_id = ?`,
                    [nowSeconds(), nowSeconds(), jobId],
                );
                if (Number(message.runtime_seconds) > 0) {
                    await this.run(
                        'INSERT INTO video_runtime_samples(model, runtime_seconds, recorded_at) VALUES(?,?,?)',
                        [row.model, Number(message.runtime_seconds), nowSeconds()],
                    );
                    await this.refreshQueuedEstimates(row.model);
                }
                this.worker.currentJob = null;
                this.worker.ready = false;
            }
        }
    }

    private async dispatchNext(): Promise<void> {
        if (!this.worker || !this.worker.ready || this.worker.currentJob) return;
        const control = await this.control();
        if (control.paused_until) return;
        const placeholders = this.worker.capabilities.map(() => '?').join(',');
        if (!placeholders) return;
        const row = await this.get<JobRow>(
            `SELECT * FROM video_jobs WHERE status = 'queued' AND model IN (${placeholders})
             ORDER BY id ASC LIMIT 1`,
            this.worker.capabilities,
        );
        if (!row) return;
        const result = await this.run(
            `UPDATE video_jobs SET status = 'leased', worker_id = ?, lease_expires_at = ?,
             started_at = COALESCE(started_at, ?), stage = 'Leased to desktop', updated_at = ?
             WHERE public_id = ? AND status = 'queued'`,
            [this.worker.id, nowSeconds() + 60, nowSeconds(), nowSeconds(), row.public_id],
        );
        if (result.changes !== 1) return;
        this.worker.ready = false;
        this.worker.currentJob = row.public_id;
        this.sendWorker({
            type: 'job',
            protocol: VIDEO_PROTOCOL_VERSION,
            job: {
                id: row.public_id,
                model: row.model,
                prompt: row.prompt,
                profile: 'maximum',
            },
        });
    }

    private sendWorker(message: unknown): void {
        if (this.worker?.socket.readyState === WebSocket.OPEN) {
            this.worker.socket.send(JSON.stringify(message));
        }
    }

    private async markWorkerOffline(): Promise<void> {
        const worker = this.worker;
        this.worker = null;
        if (worker?.currentJob) {
            await this.run(
                `UPDATE video_jobs SET
                 status = CASE
                    WHEN status IN ('pausing','cancelling') THEN status
                    ELSE 'running_disconnected'
                 END,
                 stage = CASE
                    WHEN status IN ('pausing','cancelling') THEN stage
                    ELSE 'Desktop connection lost'
                 END,
                 lease_expires_at = NULL, updated_at = ? WHERE public_id = ? AND status IN (${ACTIVE_SQL})`,
                [nowSeconds(), worker.currentJob],
            );
        }
    }

    private async checkHeartbeat(): Promise<void> {
        if (this.worker && Date.now() - this.worker.lastHeartbeat > (this.options.heartbeatTimeoutMs || 45000)) {
            this.worker.socket.terminate();
            await this.markWorkerOffline();
        }
        const control = await this.control();
        if (!control.paused_until) await this.dispatchNext();
    }

    private async handleWorkerHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
        const planning = /^\/v1\/worker\/jobs\/([0-9a-f-]+)\/plan$/.exec(url.pathname);
        if (planning && req.method === 'POST') {
            const job = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [planning[1]]);
            if (!job || job.worker_id !== this.worker?.id || planning[1] !== this.worker.currentJob) {
                writeJson(res, 409, { error: 'Job is not leased to this worker.' });
                return;
            }
            if (job.planner_json) {
                writeJson(res, 200, {
                    plan: JSON.parse(job.planner_json),
                    planner_model: job.planner_model || VIDEO_PLANNER_MODEL,
                    cached: true,
                });
                return;
            }
            try {
                const plan = await createFrontierVideoPlan(job.prompt, job.model, job.requester_id);
                await this.run(
                    `UPDATE video_jobs SET planner_json = ?, planner_model = ?, updated_at = ?
                     WHERE public_id = ?`,
                    [JSON.stringify(plan), VIDEO_PLANNER_MODEL, nowSeconds(), job.public_id],
                );
                writeJson(res, 200, { plan, planner_model: VIDEO_PLANNER_MODEL, cached: false });
            } catch (error) {
                console.warn(`Frontier planning failed for ${job.public_id}`, error);
                writeJson(res, 502, {
                    error: error instanceof Error ? error.message : String(error),
                    fallback: 'local',
                });
            }
            return;
        }
        const upload = /^\/v1\/worker\/jobs\/([0-9a-f-]+)\/result$/.exec(url.pathname);
        if (!upload || req.method !== 'PUT') {
            writeJson(res, 404, { error: 'Not found.' });
            return;
        }
        const job = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [upload[1]]);
        if (!job || job.worker_id !== this.worker?.id || upload[1] !== this.worker.currentJob) {
            writeJson(res, 409, { error: 'Job is not leased to this worker.' });
            return;
        }
        const expectedLength = Number(req.headers['content-length'] || 0);
        if (!expectedLength || expectedLength > VIDEO_RESULT_MAX_BYTES) {
            writeJson(res, 413, { error: 'Result exceeds the delivery upload limit.' });
            return;
        }
        const expectedHash = String(req.headers['x-content-sha256'] || '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
            writeJson(res, 400, { error: 'Missing or invalid SHA-256.' });
            return;
        }
        const directory = resolve(this.options.resultsDir, upload[1]);
        mkdirSync(directory, { recursive: true });
        const temporary = join(directory, 'result.mp4.part');
        const destination = join(directory, 'result.mp4');
        rmSync(temporary, { force: true });
        const hash = createHash('sha256');
        let bytes = 0;
        const meter = new Transform({
            transform(chunk, _encoding, callback) {
                bytes += chunk.length;
                hash.update(chunk);
                callback(null, chunk);
            },
        });
        try {
            await pipeline(req, meter, createWriteStream(temporary, { flags: 'wx' }));
            const actualHash = hash.digest('hex');
            if (bytes !== expectedLength || bytes > VIDEO_RESULT_MAX_BYTES || actualHash !== expectedHash) {
                unlinkSync(temporary);
                writeJson(res, 400, { error: 'Result length or checksum mismatch.' });
                return;
            }
            rmSync(destination, { force: true });
            renameSync(temporary, destination);
            await this.run(
                `UPDATE video_jobs SET result_path = ?, result_sha256 = ?, result_bytes = ?,
                 status = 'uploading', stage = 'Upload received', updated_at = ? WHERE public_id = ?`,
                [destination, actualHash, bytes, nowSeconds(), upload[1]],
            );
            writeJson(res, 200, { ok: true, bytes, sha256: actualHash });
        } catch (error) {
            rmSync(temporary, { force: true });
            throw error;
        }
    }

    private async cleanupFiles(): Promise<void> {
        const cutoff = nowSeconds() - 24 * 60 * 60;
        const rows = await this.all<JobRow>(
            `SELECT * FROM video_jobs
             WHERE status IN ('ready','delivered','failed','cancelled')
             AND COALESCE(delivered_at, completed_at, updated_at) < ?
             AND result_path IS NOT NULL`,
            [cutoff],
        );
        for (const row of rows) {
            try {
                if (row.result_path && statSync(row.result_path).isFile()) rmSync(resolve(row.result_path), { force: true });
                if (row.result_path) rmSync(dirname(resolve(row.result_path)), { recursive: true, force: true });
            } catch (error) {
                console.warn(`Could not clean video result ${row.public_id}`, error);
                continue;
            }
            await this.run('UPDATE video_jobs SET result_path = NULL, updated_at = ? WHERE public_id = ?', [nowSeconds(), row.public_id]);
        }
    }
}

export function videoBrokerOptionsFromEnvironment(): BrokerOptions {
    const settings = loadVideoSettings();
    const botToken = settings.botToken;
    const workerToken = settings.workerToken;
    if (!botToken || !workerToken) {
        throw new Error('VIDEO_BROKER_BOT_TOKEN and VIDEO_BROKER_WORKER_TOKEN are required.');
    }
    return {
        host: settings.brokerHost,
        port: settings.brokerPort,
        dbPath: settings.brokerDb,
        resultsDir: settings.resultsDir,
        botToken,
        workerToken,
    };
}

async function main(): Promise<void> {
    const broker = new VideoBroker(videoBrokerOptionsFromEnvironment());
    await broker.start();
    const stop = async () => {
        await broker.stop();
        process.exit(0);
    };
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
}

// PM2's fork container remains argv[1], so pm_id is the reliable entrypoint signal there.
if (process.env.pm_id !== undefined
    || (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
