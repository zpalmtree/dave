export type VideoServiceTier = 'default' | 'fast' | 'flex';

export class VideoUsagePersistenceError extends Error {
    readonly cause: unknown;

    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = 'VideoUsagePersistenceError';
        this.cause = cause;
    }
}

export type VideoProviderOutcome = 'success' | 'accepted' | 'best_effort' | 'rejected' | 'error' | 'unreviewed' | 'cancelled';

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
    requestedDurationSeconds?: number;
    plannerExamples?: Array<{
        prompt: string;
        plan: Record<string, unknown>;
    }>;
    onProvisionalKeyframe?: (value: {
        promptAnalysis: Record<string, unknown>;
        keyframe: Record<string, unknown>;
    }) => void;
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

export interface VideoTokenPricing {
    input: number;
    cachedInput: number;
    cacheWrite: number;
    output: number;
}

/**
 * USD per one million tokens. Keep this explicit and tested: benchmark reports
 * are reimbursement records, so silently falling back to a nearby model is
 * worse than returning an unknown price.
 */
export const OPENAI_VIDEO_TOKEN_PRICING: Readonly<Record<string, VideoTokenPricing>> = {
    'gpt-5.6-sol': { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 },
    'gpt-5.6-terra': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 },
    'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
};

function openAIPricing(model: string): VideoTokenPricing | undefined {
    return Object.entries(OPENAI_VIDEO_TOKEN_PRICING)
        .find(([prefix]) => model.startsWith(prefix))?.[1];
}

function openAIServiceTierMultiplier(serviceTier: string | undefined): number {
    if (serviceTier === 'priority' || serviceTier === 'fast') return 2;
    if (serviceTier === 'flex') return 0.5;
    return 1;
}

export function videoUsageCost(usage: VideoProviderUsage): number {
    if (usage.costOverride !== undefined && Number.isFinite(usage.costOverride)) {
        return Math.max(0, usage.costOverride);
    }
    const input = finiteNonnegative(usage.inputTokens);
    const output = finiteNonnegative(usage.outputTokens);
    const cacheRead = finiteNonnegative(usage.cacheReadTokens);
    const cacheWrite = finiteNonnegative(usage.cacheWriteTokens);
    const images = finiteNonnegative(usage.images);
    const searches = finiteNonnegative(usage.webSearches);
    const pricing = openAIPricing(usage.model);
    if (pricing) {
        const multiplier = openAIServiceTierMultiplier(usage.serviceTier);
        return multiplier * (
            input * pricing.input / 1_000_000
            + output * pricing.output / 1_000_000
            + cacheRead * pricing.cachedInput / 1_000_000
            + cacheWrite * pricing.cacheWrite / 1_000_000
        );
    }
    if (usage.model.startsWith('gemini-3.7-flash')) {
        return input * 0.75 / 1_000_000
            + output * 3.75 / 1_000_000
            + cacheRead * 0.075 / 1_000_000;
    }
    if (usage.model.startsWith('gemini-3.5-flash-lite')) {
        return input * 0.30 / 1_000_000
            + output * 2.50 / 1_000_000
            + cacheRead * 0.03 / 1_000_000;
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
    if (tier === 'fast') return 'priority';
    if (tier === 'flex') return 'flex';
    return undefined;
}

export function configuredVideoOpenAIServiceTier(
    environment: NodeJS.ProcessEnv = process.env,
): VideoServiceTier {
    const configured = environment.VIDEO_OPENAI_SERVICE_TIER;
    if (configured === 'fast' || configured === 'flex') return configured;
    return 'default';
}

export function resolvedOpenAIServiceTier(body: any, requested: VideoServiceTier | undefined): string {
    if (typeof body?.service_tier === 'string' && body.service_tier.trim()) {
        return body.service_tier.trim();
    }
    if (requested === 'fast') return 'priority';
    if (requested === 'flex') return 'flex';
    return 'default';
}
