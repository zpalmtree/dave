import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { fileURLToPath, pathToFileURL } from 'url';
import fetch from 'node-fetch';
import sqlite3 from 'sqlite3';
import { WebSocket, WebSocketServer } from 'ws';

import {
    ACTIVE_VIDEO_STATUSES,
    UNFINISHED_VIDEO_STATUSES,
    VIDEO_DISCORD_BASELINE_UPLOAD_BYTES,
    VIDEO_IMAGE_ONLY_AUTO_PROMPT,
    VIDEO_MAX_GLOBAL_JOBS,
    VIDEO_MAX_TOTAL_DURATION_SECONDS,
    VIDEO_MAX_USER_JOBS,
    VIDEO_MODELS,
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
    requestedVideoDurationSeconds,
    sanitizeVideoWorkerText,
} from './VideoProtocol.js';
import { loadVideoSettings } from './VideoSettings.js';
import {
    FrontierPlannerRejectedError,
    VIDEO_PLANNER_MODEL,
    VideoPlanSourceImage,
    configuredVideoPlannerStrategy,
    configuredVideoPlannerVariant,
    createFrontierVideoPlan,
    validateFrontierVideoPlanForKeyframe,
    videoPlannerFingerprint,
} from './VideoFrontierPlanner.js';
import {
    VIDEO_KEYFRAME_ASPECT_RATIOS,
    VIDEO_KEYFRAME_FAST_LITE_MODEL,
    VIDEO_KEYFRAME_MAX_BYTES,
    VideoKeyframeAspectRatio,
    VideoKeyframeOptions,
    VideoKeyframeResult,
    configuredVideoKeyframeStrategy,
    configuredVideoKeyframeVariant,
    createFrontierVideoKeyframe,
    generateFrontierVideoKeyframeCandidate,
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
    configuredVideoOpenAIServiceTier,
    requestedOpenAIServiceTier,
    videoUsageCost,
} from './VideoUsage.js';
import {
    VIDEO_SEGMENT_KEYFRAME_PLANNER_MODEL,
    createVideoSegmentKeyframeContracts,
    videoSegmentKeyframeTargetIndexes,
} from './VideoSegmentKeyframePlanner.js';

const ACTIVE_SQL = ACTIVE_VIDEO_STATUSES.map(status => `'${status}'`).join(',');
const UNFINISHED_SQL = UNFINISHED_VIDEO_STATUSES.map(status => `'${status}'`).join(',');
const LOCAL_VIDEO_PLANNER_MODEL = 'hauhaucs-qwen3.8:27b-q4kp-mtp';
const OALGO_VIDEO_PRESET_PATH = fileURLToPath(new URL('../images/oalgo.png', import.meta.url));

interface VideoAttachmentSourceImageDescriptor {
    url: string;
    mime_type: typeof VIDEO_SOURCE_IMAGE_MIME_TYPES[number];
    bytes: number;
    name: string;
}

interface VideoPresetSourceImageDescriptor {
    preset: 'oalgo';
}

type VideoSourceImageDescriptor =
    | VideoAttachmentSourceImageDescriptor
    | VideoPresetSourceImageDescriptor;

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
    segmentContractPlanner?: typeof createVideoSegmentKeyframeContracts;
    keyframeGenerator?: (
        plan: Record<string, any>,
        references?: VideoKeyframeReference[],
        options?: VideoKeyframeOptions,
    ) => Promise<VideoKeyframeResult>;
    keyframeCandidateGenerator?: typeof generateFrontierVideoKeyframeCandidate;
    keyframeReferenceResolver?: (
        plan: Record<string, any>,
        jobDirectory: string,
        hooks?: VideoProviderHooks,
    ) => Promise<VideoKeyframeReference[]>;
    sourceImageDownloader?: (
        descriptor: VideoSourceImageDescriptor,
        directory: string,
    ) => Promise<StoredVideoSourceImage>;
    sourceImageComposer?: (
        base: StoredVideoSourceImage,
        attached: StoredVideoSourceImage,
        prompt: string,
        hooks: VideoProviderHooks,
    ) => Promise<VideoKeyframeResult>;
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

interface VideoControlState {
    paused_until: number | null;
    dispatch_paused: boolean;
    gpuq_gaming_requested: boolean | null;
    gpuq_request_id: number;
}

interface ProvisionalKeyframeReferenceResult {
    references: VideoKeyframeReference[];
    status: 'ok' | 'error';
    durationSeconds: number;
}

interface ProvisionalKeyframePrefetch {
    identity: string;
    controller: AbortController;
    referencesRequested: number;
    references: Promise<ProvisionalKeyframeReferenceResult>;
    candidate: Promise<VideoKeyframeResult>;
    cleanupTimer: NodeJS.Timeout;
}

interface JobRow {
    id: number;
    public_id: string;
    idempotency_key: string;
    model: VideoModelId;
    prompt: string;
    planner_guidance: string | null;
    requested_duration_seconds: number | null;
    delivery_limit_bytes: number;
    prompt_tease: string | null;
    requester_id: string;
    origin_bot_id: string;
    channel_id: string;
    guild_id: string | null;
    command_message_id: string;
    status_message_id: string;
    status: VideoJobStatus;
    attempt: number;
    readiness_retries: number;
    experiment_id: string | null;
    variant_id: string;
    planner_fingerprint: string | null;
    keyframe_strategy: string | null;
    estimate_low_seconds: number;
    estimate_high_seconds: number;
    estimate_ready: number;
    initial_estimate_low_seconds: number | null;
    initial_estimate_high_seconds: number | null;
    initial_estimate_recorded_at: number | null;
    stage: string | null;
    progress: number | null;
    progress_scope: 'job' | 'stage' | null;
    segment_index: number | null;
    segment_count: number | null;
    segment_progress: number | null;
    worker_id: string | null;
    lease_expires_at: number | null;
    lease_token: string | null;
    gpu_queue_state: 'submitting' | 'queued' | 'admitted' | null;
    gpu_queue_submitted_at: number | null;
    gpu_admitted_at: number | null;
    gpu_queue_wait_seconds: number | null;
    gpu_queue_position: number | null;
    gpu_queue_jobs_ahead: number | null;
    gpu_estimated_admission_low_at: number | null;
    gpu_estimated_admission_high_at: number | null;
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

interface SegmentKeyframeRow {
    job_public_id: string;
    segment_index: number;
    path: string;
    mime_type: typeof VIDEO_SOURCE_IMAGE_MIME_TYPES[number];
    provider: string;
    model: string;
    created_at: number;
}

interface VideoJobMetricRow {
    job_public_id: string;
    model: VideoModelId;
    generator_model: VideoGeneratorModelId;
    total_seconds: number;
    output_duration_seconds: number | null;
    generated_duration_seconds: number | null;
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
    experiment_id: string | null;
    variant_id: string;
    planner_fingerprint: string | null;
    keyframe_strategy: string | null;
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

function schedulerPausesDispatch(value: VideoWorkerSchedulerState): boolean {
    return value.mode === 'enteringGaming' || value.mode === 'gaming';
}

function schedulerAcceptsReservations(value: VideoWorkerSchedulerState): boolean {
    return value.available && !schedulerPausesDispatch(value);
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

export type VideoFailureDisposition = 'fail' | 'retry' | 'wait-readiness';

export function duplicateVideoTerminalEventMatches(
    message: Record<string, any>,
    job: { status: VideoJobStatus; lease_token: string | null; error?: string | null; stage?: string | null },
): boolean {
    const leaseMatches = !job.lease_token || message.lease_id === undefined
        || message.lease_id === job.lease_token;
    if (!leaseMatches) return false;
    if (message.event === 'complete') return job.status === 'ready' || job.status === 'delivered';
    if (message.event === 'cancelled') {
        return job.status === 'cancelled'
            || (message.reason === 'pause' && job.status === 'queued' && job.stage === 'Paused for desktop use');
    }
    if (message.event === 'failed') {
        return job.status === 'failed'
            || (job.status === 'queued'
                && job.error === sanitizeVideoWorkerText(message.error, 'Worker failure', 2000));
    }
    return false;
}

export function videoFailureDisposition(
    error: string,
    retryable: boolean,
    attempt: number,
    readinessRetries: number,
    previousError: string | null,
): VideoFailureDisposition {
    if (!retryable) return 'fail';
    const normalized = error.trim().toLowerCase().replace(/\s+/g, ' ');
    const readiness = /(?:gpuq|gpu reservation|comfyui|comfy).*(?:ready|readiness|start|respond|timeout|timed out)/.test(normalized)
        || /(?:timeout|timed out).*(?:gpuq|gpu reservation|comfyui|comfy)/.test(normalized);
    if (readiness) return readinessRetries < 6 ? 'wait-readiness' : 'fail';
    if (previousError?.trim() === error.trim() && attempt > 0) return 'fail';
    return attempt < 2 ? 'retry' : 'fail';
}

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

function experimentLabel(value: unknown, fallback: string | null): string | null {
    const text = String(value || '').trim();
    if (!text) return fallback;
    return /^[a-zA-Z0-9._:-]{1,80}$/.test(text) ? text : fallback;
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
    if (['pytorch', 'comfy_kitchen_int8'].includes(value.metadata?.attention_backend)) {
        metadata.attention_backend = value.metadata.attention_backend;
    }
    if (['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'].includes(
        value.metadata?.aspect,
    )) {
        metadata.aspect = value.metadata.aspect;
    }
    for (const [name, minimum, maximum] of [
        ['segment_duration_seconds', 0.01, 60],
        ['frame_count', 1, 10_000],
        ['run_index', 1, 20],
        ['steps_observed', 1, 1_000],
        ['steps_total', 1, 1_000],
        ['first_step_seconds', 0, 3_600],
        ['steady_step_mean_seconds', 0, 3_600],
        ['steady_step_median_seconds', 0, 3_600],
        ['steady_step_p90_seconds', 0, 3_600],
    ] as const) {
        if (value.metadata?.[name] === undefined) continue;
        const number = boundedNumber(value.metadata[name], minimum, maximum, false)!;
        metadata[name] = ['frame_count', 'run_index', 'steps_observed', 'steps_total'].includes(name)
            ? Math.round(number)
            : number;
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
    if (value.metadata?.contracts !== undefined) {
        metadata.contracts = Math.round(
            boundedNumber(value.metadata.contracts, 0, 7, false)!,
        );
    }
    if (['prefetch', 'on_demand'].includes(value.metadata?.origin)) {
        metadata.origin = value.metadata.origin;
    }
    if (typeof value.metadata?.joined === 'boolean') metadata.joined = value.metadata.joined;
    if (typeof value.metadata?.prefetched === 'boolean') metadata.prefetched = value.metadata.prefetched;
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
    if (!Array.isArray(value.spans) || value.spans.length > 2_000) {
        throw new Error('Metrics spans must be an array of at most 2,000 entries.');
    }
    const output = value.output && typeof value.output === 'object' ? {
        duration_seconds: boundedNumber(value.output.duration_seconds, 0.01, 300) ?? undefined,
        generated_duration_seconds: boundedNumber(
            value.output.generated_duration_seconds,
            0.01,
            1_500,
        ) ?? undefined,
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
        experiment_id: boundedMetricText(value.environment.experiment_id, 80) ?? undefined,
        variant_id: boundedMetricText(value.environment.variant_id, 80) ?? undefined,
        planner_fingerprint: boundedMetricText(value.environment.planner_fingerprint, 80) ?? undefined,
        keyframe_strategy: boundedMetricText(value.environment.keyframe_strategy, 80) ?? undefined,
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
    const spans: VideoMetricSpan[] = value.spans.map((span: unknown) => normalizedMetricSpan(span));
    const observedSegments = new Set(spans
        .filter(span => span.source === 'comfy' && span.name === 'segment_total'
            && span.segment_index !== null && span.segment_index !== undefined)
        .map(span => span.segment_index)).size;
    if (output && observedSegments > 0) output.segment_count = observedSegments;
    const generatedSegments = new Map<number, number>();
    for (const span of spans) {
        if (span.source !== 'comfy' || span.name !== 'segment_total'
            || span.segment_index === null || span.segment_index === undefined
            || !Number.isFinite(span.metadata?.segment_duration_seconds)) continue;
        generatedSegments.set(span.segment_index, Number(span.metadata!.segment_duration_seconds));
    }
    if (output && generatedSegments.size > 0) {
        output.generated_duration_seconds = [...generatedSegments.values()]
            .reduce((sum, duration) => sum + duration, 0);
    }
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
        spans,
    };
}

function average(values: Array<number | null | undefined>): number | null {
    const finite = values.filter((value): value is number => Number.isFinite(value));
    return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

export function videoPlanRuntimeScale({
    plannedDuration,
    plannedSegments,
    sampleDuration,
    sampleSegments,
    sourceFactor = 1,
}: {
    plannedDuration: number;
    plannedSegments: number;
    sampleDuration: number;
    sampleSegments: number;
    sourceFactor?: number;
}): number {
    const plannedAverage = plannedDuration / Math.max(1, plannedSegments);
    const sampleAverage = sampleDuration / Math.max(1, sampleSegments);
    const segmentRatio = Math.max(0.01, plannedSegments / Math.max(1, sampleSegments));
    // Each generated clip has a fixed setup/decode cost, while sampling grows
    // with frames per clip. Scale the full clip count and only compare average
    // clip duration so duration and segment count are not counted twice.
    const perSegmentDurationRatio = plannedAverage / Math.max(0.01, sampleAverage);
    const perSegmentFactor = Math.max(0.25, Math.min(
        4,
        0.25 + 0.75 * perSegmentDurationRatio,
    ));
    // Roughly 15% of a normal job is fixed planning/delivery work. The old
    // combined 4x ceiling made every unusually long screenplay underestimate.
    return Math.max(0.15, 0.15 + 0.85 * segmentRatio * perSegmentFactor * sourceFactor);
}

export function projectedVideoFinishAt({
    now,
    startedAt,
    expectedRuntime,
    progress,
    progressScope,
}: {
    now: number;
    startedAt: number;
    expectedRuntime: number;
    progress: number | null;
    progressScope: 'job' | 'stage' | null;
}): number {
    const historicalFinish = startedAt + Math.max(1, expectedRuntime);
    if (progressScope !== 'job' || progress === null || progress < 0.02 || progress >= 1) {
        return Math.max(now + 30, Math.round(historicalFinish));
    }
    const elapsed = Math.max(1, now - startedAt);
    const observedRuntime = elapsed / Math.max(0.001, progress);
    // Let measured pace take over gradually, reaching 90% authority after
    // roughly one third of the render while retaining a little historical
    // stability for pauses and coarse progress boundaries.
    const observedWeight = Math.min(0.9, Math.max(0, (progress - 0.02) * 3));
    const projectedRuntime = expectedRuntime * (1 - observedWeight)
        + observedRuntime * observedWeight;
    return Math.max(now + 30, Math.round(startedAt + projectedRuntime));
}

interface WorkerProgressFields {
    progress: number | null;
    scope: 'job' | 'stage' | null;
    segmentIndex: number | null;
    segmentCount: number | null;
    segmentProgress: number | null;
}

function workerProgressFields(message: any): WorkerProgressFields {
    const progress = typeof message.progress === 'number' && Number.isFinite(message.progress)
        ? Math.min(1, Math.max(0, message.progress))
        : null;
    const scope = message.progress_scope === 'job'
        ? 'job'
        : message.progress_scope === 'stage' ? 'stage' : null;
    const segmentCount = Number.isInteger(message.segment_count)
        ? Math.min(100, Math.max(1, Number(message.segment_count)))
        : null;
    const segmentIndexCandidate = Number.isInteger(message.segment_index)
        ? Math.max(1, Number(message.segment_index))
        : null;
    const segmentIndex = segmentCount !== null && segmentIndexCandidate !== null
        ? Math.min(segmentCount, segmentIndexCandidate)
        : null;
    const segmentProgress = typeof message.segment_progress === 'number'
        && Number.isFinite(message.segment_progress)
        ? Math.min(1, Math.max(0, message.segment_progress))
        : null;
    return { progress, scope, segmentIndex, segmentCount, segmentProgress };
}

function median(values: Array<number | null | undefined>): number | null {
    const finite = values
        .filter((value): value is number => Number.isFinite(value))
        .sort((a, b) => a - b);
    if (!finite.length) return null;
    const middle = Math.floor(finite.length / 2);
    return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

function percentile(values: Array<number | null | undefined>, fraction: number): number | null {
    const finite = values
        .filter((value): value is number => Number.isFinite(value))
        .sort((a, b) => a - b);
    if (!finite.length) return null;
    return finite[Math.min(finite.length - 1, Math.max(0, Math.ceil(finite.length * fraction) - 1))];
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

function segmentKeyframePlanIdentity(plan: Record<string, any>): string {
    const stablePlan = { ...plan };
    delete stablePlan.segment_keyframes;
    delete stablePlan._segment_keyframe_planner_model;
    return createHash('sha256').update(JSON.stringify(stablePlan)).digest('hex');
}

function keyframePlanIdentity(plan: Record<string, any>): string {
    return createHash('sha256').update(JSON.stringify(plan?.keyframe || null)).digest('hex');
}

function derivedSegmentKeyframePlan(plan: Record<string, any>, segmentIndex: number): Record<string, any> | null {
    const segment = Array.isArray(plan?.segments) ? plan.segments[segmentIndex - 1] : null;
    const firstShot = Array.isArray(segment?.shots) ? segment.shots[0] : null;
    if (!segment || !firstShot || !['cut', 'dissolve'].includes(String(segment.transition))) return null;
    const title = String(segment.title || `Segment ${segmentIndex}`).trim();
    const overlayLabel = String(segment.overlay_label || '').trim();
    const independentlyLabeled = Boolean(overlayLabel && overlayLabel !== 'N/A');
    const visual = String(firstShot.visual || '').trim();
    const camera = String(firstShot.camera || '').trim();
    if (!visual || !camera) return null;
    const explicit = (Array.isArray(plan?.segment_keyframes) ? plan.segment_keyframes : [])
        .find((candidate: any) => Number(candidate?.segment_index) === segmentIndex);
    const explicitPrompt = String(explicit?.prompt || '').trim();
    const explicitMotion = explicit?.motion_contract;
    const hasExplicitContract = Boolean(explicitPrompt && [
        'subject_orientation',
        'gaze_direction',
        'travel_direction',
        'camera_relation',
        'first_second_action',
    ].every(field => String(explicitMotion?.[field] || '').trim()));
    return {
        intent: String(plan.intent || visual),
        continuity_bible: String(plan.continuity_bible || ''),
        keyframe: {
            recommended: true,
            reason: independentlyLabeled
                ? `Anchor the independently selected identity ${overlayLabel}.`
                : `Preserve the recurring cast across the ${segment.transition} into ${title}.`,
            prompt: [
                hasExplicitContract ? explicitPrompt : [
                    `Opening still for segment ${segmentIndex}, ${title}: ${visual}`,
                    `Camera and framing: ${camera}.`,
                    independentlyLabeled
                        ? `Depict ${overlayLabel} as the only selected identity; reserve a blank opaque nameplate with no readable text for postproduction.`
                        : 'Use the supplied identity reference to depict the same recognizable recurring person or people in this new shot composition.',
                    independentlyLabeled
                        ? 'Do not copy the preceding segment identity.'
                        : 'Preserve their facial identity, body proportions, hair, skin tone, and defining appearance while placing them in the pose, wardrobe, environment, lighting, and action required by this segment.',
                    'Show one frozen, motion-ready instant at 0.00 seconds of this segment.',
                ].join(' '),
                independentlyLabeled ? '' : (
                    'Treat the supplied identity reference as the sole authority for facial anatomy: '
                    + 'match its eye aperture, eye shape and spacing, iris and pupil scale, nose and '
                    + 'nostril shape, cheek contour, lip proportions, jaw width, and chin silhouette. '
                    + 'A new rendering style must not replace these features with generic face anatomy.'
                ),
            ].filter(Boolean).join(' '),
            reference_requirements: [],
            motion_contract: hasExplicitContract ? {
                subject_orientation: String(explicitMotion.subject_orientation).trim(),
                gaze_direction: String(explicitMotion.gaze_direction).trim(),
                travel_direction: String(explicitMotion.travel_direction).trim(),
                camera_relation: String(explicitMotion.camera_relation).trim(),
                first_second_action: String(explicitMotion.first_second_action).trim(),
            } : {
                subject_orientation: 'Orient each recurring subject for the opening action described by this segment.',
                gaze_direction: 'Direct each subject gaze toward the focus of the opening action.',
                travel_direction: 'Show the travel vector implied by the opening action and composition.',
                camera_relation: camera,
                first_second_action: `Continue directly into this action: ${visual}`,
            },
        },
        segments: [segment],
    };
}

function sourceImageDescriptor(value: any): VideoSourceImageDescriptor | null {
    if (value === null || value === undefined) return null;
    if (!value || typeof value !== 'object') throw new Error('Invalid starting-image metadata.');
    if (value.preset !== undefined) {
        if (value.preset !== 'oalgo') throw new Error('Unknown starting-image preset.');
        return { preset: 'oalgo' };
    }
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
        mime_type: mimeType as VideoAttachmentSourceImageDescriptor['mime_type'],
        bytes,
        name: String(value.name || 'start-frame').slice(0, 255),
    };
}

function isPresetSourceImage(
    descriptor: VideoSourceImageDescriptor,
): descriptor is VideoPresetSourceImageDescriptor {
    return 'preset' in descriptor;
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
    descriptor: VideoAttachmentSourceImageDescriptor,
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

async function storeVideoSourceImage(
    descriptor: VideoSourceImageDescriptor,
    directory: string,
): Promise<StoredVideoSourceImage> {
    if (!isPresetSourceImage(descriptor)) {
        return downloadDiscordSourceImage(descriptor, directory);
    }
    if (!existsSync(OALGO_VIDEO_PRESET_PATH) || !statSync(OALGO_VIDEO_PRESET_PATH).isFile()) {
        throw new Error('The OALGO starting-image preset is unavailable.');
    }
    const bytes = statSync(OALGO_VIDEO_PRESET_PATH).size;
    if (!bytes || bytes > VIDEO_SOURCE_IMAGE_MAX_BYTES) {
        throw new Error('The OALGO starting-image preset is empty or too large.');
    }
    mkdirSync(directory, { recursive: true });
    const destination = join(directory, 'source.png');
    rmSync(destination, { force: true });
    copyFileSync(OALGO_VIDEO_PRESET_PATH, destination);
    return { path: destination, mimeType: 'image/png', bytes };
}

export function oalgoSourceImageCompositePlan(prompt: string): Record<string, unknown> {
    const requestedAction = prompt === VIDEO_IMAGE_ONLY_AUTO_PROMPT
        ? 'Invent a lively, visually clear action that naturally follows from the combined image.'
        : `Stage the combined image so it can naturally begin this requested video: ${prompt}`;
    return {
        intent: requestedAction,
        keyframe: {
            recommended: true,
            reason: 'Combine the built-in OALGO art with the user-supplied visual reference.',
            prompt: [
                'Create one cohesive square image based primarily on Reference 1, the OALGO base image.',
                'Preserve the base character, caricature drawing style, face, body, Mexican flag clothing and emblem, city background, palette, and overall composition so OALGO remains immediately recognizable.',
                'Integrate the salient person, character, animal, or object from Reference 2 naturally into the same illustrated scene while preserving its recognizable appearance.',
                'Render a unified scene with consistent perspective, lighting, outlines, and texture, never a split screen, side-by-side layout, pasted rectangle, or collage.',
                requestedAction,
            ].join(' '),
            reference_requirements: [],
            motion_contract: {
                subject_orientation: 'Keep all subjects oriented for the opening action.',
                gaze_direction: 'Direct each visible gaze toward the opening action or another subject.',
                travel_direction: 'Give moving subjects clear space in their intended direction.',
                camera_relation: 'Use the OALGO base image framing and a coherent single camera view.',
                first_second_action: requestedAction,
            },
        },
        segments: [],
    };
}

async function composeOalgoSourceImages(
    base: StoredVideoSourceImage,
    attached: StoredVideoSourceImage,
    prompt: string,
    hooks: VideoProviderHooks,
): Promise<VideoKeyframeResult> {
    const references: VideoKeyframeReference[] = [
        {
            label: 'OALGO base image',
            kind: 'style',
            visualFactsToPreserve: 'Preserve the complete base scene, recognizable caricature, Mexican flag clothing and emblem, city background, drawing style, palette, and composition.',
            bytes: readFileSync(base.path),
            mimeType: base.mimeType,
            sourceUrl: 'built-in:oalgo',
            contextUrl: 'built-in:oalgo',
        },
        {
            label: 'User-attached image',
            kind: 'object',
            visualFactsToPreserve: 'Preserve the recognizable appearance of the salient person, character, animal, or object and integrate it naturally into the OALGO scene.',
            bytes: readFileSync(attached.path),
            mimeType: attached.mimeType,
            sourceUrl: 'discord-attachment',
            contextUrl: 'discord-attachment',
        },
    ];
    return generateFrontierVideoKeyframeCandidate(
        oalgoSourceImageCompositePlan(prompt),
        references,
        {
            ...configuredVideoKeyframeVariant(),
            aspectRatio: '1:1',
            ...hooks,
        },
    );
}

function storeCompositedSourceImage(
    result: VideoKeyframeResult,
    directory: string,
): StoredVideoSourceImage {
    if (!result.bytes.length || result.bytes.length > VIDEO_SOURCE_IMAGE_MAX_BYTES) {
        throw new Error('The composited starting image is empty or exceeds the 20 MiB limit.');
    }
    mkdirSync(directory, { recursive: true });
    const extension = imageExtension(result.mimeType);
    const temporary = join(directory, `source.${extension}.part`);
    const destination = join(directory, `source.${extension}`);
    rmSync(temporary, { force: true });
    rmSync(destination, { force: true });
    writeFileSync(temporary, result.bytes, { flag: 'wx' });
    renameSync(temporary, destination);
    return { path: destination, mimeType: result.mimeType, bytes: result.bytes.length };
}

function copyStoredSourceImage(
    source: StoredVideoSourceImage,
    directory: string,
): StoredVideoSourceImage {
    mkdirSync(directory, { recursive: true });
    const destination = join(directory, `source.${imageExtension(source.mimeType)}`);
    rmSync(destination, { force: true });
    copyFileSync(source.path, destination);
    return { path: destination, mimeType: source.mimeType, bytes: source.bytes };
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
    private readonly preparationQueued = new Set<string>();
    private readonly preparationAttempted = new Set<string>();
    private readonly plannerInFlight = new Map<string, Promise<{ plan: Record<string, any>; plannerModel: string }>>();
    private readonly segmentContractInFlight = new Map<string, Promise<void>>();
    private readonly keyframeInFlight = new Map<string, Promise<void>>();
    private readonly provisionalKeyframePrefetch = new Map<string, ProvisionalKeyframePrefetch>();
    private readonly segmentKeyframeInFlight = new Map<string, Promise<void>>();
    private segmentKeyframeSlots = 0;
    private readonly segmentKeyframeWaiters: Array<{
        key: string;
        origin: 'prefetch' | 'on_demand';
        resolve: (release: () => void) => void;
    }> = [];
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

    private acquireSegmentKeyframeSlot(
        key: string,
        origin: 'prefetch' | 'on_demand',
    ): Promise<() => void> {
        const release = () => {
            const onDemand = this.segmentKeyframeWaiters.findIndex(waiter => waiter.origin === 'on_demand');
            const nextIndex = onDemand >= 0 ? onDemand : 0;
            const next = this.segmentKeyframeWaiters.splice(nextIndex, 1)[0];
            if (next) next.resolve(release);
            else this.segmentKeyframeSlots = Math.max(0, this.segmentKeyframeSlots - 1);
        };
        if (this.segmentKeyframeSlots < 2) {
            this.segmentKeyframeSlots += 1;
            return Promise.resolve(release);
        }
        return new Promise(resolvePromise => {
            this.segmentKeyframeWaiters.push({ key, origin, resolve: resolvePromise });
        });
    }

    private promoteSegmentKeyframeSlot(key: string): void {
        const waiting = this.segmentKeyframeWaiters.find(waiter => waiter.key === key);
        if (waiting) waiting.origin = 'on_demand';
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
            planner_guidance TEXT,
            requested_duration_seconds REAL,
            delivery_limit_bytes INTEGER NOT NULL DEFAULT ${VIDEO_DISCORD_BASELINE_UPLOAD_BYTES},
            prompt_tease TEXT,
            requester_id TEXT NOT NULL,
            origin_bot_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            guild_id TEXT,
            command_message_id TEXT NOT NULL,
            status_message_id TEXT NOT NULL,
            status TEXT NOT NULL,
            attempt INTEGER NOT NULL DEFAULT 0,
            readiness_retries INTEGER NOT NULL DEFAULT 0,
            experiment_id TEXT,
            variant_id TEXT NOT NULL DEFAULT 'production-v1',
            planner_fingerprint TEXT,
            keyframe_strategy TEXT,
            estimate_low_seconds INTEGER NOT NULL,
            estimate_high_seconds INTEGER NOT NULL,
            estimate_ready INTEGER NOT NULL DEFAULT 0,
            initial_estimate_low_seconds INTEGER,
            initial_estimate_high_seconds INTEGER,
            initial_estimate_recorded_at INTEGER,
            stage TEXT,
            progress REAL,
            progress_scope TEXT,
            segment_index INTEGER,
            segment_count INTEGER,
            segment_progress REAL,
            worker_id TEXT,
            lease_expires_at INTEGER,
            lease_token TEXT,
            gpu_queue_state TEXT,
            gpu_queue_submitted_at INTEGER,
            gpu_admitted_at INTEGER,
            gpu_queue_wait_seconds INTEGER,
            gpu_queue_position INTEGER,
            gpu_queue_jobs_ahead INTEGER,
            gpu_estimated_admission_low_at INTEGER,
            gpu_estimated_admission_high_at INTEGER,
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
        if (!columnNames.has('planner_guidance')) {
            await this.run('ALTER TABLE video_jobs ADD COLUMN planner_guidance TEXT');
        }
        if (!columnNames.has('affinity_bypasses')) {
            await this.run('ALTER TABLE video_jobs ADD COLUMN affinity_bypasses INTEGER NOT NULL DEFAULT 0');
        }
        if (!columnNames.has('readiness_retries')) {
            await this.run('ALTER TABLE video_jobs ADD COLUMN readiness_retries INTEGER NOT NULL DEFAULT 0');
        }
        if (!columnNames.has('prompt_tease')) {
            await this.run('ALTER TABLE video_jobs ADD COLUMN prompt_tease TEXT');
        }
        if (!columnNames.has('requested_duration_seconds')) {
            await this.run('ALTER TABLE video_jobs ADD COLUMN requested_duration_seconds REAL');
        }
        if (!columnNames.has('delivery_limit_bytes')) {
            await this.run(`ALTER TABLE video_jobs ADD COLUMN delivery_limit_bytes INTEGER NOT NULL DEFAULT ${VIDEO_DISCORD_BASELINE_UPLOAD_BYTES}`);
        }
        for (const [name, definition] of [
            ['experiment_id', 'TEXT'],
            ['variant_id', "TEXT NOT NULL DEFAULT 'production-v1'"],
            ['planner_fingerprint', 'TEXT'],
            ['keyframe_strategy', 'TEXT'],
        ] as const) {
            if (!columnNames.has(name)) {
                await this.run(`ALTER TABLE video_jobs ADD COLUMN ${name} ${definition}`);
            }
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
        for (const [name, definition] of [
            ['progress_scope', 'TEXT'],
            ['segment_index', 'INTEGER'],
            ['segment_count', 'INTEGER'],
            ['segment_progress', 'REAL'],
        ] as const) {
            if (!columnNames.has(name)) {
                await this.run(`ALTER TABLE video_jobs ADD COLUMN ${name} ${definition}`);
            }
        }
        for (const [name, definition] of [
            ['gpu_queue_state', 'TEXT'],
            ['gpu_queue_submitted_at', 'INTEGER'],
            ['gpu_admitted_at', 'INTEGER'],
            ['gpu_queue_wait_seconds', 'INTEGER'],
            ['gpu_queue_position', 'INTEGER'],
            ['gpu_queue_jobs_ahead', 'INTEGER'],
            ['gpu_estimated_admission_low_at', 'INTEGER'],
            ['gpu_estimated_admission_high_at', 'INTEGER'],
        ] as const) {
            if (!columnNames.has(name)) {
                await this.run(`ALTER TABLE video_jobs ADD COLUMN ${name} ${definition}`);
            }
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
        await this.run(`CREATE TABLE IF NOT EXISTS video_segment_keyframes (
            job_public_id TEXT NOT NULL,
            segment_index INTEGER NOT NULL CHECK (segment_index >= 2),
            path TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY(job_public_id, segment_index)
        )`);
        await this.run(`CREATE INDEX IF NOT EXISTS video_segment_keyframes_job_idx
            ON video_segment_keyframes(job_public_id)`);
        await this.run(`CREATE TABLE IF NOT EXISTS video_control (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            paused_until INTEGER,
            dispatch_paused INTEGER NOT NULL DEFAULT 0,
            gpuq_gaming_requested INTEGER,
            gpuq_request_id INTEGER NOT NULL DEFAULT 0,
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
        if (!controlColumns.has('gpuq_gaming_requested')) {
            await this.run('ALTER TABLE video_control ADD COLUMN gpuq_gaming_requested INTEGER');
        }
        if (!controlColumns.has('gpuq_request_id')) {
            await this.run('ALTER TABLE video_control ADD COLUMN gpuq_request_id INTEGER NOT NULL DEFAULT 0');
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
            generated_duration_seconds REAL,
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
            experiment_id TEXT,
            variant_id TEXT NOT NULL DEFAULT 'production-v1',
            planner_fingerprint TEXT,
            keyframe_strategy TEXT,
            recorded_at INTEGER NOT NULL
        )`);
        const metricColumns = new Set(
            (await this.all<{ name: string }>('PRAGMA table_info(video_job_metrics)'))
                .map(column => column.name),
        );
        for (const [name, definition] of [
            ['generated_duration_seconds', 'REAL'],
            ['vram_free_min_mb', 'REAL'],
            ['temperature_peak_c', 'REAL'],
            ['pcie_link_width_min', 'REAL'],
            ['pcie_link_width_max', 'REAL'],
            ['hardware_slowdown_samples', 'INTEGER'],
            ['thermal_slowdown_samples', 'INTEGER'],
            ['power_brake_slowdown_samples', 'INTEGER'],
            ['comfy_aimdo_version', 'TEXT'],
            ['experiment_id', 'TEXT'],
            ['variant_id', "TEXT NOT NULL DEFAULT 'production-v1'"],
            ['planner_fingerprint', 'TEXT'],
            ['keyframe_strategy', 'TEXT'],
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
        // Older workers counted raw and delivery manifests separately. The
        // distinct completed segment spans are authoritative and let startup
        // repair any poisoned history, including a job that finished while a
        // worker update was waiting for a safe restart.
        await this.run(`UPDATE video_job_metrics
            SET segment_count = (
                SELECT COUNT(DISTINCT segment_index) FROM video_job_spans
                WHERE video_job_spans.job_public_id = video_job_metrics.job_public_id
                AND source = 'comfy' AND name = 'segment_total' AND segment_index > 0
            )
            WHERE EXISTS (
                SELECT 1 FROM video_job_spans
                WHERE video_job_spans.job_public_id = video_job_metrics.job_public_id
                AND source = 'comfy' AND name = 'segment_total' AND segment_index > 0
            )`);
        await this.run(`UPDATE video_job_metrics
            SET generated_duration_seconds = (
                SELECT SUM(CAST(json_extract(metadata_json, '$.segment_duration_seconds') AS REAL))
                FROM video_job_spans
                WHERE video_job_spans.job_public_id = video_job_metrics.job_public_id
                AND source = 'comfy' AND name = 'segment_total' AND segment_index > 0
                AND json_extract(metadata_json, '$.segment_duration_seconds') > 0
            )
            WHERE EXISTS (
                SELECT 1 FROM video_job_spans
                WHERE video_job_spans.job_public_id = video_job_metrics.job_public_id
                AND source = 'comfy' AND name = 'segment_total' AND segment_index > 0
                AND json_extract(metadata_json, '$.segment_duration_seconds') > 0
            )`);
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
        for (const publicId of [...this.provisionalKeyframePrefetch.keys()]) {
            this.discardProvisionalKeyframe(publicId);
        }
        if (this.worker) this.worker.socket.close(1001, 'broker shutdown');
        await new Promise<void>(resolvePromise => this.server.close(() => resolvePromise()));
        await Promise.allSettled([...this.backgroundTasks]);
        await new Promise<void>((resolvePromise, reject) => this.db.close(err => err ? reject(err) : resolvePromise()));
    }

    private async control(): Promise<VideoControlState> {
        const row = await this.get<{
            paused_until: number | null;
            dispatch_paused: number;
            gpuq_gaming_requested: number | null;
            gpuq_request_id: number;
        }>(
            `SELECT paused_until, dispatch_paused, gpuq_gaming_requested, gpuq_request_id
             FROM video_control WHERE id = 1`,
        );
        const paused = row?.paused_until && row.paused_until > nowSeconds() ? row.paused_until : null;
        if (!paused && row?.paused_until) {
            await this.run(
                'UPDATE video_control SET paused_until = NULL, updated_at = ? WHERE id = 1',
                [nowSeconds()],
            );
        }
        return {
            paused_until: paused,
            dispatch_paused: Boolean(row?.dispatch_paused),
            gpuq_gaming_requested: row?.gpuq_gaming_requested === null
                || row?.gpuq_gaming_requested === undefined
                ? null
                : Boolean(row.gpuq_gaming_requested),
            gpuq_request_id: Number(row?.gpuq_request_id) || 0,
        };
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
        const promptTease = /^\/v1\/jobs\/([0-9a-f-]+)\/prompt-tease$/.exec(url.pathname);
        if (promptTease && req.method === 'POST') {
            const body = await readJson(req);
            const tease = sanitizeVideoWorkerText(body.prompt_tease, '', 120).trim() || null;
            await this.run(
                'UPDATE video_jobs SET prompt_tease = ?, updated_at = ? WHERE public_id = ?',
                [tease, nowSeconds(), promptTease[1]],
            );
            const row = await this.get<JobRow>(
                'SELECT * FROM video_jobs WHERE public_id = ?',
                [promptTease[1]],
            );
            if (!row) {
                writeJson(res, 404, { error: 'Unknown video job.' });
                return;
            }
            writeJson(res, 200, { job: (await this.views([row]))[0] });
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
                `UPDATE video_control SET paused_until = ?, gpuq_gaming_requested = 1,
                 gpuq_request_id = gpuq_request_id + 1, updated_by = ?, updated_at = ? WHERE id = 1`,
                [until, String(body.actor_id || ''), nowSeconds()],
            );
            const control = await this.control();
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
            this.sendPendingGpuqControl(control);
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
                `UPDATE video_control SET paused_until = NULL, dispatch_paused = 0,
                 gpuq_gaming_requested = 0, gpuq_request_id = gpuq_request_id + 1,
                 updated_by = NULL, updated_at = ? WHERE id = 1`,
                [nowSeconds()],
            );
            this.sendPendingGpuqControl(await this.control());
            writeJson(res, 200, { state: await this.brokerState() });
            return;
        }
        writeJson(res, 404, { error: 'Not found.' });
    }

    private async enqueue(body: any): Promise<{ status: number; body: any }> {
        if (!isVideoModel(body.model)) return { status: 400, body: { error: 'Unknown video model.' } };
        const prompt = String(body.prompt || '').trim();
        if (!prompt) return { status: 400, body: { error: 'Prompt must not be empty.' } };
        const plannerGuidance = sanitizeVideoWorkerText(
            body.planner_guidance,
            '',
            2000,
        ).trim() || null;
        const deliveryLimit = Number(
            body.delivery_limit_bytes ?? VIDEO_DISCORD_BASELINE_UPLOAD_BYTES,
        );
        if (!Number.isInteger(deliveryLimit)
            || deliveryLimit < VIDEO_DISCORD_BASELINE_UPLOAD_BYTES
            || deliveryLimit > VIDEO_RESULT_MAX_BYTES) {
            return {
                status: 400,
                body: { error: 'Discord delivery limit is outside the supported range.' },
            };
        }
        const requestedDurationValue = body.requested_duration_seconds
            ?? requestedVideoDurationSeconds(prompt);
        const requestedDuration = requestedDurationValue === null
            || requestedDurationValue === undefined
            ? null
            : Number(requestedDurationValue);
        if (requestedDuration !== null && (!Number.isFinite(requestedDuration)
            || requestedDuration < 0.5
            || requestedDuration > VIDEO_MAX_TOTAL_DURATION_SECONDS)) {
            return {
                status: 400,
                body: {
                    error: `Requested video duration must be between 0.5 and ${VIDEO_MAX_TOTAL_DURATION_SECONDS} seconds.`,
                },
            };
        }
        const required = ['requester_id', 'origin_bot_id', 'channel_id', 'command_message_id', 'status_message_id'];
        if (required.some(key => !String(body[key] || '').trim())) {
            return { status: 400, body: { error: 'Missing Discord job identity.' } };
        }
        let sourceDescriptor: VideoSourceImageDescriptor | null;
        let compositeDescriptor: VideoSourceImageDescriptor | null;
        try {
            sourceDescriptor = sourceImageDescriptor(body.source_image);
            compositeDescriptor = sourceImageDescriptor(body.source_image_composite);
        } catch (error) {
            return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
        }
        if (compositeDescriptor && (!sourceDescriptor
            || !isPresetSourceImage(sourceDescriptor)
            || isPresetSourceImage(compositeDescriptor))) {
            return {
                status: 400,
                body: { error: 'Image compositing requires the OALGO preset and one Discord attachment.' },
            };
        }
        const existingBeforeDownload = await this.get<JobRow>(
            'SELECT * FROM video_jobs WHERE idempotency_key = ?',
            [String(body.command_message_id)],
        );
        if (existingBeforeDownload) {
            return { status: 200, body: { job: (await this.views([existingBeforeDownload]))[0], duplicate: true } };
        }
        const [globalBeforeDownload, userBeforeDownload] = await Promise.all([
            this.get<{ count: number }>(
                `SELECT COUNT(*) AS count FROM video_jobs WHERE status IN (${statusPlaceholders(UNFINISHED_VIDEO_STATUSES)})`,
                UNFINISHED_VIDEO_STATUSES,
            ),
            this.get<{ count: number }>(
                `SELECT COUNT(*) AS count FROM video_jobs WHERE requester_id = ?
                 AND status IN (${statusPlaceholders(UNFINISHED_VIDEO_STATUSES)})`,
                [String(body.requester_id), ...UNFINISHED_VIDEO_STATUSES],
            ),
        ]);
        if ((globalBeforeDownload?.count || 0) >= VIDEO_MAX_GLOBAL_JOBS) {
            return { status: 409, body: { error: `The video queue is full (${VIDEO_MAX_GLOBAL_JOBS} jobs).` } };
        }
        if ((userBeforeDownload?.count || 0) >= VIDEO_MAX_USER_JOBS) {
            return { status: 409, body: { error: `You already have ${VIDEO_MAX_USER_JOBS} unfinished video jobs.` } };
        }
        const publicId = randomUUID();
        const directory = resolve(this.options.resultsDir, publicId);
        let sourceImage: StoredVideoSourceImage | null = null;
        let sourceImageDownloadSeconds: number | null = null;
        let sourceImageCompositionSeconds: number | null = null;
        let sourceImageComposition: 'generated' | 'fallback' | null = null;
        const compositionAttempts: VideoProviderAttempt[] = [];
        const compositionUsages: VideoProviderUsage[] = [];
        if (sourceDescriptor) {
            const sourceImageStarted = Date.now();
            try {
                const sourceImageDownloader = this.options.sourceImageDownloader || storeVideoSourceImage;
                if (compositeDescriptor) {
                    const base = await sourceImageDownloader(
                        sourceDescriptor,
                        join(directory, 'composite-base'),
                    );
                    const attached = await sourceImageDownloader(
                        compositeDescriptor,
                        join(directory, 'composite-attached'),
                    );
                    sourceImageDownloadSeconds = (Date.now() - sourceImageStarted) / 1000;
                    const compositionStarted = Date.now();
                    const hooks: VideoProviderHooks = {
                        onAttempt: attempt => {
                            compositionAttempts.push({
                                ...attempt,
                                stage: `source_image_composite_${attempt.stage}`,
                            });
                        },
                        onUsage: usage => {
                            compositionUsages.push({
                                ...usage,
                                stage: `source_image_composite_${usage.stage}`,
                            });
                        },
                    };
                    try {
                        const composed = await (
                            this.options.sourceImageComposer || composeOalgoSourceImages
                        )(base, attached, prompt, hooks);
                        sourceImage = storeCompositedSourceImage(composed, directory);
                        sourceImageComposition = 'generated';
                    } catch (error) {
                        sourceImageComposition = 'fallback';
                        compositionAttempts.push({
                            stage: 'source_image_composite_fallback',
                            attempt: 1,
                            outcome: 'error',
                            provider: 'broker',
                            model: 'oalgo-preset',
                            serviceTier: 'default',
                            durationSeconds: (Date.now() - compositionStarted) / 1000,
                            detail: sanitizeVideoWorkerText(
                                error instanceof Error ? error.message : String(error),
                                'Unknown image-composition error.',
                                1000,
                            ),
                        });
                        console.warn(
                            '[Video] OALGO source-image composition failed; using the built-in preset.',
                            error,
                        );
                        sourceImage = copyStoredSourceImage(base, directory);
                    } finally {
                        sourceImageCompositionSeconds = (Date.now() - compositionStarted) / 1000;
                        rmSync(join(directory, 'composite-base'), { recursive: true, force: true });
                        rmSync(join(directory, 'composite-attached'), { recursive: true, force: true });
                    }
                } else {
                    sourceImage = await sourceImageDownloader(sourceDescriptor, directory);
                    sourceImageDownloadSeconds = (Date.now() - sourceImageStarted) / 1000;
                }
            } catch (error) {
                rmSync(directory, { recursive: true, force: true });
                return {
                    status: 400,
                    body: { error: `Could not use the starting image: ${error instanceof Error ? error.message : String(error)}` },
                };
            }
        }
        const result = await this.withWriteLock(async () => {
            const existing = await this.get<JobRow>(
                'SELECT * FROM video_jobs WHERE idempotency_key = ?',
                [String(body.command_message_id)],
            );
            if (existing) {
                if (sourceImage) rmSync(directory, { recursive: true, force: true });
                return { status: 200, body: { job: (await this.views([existing]))[0], duplicate: true } };
            }
            const global = await this.get<{ count: number }>(
                `SELECT COUNT(*) AS count FROM video_jobs WHERE status IN (${statusPlaceholders(UNFINISHED_VIDEO_STATUSES)})`,
                UNFINISHED_VIDEO_STATUSES,
            );
            if ((global?.count || 0) >= VIDEO_MAX_GLOBAL_JOBS) {
                if (sourceImage) rmSync(directory, { recursive: true, force: true });
                return { status: 409, body: { error: `The video queue is full (${VIDEO_MAX_GLOBAL_JOBS} jobs).` } };
            }
            const user = await this.get<{ count: number }>(
                `SELECT COUNT(*) AS count FROM video_jobs WHERE requester_id = ?
                 AND status IN (${statusPlaceholders(UNFINISHED_VIDEO_STATUSES)})`,
                [String(body.requester_id), ...UNFINISHED_VIDEO_STATUSES],
            );
            if ((user?.count || 0) >= VIDEO_MAX_USER_JOBS) {
                if (sourceImage) rmSync(directory, { recursive: true, force: true });
                return { status: 409, body: { error: `You already have ${VIDEO_MAX_USER_JOBS} unfinished video jobs.` } };
            }
            const estimate = await this.runtimeEstimate(body.model as VideoModelId);
            const now = nowSeconds();
            try {
                await this.run(
                    `INSERT INTO video_jobs(
                        public_id, idempotency_key, model, prompt, planner_guidance,
                        requested_duration_seconds,
                        delivery_limit_bytes,
                        requester_id, origin_bot_id,
                        channel_id, guild_id, command_message_id, status_message_id, status,
                        estimate_low_seconds, estimate_high_seconds, created_at, updated_at,
                        source_image_path, source_image_mime, source_image_bytes,
                        experiment_id, variant_id
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [
                        publicId,
                        String(body.command_message_id),
                        body.model,
                        prompt,
                        plannerGuidance,
                        requestedDuration,
                        deliveryLimit,
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
                        experimentLabel(process.env.VIDEO_EXPERIMENT_ID, null),
                        experimentLabel(process.env.VIDEO_PIPELINE_VARIANT, 'production-v1'),
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
                if (sourceImageCompositionSeconds !== null && sourceImageComposition) {
                    await this.recordMetricSpan(publicId, {
                        source: 'broker',
                        name: 'source_image_composite',
                        duration_seconds: sourceImageCompositionSeconds,
                        metadata: {
                            status: sourceImageComposition === 'generated' ? 'ok' : 'error',
                        },
                    });
                }
            } catch (error) {
                if (sourceImage) rmSync(directory, { recursive: true, force: true });
                throw error;
            }
            const row = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [publicId]);
            return {
                status: 201,
                body: {
                    job: (await this.views([row!]))[0],
                    duplicate: false,
                    source_image_composition: sourceImageComposition,
                },
            };
        });
        if (result.status === 201) {
            const job = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [publicId]);
            if (job) {
                const hooks = this.providerHooks(job);
                for (const attempt of compositionAttempts) {
                    await hooks.onAttempt?.(attempt);
                }
                for (const usage of compositionUsages) {
                    await hooks.onUsage?.(usage);
                }
            }
            if (this.worker?.currentJob) await this.scheduleNextQueuedPreparation();
            await this.dispatchNext();
        }
        return result;
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
            generated_duration_seconds: number;
            segment_count: number;
            source_image: number;
        }>(
            `SELECT total_seconds,
                COALESCE(generated_duration_seconds, output_duration_seconds) AS generated_duration_seconds,
                segment_count, source_image
             FROM video_job_metrics
             WHERE model = ?
             AND COALESCE(generated_duration_seconds, output_duration_seconds) > 0
             AND segment_count > 0
             ORDER BY recorded_at DESC LIMIT 50`,
            [job.model],
        );
        const predictions = rows.map(row => {
            const sourceFactor = usesStartFrame === Boolean(row.source_image)
                ? 1
                : usesStartFrame ? 1.08 : 0.96;
            const factor = videoPlanRuntimeScale({
                plannedDuration,
                plannedSegments: segmentCount,
                sampleDuration: Number(row.generated_duration_seconds),
                sampleSegments: Number(row.segment_count),
                sourceFactor,
            });
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
                await this.storePlanEstimate(job, plan);
                job = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [publicId]) || job;
            } catch (error) {
                console.warn(`Could not prepare initial ETA for ${publicId}`, error);
            }
        }
        return (await this.views([job]))[0] || null;
    }

    private async storePlanEstimate(job: JobRow, plan: Record<string, any>): Promise<void> {
        const estimate = await this.plannedRuntimeEstimate(job, plan);
        const now = nowSeconds();
        // This history-scaled range is for queue/display ETA only. The desktop
        // generator has model/config-specific segment timings and truncates a
        // screenplay there when its conservative GPU estimate exceeds budget.
        await this.run(
            `UPDATE video_jobs SET estimate_low_seconds = ?, estimate_high_seconds = ?,
             estimate_ready = 1,
             initial_estimate_low_seconds = COALESCE(initial_estimate_low_seconds, ?),
             initial_estimate_high_seconds = COALESCE(initial_estimate_high_seconds, ?),
             initial_estimate_recorded_at = COALESCE(initial_estimate_recorded_at, ?),
             updated_at = ?
             WHERE public_id = ? AND status IN (${ACTIVE_SQL})`,
            [estimate.low, estimate.high, estimate.low, estimate.high, now, now, job.public_id],
        );
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
                    turbo4, ltx_one_stage, experiment_id, variant_id, planner_fingerprint,
                    keyframe_strategy, recorded_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
                    experiment_id = excluded.experiment_id,
                    variant_id = excluded.variant_id,
                    planner_fingerprint = excluded.planner_fingerprint,
                    keyframe_strategy = excluded.keyframe_strategy,
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
                    job.experiment_id,
                    job.variant_id,
                    job.planner_fingerprint,
                    job.keyframe_strategy,
                    nowSeconds(),
                ],
            );
            for (const span of metrics.spans) await this.recordMetricSpan(job.public_id, span);
            await this.run(
                `UPDATE video_job_metrics SET generated_duration_seconds = ? WHERE job_public_id = ?`,
                [output.generated_duration_seconds ?? null, job.public_id],
            );
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
        const storedRows = await this.all<VideoJobMetricRow>(
            `SELECT m.*, j.planner_model, j.keyframe_provider, j.keyframe_model
             FROM video_job_metrics m
             JOIN video_jobs j ON j.public_id = m.job_public_id
             ${filter} ORDER BY m.recorded_at DESC LIMIT ?`,
            params,
        );
        const rows = storedRows.filter(row => isVideoModel(row.model));
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
                    p90: percentile(modelRows.map(row => row.total_seconds), 0.9),
                    p95: percentile(modelRows.map(row => row.total_seconds), 0.95),
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
                variants: [...new Set(modelRows.map(row => row.variant_id || 'production-v1'))]
                    .map(variantId => {
                        const variantRows = modelRows.filter(
                            row => (row.variant_id || 'production-v1') === variantId,
                        );
                        return {
                            experiment_id: variantRows[0]?.experiment_id || null,
                            variant_id: variantId,
                            samples: variantRows.length,
                            median_seconds: median(variantRows.map(row => row.total_seconds)),
                            p90_seconds: percentile(variantRows.map(row => row.total_seconds), 0.9),
                            planner_fingerprint: variantRows[0]?.planner_fingerprint || null,
                            keyframe_strategy: variantRows[0]?.keyframe_strategy || null,
                        };
                    }),
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

    private frontierOptions(job: JobRow, _criticalPath: boolean): VideoFrontierCallOptions {
        const plannerStrategy = configuredVideoPlannerStrategy(job.channel_id);
        const configured = configuredVideoPlannerVariant(process.env, plannerStrategy);
        const plannerGuidance = [job.planner_guidance]
            .map(value => String(value || '').trim())
            .filter(Boolean)
            .join('\n');
        return {
            serviceTier: configuredVideoOpenAIServiceTier(),
            ...configured,
            plannerStrategy,
            ...(plannerGuidance ? { plannerGuidance } : {}),
            ...(job.requested_duration_seconds !== null ? {
                requestedDurationSeconds: job.requested_duration_seconds,
            } : {}),
            ...this.providerHooks(job),
        };
    }

    private keyframeStrategy(job: JobRow): 'serial-v1' | 'conditional-v2' | 'fast-gated-v3' {
        return configuredVideoKeyframeStrategy(job.channel_id);
    }

    private discardProvisionalKeyframe(publicId: string): void {
        const prefetch = this.provisionalKeyframePrefetch.get(publicId);
        if (!prefetch) return;
        this.provisionalKeyframePrefetch.delete(publicId);
        clearTimeout(prefetch.cleanupTimer);
        prefetch.controller.abort();
    }

    private scheduleProvisionalKeyframe(
        job: JobRow,
        keyframe: Record<string, unknown>,
        criticalPath: boolean,
    ): void {
        const candidateGenerator = this.options.keyframeCandidateGenerator
            || (this.options.keyframeGenerator ? null : generateFrontierVideoKeyframeCandidate);
        if (this.stopping || job.source_image_path || keyframe?.recommended !== true
            || this.keyframeStrategy(job) !== 'fast-gated-v3'
            || this.provisionalKeyframePrefetch.has(job.public_id)
            || !candidateGenerator) return;
        const plan = { keyframe };
        const directory = resolve(this.options.resultsDir, job.public_id);
        mkdirSync(directory, { recursive: true });
        const controller = new AbortController();
        const referencesRequested = countVideoKeyframeReferenceRequirements(plan);
        const referenceStarted = Date.now();
        const hooks = this.providerHooks(job);
        const references = (async (): Promise<ProvisionalKeyframeReferenceResult> => {
            let status: 'ok' | 'error' = 'ok';
            let resolved: VideoKeyframeReference[] = [];
            try {
                resolved = this.options.keyframeReferenceResolver
                    ? await this.options.keyframeReferenceResolver(plan, directory, hooks)
                    : await resolveVideoKeyframeReferences(plan, directory, undefined, undefined, hooks);
            } catch (error) {
                status = 'error';
                console.warn(
                    `Provisional first-frame reference retrieval failed for ${job.public_id}; continuing without references.`,
                    error,
                );
            }
            return {
                references: resolved,
                status,
                durationSeconds: (Date.now() - referenceStarted) / 1000,
            };
        })();
        const candidate = references.then(result => candidateGenerator(
            plan,
            result.references,
            {
                ...this.frontierOptions(job, criticalPath),
                ...configuredVideoKeyframeVariant(),
                geminiModel: VIDEO_KEYFRAME_FAST_LITE_MODEL,
                imageSize: '1K',
                abortSignal: controller.signal,
            },
        ));
        void candidate.catch(() => undefined);
        const cleanupTimer = setTimeout(
            () => this.discardProvisionalKeyframe(job.public_id),
            5 * 60 * 1000,
        );
        cleanupTimer.unref();
        this.provisionalKeyframePrefetch.set(job.public_id, {
            identity: keyframePlanIdentity(plan),
            controller,
            referencesRequested,
            references,
            candidate,
            cleanupTimer,
        });
    }

    private hasSegmentKeyframeContracts(plan: Record<string, any>): boolean {
        const targets = videoSegmentKeyframeTargetIndexes(plan);
        const contracts = Array.isArray(plan?.segment_keyframes) ? plan.segment_keyframes : [];
        return targets.length > 0 && targets.every(index => contracts.some((contract: any) =>
            Number(contract?.segment_index) === index
            && String(contract?.prompt || '').trim()
            && [
                'subject_orientation',
                'gaze_direction',
                'travel_direction',
                'camera_relation',
                'first_second_action',
            ].every(field => String(contract?.motion_contract?.[field] || '').trim())));
    }

    private scheduleSegmentKeyframeContracts(job: JobRow, plan: Record<string, any>): void {
        const contractPlanner = this.options.segmentContractPlanner
            || (this.options.frontierPlanner ? null : createVideoSegmentKeyframeContracts);
        if ((!job.source_image_path && plan?.keyframe?.recommended !== true)
            || !videoSegmentKeyframeTargetIndexes(plan).length
            || this.hasSegmentKeyframeContracts(plan)
            || this.segmentContractInFlight.has(job.public_id)
            || !contractPlanner) return;
        const started = Date.now();
        const generation = (async () => {
            let status: 'ok' | 'error' | 'skipped' = 'error';
            let contractCount = 0;
            try {
                const contracts = await contractPlanner(
                    job.prompt,
                    plan,
                    this.providerHooks(job),
                );
                contractCount = contracts.length;
                const current = await this.get<Pick<JobRow, 'planner_json' | 'status'>>(
                    'SELECT planner_json, status FROM video_jobs WHERE public_id = ?',
                    [job.public_id],
                );
                if (!current?.planner_json || !ACTIVE_VIDEO_STATUSES.includes(current.status)) {
                    status = 'skipped';
                    return;
                }
                const storedPlan = JSON.parse(current.planner_json);
                if (this.hasSegmentKeyframeContracts(storedPlan)) {
                    status = 'skipped';
                    return;
                }
                storedPlan.segment_keyframes = contracts;
                storedPlan._segment_keyframe_planner_model = VIDEO_SEGMENT_KEYFRAME_PLANNER_MODEL;
                plan.segment_keyframes = contracts;
                plan._segment_keyframe_planner_model = VIDEO_SEGMENT_KEYFRAME_PLANNER_MODEL;
                await this.run(
                    `UPDATE video_jobs SET planner_json = ?, updated_at = ?
                     WHERE public_id = ? AND status IN (${ACTIVE_SQL})`,
                    [JSON.stringify(storedPlan), nowSeconds(), job.public_id],
                );
                status = 'ok';
            } catch (error) {
                console.warn(
                    `Segment frame-zero planning failed for ${job.public_id}; using deterministic derivation.`,
                    error,
                );
            } finally {
                this.segmentContractInFlight.delete(job.public_id);
                try {
                    await this.recordMetricSpan(job.public_id, {
                        source: 'broker',
                        name: 'segment_keyframe_contracts',
                        duration_seconds: (Date.now() - started) / 1000,
                        metadata: { status, contracts: contractCount },
                    });
                } catch (error) {
                    console.warn(`Could not store segment frame-zero planning timing for ${job.public_id}`, error);
                }
            }
        })();
        this.segmentContractInFlight.set(job.public_id, generation);
        this.trackBackground(generation);
    }

    private async enrichedSegmentKeyframePlan(
        job: JobRow,
        fallback: Record<string, any>,
    ): Promise<Record<string, any>> {
        this.scheduleSegmentKeyframeContracts(job, fallback);
        await this.segmentContractInFlight.get(job.public_id);
        const current = await this.get<Pick<JobRow, 'planner_json'>>(
            'SELECT planner_json FROM video_jobs WHERE public_id = ?',
            [job.public_id],
        );
        if (!current?.planner_json) return fallback;
        try {
            return JSON.parse(current.planner_json);
        } catch {
            return fallback;
        }
    }

    private async ensurePlan(
        job: JobRow,
        criticalPath = false,
    ): Promise<{ plan: Record<string, any>; plannerModel: string }> {
        if (job.planner_json) {
            const plan = JSON.parse(job.planner_json);
            this.scheduleSegmentKeyframeContracts(job, plan);
            return {
                plan,
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
                    const plannerOptions = this.frontierOptions(job, criticalPath);
                    plannerOptions.onProvisionalKeyframe = value => this.scheduleProvisionalKeyframe(
                        job,
                        value.keyframe,
                        criticalPath,
                    );
                    const plan = await (this.options.frontierPlanner || createFrontierVideoPlan)(
                        job.prompt,
                        job.model,
                        job.requester_id,
                        sourceImage,
                        plannerOptions,
                    );
                    const provisional = this.provisionalKeyframePrefetch.get(job.public_id);
                    if (provisional && provisional.identity !== keyframePlanIdentity(plan)) {
                        this.discardProvisionalKeyframe(job.public_id);
                    }
                    const plannerModel = typeof (plan as any)._planner_model === 'string'
                        ? (plan as any)._planner_model
                        : plannerOptions.plannerModel || VIDEO_PLANNER_MODEL;
                    const plannerFingerprint = typeof (plan as any)._planner_fingerprint === 'string'
                        ? (plan as any)._planner_fingerprint
                        : videoPlannerFingerprint(
                            plannerModel,
                            plannerOptions.analysisReasoningEffort,
                            plannerOptions.screenplayReasoningEffort,
                            plannerOptions.plannerGuidance,
                            plannerOptions.plannerStrategy,
                        );
                    const plannerMetrics = (plan as any).planner_metrics;
                    if (plannerMetrics && typeof plannerMetrics === 'object') {
                        for (const [name, seconds] of [
                            ['frontier_prompt_analysis', Number(plannerMetrics.prompt_analysis_seconds)],
                            ['frontier_screenplay', Number(plannerMetrics.screenplay_seconds)],
                            ['frontier_single_pass', Number(plannerMetrics.single_pass_seconds)],
                            ['frontier_single_pass_fallback', Number(plannerMetrics.single_pass_fallback_seconds)],
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
                        `UPDATE video_jobs SET planner_json = ?, planner_model = ?, planner_fingerprint = ?, updated_at = ?
                         WHERE public_id = ? AND status IN (${ACTIVE_SQL})`,
                        [JSON.stringify(plan), plannerModel, plannerFingerprint, nowSeconds(), job.public_id],
                    );
                    this.scheduleSegmentKeyframeContracts(job, plan);
                    status = 'ok';
                    return { plan, plannerModel };
                } catch (error) {
                    this.discardProvisionalKeyframe(job.public_id);
                    if (error instanceof FrontierPlannerRejectedError) {
                        const reasonCode = /^[a-z_]+$/.test(error.reasonCode)
                            ? error.reasonCode
                            : 'other';
                        const rejectionStrategy = configuredVideoPlannerStrategy(job.channel_id);
                        const rejectionVariant = configuredVideoPlannerVariant(
                            process.env,
                            rejectionStrategy,
                        );
                        await this.run(
                            `UPDATE video_jobs SET planner_model = ?, planner_fingerprint = ?, updated_at = ?
                             WHERE public_id = ? AND status IN (${ACTIVE_SQL})`,
                            [
                                `${FRONTIER_REJECTION_PREFIX}${reasonCode}`,
                                videoPlannerFingerprint(
                                    rejectionVariant.plannerModel,
                                    rejectionVariant.analysisReasoningEffort,
                                    rejectionVariant.screenplayReasoningEffort,
                                    '',
                                    rejectionStrategy,
                                ),
                                nowSeconds(),
                                job.public_id,
                            ],
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
        const provisional = this.provisionalKeyframePrefetch.get(job.public_id);
        const provisionalMatches = Boolean(
            provisional
            && !job.source_image_path
            && plan?.keyframe?.recommended === true
            && !(job.keyframe_path && job.keyframe_mime)
            && provisional.identity === keyframePlanIdentity(plan),
        );
        if (provisional && !provisionalMatches) this.discardProvisionalKeyframe(job.public_id);
        if (job.source_image_path || plan?.keyframe?.recommended !== true
            || (job.keyframe_path && job.keyframe_mime)) return;
        let generation = this.keyframeInFlight.get(job.public_id);
        if (!generation) {
            const prefetch = provisionalMatches ? provisional : undefined;
            if (prefetch) {
                this.provisionalKeyframePrefetch.delete(job.public_id);
                clearTimeout(prefetch.cleanupTimer);
            }
            generation = (async () => {
                const started = Date.now();
                let status: 'ok' | 'error' | 'skipped' = 'error';
                try {
                    const directory = resolve(this.options.resultsDir, job.public_id);
                    mkdirSync(directory, { recursive: true });
                    const referenceStarted = Date.now();
                    let referenceResult: ProvisionalKeyframeReferenceResult;
                    if (prefetch) {
                        referenceResult = await prefetch.references;
                    } else {
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
                        }
                        referenceResult = {
                            references,
                            status: referenceStatus,
                            durationSeconds: (Date.now() - referenceStarted) / 1000,
                        };
                    }
                    try {
                        await this.recordMetricSpan(job.public_id, {
                            source: 'broker',
                            name: 'frontier_keyframe_references',
                            duration_seconds: referenceResult.durationSeconds,
                            metadata: {
                                status: referenceResult.status,
                                references_requested: prefetch?.referencesRequested
                                    ?? countVideoKeyframeReferenceRequirements(plan),
                                references_resolved: referenceResult.references.length,
                                prefetched: Boolean(prefetch),
                            },
                        });
                    } catch (error) {
                        console.warn(`Could not store first-frame reference timing for ${job.public_id}`, error);
                    }
                    const strategy = this.keyframeStrategy(job);
                    await this.run(
                        `UPDATE video_jobs SET keyframe_strategy = ?, updated_at = ?
                         WHERE public_id = ? AND status IN (${ACTIVE_SQL})`,
                        [strategy, nowSeconds(), job.public_id],
                    );
                    const result = await (this.options.keyframeGenerator || createFrontierVideoKeyframe)(
                        plan,
                        referenceResult.references,
                        {
                            ...this.frontierOptions(job, criticalPath),
                            ...configuredVideoKeyframeVariant(),
                            strategy,
                            initialCandidate: prefetch?.candidate,
                        },
                    );
                    if (!result.bytes.length || result.bytes.length > VIDEO_KEYFRAME_MAX_BYTES) {
                        throw new Error('Generated first frame is empty or too large.');
                    }
                    await this.providerHooks(job).onAttempt?.({
                        stage: 'keyframe_review_decision',
                        attempt: 1,
                        outcome: result.reviewStatus === 'unreviewed'
                            ? 'unreviewed'
                            : result.reviewStatus === 'best_effort' ? 'best_effort' : 'accepted',
                        provider: result.provider,
                        model: result.model,
                        serviceTier: requestedOpenAIServiceTier(
                            configuredVideoOpenAIServiceTier(),
                        ) || 'default',
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

    private segmentProviderHooks(job: JobRow, segmentIndex: number): VideoProviderHooks {
        const hooks = this.providerHooks(job);
        const stage = (value: string) => `segment_${segmentIndex}_${value}`;
        return {
            onAttempt: hooks.onAttempt
                ? attempt => hooks.onAttempt!({ ...attempt, stage: stage(attempt.stage) })
                : undefined,
            onUsage: hooks.onUsage
                ? usage => hooks.onUsage!({ ...usage, stage: stage(usage.stage) })
                : undefined,
        };
    }

    private async segmentIdentityReference(
        job: JobRow,
        plan: Record<string, any>,
        segmentIndex: number,
    ): Promise<VideoKeyframeReference | null> {
        const segments = Array.isArray(plan?.segments) ? plan.segments : [];
        const firstLabel = String(segments[0]?.overlay_label || '').trim();
        const targetLabel = String(segments[segmentIndex - 1]?.overlay_label || '').trim();
        if (targetLabel && targetLabel !== 'N/A' && targetLabel !== firstLabel) return null;
        let current = job;
        if (!current.source_image_path && !current.keyframe_path && plan?.keyframe?.recommended === true) {
            await this.ensureKeyframe(current, plan, true);
            current = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [job.public_id]) || current;
        }
        const path = current.source_image_path || current.keyframe_path;
        const mimeType = current.source_image_path ? current.source_image_mime : current.keyframe_mime;
        if (!path || !mimeType || !existsSync(path)
            || !VIDEO_SOURCE_IMAGE_MIME_TYPES.includes(mimeType as any)) return null;
        return {
            label: 'Recurring cast identity from frame zero',
            kind: 'identity',
            visualFactsToPreserve: (
                'Use this frame as the sole authority for each recurring face. Preserve the exact '
                + 'eye aperture, eye shape and spacing, iris and pupil scale, nose and nostril shape, '
                + 'cheek volume and contour, lip proportions, jaw width, chin silhouette, body '
                + 'proportions, hair, skin tone, and defining appearance; style is not anatomy.'
            ),
            bytes: readFileSync(path),
            mimeType: mimeType as VideoKeyframeReference['mimeType'],
            sourceUrl: current.source_image_path ? 'user-attachment' : 'generated-frame-zero',
            contextUrl: current.source_image_path ? 'user-attachment' : 'generated-frame-zero',
        };
    }

    private async ensureSegmentKeyframe(
        job: JobRow,
        plan: Record<string, any>,
        segmentIndex: number,
        aspectRatio: VideoKeyframeAspectRatio,
        criticalPath = true,
        origin: 'prefetch' | 'on_demand' = 'on_demand',
    ): Promise<void> {
        plan = await this.enrichedSegmentKeyframePlan(job, plan);
        const derivedPlan = derivedSegmentKeyframePlan(plan, segmentIndex);
        if (!derivedPlan) return;
        const existing = await this.get<SegmentKeyframeRow>(
            'SELECT * FROM video_segment_keyframes WHERE job_public_id = ? AND segment_index = ?',
            [job.public_id, segmentIndex],
        );
        if (existing?.path && existsSync(existing.path)) return;
        if (existing) {
            await this.run(
                'DELETE FROM video_segment_keyframes WHERE job_public_id = ? AND segment_index = ?',
                [job.public_id, segmentIndex],
            );
        }
        const inflightKey = `${job.public_id}:${segmentIndex}`;
        let generation = this.segmentKeyframeInFlight.get(inflightKey);
        if (!generation) {
            generation = (async () => {
                const started = Date.now();
                const slotStarted = Date.now();
                let slotWaitSeconds = 0;
                let status: 'ok' | 'error' | 'skipped' = 'error';
                let releaseSlot: (() => void) | null = null;
                try {
                    releaseSlot = await this.acquireSegmentKeyframeSlot(inflightKey, origin);
                    slotWaitSeconds = (Date.now() - slotStarted) / 1000;
                    const currentBeforeGeneration = await this.get<Pick<JobRow, 'status'>>(
                        'SELECT status FROM video_jobs WHERE public_id = ?',
                        [job.public_id],
                    );
                    if (this.stopping || !currentBeforeGeneration
                        || !ACTIVE_VIDEO_STATUSES.includes(currentBeforeGeneration.status)) {
                        status = 'skipped';
                        return;
                    }
                    const identity = await this.segmentIdentityReference(job, plan, segmentIndex);
                    const hooks = this.segmentProviderHooks(job, segmentIndex);
                    const result = await (this.options.keyframeGenerator || createFrontierVideoKeyframe)(
                        derivedPlan,
                        identity ? [identity] : [],
                        {
                            serviceTier: configuredVideoOpenAIServiceTier(),
                            ...hooks,
                            ...configuredVideoKeyframeVariant(),
                            strategy: this.keyframeStrategy(job),
                            aspectRatio,
                        },
                    );
                    if (!result.bytes.length || result.bytes.length > VIDEO_KEYFRAME_MAX_BYTES) {
                        throw new Error('Generated segment frame is empty or too large.');
                    }
                    await hooks.onAttempt?.({
                        stage: 'keyframe_review_decision',
                        attempt: 1,
                        outcome: result.reviewStatus === 'unreviewed'
                            ? 'unreviewed'
                            : result.reviewStatus === 'best_effort' ? 'best_effort' : 'accepted',
                        provider: result.provider,
                        model: result.model,
                        serviceTier: requestedOpenAIServiceTier(
                            configuredVideoOpenAIServiceTier(),
                        ) || 'default',
                        durationSeconds: 0,
                    });
                    const currentAfterGeneration = await this.get<JobRow>(
                        'SELECT status FROM video_jobs WHERE public_id = ?',
                        [job.public_id],
                    );
                    if (!currentAfterGeneration || !ACTIVE_VIDEO_STATUSES.includes(currentAfterGeneration.status)) {
                        status = 'skipped';
                        return;
                    }
                    const directory = resolve(this.options.resultsDir, job.public_id);
                    mkdirSync(directory, { recursive: true });
                    const extension = imageExtension(result.mimeType);
                    const temporary = join(directory, `segment-${segmentIndex}-keyframe.${extension}.part`);
                    const destination = join(directory, `segment-${segmentIndex}-keyframe.${extension}`);
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
                        `INSERT INTO video_segment_keyframes(
                            job_public_id, segment_index, path, mime_type, provider, model, created_at
                         ) VALUES(?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(job_public_id, segment_index) DO UPDATE SET
                            path = excluded.path, mime_type = excluded.mime_type,
                            provider = excluded.provider, model = excluded.model,
                            created_at = excluded.created_at`,
                        [
                            job.public_id,
                            segmentIndex,
                            destination,
                            result.mimeType,
                            result.provider,
                            result.model,
                            nowSeconds(),
                        ],
                    );
                    status = 'ok';
                } finally {
                    releaseSlot?.();
                    try {
                        await this.recordMetricSpan(job.public_id, {
                            source: 'broker',
                            name: 'segment_keyframe_slot_wait',
                            segment_index: segmentIndex,
                            duration_seconds: slotWaitSeconds,
                            metadata: { status, origin },
                        });
                        await this.recordMetricSpan(job.public_id, {
                            source: 'broker',
                            name: 'frontier_segment_keyframe',
                            segment_index: segmentIndex,
                            duration_seconds: (Date.now() - started) / 1000,
                            metadata: { status, origin },
                        });
                    } catch (error) {
                        console.warn(`Could not store segment-frame timing for ${job.public_id}`, error);
                    }
                }
            })();
            this.segmentKeyframeInFlight.set(inflightKey, generation);
        } else if (origin === 'on_demand') {
            this.promoteSegmentKeyframeSlot(inflightKey);
        }
        try {
            await generation;
        } finally {
            if (this.segmentKeyframeInFlight.get(inflightKey) === generation) {
                this.segmentKeyframeInFlight.delete(inflightKey);
            }
        }
    }

    private async ensureQueuedSegmentKeyframes(
        job: JobRow,
        plan: Record<string, any>,
        criticalPath: boolean,
    ): Promise<void> {
        // Generated primary frames are always 16:9. User attachments can have
        // arbitrary aspect ratios, so those remain a worker-side preparation
        // where the decoded dimensions are already known.
        if (!job.keyframe_path || job.source_image_path || !existsSync(job.keyframe_path)) return;
        const indexes = (Array.isArray(plan?.segments) ? plan.segments : [])
            .map((_segment: unknown, index: number) => index + 1)
            .filter((index: number) => index > 1 && derivedSegmentKeyframePlan(plan, index));
        let cursor = 0;
        const worker = async () => {
            while (cursor < indexes.length) {
                const index = indexes[cursor++];
                const current = await this.get<Pick<JobRow, 'status'>>(
                    'SELECT status FROM video_jobs WHERE public_id = ?',
                    [job.public_id],
                );
                if (this.stopping || !current || !ACTIVE_VIDEO_STATUSES.includes(current.status)) return;
                await this.ensureSegmentKeyframe(job, plan, index, '16:9', criticalPath, 'prefetch');
            }
        };
        await Promise.allSettled(Array.from({ length: Math.min(2, indexes.length) }, () => worker()));
    }

    private preparationComplete(job: JobRow): boolean {
        if (cachedFrontierRejection(job.planner_model)) return true;
        if (!job.planner_json || !job.estimate_ready) return false;
        if (job.source_image_path || (job.keyframe_path && job.keyframe_mime)) return true;
        try {
            return JSON.parse(job.planner_json)?.keyframe?.recommended !== true;
        } catch {
            return false;
        }
    }

    private schedulePreparation(publicId: string, criticalPath: boolean): void {
        if (!this.options.preplanQueuedJobs
            || this.preparationQueued.has(publicId) || this.preparationAttempted.has(publicId)
            || this.preparationQueued.size >= 1) return;
        this.preparationQueued.add(publicId);
        const task = (async () => {
            try {
                const job = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [publicId]);
                if (!job || job.status !== 'queued') return;
                const { plan } = await this.ensurePlan(job, criticalPath);
                await this.storePlanEstimate(job, plan);
                const refreshed = await this.get<JobRow>('SELECT * FROM video_jobs WHERE public_id = ?', [publicId]);
                if (!refreshed || refreshed.status !== 'queued') return;
                await this.ensureKeyframe(refreshed, plan, criticalPath);
                const withKeyframe = await this.get<JobRow>(
                    'SELECT * FROM video_jobs WHERE public_id = ?',
                    [publicId],
                );
                if (withKeyframe?.status === 'queued') {
                    const segmentPrefetch = this.ensureQueuedSegmentKeyframes(
                        withKeyframe,
                        plan,
                        criticalPath,
                    );
                    // On an idle worker, dispatch as soon as the screenplay and
                    // primary frame are ready. Later cut frames then overlap GPU
                    // startup and segment one instead of delaying the lease.
                    if (criticalPath) await this.dispatchNext();
                    await segmentPrefetch;
                }
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
                const current = await this.get<{ status: VideoJobStatus }>(
                    'SELECT status FROM video_jobs WHERE public_id = ?',
                    [publicId],
                );
                if (current?.status === 'queued') this.preparationAttempted.add(publicId);
                else this.preparationAttempted.delete(publicId);
                await this.dispatchNext();
                await this.scheduleNextQueuedPreparation();
            }
        })();
        this.trackBackground(task);
    }

    private async scheduleNextQueuedPreparation(): Promise<void> {
        if (!this.options.preplanQueuedJobs || !this.worker?.currentJob || this.preparationQueued.size >= 1) return;
        const placeholders = this.worker.capabilities.map(() => '?').join(',');
        if (!placeholders) return;
        const candidates = await this.all<JobRow>(
            `SELECT * FROM video_jobs WHERE status = 'queued' AND model IN (${placeholders})
             ORDER BY id ASC LIMIT 2`,
            this.worker.capabilities,
        );
        if (!candidates.length) return;
        let row = candidates[0];
        if (candidates.length > 1 && this.worker.warmModel
            && VIDEO_MODELS[row.model].generatorModel !== this.worker.warmModel
            && row.affinity_bypasses < 1
            && VIDEO_MODELS[candidates[1].model].generatorModel === this.worker.warmModel) {
            row = candidates[1];
        }
        if (!this.preparationComplete(row)) this.schedulePreparation(row.public_id, false);
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
            dispatch_paused: control.dispatch_paused
                || Boolean(this.worker && schedulerPausesDispatch(this.worker.scheduler)),
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
        const busy = Boolean(this.worker?.currentJob);
        const now = nowSeconds();
        // Keep a deliberately rough projection available before planning and GPU
        // admission. Runtime history gives every job a usable initial estimate;
        // later plan-aware estimates and actual GPU admission refine the same
        // timeline. Pauses with a known end anchor the projection there. An
        // offline worker, a dispatch drain, or unrelated gpuq work can move it
        // later, and the Discord copy calls those assumptions out explicitly.
        let cursor = Math.max(now, control.paused_until || now);
        const projections = new Map<string, { position: number | null; start: number | null; finish: number | null }>();
        let pipelinePosition = 0;
        for (const row of allActive) {
            pipelinePosition += 1;
            if (row.status !== 'queued' && row.gpu_queue_position) {
                pipelinePosition = Math.max(pipelinePosition, row.gpu_queue_position);
            }
            const expectedRuntime = Math.max(
                1,
                Math.round((row.estimate_low_seconds + row.estimate_high_seconds) / 2),
            );
            if (row.status === 'queued') {
                const start = cursor;
                cursor += expectedRuntime;
                projections.set(row.public_id, { position: pipelinePosition, start, finish: cursor });
            } else {
                const admitted = row.gpu_queue_state === 'admitted' || Boolean(row.gpu_admitted_at);
                const estimatedAdmission = row.gpu_estimated_admission_low_at
                    && row.gpu_estimated_admission_high_at
                    ? Math.round((row.gpu_estimated_admission_low_at + row.gpu_estimated_admission_high_at) / 2)
                    : row.gpu_estimated_admission_high_at || row.gpu_estimated_admission_low_at;
                const start = admitted
                    ? row.gpu_admitted_at || row.started_at || now
                    : Math.max(cursor, estimatedAdmission || cursor);
                const finish = admitted
                    ? projectedVideoFinishAt({
                        now,
                        startedAt: start,
                        expectedRuntime,
                        progress: row.progress,
                        progressScope: row.progress_scope,
                    })
                    : Math.max(now + 30, start + expectedRuntime);
                cursor = Math.max(cursor, finish);
                projections.set(row.public_id, { position: null, start, finish });
            }
        }
        return rows.map(row => {
            const projection = projections.get(row.public_id) || { position: null, start: null, finish: null };
            return {
                id: row.public_id,
                model: row.model,
                prompt: row.prompt,
                requested_duration_seconds: row.requested_duration_seconds,
                delivery_limit_bytes: row.delivery_limit_bytes,
                prompt_tease: row.prompt_tease,
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
                progress_scope: row.progress_scope,
                segment_index: row.segment_index,
                segment_count: row.segment_count,
                segment_progress: row.segment_progress,
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
                dispatch_paused: control.dispatch_paused
                    || Boolean(this.worker && schedulerPausesDispatch(this.worker.scheduler)),
                gpu_queue_state: row.gpu_queue_state,
                gpu_queue_submitted_at: row.gpu_queue_submitted_at,
                gpu_admitted_at: row.gpu_admitted_at,
                gpu_queue_wait_seconds: row.gpu_queue_wait_seconds,
                gpu_queue_position: row.gpu_queue_position,
                gpu_queue_jobs_ahead: row.gpu_queue_jobs_ahead,
                gpu_estimated_admission_low_at: row.gpu_estimated_admission_low_at,
                gpu_estimated_admission_high_at: row.gpu_estimated_admission_high_at,
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
                    const reconciliation = await this.reconcileWorker(hello);
                    this.sendWorker({
                        type: 'hello_ack',
                        protocol: VIDEO_PROTOCOL_VERSION,
                        state: await this.brokerState(),
                        resume_current_job: reconciliation.resumeCurrentJob,
                    });
                    if (reconciliation.cancel) this.sendWorker(reconciliation.cancel);
                    await this.synchronizeSchedulerGaming(null);
                    const control = await this.control();
                    if (!hello.current_job) {
                        if (control.paused_until) {
                            this.sendWorker({ type: 'unload', reason: 'pause' });
                            this.worker.warmModel = null;
                        } else if (control.gpuq_gaming_requested === null) {
                            await this.dispatchNext();
                        }
                    }
                    this.sendPendingGpuqControl(control);
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

    private async reconcileWorker(hello: VideoWorkerHello): Promise<{
        resumeCurrentJob: boolean;
        cancel?: { type: 'cancel'; job_id: string; reason: 'pause' | 'user' | 'release' | 'orphan' };
    }> {
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
            const leaseMatches = Boolean(row)
                && (row!.lease_token
                    ? row!.lease_token === hello.current_lease
                    : !hello.current_lease);
            if (row && ACTIVE_VIDEO_STATUSES.includes(row.status) && leaseMatches) {
                if (row.status === 'pausing' || row.status === 'cancelling') {
                    return {
                        resumeCurrentJob: false,
                        cancel: {
                            type: 'cancel',
                            job_id: hello.current_job,
                            reason: row.status === 'pausing' ? 'pause' : 'user',
                        },
                    };
                }
                await this.run(
                    `UPDATE video_jobs SET status = 'running', worker_id = ?, lease_expires_at = ?, updated_at = ?
                     WHERE public_id = ?`,
                    [hello.worker_id, nowSeconds() + 60, nowSeconds(), hello.current_job],
                );
                return { resumeCurrentJob: true };
            }
            if (row && ACTIVE_VIDEO_STATUSES.includes(row.status)
                && row.worker_id === hello.worker_id) {
                await this.run(
                    `UPDATE video_jobs SET status = 'queued', stage = 'Resuming with a fresh worker lease',
                     progress = NULL, progress_scope = NULL, segment_index = NULL,
                     segment_count = NULL, segment_progress = NULL,
                     worker_id = NULL, lease_expires_at = NULL, lease_token = NULL,
                     gpu_queue_state = NULL, gpu_queue_submitted_at = NULL,
                     gpu_admitted_at = NULL, gpu_queue_wait_seconds = NULL,
                     gpu_queue_position = NULL, gpu_queue_jobs_ahead = NULL,
                     gpu_estimated_admission_low_at = NULL,
                     gpu_estimated_admission_high_at = NULL, updated_at = ?
                     WHERE public_id = ? AND worker_id = ? AND lease_token = ?
                     AND status IN (${ACTIVE_SQL})`,
                    [
                        nowSeconds(),
                        hello.current_job,
                        hello.worker_id,
                        row.lease_token,
                    ],
                );
            }
            return {
                resumeCurrentJob: false,
                cancel: {
                    type: 'cancel',
                    job_id: hello.current_job,
                    reason: row ? 'release' : 'orphan',
                },
            };
        }
        const disconnected = await this.get<JobRow>(
            `SELECT * FROM video_jobs WHERE status = 'running_disconnected' ORDER BY id ASC LIMIT 1`,
        );
        if (disconnected) {
            await this.run(
                `UPDATE video_jobs SET status = 'queued', stage = 'Resuming after reconnect',
                 progress = NULL, progress_scope = NULL, segment_index = NULL,
                 segment_count = NULL, segment_progress = NULL,
                 worker_id = NULL, lease_expires_at = NULL, gpu_queue_state = NULL,
                 gpu_queue_submitted_at = NULL, gpu_admitted_at = NULL, gpu_queue_wait_seconds = NULL,
                 gpu_queue_position = NULL, gpu_queue_jobs_ahead = NULL,
                 gpu_estimated_admission_low_at = NULL, gpu_estimated_admission_high_at = NULL,
                 updated_at = ? WHERE public_id = ?`,
                [nowSeconds(), disconnected.public_id],
            );
        }
        return { resumeCurrentJob: false };
    }

    private async handleWorkerMessage(message: any): Promise<void> {
        if (!this.worker) return;
        this.worker.lastHeartbeat = Date.now();
        if (message.type === 'heartbeat') {
            if (message.scheduler !== undefined) {
                const previousScheduler = this.worker.scheduler;
                this.worker.scheduler = workerScheduler(message.scheduler);
                await this.synchronizeSchedulerGaming(previousScheduler);
            }
            if (message.job_id && message.job_id === this.worker.currentJob) {
                const workerProgress = workerProgressFields(message);
                await this.run(
                    `UPDATE video_jobs SET lease_expires_at = ?, stage = COALESCE(?, stage),
                     progress = CASE WHEN ? = 'job' AND progress_scope = 'job'
                        THEN MAX(COALESCE(progress, 0), COALESCE(?, progress, 0))
                        ELSE COALESCE(?, progress) END,
                     progress_scope = COALESCE(?, progress_scope),
                     segment_index = COALESCE(?, segment_index),
                     segment_count = COALESCE(?, segment_count),
                     segment_progress = COALESCE(?, segment_progress),
                     updated_at = ? WHERE public_id = ?`,
                    [
                        nowSeconds() + 60,
                        message.stage === undefined
                            ? null
                            : sanitizeVideoWorkerText(message.stage, 'Generating'),
                        workerProgress.scope,
                        workerProgress.progress,
                        workerProgress.progress,
                        workerProgress.scope,
                        workerProgress.segmentIndex,
                        workerProgress.segmentCount,
                        workerProgress.segmentProgress,
                        nowSeconds(),
                        message.job_id,
                    ],
                );
            }
            if (!this.worker.currentJob && this.worker.ready && schedulerAcceptsReservations(this.worker.scheduler)) {
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
                this.sendPendingGpuqControl(control);
                return;
            }
            if (control.gpuq_gaming_requested !== null) {
                this.sendPendingGpuqControl(control);
                return;
            }
            await this.dispatchNext();
            return;
        }
        if (message.type === 'gpuq_gaming_ack') {
            const requestId = Number(message.request_id);
            const enabled = message.enabled;
            if (!Number.isInteger(requestId) || requestId < 1 || typeof enabled !== 'boolean') return;
            const previousScheduler = this.worker.scheduler;
            if (message.scheduler !== undefined) {
                this.worker.scheduler = workerScheduler(message.scheduler);
            }
            await this.run(
                `UPDATE video_control SET gpuq_gaming_requested = NULL, updated_at = ?
                 WHERE id = 1 AND gpuq_request_id = ? AND gpuq_gaming_requested = ?`,
                [nowSeconds(), requestId, enabled ? 1 : 0],
            );
            await this.synchronizeSchedulerGaming(previousScheduler);
            const control = await this.control();
            if (control.gpuq_gaming_requested !== null) {
                this.sendPendingGpuqControl(control);
            } else if (!this.worker.currentJob && this.worker.ready
                && !control.paused_until && !control.dispatch_paused) {
                await this.dispatchNext();
            }
            return;
        }
        const jobId = String(message.job_id || '');
        if (!jobId) return;
        if (message.type === 'event' && ['cancelled', 'failed', 'complete'].includes(String(message.event || ''))
            && typeof message.event_id === 'string' && message.event_id) {
            const terminal = await this.get<Pick<JobRow, 'status' | 'lease_token' | 'error' | 'stage'>>(
                'SELECT status, lease_token, error, stage FROM video_jobs WHERE public_id = ?',
                [jobId],
            );
            if (terminal && duplicateVideoTerminalEventMatches(message, terminal)) {
                this.sendWorker({ type: 'event_ack', job_id: jobId, event_id: message.event_id });
                return;
            }
        }
        if (jobId !== this.worker.currentJob) return;
        if (this.worker.leaseId && message.lease_id !== undefined
            && message.lease_id !== this.worker.leaseId) return;
        if (message.type === 'event') {
            const event = String(message.event || '');
            if (event === 'gpu_queue') {
                const state = message.state === 'admitted' ? 'admitted' : 'queued';
                const now = nowSeconds();
                const submittedAt = Number.isFinite(Number(message.submitted_at))
                    ? Math.max(1, Math.min(now + 60, Math.round(Number(message.submitted_at))))
                    : now;
                const admittedAt = state === 'admitted'
                    ? Number.isFinite(Number(message.admitted_at))
                        ? Math.max(submittedAt, Math.min(now + 60, Math.round(Number(message.admitted_at))))
                        : now
                    : null;
                const queueWait = admittedAt === null
                    ? null
                    : Math.max(0, Math.round(Number(message.queue_wait_seconds) || admittedAt - submittedAt));
                const queuePosition = state === 'queued' && Number.isFinite(Number(message.queue_position))
                    ? Math.max(1, Math.min(10_000, Math.round(Number(message.queue_position))))
                    : null;
                const jobsAhead = state === 'queued' && Number.isFinite(Number(message.jobs_ahead))
                    ? Math.max(0, Math.min(9_999, Math.round(Number(message.jobs_ahead))))
                    : null;
                const latestEstimate = now + 365 * 24 * 60 * 60;
                const admissionLow = state === 'queued' && Number.isFinite(Number(message.estimated_admission_low_at))
                    ? Math.max(now - 60, Math.min(latestEstimate, Math.round(Number(message.estimated_admission_low_at))))
                    : null;
                const admissionHighCandidate = state === 'queued'
                    && Number.isFinite(Number(message.estimated_admission_high_at))
                    ? Math.max(now - 60, Math.min(latestEstimate, Math.round(Number(message.estimated_admission_high_at))))
                    : null;
                const admissionHigh = admissionHighCandidate === null
                    ? null
                    : Math.max(admissionLow || now - 60, admissionHighCandidate);
                await this.run(
                    `UPDATE video_jobs SET gpu_queue_state = ?,
                     gpu_queue_submitted_at = COALESCE(gpu_queue_submitted_at, ?),
                     gpu_admitted_at = COALESCE(gpu_admitted_at, ?),
                     gpu_queue_wait_seconds = COALESCE(gpu_queue_wait_seconds, ?),
                     gpu_queue_position = ?, gpu_queue_jobs_ahead = ?,
                     gpu_estimated_admission_low_at = ?, gpu_estimated_admission_high_at = ?,
                     stage = ?, lease_expires_at = ?, updated_at = ? WHERE public_id = ?`,
                    [
                        state,
                        submittedAt,
                        admittedAt,
                        queueWait,
                        queuePosition,
                        jobsAhead,
                        admissionLow,
                        admissionHigh,
                        sanitizeVideoWorkerText(
                            message.stage,
                            state === 'admitted' ? 'GPU admitted; starting video render' : 'Waiting for GPU queue admission',
                        ),
                        now + 60,
                        now,
                        jobId,
                    ],
                );
            } else if (event === 'plan') {
                const estimateLow = Number(message.estimate_low_seconds) > 0
                    ? Math.max(1, Number(message.estimate_low_seconds))
                    : null;
                const estimateHigh = Number(message.estimate_high_seconds) > 0
                    ? Math.max(1, Number(message.estimate_high_seconds))
                    : null;
                await this.run(
                    `UPDATE video_jobs SET status = 'planning', stage = ?,
                     estimate_low_seconds = COALESCE(?, estimate_low_seconds),
                     estimate_high_seconds = COALESCE(?, estimate_high_seconds),
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
                const workerProgress = workerProgressFields(message);
                await this.run(
                    `UPDATE video_jobs SET status = 'running', stage = ?,
                     progress = CASE WHEN ? = 'job' AND progress_scope = 'job'
                        THEN MAX(COALESCE(progress, 0), COALESCE(?, progress, 0))
                        ELSE COALESCE(?, progress) END,
                     progress_scope = COALESCE(?, progress_scope),
                     segment_index = COALESCE(?, segment_index),
                     segment_count = COALESCE(?, segment_count),
                     segment_progress = COALESCE(?, segment_progress),
                     lease_expires_at = ?, updated_at = ? WHERE public_id = ?`,
                    [
                        sanitizeVideoWorkerText(message.stage, 'Generating'),
                        workerProgress.scope,
                        workerProgress.progress,
                        workerProgress.progress,
                        workerProgress.scope,
                        workerProgress.segmentIndex,
                        workerProgress.segmentCount,
                        workerProgress.segmentProgress,
                        nowSeconds() + 60,
                        nowSeconds(),
                        jobId,
                    ],
                );
            } else if (event === 'uploading') {
                await this.run(
                    `UPDATE video_jobs SET status = 'uploading', stage = 'Uploading result',
                     progress = CASE WHEN progress_scope = 'job'
                        THEN MAX(COALESCE(progress, 0), 0.99) ELSE progress END,
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
                        ? `UPDATE video_jobs SET status = 'queued', stage = 'Paused for desktop use',
                           progress = NULL, progress_scope = NULL, segment_index = NULL,
                           segment_count = NULL, segment_progress = NULL,
                           worker_id = NULL, lease_expires_at = NULL, gpu_queue_state = NULL,
                           gpu_queue_submitted_at = NULL, gpu_admitted_at = NULL, gpu_queue_wait_seconds = NULL,
                           gpu_queue_position = NULL, gpu_queue_jobs_ahead = NULL,
                           gpu_estimated_admission_low_at = NULL, gpu_estimated_admission_high_at = NULL,
                           updated_at = ? WHERE public_id = ?`
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
                const publicError = sanitizeVideoWorkerText(message.error, 'Worker failure', 2000);
                const disposition = videoFailureDisposition(
                    publicError,
                    Boolean(message.retryable),
                    row.attempt || 0,
                    row.readiness_retries || 0,
                    row.error,
                );
                const retry = disposition !== 'fail';
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
                        ? `UPDATE video_jobs SET status = 'queued',
                           attempt = attempt + ?, readiness_retries = readiness_retries + ?, stage = ?,
                           progress = NULL, progress_scope = NULL, segment_index = NULL,
                           segment_count = NULL, segment_progress = NULL,
                           worker_id = NULL, lease_expires_at = NULL,
                           gpu_queue_state = NULL, gpu_queue_submitted_at = NULL,
                           gpu_admitted_at = NULL, gpu_queue_wait_seconds = NULL,
                           gpu_queue_position = NULL, gpu_queue_jobs_ahead = NULL,
                           gpu_estimated_admission_low_at = NULL, gpu_estimated_admission_high_at = NULL,
                           error = ?, updated_at = ?
                           WHERE public_id = ?`
                        : `UPDATE video_jobs SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
                           WHERE public_id = ?`,
                    retry
                        ? [
                            disposition === 'retry' ? 1 : 0,
                            disposition === 'wait-readiness' ? 1 : 0,
                            safetyPauseSeconds !== null
                                ? 'Paused after GPU driver reset'
                                : disposition === 'wait-readiness'
                                    ? 'Waiting for GPU/Comfy readiness'
                                    : 'Retrying',
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
                    const processingRuntime = Math.max(
                        0.01,
                        runtimeSeconds - Math.max(0, Number(row.gpu_queue_wait_seconds) || 0),
                    );
                    await this.run(
                        'INSERT INTO video_runtime_samples(model, runtime_seconds, recorded_at) VALUES(?,?,?)',
                        [row.model, processingRuntime, nowSeconds()],
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
        if (!schedulerAcceptsReservations(this.worker.scheduler)) return;
        const control = await this.control();
        if (control.paused_until || control.dispatch_paused
            || control.gpuq_gaming_requested !== null) return;
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
        if (this.options.preplanQueuedJobs
            && !this.preparationComplete(row) && !this.preparationAttempted.has(row.public_id)) {
            this.schedulePreparation(row.public_id, true);
            return;
        }
        const leaseId = randomUUID();
        const result = await this.run(
            `UPDATE video_jobs SET status = 'leased', worker_id = ?, lease_expires_at = ?,
             lease_token = ?, gpu_queue_state = 'submitting', gpu_queue_submitted_at = NULL,
             gpu_admitted_at = NULL, gpu_queue_wait_seconds = NULL,
             gpu_queue_position = NULL, gpu_queue_jobs_ahead = NULL,
             gpu_estimated_admission_low_at = NULL, gpu_estimated_admission_high_at = NULL,
             started_at = COALESCE(started_at, ?), stage = 'Reserving GPU queue position', updated_at = ?
             WHERE public_id = ? AND status = 'queued'`,
            [this.worker.id, nowSeconds() + 60, leaseId, nowSeconds(), nowSeconds(), row.public_id],
        );
        if (result.changes !== 1) return;
        this.worker.ready = false;
        this.preparationAttempted.delete(row.public_id);
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
                requested_duration_seconds: row.requested_duration_seconds,
                delivery_limit_bytes: row.delivery_limit_bytes,
                profile: 'maximum',
                has_source_image: Boolean(row.source_image_path),
                lease_id: leaseId,
                estimate_low_seconds: row.estimate_low_seconds,
                estimate_high_seconds: row.estimate_high_seconds,
                experiment_id: row.experiment_id,
                variant_id: row.variant_id,
                planner_fingerprint: row.planner_fingerprint,
                keyframe_strategy: row.keyframe_strategy,
            },
        });
        await this.scheduleNextQueuedPreparation();
    }

    private async synchronizeSchedulerGaming(
        previousScheduler: VideoWorkerSchedulerState | null,
    ): Promise<void> {
        if (!this.worker) return;
        if (!schedulerPausesDispatch(this.worker.scheduler)) {
            if (previousScheduler && schedulerPausesDispatch(previousScheduler)) {
                await this.run(
                    `UPDATE video_control SET paused_until = NULL, updated_by = NULL, updated_at = ?
                     WHERE id = 1 AND gpuq_gaming_requested IS NULL`,
                    [nowSeconds()],
                );
            }
            return;
        }
        if (this.worker.currentJob) {
            const result = await this.run(
                `UPDATE video_jobs SET status = 'pausing', updated_at = ?
                 WHERE public_id = ? AND status IN ('leased','planning','running','uploading','running_disconnected')`,
                [nowSeconds(), this.worker.currentJob],
            );
            if (result.changes === 1) {
                this.sendWorker({
                    type: 'cancel',
                    job_id: this.worker.currentJob,
                    reason: 'pause',
                });
            }
            return;
        }
        if (this.worker.ready && this.worker.warmModel) {
            this.sendWorker({ type: 'unload', reason: 'pause' });
            this.worker.warmModel = null;
        }
    }

    private sendWorker(message: unknown): void {
        if (this.worker?.socket.readyState === WebSocket.OPEN) {
            this.worker.socket.send(JSON.stringify(message));
        }
    }

    private sendPendingGpuqControl(control: VideoControlState): void {
        if (control.gpuq_gaming_requested === null) return;
        this.sendWorker({
            type: 'gpuq_gaming',
            enabled: control.gpuq_gaming_requested,
            request_id: control.gpuq_request_id,
        });
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
                const plan = JSON.parse(job.planner_json);
                writeJson(res, 200, {
                    plan,
                    plan_identity: segmentKeyframePlanIdentity(plan),
                    planner_model: job.planner_model || VIDEO_PLANNER_MODEL,
                    cached: true,
                });
                return;
            }
            try {
                const prepared = await this.ensurePlan(job, true);
                await this.storePlanEstimate(job, prepared.plan);
                writeJson(res, 200, {
                    plan: prepared.plan,
                    plan_identity: segmentKeyframePlanIdentity(prepared.plan),
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
                validateFrontierVideoPlanForKeyframe(
                    plan,
                    job.model,
                    job.prompt,
                    job.requested_duration_seconds,
                );
                const estimate = await this.plannedRuntimeEstimate(job, plan);
                const now = nowSeconds();
                await this.run(
                    `UPDATE video_jobs SET planner_json = ?, planner_model = ?, planner_fingerprint = ?,
                     estimate_low_seconds = ?, estimate_high_seconds = ?, estimate_ready = 1,
                     initial_estimate_low_seconds = COALESCE(initial_estimate_low_seconds, ?),
                     initial_estimate_high_seconds = COALESCE(initial_estimate_high_seconds, ?),
                     initial_estimate_recorded_at = COALESCE(initial_estimate_recorded_at, ?),
                     updated_at = ? WHERE public_id = ? AND status IN (${ACTIVE_SQL})`,
                    [
                        JSON.stringify(plan),
                        LOCAL_VIDEO_PLANNER_MODEL,
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
                    plan_identity: segmentKeyframePlanIdentity(plan),
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
            const segmentValue = url.searchParams.get('segment');
            const segmentIndex = segmentValue === null ? 1 : Number(segmentValue);
            if (!Number.isInteger(segmentIndex) || segmentIndex < 1 || segmentIndex > 64) {
                writeJson(res, 400, { error: 'Segment must be an integer from 1 through 64.' });
                return;
            }
            if (segmentIndex > 1) {
                if (!job.planner_json) {
                    writeJson(res, 409, { error: 'A screenplay is required before generating segment frames.' });
                    return;
                }
                const aspectValue = url.searchParams.get('aspect') || '16:9';
                if (!VIDEO_KEYFRAME_ASPECT_RATIOS.includes(aspectValue as VideoKeyframeAspectRatio)) {
                    writeJson(res, 400, { error: 'Unsupported segment-frame aspect ratio.' });
                    return;
                }
                const plan = JSON.parse(job.planner_json);
                const suppliedPlanIdentity = req.headers['x-video-plan-identity'];
                if (suppliedPlanIdentity !== segmentKeyframePlanIdentity(plan)) {
                    writeJson(res, 409, {
                        error: 'Worker screenplay does not match the broker-approved screenplay.',
                        reason_code: 'plan_mismatch',
                    });
                    return;
                }
                if (!derivedSegmentKeyframePlan(plan, segmentIndex)) {
                    res.writeHead(204, { 'cache-control': 'no-store' });
                    res.end();
                    return;
                }
                try {
                    const deliveryStarted = Date.now();
                    let stored = await this.get<SegmentKeyframeRow>(
                        'SELECT * FROM video_segment_keyframes WHERE job_public_id = ? AND segment_index = ?',
                        [job.public_id, segmentIndex],
                    );
                    const cached = Boolean(stored?.path && existsSync(stored.path));
                    const joined = !cached && this.segmentKeyframeInFlight.has(`${job.public_id}:${segmentIndex}`);
                    let deliveryStatus: 'ok' | 'error' | 'skipped' = 'skipped';
                    if (!cached) {
                        await this.ensureSegmentKeyframe(
                            job,
                            plan,
                            segmentIndex,
                            aspectValue as VideoKeyframeAspectRatio,
                            true,
                            'on_demand',
                        );
                        stored = await this.get<SegmentKeyframeRow>(
                            'SELECT * FROM video_segment_keyframes WHERE job_public_id = ? AND segment_index = ?',
                            [job.public_id, segmentIndex],
                        );
                    }
                    if (!stored?.path || !stored.mime_type || !existsSync(stored.path)) {
                        await this.recordMetricSpan(keyframe[1], {
                            source: 'broker',
                            name: 'segment_keyframe_delivery_wait',
                            segment_index: segmentIndex,
                            duration_seconds: (Date.now() - deliveryStarted) / 1000,
                            metadata: { cached, joined, status: deliveryStatus },
                        }).catch(error => console.warn(
                            `Could not store segment-frame delivery timing for ${keyframe[1]}`,
                            error,
                        ));
                        res.writeHead(204, { 'cache-control': 'no-store' });
                        res.end();
                        return;
                    }
                    deliveryStatus = 'ok';
                    await this.recordMetricSpan(keyframe[1], {
                        source: 'broker',
                        name: 'segment_keyframe_delivery_wait',
                        segment_index: segmentIndex,
                        duration_seconds: (Date.now() - deliveryStarted) / 1000,
                        metadata: { cached, joined, status: deliveryStatus },
                    }).catch(error => console.warn(
                        `Could not store segment-frame delivery timing for ${keyframe[1]}`,
                        error,
                    ));
                    writeImage(res, stored.path, stored.mime_type, {
                        'x-video-keyframe-provider': stored.provider || 'frontier-image',
                        'x-video-keyframe-model': stored.model || 'unknown',
                        'x-video-keyframe-cached': cached ? 'true' : 'false',
                        'x-video-keyframe-segment': String(segmentIndex),
                    });
                } catch (error) {
                    console.warn(`Derived frame generation failed for ${keyframe[1]} segment ${segmentIndex}`, error);
                    writeJson(res, 502, {
                        error: error instanceof Error ? error.message : String(error),
                        fallback: 't2v',
                    });
                }
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
                await this.storeWorkerMetrics(job, await readJson(req, 2 * 1024 * 1024));
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
            await this.run('DELETE FROM video_segment_keyframes WHERE job_public_id = ?', [row.public_id]);
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
        preplanQueuedJobs: process.env.VIDEO_PREPLAN_QUEUED !== '0',
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
