export const VIDEO_PROTOCOL_VERSION = 1;
export const VIDEO_IMAGE_ONLY_AUTO_PROMPT = 'Image-only auto-direction: inspect the supplied image and create the most natural short motion continuation.';
export const VIDEO_MAX_USER_JOBS = 3;
export const VIDEO_MAX_GLOBAL_JOBS = 20;
export const VIDEO_RESULT_MAX_BYTES = 50 * 1024 * 1024;
export const VIDEO_SOURCE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const VIDEO_SOURCE_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type VideoModelId = 'ltx' | 'ltxfast' | 'minimax' | 'minimaxfast';
export type VideoGeneratorModelId = 'ltx' | 'h3';

export interface VideoMetricSpan {
    source: 'broker' | 'worker' | 'comfy';
    name: string;
    duration_seconds: number;
    segment_index?: number | null;
    metadata?: {
        cached?: boolean;
        status?: 'ok' | 'error' | 'skipped';
        mode?: 't2v' | 'i2v';
        quality?: 'draft' | 'final';
        transition?: 'start' | 'cut' | 'continue' | 'dissolve';
        attention_backend?: 'pytorch' | 'comfy_kitchen_int8';
        aspect?: '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '9:16' | '16:9' | '21:9';
        segment_duration_seconds?: number;
        frame_count?: number;
        run_index?: number;
        steps_observed?: number;
        steps_total?: number;
        first_step_seconds?: number;
        steady_step_mean_seconds?: number;
        steady_step_median_seconds?: number;
        steady_step_p90_seconds?: number;
        references_requested?: number;
        references_resolved?: number;
        contracts?: number;
        origin?: 'prefetch' | 'on_demand';
        joined?: boolean;
        prefetched?: boolean;
    };
}

export interface VideoWorkerMetrics {
    schema_version: 1;
    model: VideoModelId;
    generator_model: VideoGeneratorModelId;
    total_seconds: number;
    output?: {
        duration_seconds?: number;
        width?: number;
        height?: number;
        fps?: number;
        segment_count?: number;
        bytes?: number;
        source_image?: boolean;
    };
    gpu?: {
        name?: string;
        driver_version?: string;
        vram_total_mb?: number;
        vram_peak_mb?: number;
        vram_average_mb?: number;
        vram_free_min_mb?: number;
        utilization_average_percent?: number;
        utilization_peak_percent?: number;
        power_average_watts?: number;
        temperature_peak_c?: number;
        pcie_link_width_min?: number;
        pcie_link_width_max?: number;
        hardware_slowdown_samples?: number;
        thermal_slowdown_samples?: number;
        power_brake_slowdown_samples?: number;
        samples?: number;
    };
    environment?: {
        worker_sha256?: string;
        generator_sha256?: string;
        python_version?: string;
        comfy_aimdo_version?: string;
        warm_model_before?: VideoGeneratorModelId | null;
        warm_model_after?: VideoGeneratorModelId | null;
        experiment_id?: string | null;
        variant_id?: string;
        planner_fingerprint?: string | null;
        keyframe_strategy?: string | null;
    };
    failure?: {
        kind: 'nvidia_driver_reset' | 'generator_failure';
        event_count?: number;
        event_ids?: number[];
        latest_utc?: string;
    };
    flags?: {
        fast?: boolean;
        turbo4?: boolean;
        ltx_one_stage?: boolean;
        quality?: 'draft' | 'final';
    };
    spans: VideoMetricSpan[];
}

export type VideoJobStatus =
    | 'queued'
    | 'leased'
    | 'planning'
    | 'running'
    | 'running_disconnected'
    | 'pausing'
    | 'cancelling'
    | 'uploading'
    | 'ready'
    | 'delivered'
    | 'failed'
    | 'cancelled';

export const ACTIVE_VIDEO_STATUSES: VideoJobStatus[] = [
    'queued',
    'leased',
    'planning',
    'running',
    'running_disconnected',
    'pausing',
    'cancelling',
    'uploading',
];

export const UNFINISHED_VIDEO_STATUSES: VideoJobStatus[] = [
    ...ACTIVE_VIDEO_STATUSES,
    'ready',
];

export interface VideoModelDefinition {
    id: VideoModelId;
    command: string;
    displayName: string;
    generatorModel: 'ltx' | 'h3';
    generatorArgs: string[];
    fallbackLowSeconds: number;
    fallbackHighSeconds: number;
}

export const VIDEO_MODELS: Record<VideoModelId, VideoModelDefinition> = {
    ltx: {
        id: 'ltx',
        command: 'ltx',
        displayName: 'LTX 2.5',
        generatorModel: 'ltx',
        generatorArgs: ['--model', 'ltx', '--quality', 'final'],
        fallbackLowSeconds: 480,
        fallbackHighSeconds: 1500,
    },
    minimax: {
        id: 'minimax',
        command: 'minimax',
        displayName: 'MiniMax H3',
        generatorModel: 'h3',
        generatorArgs: ['--model', 'h3', '--quality', 'final'],
        fallbackLowSeconds: 600,
        fallbackHighSeconds: 1800,
    },
    ltxfast: {
        id: 'ltxfast',
        command: 'ltxfast',
        displayName: 'LTX 2.5 Fast Preview',
        generatorModel: 'ltx',
        generatorArgs: ['--model', 'ltx', '--quality', 'draft', '--ltx-one-stage'],
        fallbackLowSeconds: 120,
        fallbackHighSeconds: 600,
    },
    minimaxfast: {
        id: 'minimaxfast',
        command: 'minimaxfast',
        displayName: 'MiniMax H3 Turbo',
        generatorModel: 'h3',
        generatorArgs: ['--model', 'h3', '--quality', 'final', '--fast'],
        fallbackLowSeconds: 360,
        fallbackHighSeconds: 1200,
    },
};

export interface VideoJobView {
    id: string;
    model: VideoModelId;
    prompt: string;
    prompt_tease?: string | null;
    planned_intent?: string | null;
    generation_notice?: string | null;
    requester_id: string;
    origin_bot_id: string;
    channel_id: string;
    guild_id: string | null;
    command_message_id: string;
    status_message_id: string;
    status: VideoJobStatus;
    queue_position: number | null;
    estimate_low_seconds: number;
    estimate_high_seconds: number;
    estimate_ready: boolean;
    initial_estimate_low_seconds?: number | null;
    initial_estimate_high_seconds?: number | null;
    initial_estimate_recorded_at?: number | null;
    expected_start_at: number | null;
    expected_finish_at: number | null;
    stage: string | null;
    progress: number | null;
    error: string | null;
    result_path: string | null;
    result_bytes: number | null;
    has_source_image: boolean;
    created_at: number;
    updated_at: number;
    started_at: number | null;
    completed_at: number | null;
    runtime_seconds: number | null;
    delivered_at: number | null;
    worker_online: boolean;
    worker_busy: boolean;
    paused_until: number | null;
    dispatch_paused: boolean;
    gpu_queue_state?: 'submitting' | 'queued' | 'admitted' | null;
    gpu_queue_submitted_at?: number | null;
    gpu_admitted_at?: number | null;
    gpu_queue_wait_seconds?: number | null;
    gpu_queue_position?: number | null;
    gpu_queue_jobs_ahead?: number | null;
    gpu_estimated_admission_low_at?: number | null;
    gpu_estimated_admission_high_at?: number | null;
}

export interface VideoWorkerHello {
    type: 'hello';
    protocol: number;
    worker_id: string;
    capabilities: VideoModelId[];
    current_job: string | null;
    warm_model?: VideoGeneratorModelId | null;
    current_lease?: string | null;
    scheduler?: VideoWorkerSchedulerState;
    estimates?: Partial<Record<VideoModelId, { low: number; high: number }>>;
}

export interface VideoWorkerSchedulerState {
    available: boolean;
    mode?: 'normal' | 'draining' | 'enteringGaming' | 'gaming' | null;
    gaming_ready?: boolean;
    health?: 'healthy' | 'recovering' | 'probing' | 'externalBusy' | null;
}

export function isVideoModel(value: unknown): value is VideoModelId {
    return value === 'ltx'
        || value === 'ltxfast'
        || value === 'minimax'
        || value === 'minimaxfast';
}

export function sanitizeVideoWorkerText(
    value: unknown,
    fallback: string,
    maxLength = 255,
): string {
    const compact = String(value || '').replace(/\s+/g, ' ').trim();
    const completedPath = /^Completed\s+([^:]{1,80}):\s*(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|mnt|Users|tmp|var|opt|srv)\/)/i.exec(compact);
    if (completedPath) {
        const label = completedPath[1].trim();
        return (label.toLowerCase().endsWith('segment')
            ? `${label} complete`
            : `${label} segment complete`).slice(0, maxLength);
    }
    const sanitized = compact
        .replace(/\b[A-Za-z]:[\\/][^\r\n]*/g, '[local file]')
        .replace(/\\\\[^\r\n]*/g, '[local file]')
        .replace(/(^|\s)\/(?:home|mnt|Users|tmp|var|opt|srv)\/[^\r\n]*/g, '$1[local file]')
        .trim();
    return (sanitized || fallback).slice(0, maxLength);
}

export function parsePauseDuration(value: string | undefined): number {
    if (!value) return 6 * 60 * 60;
    const match = /^(\d+(?:\.\d+)?)(m|h|d)$/i.exec(value.trim());
    if (!match) throw new Error('Pause duration must look like 30m, 6h, or 1d.');
    const multiplier = match[2].toLowerCase() === 'm'
        ? 60
        : match[2].toLowerCase() === 'h'
            ? 60 * 60
            : 24 * 60 * 60;
    const seconds = Number(match[1]) * multiplier;
    if (seconds < 60 || seconds > 7 * 24 * 60 * 60) {
        throw new Error('Pause duration must be between 1 minute and 7 days.');
    }
    return Math.round(seconds);
}
