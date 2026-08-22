export const VIDEO_PROTOCOL_VERSION = 1;
export const VIDEO_PROMPT_MAX_LENGTH = 1800;
export const VIDEO_MAX_USER_JOBS = 3;
export const VIDEO_MAX_GLOBAL_JOBS = 20;
export const VIDEO_RESULT_MAX_BYTES = 10 * 1024 * 1024;
export const VIDEO_SOURCE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const VIDEO_SOURCE_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type VideoModelId = 'ltx' | 'minimax';

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
};

export interface VideoJobView {
    id: string;
    model: VideoModelId;
    prompt: string;
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
    delivered_at: number | null;
    worker_online: boolean;
    worker_busy: boolean;
    paused_until: number | null;
}

export interface VideoWorkerHello {
    type: 'hello';
    protocol: number;
    worker_id: string;
    capabilities: VideoModelId[];
    current_job: string | null;
    estimates?: Partial<Record<VideoModelId, { low: number; high: number }>>;
}

export function isVideoModel(value: unknown): value is VideoModelId {
    return value === 'ltx' || value === 'minimax';
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
