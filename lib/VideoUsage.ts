export type VideoServiceTier = 'default' | 'fast';

export class VideoUsagePersistenceError extends Error {
    readonly cause: unknown;

    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = 'VideoUsagePersistenceError';
        this.cause = cause;
    }
}

export type VideoProviderOutcome = 'success' | 'accepted' | 'rejected' | 'error' | 'unreviewed' | 'cancelled';

export interface VideoProviderUsage {
    stage: string;
    attempt: number;
    outcome: VideoProviderOutcome;
    provider: string;
    model: string;
    serviceTier?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    images?: number;
    webSearches?: number;
    costOverride?: number;
}

export interface VideoProviderAttempt {
    stage: string;
    attempt: number;
    outcome: VideoProviderOutcome;
    provider: string;
    model: string;
    serviceTier?: string;
    durationSeconds: number;
    detail?: string;
}

export interface VideoProviderHooks {
    onUsage?: (usage: VideoProviderUsage) => void | Promise<void>;
    onAttempt?: (attempt: VideoProviderAttempt) => void | Promise<void>;
}

export interface VideoFrontierCallOptions extends VideoProviderHooks {
    serviceTier?: VideoServiceTier;
    plannerModel?: string;
    plannerStrategy?: 'two-pass' | 'single-pass';
    analysisReasoningEffort?: 'low' | 'medium' | 'high';
    screenplayReasoningEffort?: 'low' | 'medium' | 'high';
    plannerGuidance?: string;
    plannerExamples?: Array<{
        prompt: string;
        plan: Record<string, unknown>;
    }>;
}

export interface VideoUsageEvent {
    event_id: string;
    job_id: string;
    user_id: string;
    channel_id: string;
    guild_id: string | null;
    command: string;
    stage: string;
    attempt: number;
    outcome: VideoProviderOutcome;
    provider: string;
    model: string;
    service_tier: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    images: number;
    web_searches: number;
    cost: number;
    created_at: number;
}

function finiteNonnegative(value: number | undefined): number {
    return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : 0;
}

export function videoUsageCost(usage: VideoProviderUsage): number {
    if (usage.costOverride !== undefined && Number.isFinite(usage.costOverride)) {
        return Math.max(0, usage.costOverride);
    }
    const input = finiteNonnegative(usage.inputTokens);
    const output = finiteNonnegative(usage.outputTokens);
    const cacheRead = finiteNonnegative(usage.cacheReadTokens);
    const images = finiteNonnegative(usage.images);
    const searches = finiteNonnegative(usage.webSearches);
    if (usage.model.startsWith('gpt-5.6-sol')) {
        const priority = usage.serviceTier === 'priority' || usage.serviceTier === 'fast';
        return input * (priority ? 8 : 5) / 1_000_000
            + output * (priority ? 40 : 30) / 1_000_000
            + cacheRead * (priority ? 0.8 : 0.5) / 1_000_000;
    }
    if (usage.model.startsWith('gemini-3.7-flash')) {
        return input * 0.75 / 1_000_000
            + output * 3.75 / 1_000_000
            + cacheRead * 0.075 / 1_000_000;
    }
    if (usage.model.startsWith('gemini-3-pro-image')) {
        return input * 2 / 1_000_000 + output * 12 / 1_000_000 + images * 0.12;
    }
    if (usage.model.startsWith('gpt-image-2')) {
        // GPT Image 2 high landscape output is $0.165 per generated image.
        return images * 0.165;
    }
    if (usage.model === 'google-custom-search') {
        return searches * 0.005;
    }
    return 0;
}

export function requestedOpenAIServiceTier(tier: VideoServiceTier | undefined): string | undefined {
    return tier === 'fast' ? 'priority' : undefined;
}

export function resolvedOpenAIServiceTier(body: any, requested: VideoServiceTier | undefined): string {
    if (typeof body?.service_tier === 'string' && body.service_tier.trim()) {
        return body.service_tier.trim();
    }
    return requested === 'fast' ? 'priority' : 'default';
}
