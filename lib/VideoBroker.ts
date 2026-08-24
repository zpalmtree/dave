import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { pathToFileURL } from 'url';
import fetch from 'node-fetch';
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
    VIDEO_SOURCE_IMAGE_MAX_BYTES,
    VIDEO_SOURCE_IMAGE_MIME_TYPES,
    VideoJobStatus,
    VideoJobView,
    VideoGeneratorModelId,
    VideoMetricSpan,
    VideoModelId,
    VideoWorkerMetrics,
    VideoWorkerHello,
    VideoWorkerSchedulerState,
    isVideoModel,
    sanitizeVideoWorkerText,
} from './VideoProtocol.js';
import { loadVideoSettings } from './VideoSettings.js';
import {
    FrontierPlannerRejectedError,
    VIDEO_PLANNER_MODEL,
    VideoPlanSourceImage,
    createFrontierVideoPlan,
    validateFrontierVideoPlanForKeyframe,
} from './VideoFrontierPlanner.js';
import {
    VIDEO_KEYFRAME_MAX_BYTES,
    VideoKeyframeOptions,
    VideoKeyframeResult,
    createFrontierVideoKeyframe,
} from './VideoKeyframeProvider.js';
import {
    VideoKeyframeReference,
    countVideoKeyframeReferenceRequirements,
    resolveVideoKeyframeReferences,
} from './VideoKeyframeReferences.js';
import {
    VideoFrontierCallOptions,
    VideoProviderAttempt,
    VideoProviderHooks,
    VideoProviderUsage,
    VideoUsagePersistenceError,
    videoUsageCost,
} from './VideoUsage.js';

const ACTIVE_SQL = ACTIVE_VIDEO_STATUSES.map(status => `'${status}'`).join(',');
const UNFINISHED_SQL = UNFINISHED_VIDEO_STATUSES.map(status => `'${status}'`).join(',');
const LOCAL_VIDEO_PLANNER_MODEL = 'hauhaucs-qwen3.8:27b-q4kp-mtp';

interface VideoSourceImageDescriptor {
    url: string;
    mime_type: typeof VIDEO_SOURCE_IMAGE_MIME_TYPES[number];
    bytes: number;
    name: string;
}

interface StoredVideoSourceImage {
    path: string;
    mimeType: typeof VIDEO_SOURCE_IMAGE_MIME_TYPES[number];
    bytes: number;
}

interface BrokerOptions {
    host: string;
    port: number;
    dbPath: string;
    resultsDir: string;
    botToken: string;
    workerToken: string;
    heartbeatTimeoutMs?: number;
    preplanQueuedJobs?: boolean;
    frontierPlanner?: typeof createFrontierVideoPlan;
    keyframeGenerator?: (
        plan: Record<string, any>,
        references?: VideoKeyframeReference[],
        options?: VideoKeyframeOptions,
    ) => Promise<VideoKeyframeResult>;
    keyframeReferenceResolver?: (
        plan: Record<string, any>,
        jobDirectory: string,
        hooks?: VideoProviderHooks,
    ) => Promise<VideoKeyframeReference[]>;
    sourceImageDownloader?: (
        descriptor: VideoSourceImageDescriptor,
        directory: string,
    ) => Promise<StoredVideoSourceImage>;
}

interface WorkerConnection {
    socket: WebSocket;
    id: string;
    capabilities: VideoModelId[];
    lastHeartbeat: number;
    currentJob: string | null;
    ready: boolean;
    warmModel: VideoGeneratorModelId | null;
    leaseId: string | null;
    scheduler: VideoWorkerSchedulerState;
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
    estimate_ready: number;
    initial_estimate_low_seconds: number | null;
    initial_estimate_high_seconds: number | null;
    initial_estimate_recorded_at: number | null;
    stage: string | null;
    progress: number | null;
    worker_id: string | null;
    lease_expires_at: number | null;
    lease_token: string | null;
    result_path: string | null;
    result_sha256: string | null;
    result_bytes: number | null;
    error: string | null;
    created_at: number;
    updated_at: number;
    started_at: number | null;
    completed_at: number | null;
    runtime_seconds: number | null;
    delivered_at: number | null;
    notified_at: number | null;
    planner_json: string | null;
    planner_model: string | null;
    source_image_path: string | null;
    source_image_mime: string | null;
    source_image_bytes: number | null;
    keyframe_path: string | null;
    keyframe_mime: string | null;
    keyframe_provider: string | null;
    keyframe_model: string | null;
    affinity_bypasses: number;
}

interface VideoJobMetricRow {
    job_public_id: string;
    model: VideoModelId;
    generator_model: VideoGeneratorModelId;
    total_seconds: number;
    output_duration_seconds: number | null;
    width: number | null;
    height: number | null;
    fps: number | null;
    segment_count: number | null;
    output_bytes: number | null;
    source_image: number;
    gpu_name: string | null;
    driver_version: string | null;
    vram_total_mb: number | null;
    vram_peak_mb: number | null;
    vram_average_mb: number | null;
    vram_free_min_mb: number | null;
    gpu_utilization_average: number | null;
    gpu_utilization_peak: number | null;
    power_average_watts: number | null;
    temperature_peak_c: number | null;
    pcie_link_width_min: number | null;
    pcie_link_width_max: number | null;
    hardware_slowdown_samples: number | null;
    thermal_slowdown_samples: number | null;
    power_brake_slowdown_samples: number | null;
    gpu_samples: number | null;
    worker_sha256: string | null;
    generator_sha256: string | null;
    python_version: string | null;
    comfy_aimdo_version: string | null;
    warm_model_before: VideoGeneratorModelId | null;
    warm_model_after: VideoGeneratorModelId | null;
    quality: string | null;
    fast: number;
    turbo4: number;
    ltx_one_stage: number;
    recorded_at: number;
    planner_model: string | null;
    keyframe_provider: string | null;
    keyframe_model: string | null;
}

interface VideoJobSpanRow {
    job_public_id: string;
    source: VideoMetricSpan['source'];
    name: string;
    segment_index: number;
    duration_seconds: number;
    metadata_json: string | null;
}

function generatorModel(value: unknown): VideoGeneratorModelId | null {
    return value === 'ltx' || value === 'h3' ? value : null;
}

function workerScheduler(value: unknown): VideoWorkerSchedulerState {
    if (!value || typeof value !== 'object') {
        return { available: true, mode: 'normal', health: 'healthy' };
    }
    const scheduler = value as Record<string, unknown>;
    return {
        available: scheduler.available === true,
        mode: typeof scheduler.mode === 'string'
            ? scheduler.mode as VideoWorkerSchedulerState['mode']
            : null,
        gaming_ready: scheduler.gaming_ready === true,
        health: typeof scheduler.health === 'string'
            ? scheduler.health as VideoWorkerSchedulerState['health']
            : null,
    };
}

function schedulerAdmitsWork(value: VideoWorkerSchedulerState): boolean {
    return value.available && value.mode === 'normal' && value.health === 'healthy';
}

function plannedIntent(row: JobRow): string | null {
    if (!row.planner_json) return null;
    try {
        const intent = JSON.parse(row.planner_json)?.intent;
        return typeof intent === 'string' && intent.trim()
            ? sanitizeVideoWorkerText(intent, '', 1000).trim() || null
            : null;
    } catch {
        return null;
    }
}

function generationNotice(row: JobRow): string | null {
    if (!row.planner_json) return null;
    try {
        const notice = JSON.parse(row.planner_json)?.generation_notice;
        return typeof notice === 'string' && notice.trim()
            ? sanitizeVideoWorkerText(notice, '', 1000).trim() || null
            : null;
    } catch {
        return null;
    }
}

const FRONTIER_REJECTION_PREFIX = 'local-fallback:';

function cachedFrontierRejection(plannerModel: string | null): string | null {
    if (!plannerModel?.startsWith(FRONTIER_REJECTION_PREFIX)) return null;
    return plannerModel.slice(FRONTIER_REJECTION_PREFIX.length).trim() || 'other';
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

function boundedNumber(
    value: unknown,
    minimum: number,
    maximum: number,
    nullable = true,
): number | null {
    if ((value === null || value === undefined || value === '') && nullable) return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) {
        throw new Error(`Metric must be a finite number between ${minimum} and ${maximum}.`);
    }
    return number;
}

function boundedMetricText(value: unknown, maximum = 160): string | null {
    if (value === null || value === undefined || value === '') return null;
    const text = sanitizeVideoWorkerText(value, '', maximum);
    if (!text || text.includes('[local file]')) throw new Error('Metric text contains a local path.');
    return text;
}

function optionalGeneratorModel(value: unknown): VideoGeneratorModelId | null {
    if (value === null || value === undefined || value === '') return null;
    const model = generatorModel(value);
    if (!model) throw new Error('Invalid warm model metric.');
    return model;
}

function normalizedMetricSpan(value: any): VideoMetricSpan {
    if (!value || typeof value !== 'object') throw new Error('Invalid metric span.');
    if (!['broker', 'worker', 'comfy'].includes(String(value.source))) {
        throw new Error('Invalid metric span source.');
    }
    const name = boundedMetricText(value.name, 120);
    if (!name) throw new Error('Metric span name is required.');
    const segment = value.segment_index === null || value.segment_index === undefined
        ? null
        : boundedNumber(value.segment_index, 1, 100, false);
    const metadata: VideoMetricSpan['metadata'] = {};
    if (typeof value.metadata?.cached === 'boolean') metadata.cached = value.metadata.cached;
    if (['ok', 'error', 'skipped'].includes(value.metadata?.status)) metadata.status = value.metadata.status;
    if (['t2v', 'i2v'].includes(value.metadata?.mode)) metadata.mode = value.metadata.mode;
    if (['draft', 'final'].includes(value.metadata?.quality)) metadata.quality = value.metadata.quality;
    if (['start', 'cut', 'continue', 'dissolve'].includes(value.metadata?.transition)) {
        metadata.transition = value.metadata.transition;
    }
    if (value.metadata?.references_requested !== undefined) {
        metadata.references_requested = Math.round(
            boundedNumber(value.metadata.references_requested, 0, 4, false)!,
        );
    }
    if (value.metadata?.references_resolved !== undefined) {
        metadata.references_resolved = Math.round(
            boundedNumber(value.metadata.references_resolved, 0, 4, false)!,
        );
    }
    return {
        source: value.source,
        name,
        duration_seconds: boundedNumber(value.duration_seconds, 0, 24 * 60 * 60, false)!,
        segment_index: segment === null ? null : Math.round(segment),
        ...(Object.keys(metadata).length ? { metadata } : {}),
    };
}

function normalizedWorkerMetrics(value: any, expectedModel: VideoModelId): VideoWorkerMetrics {
    if (!value || typeof value !== 'object' || value.schema_version !== 1) {
        throw new Error('Unsupported video metrics payload.');
    }
    if (value.model !== expectedModel || !isVideoModel(value.model)) {
        throw new Error('Metrics model does not match the leased job.');
    }
    const expectedGenerator = VIDEO_MODELS[expectedModel].generatorModel;
    if (value.generator_model !== expectedGenerator) {
        throw new Error('Metrics generator model does not match the leased job.');
    }
    if (!Array.isArray(value.spans) || value.spans.length > 300) {
        throw new Error('Metrics spans must be an array of at most 300 entries.');
    }
    const output = value.output && typeof value.output === 'object' ? {
        duration_seconds: boundedNumber(value.output.duration_seconds, 0.01, 300) ?? undefined,
        width: Math.round(boundedNumber(value.output.width, 16, 16384) ?? 0) || undefined,
        height: Math.round(boundedNumber(value.output.height, 16, 16384) ?? 0) || undefined,
        fps: boundedNumber(value.output.fps, 0.1, 240) ?? undefined,
        segment_count: Math.round(boundedNumber(value.output.segment_count, 1, 100) ?? 0) || undefined,
        bytes: Math.round(boundedNumber(value.output.bytes, 1, 1024 * 1024 * 1024) ?? 0) || undefined,
        source_image: Boolean(value.output.source_image),
    } : undefined;
    const gpu = value.gpu && typeof value.gpu === 'object' ? {
        name: boundedMetricText(value.gpu.name) ?? undefined,
        driver_version: boundedMetricText(value.gpu.driver_version, 80) ?? undefined,
        vram_total_mb: boundedNumber(value.gpu.vram_total_mb, 1, 1024 * 1024) ?? undefined,
        vram_peak_mb: boundedNumber(value.gpu.vram_peak_mb, 0, 1024 * 1024) ?? undefined,
        vram_average_mb: boundedNumber(value.gpu.vram_average_mb, 0, 1024 * 1024) ?? undefined,
        vram_free_min_mb: boundedNumber(value.gpu.vram_free_min_mb, 0, 1024 * 1024) ?? undefined,
        utilization_average_percent: boundedNumber(value.gpu.utilization_average_percent, 0, 100) ?? undefined,
        utilization_peak_percent: boundedNumber(value.gpu.utilization_peak_percent, 0, 100) ?? undefined,
        power_average_watts: boundedNumber(value.gpu.power_average_watts, 0, 5000) ?? undefined,
        temperature_peak_c: boundedNumber(value.gpu.temperature_peak_c, 0, 200) ?? undefined,
        pcie_link_width_min: boundedNumber(value.gpu.pcie_link_width_min, 1, 32) ?? undefined,
        pcie_link_width_max: boundedNumber(value.gpu.pcie_link_width_max, 1, 32) ?? undefined,
        hardware_slowdown_samples: Math.round(boundedNumber(value.gpu.hardware_slowdown_samples, 0, 1_000_000) ?? 0),
        thermal_slowdown_samples: Math.round(boundedNumber(value.gpu.thermal_slowdown_samples, 0, 1_000_000) ?? 0),
        power_brake_slowdown_samples: Math.round(boundedNumber(value.gpu.power_brake_slowdown_samples, 0, 1_000_000) ?? 0),
        samples: Math.round(boundedNumber(value.gpu.samples, 0, 1_000_000) ?? 0),
    } : undefined;
    const environment = value.environment && typeof value.environment === 'object' ? {
        worker_sha256: boundedMetricText(value.environment.worker_sha256, 64) ?? undefined,
        generator_sha256: boundedMetricText(value.environment.generator_sha256, 64) ?? undefined,
        python_version: boundedMetricText(value.environment.python_version, 160) ?? undefined,
        comfy_aimdo_version: boundedMetricText(value.environment.comfy_aimdo_version, 80) ?? undefined,
        warm_model_before: optionalGeneratorModel(value.environment.warm_model_before),
        warm_model_after: optionalGeneratorModel(value.environment.warm_model_after),
    } : undefined;
    for (const hash of [environment?.worker_sha256, environment?.generator_sha256]) {
        if (hash && !/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid environment fingerprint.');
    }
    const quality = ['draft', 'final'].includes(value.flags?.quality)
        ? value.flags.quality as 'draft' | 'final'
        : undefined;
    const failureKind = ['nvidia_driver_reset', 'generator_failure'].includes(value.failure?.kind)
        ? value.failure.kind as 'nvidia_driver_reset' | 'generator_failure'
        : null;
    const eventIds = Array.isArray(value.failure?.event_ids)
        ? value.failure.event_ids
            .map((eventId: unknown) => Number(eventId))
            .filter((eventId: number) => Number.isFinite(eventId) && eventId >= 0 && eventId <= 65535)
            .map((eventId: number) => Math.round(eventId))
            .slice(0, 20)
        : undefined;
    const failure = failureKind ? {
        kind: failureKind,
        event_count: Math.round(boundedNumber(value.failure?.event_count, 0, 1_000_000) ?? 0),
        ...(eventIds ? { event_ids: eventIds } : {}),
        ...(value.failure?.latest_utc
            ? { latest_utc: boundedMetricText(value.failure.latest_utc, 80) ?? undefined }
            : {}),
    } : undefined;
    return {
        schema_version: 1,
        model: expectedModel,
        generator_model: expectedGenerator,
        total_seconds: boundedNumber(value.total_seconds, 0.01, 24 * 60 * 60, false)!,
        ...(output ? { output } : {}),
        ...(gpu ? { gpu } : {}),
        ...(environment ? { environment } : {}),
        ...(failure ? { failure } : {}),
        flags: {
            fast: Boolean(value.flags?.fast),
            turbo4: Boolean(value.flags?.turbo4),
            ltx_one_stage: Boolean(value.flags?.ltx_one_stage),
            ...(quality ? { quality } : {}),
        },
        spans: value.spans.map(normalizedMetricSpan),
    };
}

function average(values: Array<number | null | undefined>): number | null {
    const finite = values.filter((value): value is number => Number.isFinite(value));
    return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function median(values: Array<number | null | undefined>): number | null {
    const finite = values
        .filter((value): value is number => Number.isFinite(value))
        .sort((a, b) => a - b);
    if (!finite.length) return null;
    const middle = Math.floor(finite.length / 2);
    return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

function minimum(values: Array<number | null | undefined>): number | null {
    const finite = values.filter((value): value is number => Number.isFinite(value));
    return finite.length ? Math.min(...finite) : null;
}

function maximum(values: Array<number | null | undefined>): number | null {
    const finite = values.filter((value): value is number => Number.isFinite(value));
    return finite.length ? Math.max(...finite) : null;
}

function imageExtension(mimeType: string): string {
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/webp') return 'webp';
    return 'png';
}

function sourceImageDescriptor(value: any): VideoSourceImageDescriptor | null {
    if (value === null || value === undefined) return null;
    if (!value || typeof value !== 'object') throw new Error('Invalid starting-image metadata.');
    const mimeType = String(value.mime_type || '').split(';')[0].toLowerCase();
    const bytes = Number(value.bytes || 0);
    if (!VIDEO_SOURCE_IMAGE_MIME_TYPES.includes(mimeType as any)) {
        throw new Error('The starting image must be PNG, JPEG, or WebP.');
    }
    if (!Number.isInteger(bytes) || bytes <= 0 || bytes > VIDEO_SOURCE_IMAGE_MAX_BYTES) {
        throw new Error('The starting image is empty or exceeds the 20 MiB limit.');
    }
    return {
        url: String(value.url || ''),
        mime_type: mimeType as VideoSourceImageDescriptor['mime_type'],
        bytes,
        name: String(value.name || 'start-frame').slice(0, 255),
    };
}

function isDiscordAttachmentUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'https:'
            && (url.hostname === 'cdn.discordapp.com' || url.hostname === 'media.discordapp.net');
    } catch {
        return false;
    }
}

async function downloadDiscordSourceImage(
    descriptor: VideoSourceImageDescriptor,
    directory: string,
): Promise<StoredVideoSourceImage> {
    if (!isDiscordAttachmentUrl(descriptor.url)) {
        throw new Error('The starting image is not a Discord attachment.');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, 'source.part');
    rmSync(temporary, { force: true });
    try {
        const response = await fetch(descriptor.url, {
            signal: controller.signal,
            redirect: 'follow',
        });
        if (!response.ok || !response.body || !isDiscordAttachmentUrl(response.url)) {
            throw new Error(`Discord returned HTTP ${response.status} for the starting image.`);
        }
        const mimeType = String(response.headers.get('content-type') || descriptor.mime_type)
            .split(';')[0]
            .toLowerCase();
        if (!VIDEO_SOURCE_IMAGE_MIME_TYPES.includes(mimeType as any)) {
            throw new Error(`Discord returned unsupported image type ${mimeType || 'unknown'}.`);
        }
        const declaredLength = Number(response.headers.get('content-length') || 0);
        if (declaredLength > VIDEO_SOURCE_IMAGE_MAX_BYTES) {
            throw new Error('The starting image exceeds the 20 MiB limit.');
        }
        let bytes = 0;
        const meter = new Transform({
            transform(chunk, _encoding, callback) {
                bytes += chunk.length;
                if (bytes > VIDEO_SOURCE_IMAGE_MAX_BYTES) {
                    callback(new Error('The starting image exceeds the 20 MiB limit.'));
                    return;
                }
                callback(null, chunk);
            },
        });
        await pipeline(response.body, meter, createWriteStream(temporary, { flags: 'wx' }));
        if (!bytes) throw new Error('The starting image is empty.');
        const destination = join(directory, `source.${imageExtension(mimeType)}`);
        rmSync(destination, { force: true });
        renameSync(temporary, destination);
        return {
            path: destination,
            mimeType: mimeType as StoredVideoSourceImage['mimeType'],
            bytes,
        };
    } finally {
        clearTimeout(timeout);
        rmSync(temporary, { force: true });
    }
}

function writeImage(res: ServerResponse, path: string, mimeType: string, headers: Record<string, string>): void {
    const size = statSync(path).size;
    res.writeHead(200, {
        'content-type': mimeType,
        'content-length': size,
        'cache-control': 'no-store',
        ...headers,
    });
    createReadStream(path).pipe(res);
}

export class VideoBroker {
    private readonly options: BrokerOptions;
    private readonly db: sqlite3.Database;
    private readonly server = createServer((req, res) => void this.handleHttp(req, res));
    private readonly wsServer = new WebSocketServer({ noServer: true });
    private worker: WorkerConnection | null = null;
    private writeChain: Promise<unknown> = Promise.resolve();
    private preparationChain: Promise<void> = Promise.resolve();
    private readonly preparationQueued = new Set<string>();
    private readonly plannerInFlight = new Map<string, Promise<{ plan: Record<string, any>; plannerModel: string }>>();
    private readonly keyframeInFlight = new Map<string, Promise<void>>();
    private readonly backgroundTasks = new Set<Promise<void>>();
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private cleanupTimer: NodeJS.Timeout | null = null;
    private stopping = false;

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

    private trackBackground(task: Promise<void>): void {
        this.backgroundTasks.add(task);
        void task.then(
            () => this.backgroundTasks.delete(task),
            error => {
                this.backgroundTasks.delete(task);
                console.error('Video broker background task failed', error);
            },
        );
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
            estimate_ready INTEGER NOT NULL DEFAULT 0,
            initial_estimate_low_seconds INTEGER,
            initial_estimate_high_seconds INTEGER,
            initial_estimate_recorded_at INTEGER,
            stage TEXT,
            progress REAL,
            worker_id TEXT,
            lease_expires_at INTEGER,
            lease_token TEXT,
            result_path TEXT,
            result_sha256 TEXT,
            result_bytes INTEGER,
            error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            started_at INTEGER,
            completed_at INTEGER,
            runtime_seconds REAL,
            delivered_at INTEGER,
            notified_at INTEGER,
            planner_json TEXT,
            planner_model TEXT,
            source_image_path TEXT,
            source_image_mime TEXT,
            source_image_bytes INTEGER,
            keyframe_path TEXT,
            keyframe_mime TEXT,
            keyframe_provider TEXT,
            keyframe_model TEXT,
            affinity_bypasses INTEGER NOT NULL DEFAULT 0
        )`);
        const jobColumns = await this.all<{ name: string }>('PRAGMA table_info(video_jobs)');
        const columnNames = new Set(jobColumns.map(column => column.name));
        if (!columnNames.has('planner_json')) {
            await this.run('ALTER TABLE video_jobs ADD COLUMN planner_json TEXT');
        }
        if (!columnNames.has('planner_model')) {
            await this.run('ALTER TABLE video_jobs ADD COLUMN planner_model TEXT');
        }
        if (!columnNames.has('affinity_bypasses')) {
            await this.run('ALTER TABLE video_jobs ADD COLUMN affinity_bypasses INTEGER NOT NULL DEFAULT 0');
        }
        if (!columnNames.has('runtime_seconds')) {
            await this.run('ALTER TABLE video_jobs ADD COLUMN runtime_seconds REAL');
            await this.run(`UPDATE video_jobs SET runtime_seconds = completed_at - started_at
                WHERE completed_at IS NOT NULL AND started_at IS NOT NULL AND completed_at > started_at`);
        }
        if (!columnNames.has('estimate_ready')) {
            await this.run('ALTER TABLE video_jobs ADD COLUMN estimate_ready INTEGER NOT NULL DEFAULT 0');
        }
        if (!columnNames.has('lease_token')) {
            await this.run('ALTER TABLE video_jobs ADD COLUMN lease_token TEXT');
        }
        for (const name of [
            'initial_estimate_low_seconds',
            'initial_estimate_high_seconds',
            'initial_estimate_recorded_at',
        ]) {
            if (!columnNames.has(name)) {
                await this.run(`ALTER TABLE video_jobs ADD COLUMN ${name} INTEGER`);
            }
        }
        for (const [name, definition] of [
            ['source_image_path', 'TEXT'],
            ['source_image_mime', 'TEXT'],
            ['source_image_bytes', 'INTEGER'],
            ['keyframe_path', 'TEXT'],
            ['keyframe_mime', 'TEXT'],
            ['keyframe_provider', 'TEXT'],
            ['keyframe_model', 'TEXT'],
        ] as const) {
            if (!columnNames.has(name)) {
                await this.run(`ALTER TABLE video_jobs ADD COLUMN ${name} ${definition}`);
            }
        }
        await this.run(`CREATE INDEX IF NOT EXISTS video_jobs_queue_idx
            ON video_jobs(status, id)`);
        await this.run(`CREATE INDEX IF NOT EXISTS video_jobs_origin_idx
            ON video_jobs(origin_bot_id, status, updated_at)`);
        await this.run(`CREATE TABLE IF NOT EXISTS video_control (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            paused_until INTEGER,
            dispatch_paused INTEGER NOT NULL DEFAULT 0,
            updated_by TEXT,
            updated_at INTEGER NOT NULL
        )`);
        const controlColumns = new Set(
            (await this.all<{ name: string }>('PRAGMA table_info(video_control)'))
                .map(column => column.name),
        );
        if (!controlColumns.has('dispatch_paused')) {
            await this.run('ALTER TABLE video_control ADD COLUMN dispatch_paused INTEGER NOT NULL DEFAULT 0');
        }
        await this.run(
            `INSERT OR IGNORE INTO video_control(id, paused_until, dispatch_paused, updated_by, updated_at)
             VALUES(1, NULL, 0, NULL, ?)`,
            [nowSeconds()],
        );
        await this.run(`CREATE TABLE IF NOT EXISTS video_runtime_samples (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            model TEXT NOT NULL,
            runtime_seconds REAL NOT NULL,
            recorded_at INTEGER NOT NULL
        )`);
        await this.run(`CREATE TABLE IF NOT EXISTS video_job_metrics (
            job_public_id TEXT PRIMARY KEY,
            model TEXT NOT NULL,
            generator_model TEXT NOT NULL,
            total_seconds REAL NOT NULL,
            output_duration_seconds REAL,
            width INTEGER,
            height INTEGER,
            fps REAL,
            segment_count INTEGER,
            output_bytes INTEGER,
            source_image INTEGER NOT NULL DEFAULT 0,
            gpu_name TEXT,
            driver_version TEXT,
            vram_total_mb REAL,
            vram_peak_mb REAL,
            vram_average_mb REAL,
            vram_free_min_mb REAL,
            gpu_utilization_average REAL,
            gpu_utilization_peak REAL,
            power_average_watts REAL,
            temperature_peak_c REAL,
            pcie_link_width_min REAL,
            pcie_link_width_max REAL,
            hardware_slowdown_samples INTEGER,
            thermal_slowdown_samples INTEGER,
            power_brake_slowdown_samples INTEGER,
            gpu_samples INTEGER,
            worker_sha256 TEXT,
            generator_sha256 TEXT,
            python_version TEXT,
            comfy_aimdo_version TEXT,
            warm_model_before TEXT,
            warm_model_after TEXT,
            quality TEXT,
            fast INTEGER NOT NULL DEFAULT 0,
            turbo4 INTEGER NOT NULL DEFAULT 0,
            ltx_one_stage INTEGER NOT NULL DEFAULT 0,
            recorded_at INTEGER NOT NULL
        )`);
        const metricColumns = new Set(
            (await this.all<{ name: string }>('PRAGMA table_info(video_job_metrics)'))
                .map(column => column.name),
        );
        for (const [name, definition] of [
            ['vram_free_min_mb', 'REAL'],
            ['temperature_peak_c', 'REAL'],
            ['pcie_link_width_min', 'REAL'],
            ['pcie_link_width_max', 'REAL'],
            ['hardware_slowdown_samples', 'INTEGER'],
            ['thermal_slowdown_samples', 'INTEGER'],
            ['power_brake_slowdown_samples', 'INTEGER'],
            ['comfy_aimdo_version', 'TEXT'],
        ] as const) {
            if (!metricColumns.has(name)) {
                await this.run(`ALTER TABLE video_job_metrics ADD COLUMN ${name} ${definition}`);
            }
        }
        await this.run(`CREATE INDEX IF NOT EXISTS video_job_metrics_model_idx
            ON video_job_metrics(model, recorded_at DESC)`);
        await this.run(`CREATE TABLE IF NOT EXISTS video_job_attempt_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_public_id TEXT NOT NULL,
            attempt INTEGER NOT NULL,
            status TEXT NOT NULL,
            total_seconds REAL NOT NULL,
            error TEXT,
            metrics_json TEXT NOT NULL,
            recorded_at INTEGER NOT NULL,
            UNIQUE(job_public_id, attempt)
        )`);
        await this.run(`CREATE INDEX IF NOT EXISTS video_job_attempt_metrics_job_idx
            ON video_job_attempt_metrics(job_public_id, attempt)`);
        await this.run(`CREATE TABLE IF NOT EXISTS video_job_spans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_public_id TEXT NOT NULL,
            source TEXT NOT NULL,
            name TEXT NOT NULL,
            segment_index INTEGER NOT NULL DEFAULT -1,
            duration_seconds REAL NOT NULL,
            metadata_json TEXT,
            recorded_at INTEGER NOT NULL,
            UNIQUE(job_public_id, source, name, segment_index)
        )`);
        await this.run(`CREATE INDEX IF NOT EXISTS video_job_spans_job_idx
            ON video_job_spans(job_public_id)`);
        await this.run(`CREATE TABLE IF NOT EXISTS video_provider_attempt_metrics (
            job_public_id TEXT NOT NULL,
            stage TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            attempt INTEGER NOT NULL,
            outcome TEXT NOT NULL,
            service_tier TEXT,
            duration_seconds REAL NOT NULL,
            detail TEXT,
            recorded_at INTEGER NOT NULL,
            PRIMARY KEY(job_public_id, stage, provider, model, attempt)
        )`);
        await this.run(`CREATE INDEX IF NOT EXISTS video_provider_attempt_metrics_job_idx
            ON video_provider_attempt_metrics(job_public_id, recorded_at)`);
        await this.run(`CREATE TABLE IF NOT EXISTS video_usage_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            job_public_id TEXT NOT NULL,
            origin_bot_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            guild_id TEXT,
            command TEXT NOT NULL,
            stage TEXT NOT NULL,
            attempt INTEGER NOT NULL,
            outcome TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            service_tier TEXT,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            cache_write_tokens INTEGER NOT NULL DEFAULT 0,
            images INTEGER NOT NULL DEFAULT 0,
            web_searches INTEGER NOT NULL DEFAULT 0,
            cost REAL NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            acked_at INTEGER
        )`);
        await this.run(`CREATE INDEX IF NOT EXISTS video_usage_events_delivery_idx
            ON video_usage_events(origin_bot_id, acked_at, sequence)`);
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
        this.stopping = true;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);
        if (this.worker) this.worker.socket.close(1001, 'broker shutdown');
        await new Promise<void>(resolvePromise => this.server.close(() => resolvePromise()));
        await this.preparationChain.catch(() => undefined);
        await Promise.allSettled([...this.backgroundTasks]);
        await new Promise<void>((resolvePromise, reject) => this.db.close(err => err ? reject(err) : resolvePromise()));
    }

    private async control(): Promise<{ paused_until: number | null; dispatch_paused: boolean }> {
        const row = await this.get<{ paused_until: number | null; dispatch_paused: number }>(
            'SELECT paused_until, dispatch_paused FROM video_control WHERE id = 1',
        );
        const paused = row?.paused_until && row.paused_until > nowSeconds() ? row.paused_until : null;
        if (!paused && row?.paused_until) {
            await this.run(
                'UPDATE video_control SET paused_until = NULL, updated_at = ? WHERE id = 1',
                [nowSeconds()],
            );
        }
        return { paused_until: paused, dispatch_paused: Boolean(row?.dispatch_paused) };
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
        if (url.pathname === '/v1/stats' && req.method === 'GET') {
            const requestedModel = url.searchParams.get('model');
            const model = requestedModel && requestedModel !== 'all'
                ? requestedModel
                : null;
            if (model !== null && !isVideoModel(model)) {
                writeJson(res, 400, { error: 'Unknown video model.' });
                return;
            }
            const limit = Math.max(1, Math.min(500, Math.round(Number(url.searchParams.get('limit')) || 100)));
            writeJson(res, 200, await this.videoStats(model, limit));
            return;
        }
        if (url.pathname === '/v1/jobs' && req.method === 'POST') {
            const body = await readJson(req);
            const result = await this.enqueue(body);
            writeJson(res, result.status, result.body);
            return;
        }
        const usageEvents = /^\/v1\/bots\/([^/]+)\/usage-events$/.exec(url.pathname);
        if (usageEvents && req.method === 'GET') {
            const originBotId = decodeURIComponent(usageEvents[1]);
            const limit = Math.max(1, Math.min(200, Math.round(Number(url.searchParams.get('limit')) || 100)));
            const events = await this.all<any>(
                `SELECT event_id, job_public_id AS job_id, user_id, channel_id, guild_id,
                        command, stage, attempt, outcome, provider, model, service_tier,
                        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                        images, web_searches, cost, created_at
                 FROM video_usage_events
                 WHERE origin_bot_id = ? AND acked_at IS NULL
                 ORDER BY sequence ASC LIMIT ?`,
                [originBotId, limit],
            );
            writeJson(res, 200, { events });
            return;
        }
        const usageAck = /^\/v1\/bots\/([^/]+)\/usage-events\/ack$/.exec(url.pathname);
        if (usageAck && req.method === 'POST') {
            const originBotId = decodeURIComponent(usageAck[1]);
            const body = await readJson(req);
            const eventIds = Array.isArray(body.event_ids)
                ? [...new Set(body.event_ids.map((value: unknown) => String(value)).filter(Boolean))].slice(0, 200)
                : [];
            if (eventIds.length) {
                await this.run(
                    `UPDATE video_usage_events SET acked_at = ?
                     WHERE origin_bot_id = ? AND acked_at IS NULL
                     AND event_id IN (${eventIds.map(() => '?').join(',')})`,
                    [nowSeconds(), originBotId, ...eventIds],
                );
            }
            writeJson(res, 200, { ok: true, acknowledged: eventIds.length });
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
        if (url.pathname === '/v1/queue' && req.method === 'GET') {
            const guildId = url.searchParams.get('guild_id');
            const rows = guildId === null
                ? await this.all<JobRow>(
                    `SELECT * FROM video_jobs
                     WHERE status IN (${ACTIVE_SQL}) OR status = 'ready'
                     ORDER BY CASE WHEN status = 'queued' THEN 1 ELSE 0 END, id ASC`,
                )
                : await this.all<JobRow>(
                    `SELECT * FROM video_jobs
                     WHERE guild_id = ? AND (status IN (${ACTIVE_SQL}) OR status = 'ready')
                     ORDER BY CASE WHEN status = 'queued' THEN 1 ELSE 0 END, id ASC`,
                    [guildId],
                );
            writeJson(res, 200, { jobs: await this.views(rows), state: await this.brokerState() });
            return;
        }
        const prepare = /^\/v1\/jobs\/([0-9a-f-]+)\/prepare$/.exec(url.pathname);
        if (prepare && req.method === 'POST') {
            const job = await this.prepareInitialEstimate(prepare[1]);
            if (!job) {
                writeJson(res, 404, { error: 'Unknown video job.' });
                return;
            }
            writeJson(res, 200, { job });
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
            const body = await readJson(req);
            await this.run(
                `UPDATE video_jobs SET status = 'delivered', delivered_at = ?, notified_at = ?, updated_at = ?
                 WHERE public_id = ? AND status = 'ready'`,
                [nowSeconds(), nowSeconds(), nowSeconds(), delivered[1]],
            );
            if (body.duration_seconds !== null && body.duration_seconds !== undefined) {
                await this.recordMetricSpan(delivered[1], {
                    source: 'broker',
                    name: 'discord_delivery',
                    duration_seconds: boundedNumber(body.duration_seconds, 0, 10 * 60, false)!,
                    metadata: { status: 'ok' },
                });
            }
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
            } else if (this.worker) {
                this.sendWorker({ type: 'unload', reason: 'pause' });
                this.worker.warmModel = null;
            }
            writeJson(res, 200, { paused_until: until, state: await this.brokerState() });
            return;
        }
        if (url.pathname === '/v1/control/drain' && req.method === 'POST') {
            const body = await readJson(req);
            await this.run(
                'UPDATE video_control SET dispatch_paused = 1, updated_by = ?, updated_at = ? WHERE id = 1',
                [String(body.actor_id || ''), nowSeconds()],
            );
            writeJson(res, 200, { state: await this.brokerState() });
            return;
        }
        if (url.pathname === '/v1/control/resume-dispatch' && req.method === 'POST') {
            await this.run(
                'UPDATE video_control SET dispatch_paused = 0, updated_by = NULL, updated_at = ? WHERE id = 1',
                [nowSeconds()],
            );
            await this.dispatchNext();
            writeJson(res, 200, { state: await this.brokerState() });
            return;
        }
        if (url.pathname === '/v1/control/resume' && req.method === 'POST') {
            await this.run(
                'UPDATE video_control SET paused_until = NULL, dispatch_paused = 0, updated_by = NULL, updated_at = ? WHERE id = 1',
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
        let sourceDescriptor: VideoSourceImageDescriptor | null;
        try {
            sourceDescriptor = sourceImageDescriptor(body.source_image);
        } catch (error) {
            return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
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
            const directory = resolve(this.options.resultsDir, publicId);
            let sourceImage: StoredVideoSourceImage | null = null;
            let sourceImageDownloadSeconds: number | null = null;
            if (sourceDescriptor) {
                const sourceImageStarted = Date.now();
                try {
                    sourceImage = await (this.options.sourceImageDownloader || downloadDiscordSourceImage)(
                        sourceDescriptor,
                        directory,
                    );
                    sourceImageDownloadSeconds = (Date.now() - sourceImageStarted) / 1000;
                } catch (error) {
                    rmSync(directory, { recursive: true, force: true });
                    return {
                        status: 400,
                        body: { error: `Could not use the attached starting image: ${error instanceof Error ? error.message : String(error)}` },
                    };
                }
            }
            try {
                await this.run(
                    `INSERT INTO video_jobs(
                        public_id, idempotency_key, model, prompt, requester_id, origin_bot_id,
                        channel_id, guild_id, command_message_id, status_message_id, status,
                        estimate_low_seconds, estimate_high_seconds, created_at, updated_at,
                        source_image_path, source_image_mime, source_image_bytes
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
                        sourceImage?.path || null,
                        sourceImage?.mimeType || null,
                        sourceImage?.bytes || null,
                    ],
                );
                if (sourceImageDownloadSeconds !== null) {
                    await this.recordMetricSpan(publicId, {
                        source: 'broker',
                        name: 'source_image_download',
                        duration_seconds: sourceImageDownloadSeconds,
                        metadata: { status: 'ok' },
                    });
                }
            } catch (error) {
                if (sourceImage) rmSync(directory, { recursive: true, force: true });
                throw error;
            }
            const row = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [publicId]);
            if (this.worker?.currentJob) this.schedulePreparation(publicId, false);
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
        if (samples.length === 0) {
            return { low: definition.fallbackLowSeconds, high: definition.fallbackHighSeconds };
        }
        const percentile = (fraction: number) => samples[Math.min(
            samples.length - 1,
            Math.max(0, Math.round((samples.length - 1) * fraction)),
        )];
        const sparse = samples.length < 3;
        const low = Math.max(sparse ? 30 : 60, Math.round(percentile(0.2) * (sparse ? 0.75 : 0.9)));
        const high = Math.max(low + (sparse ? 30 : 60), Math.round(percentile(0.9) * (sparse ? 1.75 : 1.15)));
        return { low, high };
    }

    private async plannedRuntimeEstimate(
        job: JobRow,
        plan: Record<string, any>,
    ): Promise<{ low: number; high: number }> {
        const segments = Array.isArray(plan.segments) ? plan.segments : [];
        const plannedDuration = segments.reduce(
            (sum: number, segment: any) => sum + Math.max(0, Number(segment?.target_seconds) || 0),
            0,
        );
        const segmentCount = Math.max(1, segments.length);
        if (!(plannedDuration > 0)) return this.runtimeEstimate(job.model);
        const usesStartFrame = Boolean(job.source_image_path || plan?.keyframe?.recommended === true);
        const rows = await this.all<{
            total_seconds: number;
            output_duration_seconds: number;
            segment_count: number;
            source_image: number;
        }>(
            `SELECT total_seconds, output_duration_seconds, segment_count, source_image
             FROM video_job_metrics
             WHERE model = ? AND output_duration_seconds > 0 AND segment_count > 0
             ORDER BY recorded_at DESC LIMIT 50`,
            [job.model],
        );
        const predictions = rows.map(row => {
            const durationRatio = plannedDuration / Number(row.output_duration_seconds);
            const segmentRatio = segmentCount / Number(row.segment_count);
            const durationFactor = 0.25 + 0.75 * durationRatio;
            const segmentFactor = 0.85 + 0.15 * segmentRatio;
            const sourceFactor = usesStartFrame === Boolean(row.source_image)
                ? 1
                : usesStartFrame ? 1.08 : 0.96;
            const factor = Math.max(0.3, Math.min(4, durationFactor * segmentFactor * sourceFactor));
            return Number(row.total_seconds) * factor;
        }).filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
        if (predictions.length) {
            const percentile = (fraction: number) => predictions[Math.min(
                predictions.length - 1,
                Math.max(0, Math.round((predictions.length - 1) * fraction)),
            )];
            const center = percentile(0.5);
            let low = Math.max(30, Math.round(center * 0.45));
            let high = Math.max(low + 30, Math.round(center * 1.55));
            // One or two structured samples must not create a falsely precise ETA.
            // Blend the broader model history until plan-aware evidence is mature.
            if (predictions.length < 3) {
                const legacy = await this.runtimeEstimate(job.model);
                const durationFactor = Math.max(0.4, Math.min(2.5, 0.25 + 0.75 * (plannedDuration / 10)));
                const segmentFactor = 1 + Math.max(0, segmentCount - 1) * 0.12;
                low = Math.min(low, Math.max(30, Math.round(legacy.low * durationFactor * segmentFactor)));
                high = Math.max(high, Math.round(legacy.high * durationFactor * segmentFactor));
            }
            return { low, high };
        }
        const legacy = await this.runtimeEstimate(job.model);
        const durationFactor = Math.max(0.4, Math.min(2.5, 0.25 + 0.75 * (plannedDuration / 10)));
        const segmentFactor = 1 + Math.max(0, segmentCount - 1) * 0.12;
        return {
            low: Math.max(30, Math.round(legacy.low * durationFactor * segmentFactor)),
            high: Math.max(60, Math.round(legacy.high * durationFactor * segmentFactor)),
        };
    }

    private async prepareInitialEstimate(publicId: string): Promise<VideoJobView | null> {
        let job = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [publicId]);
        if (!job) return null;
        if (ACTIVE_VIDEO_STATUSES.includes(job.status)) {
            try {
                const { plan } = await this.ensurePlan(job, true);
                const estimate = await this.plannedRuntimeEstimate(job, plan);
                await this.run(
                    `UPDATE video_jobs SET estimate_low_seconds = ?, estimate_high_seconds = ?,
                     estimate_ready = 1,
                     initial_estimate_low_seconds = COALESCE(initial_estimate_low_seconds, ?),
                     initial_estimate_high_seconds = COALESCE(initial_estimate_high_seconds, ?),
                     initial_estimate_recorded_at = COALESCE(initial_estimate_recorded_at, ?),
                     updated_at = ?
                     WHERE public_id = ? AND status IN (${ACTIVE_SQL})`,
                    [
                        estimate.low,
                        estimate.high,
                        estimate.low,
                        estimate.high,
                        nowSeconds(),
                        nowSeconds(),
                        publicId,
                    ],
                );
                job = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [publicId]) || job;
            } catch (error) {
                console.warn(`Could not prepare initial ETA for ${publicId}`, error);
            }
        }
        return (await this.views([job]))[0] || null;
    }

    private async refreshQueuedEstimates(model: VideoModelId): Promise<void> {
        const estimate = await this.runtimeEstimate(model);
        await this.run(
            `UPDATE video_jobs SET estimate_low_seconds = ?, estimate_high_seconds = ?, updated_at = ?
             WHERE model = ? AND status = 'queued' AND estimate_ready = 0`,
            [estimate.low, estimate.high, nowSeconds(), model],
        );
    }

    private async recordMetricSpan(jobId: string, span: VideoMetricSpan): Promise<void> {
        const normalized = normalizedMetricSpan(span);
        await this.run(
            `INSERT INTO video_job_spans(
                job_public_id, source, name, segment_index, duration_seconds, metadata_json, recorded_at
             ) VALUES(?,?,?,?,?,?,?)
             ON CONFLICT(job_public_id, source, name, segment_index) DO UPDATE SET
                duration_seconds = excluded.duration_seconds,
                metadata_json = excluded.metadata_json,
                recorded_at = excluded.recorded_at`,
            [
                jobId,
                normalized.source,
                normalized.name,
                normalized.segment_index ?? -1,
                normalized.duration_seconds,
                normalized.metadata ? JSON.stringify(normalized.metadata) : null,
                nowSeconds(),
            ],
        );
    }

    private async storeWorkerMetrics(job: JobRow, body: any): Promise<void> {
        const metrics = normalizedWorkerMetrics(body, job.model);
        const output = metrics.output || {};
        const gpu = metrics.gpu || {};
        const environment = metrics.environment || {};
        const flags = metrics.flags || {};
        await this.withWriteLock(async () => {
            await this.run(
                `INSERT INTO video_job_metrics(
                    job_public_id, model, generator_model, total_seconds,
                    output_duration_seconds, width, height, fps, segment_count, output_bytes,
                    source_image, gpu_name, driver_version, vram_total_mb, vram_peak_mb,
                    vram_average_mb, vram_free_min_mb, gpu_utilization_average, gpu_utilization_peak,
                    power_average_watts, temperature_peak_c, pcie_link_width_min, pcie_link_width_max,
                    hardware_slowdown_samples, thermal_slowdown_samples, power_brake_slowdown_samples,
                    gpu_samples, worker_sha256, generator_sha256,
                    python_version, comfy_aimdo_version, warm_model_before, warm_model_after, quality, fast,
                    turbo4, ltx_one_stage, recorded_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(job_public_id) DO UPDATE SET
                    model = excluded.model,
                    generator_model = excluded.generator_model,
                    total_seconds = excluded.total_seconds,
                    output_duration_seconds = excluded.output_duration_seconds,
                    width = excluded.width,
                    height = excluded.height,
                    fps = excluded.fps,
                    segment_count = excluded.segment_count,
                    output_bytes = excluded.output_bytes,
                    source_image = excluded.source_image,
                    gpu_name = excluded.gpu_name,
                    driver_version = excluded.driver_version,
                    vram_total_mb = excluded.vram_total_mb,
                    vram_peak_mb = excluded.vram_peak_mb,
                    vram_average_mb = excluded.vram_average_mb,
                    vram_free_min_mb = excluded.vram_free_min_mb,
                    gpu_utilization_average = excluded.gpu_utilization_average,
                    gpu_utilization_peak = excluded.gpu_utilization_peak,
                    power_average_watts = excluded.power_average_watts,
                    temperature_peak_c = excluded.temperature_peak_c,
                    pcie_link_width_min = excluded.pcie_link_width_min,
                    pcie_link_width_max = excluded.pcie_link_width_max,
                    hardware_slowdown_samples = excluded.hardware_slowdown_samples,
                    thermal_slowdown_samples = excluded.thermal_slowdown_samples,
                    power_brake_slowdown_samples = excluded.power_brake_slowdown_samples,
                    gpu_samples = excluded.gpu_samples,
                    worker_sha256 = excluded.worker_sha256,
                    generator_sha256 = excluded.generator_sha256,
                    python_version = excluded.python_version,
                    comfy_aimdo_version = excluded.comfy_aimdo_version,
                    warm_model_before = excluded.warm_model_before,
                    warm_model_after = excluded.warm_model_after,
                    quality = excluded.quality,
                    fast = excluded.fast,
                    turbo4 = excluded.turbo4,
                    ltx_one_stage = excluded.ltx_one_stage,
                    recorded_at = excluded.recorded_at`,
                [
                    job.public_id,
                    metrics.model,
                    metrics.generator_model,
                    metrics.total_seconds,
                    output.duration_seconds ?? null,
                    output.width ?? null,
                    output.height ?? null,
                    output.fps ?? null,
                    output.segment_count ?? null,
                    output.bytes ?? null,
                    output.source_image ? 1 : 0,
                    gpu.name ?? null,
                    gpu.driver_version ?? null,
                    gpu.vram_total_mb ?? null,
                    gpu.vram_peak_mb ?? null,
                    gpu.vram_average_mb ?? null,
                    gpu.vram_free_min_mb ?? null,
                    gpu.utilization_average_percent ?? null,
                    gpu.utilization_peak_percent ?? null,
                    gpu.power_average_watts ?? null,
                    gpu.temperature_peak_c ?? null,
                    gpu.pcie_link_width_min ?? null,
                    gpu.pcie_link_width_max ?? null,
                    gpu.hardware_slowdown_samples ?? null,
                    gpu.thermal_slowdown_samples ?? null,
                    gpu.power_brake_slowdown_samples ?? null,
                    gpu.samples ?? null,
                    environment.worker_sha256 ?? null,
                    environment.generator_sha256 ?? null,
                    environment.python_version ?? null,
                    environment.comfy_aimdo_version ?? null,
                    environment.warm_model_before ?? null,
                    environment.warm_model_after ?? null,
                    flags.quality ?? null,
                    flags.fast ? 1 : 0,
                    flags.turbo4 ? 1 : 0,
                    flags.ltx_one_stage ? 1 : 0,
                    nowSeconds(),
                ],
            );
            for (const span of metrics.spans) await this.recordMetricSpan(job.public_id, span);
        });
    }

    private async storeWorkerAttemptMetrics(job: JobRow, body: any, error: string): Promise<void> {
        const metrics = normalizedWorkerMetrics(body, job.model);
        await this.run(
            `INSERT INTO video_job_attempt_metrics(
                job_public_id, attempt, status, total_seconds, error, metrics_json, recorded_at
             ) VALUES(?,?,?,?,?,?,?)
             ON CONFLICT(job_public_id, attempt) DO UPDATE SET
                status = excluded.status,
                total_seconds = excluded.total_seconds,
                error = excluded.error,
                metrics_json = excluded.metrics_json,
                recorded_at = excluded.recorded_at`,
            [
                job.public_id,
                job.attempt,
                metrics.failure?.kind || 'generator_failure',
                metrics.total_seconds,
                error,
                JSON.stringify(metrics),
                nowSeconds(),
            ],
        );
    }

    private async videoStats(model: VideoModelId | null, limit: number): Promise<any> {
        const params: any[] = [];
        const filter = model ? 'WHERE m.model = ?' : '';
        if (model) params.push(model);
        params.push(limit);
        const rows = await this.all<VideoJobMetricRow>(
            `SELECT m.*, j.planner_model, j.keyframe_provider, j.keyframe_model
             FROM video_job_metrics m
             JOIN video_jobs j ON j.public_id = m.job_public_id
             ${filter} ORDER BY m.recorded_at DESC LIMIT ?`,
            params,
        );
        if (!rows.length) {
            return { generated_at: nowSeconds(), filter: model || 'all', samples: 0, models: [] };
        }
        const ids = rows.map(row => row.job_public_id);
        const spans = await this.all<VideoJobSpanRow>(
            `SELECT job_public_id, source, name, segment_index, duration_seconds, metadata_json
             FROM video_job_spans WHERE job_public_id IN (${ids.map(() => '?').join(',')})`,
            ids,
        );
        const summaries = [...new Set(rows.map(row => row.model))].map(modelId => {
            const modelRows = rows.filter(row => row.model === modelId);
            const jobIds = new Set(modelRows.map(row => row.job_public_id));
            const modelSpans = spans.filter(span => jobIds.has(span.job_public_id));
            const phase = (source: VideoMetricSpan['source'], name: string) => average(
                modelSpans
                    .filter(span => span.source === source && span.name === name)
                    .map(span => span.duration_seconds),
            );
            const spanGroups = new Map<string, VideoJobSpanRow[]>();
            for (const span of modelSpans) {
                const key = `${span.source}\u0000${span.name}`;
                spanGroups.set(key, [...(spanGroups.get(key) || []), span]);
            }
            const bottlenecks = [...spanGroups.entries()]
                .map(([key, values]) => {
                    const [source, name] = key.split('\u0000');
                    return {
                        source,
                        name,
                        average_seconds: average(values.map(value => value.duration_seconds)),
                        samples: values.length,
                    };
                })
                .sort((a, b) => (b.average_seconds || 0) - (a.average_seconds || 0))
                .slice(0, 8);
            return {
                model: modelId,
                display_name: VIDEO_MODELS[modelId].displayName,
                samples: modelRows.length,
                total_seconds: {
                    average: average(modelRows.map(row => row.total_seconds)),
                    median: median(modelRows.map(row => row.total_seconds)),
                    minimum: Math.min(...modelRows.map(row => row.total_seconds)),
                    maximum: Math.max(...modelRows.map(row => row.total_seconds)),
                },
                output_duration_average: average(modelRows.map(row => row.output_duration_seconds)),
                seconds_per_output_second_average: average(modelRows.map(row => (
                    row.output_duration_seconds && row.output_duration_seconds > 0
                        ? row.total_seconds / row.output_duration_seconds
                        : null
                ))),
                segment_count_average: average(modelRows.map(row => row.segment_count)),
                phases: {
                    planning: phase('broker', 'frontier_planner'),
                    first_frame: phase('broker', 'frontier_keyframe'),
                    generator: phase('worker', 'generator_process'),
                    compression: phase('worker', 'delivery_compression'),
                    upload: phase('worker', 'result_upload'),
                    discord_delivery: phase('broker', 'discord_delivery'),
                },
                gpu: {
                    vram_peak_average_mb: average(modelRows.map(row => row.vram_peak_mb)),
                    vram_free_minimum_mb: minimum(modelRows.map(row => row.vram_free_min_mb)),
                    utilization_average_percent: average(modelRows.map(row => row.gpu_utilization_average)),
                    power_average_watts: average(modelRows.map(row => row.power_average_watts)),
                    temperature_peak_c: maximum(modelRows.map(row => row.temperature_peak_c)),
                },
                cold_starts: modelRows.filter(row => row.warm_model_before !== row.generator_model).length,
                bottlenecks,
                latest_environment: {
                    gpu_name: modelRows[0].gpu_name,
                    driver_version: modelRows[0].driver_version,
                    worker_sha256: modelRows[0].worker_sha256,
                    generator_sha256: modelRows[0].generator_sha256,
                    python_version: modelRows[0].python_version,
                    comfy_aimdo_version: modelRows[0].comfy_aimdo_version,
                    planner_model: modelRows[0].planner_model,
                    keyframe_provider: modelRows[0].keyframe_provider,
                    keyframe_model: modelRows[0].keyframe_model,
                },
            };
        });
        return {
            generated_at: nowSeconds(),
            filter: model || 'all',
            samples: rows.length,
            models: summaries,
        };
    }

    private providerHooks(job: JobRow): VideoProviderHooks {
        return {
            onUsage: async (usage: VideoProviderUsage) => {
                const eventId = [
                    job.public_id,
                    usage.stage,
                    usage.provider,
                    usage.model,
                    usage.attempt,
                ].join(':');
                const integer = (value: number | undefined) => Math.max(0, Math.round(Number(value) || 0));
                await this.run(
                    `INSERT OR IGNORE INTO video_usage_events(
                        event_id, job_public_id, origin_bot_id, user_id, channel_id, guild_id,
                        command, stage, attempt, outcome, provider, model, service_tier,
                        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                        images, web_searches, cost, created_at
                     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [
                        eventId,
                        job.public_id,
                        job.origin_bot_id,
                        job.requester_id,
                        job.channel_id,
                        job.guild_id,
                        VIDEO_MODELS[job.model].command,
                        usage.stage,
                        Math.max(1, Math.round(usage.attempt)),
                        usage.outcome,
                        usage.provider,
                        usage.model,
                        usage.serviceTier || null,
                        integer(usage.inputTokens),
                        integer(usage.outputTokens),
                        integer(usage.cacheReadTokens),
                        integer(usage.cacheWriteTokens),
                        integer(usage.images),
                        integer(usage.webSearches),
                        videoUsageCost(usage),
                        nowSeconds(),
                    ],
                ).catch((error) => {
                    throw new VideoUsagePersistenceError(
                        `Could not persist provider usage for ${job.public_id}.`,
                        error,
                    );
                });
            },
            onAttempt: async (attempt: VideoProviderAttempt) => {
                await this.run(
                    `INSERT INTO video_provider_attempt_metrics(
                        job_public_id, stage, provider, model, attempt, outcome,
                        service_tier, duration_seconds, detail, recorded_at
                     ) VALUES(?,?,?,?,?,?,?,?,?,?)
                     ON CONFLICT(job_public_id, stage, provider, model, attempt) DO UPDATE SET
                        outcome = excluded.outcome,
                        service_tier = excluded.service_tier,
                        duration_seconds = excluded.duration_seconds,
                        detail = excluded.detail,
                        recorded_at = excluded.recorded_at`,
                    [
                        job.public_id,
                        attempt.stage,
                        attempt.provider,
                        attempt.model,
                        Math.max(1, Math.round(attempt.attempt)),
                        attempt.outcome,
                        attempt.serviceTier || null,
                        Math.max(0, attempt.durationSeconds),
                        attempt.detail ? sanitizeVideoWorkerText(attempt.detail, '', 1000) : null,
                        nowSeconds(),
                    ],
                ).catch((error) => {
                    console.warn(`Could not persist provider attempt timing for ${job.public_id}`, error);
                    return { changes: 0, lastID: 0 };
                });
            },
        };
    }

    private frontierOptions(job: JobRow, criticalPath: boolean): VideoFrontierCallOptions {
        return {
            serviceTier: criticalPath ? 'fast' : 'default',
            ...this.providerHooks(job),
        };
    }

    private keyframeStrategy(job: JobRow): 'serial-v1' | 'conditional-v2' {
        const globalStrategy = process.env.VIDEO_KEYFRAME_STRATEGY;
        if (globalStrategy === 'serial-v1' || globalStrategy === 'conditional-v2') {
            return globalStrategy;
        }
        const canaryChannels = new Set(
            (process.env.VIDEO_KEYFRAME_CANARY_CHANNELS || '483470443001413675')
                .split(',')
                .map(value => value.trim())
                .filter(Boolean),
        );
        return canaryChannels.has(job.channel_id) ? 'conditional-v2' : 'serial-v1';
    }

    private async ensurePlan(
        job: JobRow,
        criticalPath = false,
    ): Promise<{ plan: Record<string, any>; plannerModel: string }> {
        if (job.planner_json) {
            return {
                plan: JSON.parse(job.planner_json),
                plannerModel: job.planner_model || VIDEO_PLANNER_MODEL,
            };
        }
        const cachedRejection = cachedFrontierRejection(job.planner_model);
        if (cachedRejection) {
            throw new FrontierPlannerRejectedError(
                cachedRejection,
                `Frontier planner previously classified this request for local fallback (${cachedRejection}).`,
            );
        }
        let planning = this.plannerInFlight.get(job.public_id);
        if (!planning) {
            planning = (async () => {
                const started = Date.now();
                let status: 'ok' | 'error' = 'error';
                try {
                    let sourceImage: VideoPlanSourceImage | undefined;
                    if (job.source_image_path && job.source_image_mime
                        && VIDEO_SOURCE_IMAGE_MIME_TYPES.includes(job.source_image_mime as any)
                        && existsSync(job.source_image_path)
                        && statSync(job.source_image_path).isFile()) {
                        sourceImage = {
                            mimeType: job.source_image_mime as VideoPlanSourceImage['mimeType'],
                            data: readFileSync(job.source_image_path),
                        };
                    }
                    const plan = await (this.options.frontierPlanner || createFrontierVideoPlan)(
                        job.prompt,
                        job.model,
                        job.requester_id,
                        sourceImage,
                        this.frontierOptions(job, criticalPath),
                    );
                    const plannerMetrics = (plan as any).planner_metrics;
                    if (plannerMetrics && typeof plannerMetrics === 'object') {
                        for (const [name, seconds] of [
                            ['frontier_prompt_analysis', Number(plannerMetrics.prompt_analysis_seconds)],
                            ['frontier_screenplay', Number(plannerMetrics.screenplay_seconds)],
                        ] as const) {
                            if (Number.isFinite(seconds) && seconds >= 0) {
                                await this.recordMetricSpan(job.public_id, {
                                    source: 'broker',
                                    name,
                                    duration_seconds: seconds,
                                });
                            }
                        }
                    }
                    await this.run(
                        `UPDATE video_jobs SET planner_json = ?, planner_model = ?, updated_at = ?
                         WHERE public_id = ? AND status IN (${ACTIVE_SQL})`,
                        [JSON.stringify(plan), VIDEO_PLANNER_MODEL, nowSeconds(), job.public_id],
                    );
                    status = 'ok';
                    return { plan, plannerModel: VIDEO_PLANNER_MODEL };
                } catch (error) {
                    if (error instanceof FrontierPlannerRejectedError) {
                        const reasonCode = /^[a-z_]+$/.test(error.reasonCode)
                            ? error.reasonCode
                            : 'other';
                        await this.run(
                            `UPDATE video_jobs SET planner_model = ?, updated_at = ?
                             WHERE public_id = ? AND status IN (${ACTIVE_SQL})`,
                            [`${FRONTIER_REJECTION_PREFIX}${reasonCode}`, nowSeconds(), job.public_id],
                        );
                    }
                    throw error;
                } finally {
                    try {
                        await this.recordMetricSpan(job.public_id, {
                            source: 'broker',
                            name: 'frontier_planner',
                            duration_seconds: (Date.now() - started) / 1000,
                            metadata: { status },
                        });
                    } catch (error) {
                        console.warn(`Could not store planner timing for ${job.public_id}`, error);
                    }
                }
            })();
            this.plannerInFlight.set(job.public_id, planning);
        }
        try {
            return await planning;
        } finally {
            if (this.plannerInFlight.get(job.public_id) === planning) {
                this.plannerInFlight.delete(job.public_id);
            }
        }
    }

    private async ensureKeyframe(
        job: JobRow,
        plan: Record<string, any>,
        criticalPath = false,
    ): Promise<void> {
        if (job.source_image_path || plan?.keyframe?.recommended !== true
            || (job.keyframe_path && job.keyframe_mime)) return;
        let generation = this.keyframeInFlight.get(job.public_id);
        if (!generation) {
            generation = (async () => {
                const started = Date.now();
                let status: 'ok' | 'error' | 'skipped' = 'error';
                try {
                    const directory = resolve(this.options.resultsDir, job.public_id);
                    mkdirSync(directory, { recursive: true });
                    const referencesRequested = countVideoKeyframeReferenceRequirements(plan);
                    const referenceStarted = Date.now();
                    let referenceStatus: 'ok' | 'error' = 'ok';
                    let references: VideoKeyframeReference[] = [];
                    try {
                        const hooks = this.providerHooks(job);
                        references = this.options.keyframeReferenceResolver
                            ? await this.options.keyframeReferenceResolver(plan, directory, hooks)
                            : await resolveVideoKeyframeReferences(
                                plan,
                                directory,
                                undefined,
                                undefined,
                                hooks,
                            );
                    } catch (error) {
                        referenceStatus = 'error';
                        console.warn(`First-frame reference retrieval failed for ${job.public_id}; continuing without references.`, error);
                    } finally {
                        try {
                            await this.recordMetricSpan(job.public_id, {
                                source: 'broker',
                                name: 'frontier_keyframe_references',
                                duration_seconds: (Date.now() - referenceStarted) / 1000,
                                metadata: {
                                    status: referenceStatus,
                                    references_requested: referencesRequested,
                                    references_resolved: references.length,
                                },
                            });
                        } catch (error) {
                            console.warn(`Could not store first-frame reference timing for ${job.public_id}`, error);
                        }
                    }
                    const result = await (this.options.keyframeGenerator || createFrontierVideoKeyframe)(
                        plan,
                        references,
                        {
                            ...this.frontierOptions(job, criticalPath),
                            strategy: this.keyframeStrategy(job),
                        },
                    );
                    if (!result.bytes.length || result.bytes.length > VIDEO_KEYFRAME_MAX_BYTES) {
                        throw new Error('Generated first frame is empty or too large.');
                    }
                    await this.providerHooks(job).onAttempt?.({
                        stage: 'keyframe_review_decision',
                        attempt: 1,
                        outcome: result.reviewStatus === 'unreviewed' ? 'unreviewed' : 'accepted',
                        provider: result.provider,
                        model: result.model,
                        serviceTier: criticalPath ? 'priority' : 'default',
                        durationSeconds: 0,
                    });
                    const current = await this.get<JobRow>(
                        'SELECT status FROM video_jobs WHERE public_id = ?',
                        [job.public_id],
                    );
                    if (!current || !ACTIVE_VIDEO_STATUSES.includes(current.status)) {
                        status = 'skipped';
                        return;
                    }
                    const extension = imageExtension(result.mimeType);
                    const temporary = join(directory, `keyframe.${extension}.part`);
                    const destination = join(directory, `keyframe.${extension}`);
                    rmSync(temporary, { force: true });
                    const stream = createWriteStream(temporary, { flags: 'wx' });
                    await new Promise<void>((resolvePromise, reject) => {
                        stream.once('finish', resolvePromise);
                        stream.once('error', reject);
                        stream.end(result.bytes);
                    });
                    rmSync(destination, { force: true });
                    renameSync(temporary, destination);
                    await this.run(
                        `UPDATE video_jobs SET keyframe_path = ?, keyframe_mime = ?,
                         keyframe_provider = ?, keyframe_model = ?, updated_at = ?
                         WHERE public_id = ? AND status IN (${ACTIVE_SQL})`,
                        [
                            destination,
                            result.mimeType,
                            result.provider,
                            result.model,
                            nowSeconds(),
                            job.public_id,
                        ],
                    );
                    status = 'ok';
                } finally {
                    try {
                        await this.recordMetricSpan(job.public_id, {
                            source: 'broker',
                            name: 'frontier_keyframe',
                            duration_seconds: (Date.now() - started) / 1000,
                            metadata: { status },
                        });
                    } catch (error) {
                        console.warn(`Could not store first-frame timing for ${job.public_id}`, error);
                    }
                }
            })();
            this.keyframeInFlight.set(job.public_id, generation);
        }
        try {
            await generation;
        } finally {
            if (this.keyframeInFlight.get(job.public_id) === generation) {
                this.keyframeInFlight.delete(job.public_id);
            }
        }
    }

    private schedulePreparation(publicId: string, criticalPath = false): void {
        if (!this.options.preplanQueuedJobs || this.preparationQueued.has(publicId)) return;
        this.preparationQueued.add(publicId);
        const prepare = async () => {
            try {
                const job = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [publicId]);
                if (!job || !ACTIVE_VIDEO_STATUSES.includes(job.status)) return;
                const { plan } = await this.ensurePlan(job, criticalPath);
                const refreshed = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [publicId]);
                if (!refreshed || !ACTIVE_VIDEO_STATUSES.includes(refreshed.status)) return;
                await this.ensureKeyframe(refreshed, plan, criticalPath);
            } catch (error) {
                if (error instanceof FrontierPlannerRejectedError) {
                    console.log(
                        `Frontier planner routed ${publicId} to the local planner (${error.reasonCode}).`,
                    );
                } else {
                    console.warn(`Queued video preparation failed for ${publicId}; the worker will retry on demand.`, error);
                }
            } finally {
                this.preparationQueued.delete(publicId);
            }
        };
        this.preparationChain = this.preparationChain.then(prepare, prepare);
    }

    private async scheduleNextQueuedPreparation(): Promise<void> {
        if (!this.options.preplanQueuedJobs || !this.worker) return;
        const placeholders = this.worker.capabilities.map(() => '?').join(',');
        if (!placeholders) return;
        const row = await this.get<JobRow>(
            `SELECT * FROM video_jobs WHERE status = 'queued' AND model IN (${placeholders})
             ORDER BY id ASC LIMIT 1`,
            this.worker.capabilities,
        );
        if (row) this.schedulePreparation(row.public_id, false);
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
        const active = await this.get<{ count: number }>(
            `SELECT COUNT(*) AS count FROM video_jobs
             WHERE status IN (${ACTIVE_SQL}) AND status != 'queued'`,
        );
        return {
            worker_online: Boolean(this.worker),
            worker_busy: Boolean(this.worker?.currentJob),
            worker_id: this.worker?.id || null,
            current_job: this.worker?.currentJob || null,
            paused_until: control.paused_until,
            dispatch_paused: control.dispatch_paused,
            scheduler: this.worker?.scheduler || null,
            queued: queued?.count || 0,
            active_jobs: active?.count || 0,
            preparation_busy: this.plannerInFlight.size > 0 || this.keyframeInFlight.size > 0
                || this.preparationQueued.size > 0,
        };
    }

    private async views(rows: JobRow[]): Promise<VideoJobView[]> {
        if (rows.length === 0) return [];
        const allActive = await this.all<JobRow>(
            `SELECT * FROM video_jobs WHERE status IN (${ACTIVE_SQL})
             ORDER BY CASE WHEN status = 'queued' THEN 1 ELSE 0 END, id ASC`,
        );
        const control = await this.control();
        const online = Boolean(this.worker);
        // A dispatch drain only blocks future leases. It must not erase the ETA
        // of work the desktop is already rendering.
        const canEstimateActive = online && !control.paused_until;
        const canEstimateQueued = canEstimateActive
            && schedulerAdmitsWork(this.worker!.scheduler)
            && !control.dispatch_paused;
        const busy = Boolean(this.worker?.currentJob);
        const now = nowSeconds();
        let cursor = Math.max(now, control.paused_until || now);
        const projections = new Map<string, { position: number | null; start: number | null; finish: number | null }>();
        let queuePosition = 0;
        for (const row of allActive) {
            const expectedRuntime = Math.max(
                1,
                Math.round((row.estimate_low_seconds + row.estimate_high_seconds) / 2),
            );
            if (row.status === 'queued') {
                queuePosition += 1;
                if (!canEstimateQueued) {
                    projections.set(row.public_id, { position: queuePosition, start: null, finish: null });
                    continue;
                }
                const start = cursor;
                cursor += expectedRuntime;
                projections.set(row.public_id, { position: queuePosition, start, finish: cursor });
            } else {
                if (!canEstimateActive) {
                    projections.set(row.public_id, { position: null, start: null, finish: null });
                    continue;
                }
                const start = row.started_at || now;
                const finish = Math.max(now + 30, start + expectedRuntime);
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
                planned_intent: plannedIntent(row),
                generation_notice: generationNotice(row),
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
                estimate_ready: Boolean(row.estimate_ready),
                initial_estimate_low_seconds: row.initial_estimate_low_seconds,
                initial_estimate_high_seconds: row.initial_estimate_high_seconds,
                initial_estimate_recorded_at: row.initial_estimate_recorded_at,
                expected_start_at: projection.start,
                expected_finish_at: projection.finish,
                stage: row.stage,
                progress: row.progress,
                error: row.error,
                result_path: row.result_path,
                result_bytes: row.result_bytes,
                has_source_image: Boolean(row.source_image_path),
                created_at: row.created_at,
                updated_at: row.updated_at,
                started_at: row.started_at,
                completed_at: row.completed_at,
                runtime_seconds: row.runtime_seconds,
                delivered_at: row.delivered_at,
                worker_online: online,
                worker_busy: busy,
                paused_until: control.paused_until,
                dispatch_paused: control.dispatch_paused,
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
                        warmModel: generatorModel(hello.warm_model),
                        leaseId: hello.current_lease || null,
                        scheduler: workerScheduler(hello.scheduler),
                    };
                    initialized = true;
                    await this.reconcileWorker(hello);
                    this.sendWorker({ type: 'hello_ack', protocol: VIDEO_PROTOCOL_VERSION, state: await this.brokerState() });
                    if (!hello.current_job) {
                        const control = await this.control();
                        if (control.paused_until) {
                            this.sendWorker({ type: 'unload', reason: 'pause' });
                            this.worker.warmModel = null;
                        } else {
                            await this.dispatchNext();
                        }
                    }
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
            if (!this.stopping && this.worker?.socket === socket) {
                this.trackBackground(this.markWorkerOffline());
            }
        });
        socket.on('error', error => console.error('Video worker socket error', error));
    }

    private async reconcileWorker(hello: VideoWorkerHello): Promise<void> {
        if (hello.estimates) {
            for (const [model, estimate] of Object.entries(hello.estimates)) {
                if (!isVideoModel(model) || !estimate) continue;
                await this.run(
                    `UPDATE video_jobs SET estimate_low_seconds = ?, estimate_high_seconds = ?, updated_at = ?
                     WHERE status = 'queued' AND model = ? AND estimate_ready = 0`,
                    [Math.max(1, estimate.low), Math.max(1, estimate.high), nowSeconds(), model],
                );
            }
        }
        if (hello.current_job) {
            const row = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [hello.current_job]);
            const leaseMatches = !row?.lease_token || !hello.current_lease
                || row.lease_token === hello.current_lease;
            if (row && ACTIVE_VIDEO_STATUSES.includes(row.status) && leaseMatches) {
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
            if (message.scheduler !== undefined) {
                this.worker.scheduler = workerScheduler(message.scheduler);
            }
            if (message.job_id && message.job_id === this.worker.currentJob) {
                await this.run(
                    `UPDATE video_jobs SET lease_expires_at = ?, stage = COALESCE(?, stage),
                     progress = COALESCE(?, progress), updated_at = ? WHERE public_id = ?`,
                    [
                        nowSeconds() + 60,
                        message.stage === undefined
                            ? null
                            : sanitizeVideoWorkerText(message.stage, 'Generating'),
                        typeof message.progress === 'number' ? Math.min(1, Math.max(0, message.progress)) : null,
                        nowSeconds(),
                        message.job_id,
                    ],
                );
            }
            if (!this.worker.currentJob && this.worker.ready && schedulerAdmitsWork(this.worker.scheduler)) {
                await this.dispatchNext();
            }
            return;
        }
        if (message.type === 'ready') {
            if (message.warm_model === null || message.warm_model !== undefined) {
                this.worker.warmModel = generatorModel(message.warm_model);
            }
            this.worker.ready = true;
            this.worker.currentJob = null;
            const control = await this.control();
            if (control.paused_until) {
                this.sendWorker({ type: 'unload', reason: 'safety-pause' });
                return;
            }
            await this.dispatchNext();
            return;
        }
        const jobId = String(message.job_id || '');
        if (!jobId || jobId !== this.worker.currentJob) return;
        if (this.worker.leaseId && message.lease_id !== undefined
            && message.lease_id !== this.worker.leaseId) return;
        if (message.type === 'event') {
            const event = String(message.event || '');
            if (event === 'plan') {
                const estimateLow = Number(message.estimate_low_seconds) > 0
                    ? Math.max(1, Number(message.estimate_low_seconds))
                    : null;
                const estimateHigh = Number(message.estimate_high_seconds) > 0
                    ? Math.max(1, Number(message.estimate_high_seconds))
                    : null;
                await this.run(
                    `UPDATE video_jobs SET status = 'planning', stage = ?,
                     estimate_low_seconds = CASE WHEN estimate_ready = 0
                        THEN COALESCE(?, estimate_low_seconds) ELSE estimate_low_seconds END,
                     estimate_high_seconds = CASE WHEN estimate_ready = 0
                        THEN COALESCE(?, estimate_high_seconds) ELSE estimate_high_seconds END,
                     estimate_ready = CASE WHEN ? IS NOT NULL AND ? IS NOT NULL
                        THEN 1 ELSE estimate_ready END,
                     initial_estimate_low_seconds = COALESCE(initial_estimate_low_seconds, ?),
                     initial_estimate_high_seconds = COALESCE(initial_estimate_high_seconds, ?),
                     initial_estimate_recorded_at = CASE WHEN ? IS NOT NULL AND ? IS NOT NULL
                        THEN COALESCE(initial_estimate_recorded_at, ?) ELSE initial_estimate_recorded_at END,
                     updated_at = ? WHERE public_id = ?`,
                    [
                        sanitizeVideoWorkerText(message.stage, 'Planning'),
                        estimateLow,
                        estimateHigh,
                        estimateLow,
                        estimateHigh,
                        estimateLow,
                        estimateHigh,
                        estimateLow,
                        estimateHigh,
                        nowSeconds(),
                        nowSeconds(),
                        jobId,
                    ],
                );
            } else if (event === 'progress') {
                await this.run(
                    `UPDATE video_jobs SET status = 'running', stage = ?, progress = ?, lease_expires_at = ?,
                     updated_at = ? WHERE public_id = ?`,
                    [
                        sanitizeVideoWorkerText(message.stage, 'Generating'),
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
                const publicError = sanitizeVideoWorkerText(message.error, 'Worker failure', 2000);
                if (message.metrics && typeof message.metrics === 'object') {
                    try {
                        await this.storeWorkerAttemptMetrics(row, message.metrics, publicError);
                    } catch (error) {
                        console.warn(`Could not store failed-attempt telemetry for ${jobId}`, error);
                    }
                }
                const safetyPauseSeconds = message.safety_pause_seconds === undefined
                    ? null
                    : Math.round(boundedNumber(message.safety_pause_seconds, 60, 24 * 60 * 60, false)!);
                if (safetyPauseSeconds !== null) {
                    await this.run(
                        `UPDATE video_control SET paused_until = ?, updated_by = ?, updated_at = ? WHERE id = 1`,
                        [nowSeconds() + safetyPauseSeconds, `worker-safety:${this.worker.id}`, nowSeconds()],
                    );
                }
                await this.run(
                    retry
                        ? `UPDATE video_jobs SET status = 'queued', attempt = attempt + 1, stage = ?,
                           progress = NULL, worker_id = NULL, lease_expires_at = NULL, error = ?, updated_at = ?
                           WHERE public_id = ?`
                        : `UPDATE video_jobs SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
                           WHERE public_id = ?`,
                    retry
                        ? [
                            safetyPauseSeconds === null ? 'Retrying' : 'Paused after GPU driver reset',
                            publicError,
                            nowSeconds(),
                            jobId,
                        ]
                        : [publicError, nowSeconds(), nowSeconds(), jobId],
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
                const runtimeSeconds = Number(message.runtime_seconds) > 0
                    ? Number(message.runtime_seconds)
                    : null;
                await this.run(
                    `UPDATE video_jobs SET status = 'ready', stage = 'Ready for Discord delivery', progress = 1,
                     runtime_seconds = ?, completed_at = ?, updated_at = ? WHERE public_id = ?`,
                    [runtimeSeconds, nowSeconds(), nowSeconds(), jobId],
                );
                if (runtimeSeconds !== null) {
                    await this.run(
                        'INSERT INTO video_runtime_samples(model, runtime_seconds, recorded_at) VALUES(?,?,?)',
                        [row.model, runtimeSeconds, nowSeconds()],
                    );
                    await this.refreshQueuedEstimates(row.model);
                }
                this.worker.currentJob = null;
                this.worker.ready = false;
            }
            if (['cancelled', 'failed', 'complete'].includes(event)
                && typeof message.event_id === 'string' && message.event_id) {
                this.sendWorker({
                    type: 'event_ack',
                    job_id: jobId,
                    event_id: message.event_id,
                });
            }
        }
    }

    private async dispatchNext(): Promise<void> {
        if (!this.worker || !this.worker.ready || this.worker.currentJob) return;
        if (!schedulerAdmitsWork(this.worker.scheduler)) return;
        const control = await this.control();
        if (control.paused_until || control.dispatch_paused) return;
        const placeholders = this.worker.capabilities.map(() => '?').join(',');
        if (!placeholders) return;
        const candidates = await this.all<JobRow>(
            `SELECT * FROM video_jobs WHERE status = 'queued' AND model IN (${placeholders})
             ORDER BY id ASC LIMIT 2`,
            this.worker.capabilities,
        );
        if (!candidates.length) return;
        const oldest = candidates[0];
        let row = oldest;
        const warmModel = this.worker.warmModel;
        if (candidates.length > 1 && warmModel
            && VIDEO_MODELS[oldest.model].generatorModel !== warmModel
            && oldest.affinity_bypasses < 1
            && VIDEO_MODELS[candidates[1].model].generatorModel === warmModel) {
            row = candidates[1];
            await this.run(
                'UPDATE video_jobs SET affinity_bypasses = affinity_bypasses + 1, updated_at = ? WHERE public_id = ?',
                [nowSeconds(), oldest.public_id],
            );
        }
        this.schedulePreparation(row.public_id, true);
        const leaseId = randomUUID();
        const result = await this.run(
            `UPDATE video_jobs SET status = 'leased', worker_id = ?, lease_expires_at = ?,
             lease_token = ?, started_at = COALESCE(started_at, ?), stage = 'Leased to desktop', updated_at = ?
             WHERE public_id = ? AND status = 'queued'`,
            [this.worker.id, nowSeconds() + 60, leaseId, nowSeconds(), nowSeconds(), row.public_id],
        );
        if (result.changes !== 1) return;
        this.worker.ready = false;
        this.worker.currentJob = row.public_id;
        this.worker.leaseId = leaseId;
        this.worker.warmModel = VIDEO_MODELS[row.model].generatorModel;
        this.sendWorker({
            type: 'job',
            protocol: VIDEO_PROTOCOL_VERSION,
            job: {
                id: row.public_id,
                model: row.model,
                prompt: row.prompt,
                profile: 'maximum',
                has_source_image: Boolean(row.source_image_path),
                lease_id: leaseId,
            },
        });
        await this.scheduleNextQueuedPreparation();
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
        if (!control.paused_until && !control.dispatch_paused) await this.dispatchNext();
    }

    private async handleWorkerHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
        const planning = /^\/v1\/worker\/jobs\/([0-9a-f-]+)\/plan$/.exec(url.pathname);
        if (planning && req.method === 'POST') {
            const job = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [planning[1]]);
            if (!job || job.worker_id !== this.worker?.id || planning[1] !== this.worker.currentJob
                || !this.workerLeaseMatches(req, job)) {
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
                const prepared = await this.ensurePlan(job, true);
                writeJson(res, 200, {
                    plan: prepared.plan,
                    planner_model: prepared.plannerModel,
                    cached: false,
                });
            } catch (error) {
                if (error instanceof FrontierPlannerRejectedError) {
                    console.log(
                        `Frontier planner routed ${job.public_id} to the local planner (${error.reasonCode}).`,
                    );
                } else {
                    console.warn(`Frontier planning failed for ${job.public_id}`, error);
                }
                writeJson(res, 502, {
                    error: error instanceof Error ? error.message : String(error),
                    fallback: 'local',
                    ...(error instanceof FrontierPlannerRejectedError ? {
                        disposition: 'reject',
                        reason_code: error.reasonCode,
                    } : {}),
                });
            }
            return;
        }
        const localPlanning = /^\/v1\/worker\/jobs\/([0-9a-f-]+)\/local-plan$/.exec(url.pathname);
        if (localPlanning && req.method === 'POST') {
            let job = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [localPlanning[1]]);
            if (!job || job.worker_id !== this.worker?.id || localPlanning[1] !== this.worker.currentJob
                || !this.workerLeaseMatches(req, job)) {
                writeJson(res, 409, { error: 'Job is not leased to this worker.' });
                return;
            }
            if (job.planner_json && !cachedFrontierRejection(job.planner_model)) {
                writeJson(res, 409, { error: 'A completed screenplay is already stored for this job.' });
                return;
            }
            try {
                const body = await readJson(req, 512 * 1024);
                const plan = body?.plan;
                validateFrontierVideoPlanForKeyframe(plan, job.model, job.prompt);
                const estimate = await this.plannedRuntimeEstimate(job, plan);
                const now = nowSeconds();
                await this.run(
                    `UPDATE video_jobs SET planner_json = ?, planner_model = ?,
                     estimate_low_seconds = ?, estimate_high_seconds = ?, estimate_ready = 1,
                     initial_estimate_low_seconds = COALESCE(initial_estimate_low_seconds, ?),
                     initial_estimate_high_seconds = COALESCE(initial_estimate_high_seconds, ?),
                     initial_estimate_recorded_at = COALESCE(initial_estimate_recorded_at, ?),
                     updated_at = ? WHERE public_id = ? AND status IN (${ACTIVE_SQL})`,
                    [
                        JSON.stringify(plan),
                        LOCAL_VIDEO_PLANNER_MODEL,
                        estimate.low,
                        estimate.high,
                        estimate.low,
                        estimate.high,
                        now,
                        now,
                        job.public_id,
                    ],
                );
                job = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [localPlanning[1]]) || job;
                writeJson(res, 200, {
                    ok: true,
                    planner_model: LOCAL_VIDEO_PLANNER_MODEL,
                    job: (await this.views([job]))[0],
                });
            } catch (error) {
                console.warn(`Local screenplay upload failed for ${job.public_id}`, error);
                writeJson(res, 400, {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }
        const keyframe = /^\/v1\/worker\/jobs\/([0-9a-f-]+)\/keyframe$/.exec(url.pathname);
        if (keyframe && req.method === 'POST') {
            let job = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [keyframe[1]]);
            if (!job || job.worker_id !== this.worker?.id || keyframe[1] !== this.worker.currentJob
                || !this.workerLeaseMatches(req, job)) {
                writeJson(res, 409, { error: 'Job is not leased to this worker.' });
                return;
            }
            if (job.source_image_path && job.source_image_mime && existsSync(job.source_image_path)) {
                writeImage(res, job.source_image_path, job.source_image_mime, {
                    'x-video-keyframe-provider': 'user-attachment',
                    'x-video-keyframe-model': 'none',
                    'x-video-keyframe-cached': 'true',
                });
                return;
            }
            if (!job.planner_json) {
                writeJson(res, 409, { error: 'A screenplay is required before generating a first frame.', fallback: 'local' });
                return;
            }
            const plan = JSON.parse(job.planner_json);
            if (plan?.keyframe?.recommended !== true) {
                res.writeHead(204, { 'cache-control': 'no-store' });
                res.end();
                return;
            }
            try {
                const cached = Boolean(job.keyframe_path && job.keyframe_mime);
                if (!job.keyframe_path || !job.keyframe_mime) {
                    await this.ensureKeyframe(job, plan, true);
                    job = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [keyframe[1]]);
                }
                if (!job?.keyframe_path || !job.keyframe_mime) {
                    throw new Error('First-frame generation completed without an image.');
                }
                writeImage(res, job.keyframe_path, job.keyframe_mime, {
                    'x-video-keyframe-provider': job.keyframe_provider || 'frontier-image',
                    'x-video-keyframe-model': job.keyframe_model || 'unknown',
                    'x-video-keyframe-cached': cached ? 'true' : 'false',
                });
            } catch (error) {
                console.warn(`Frontier first-frame generation failed for ${keyframe[1]}`, error);
                writeJson(res, 502, {
                    error: error instanceof Error ? error.message : String(error),
                    fallback: 'local',
                });
            }
            return;
        }
        const metricsUpload = /^\/v1\/worker\/jobs\/([0-9a-f-]+)\/metrics$/.exec(url.pathname);
        if (metricsUpload && req.method === 'PUT') {
            const job = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [metricsUpload[1]]);
            if (!job || job.worker_id !== this.worker?.id || metricsUpload[1] !== this.worker.currentJob
                || !this.workerLeaseMatches(req, job)
                || !ACTIVE_VIDEO_STATUSES.includes(job.status)) {
                writeJson(res, 409, { error: 'Job is not leased to this worker.' });
                return;
            }
            try {
                await this.storeWorkerMetrics(job, await readJson(req));
                writeJson(res, 200, { ok: true });
            } catch (error) {
                writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
            }
            return;
        }
        const upload = /^\/v1\/worker\/jobs\/([0-9a-f-]+)\/result$/.exec(url.pathname);
        if (!upload || req.method !== 'PUT') {
            writeJson(res, 404, { error: 'Not found.' });
            return;
        }
        const job = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [upload[1]]);
        if (!job || job.worker_id !== this.worker?.id || upload[1] !== this.worker.currentJob
            || !this.workerLeaseMatches(req, job)) {
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

    private workerLeaseMatches(req: IncomingMessage, job: JobRow): boolean {
        if (!job.lease_token) return true;
        const supplied = req.headers['x-video-lease'];
        return supplied === undefined || supplied === job.lease_token;
    }

    private async cleanupFiles(): Promise<void> {
        const cutoff = nowSeconds() - 24 * 60 * 60;
        const rows = await this.all<JobRow>(
            `SELECT * FROM video_jobs
             WHERE status IN ('ready','delivered','failed','cancelled')
             AND COALESCE(delivered_at, completed_at, updated_at) < ?
             AND (result_path IS NOT NULL OR source_image_path IS NOT NULL OR keyframe_path IS NOT NULL)`,
            [cutoff],
        );
        for (const row of rows) {
            try {
                const storedPath = row.result_path || row.source_image_path || row.keyframe_path;
                if (storedPath) rmSync(dirname(resolve(storedPath)), { recursive: true, force: true });
            } catch (error) {
                console.warn(`Could not clean video result ${row.public_id}`, error);
                continue;
            }
            await this.run(
                `UPDATE video_jobs SET result_path = NULL, source_image_path = NULL, keyframe_path = NULL,
                 updated_at = ? WHERE public_id = ?`,
                [nowSeconds(), row.public_id],
            );
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
        preplanQueuedJobs: true,
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
