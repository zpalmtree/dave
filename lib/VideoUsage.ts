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
    imageInputTokens?: number;
    imageOutputTokens?: number;
    webSearches?: number;
    costOverride?: number;
    rawUsage?: Record<string, unknown>;
    pricingDate?: string;
    usageMissing?: boolean;
}

export interface VideoProviderRequest {
    stage: string;
    attempt: number;
    provider: string;
    model: string;
    serviceTier?: string;
    /** Conservative upper bound, including image inputs where applicable. */
    maxInputTokens: number;
    maxOutputTokens: number;
    maxImages?: number;
    maxWebSearches?: number;
}

export function videoRequestInputTokenBound(value: unknown): number {
    const count = (item: any): number => {
        if (typeof item === 'string') return item.startsWith('data:') ? 131_072 : Buffer.byteLength(item, 'utf8');
        if (Array.isArray(item)) return item.reduce((sum, nested) => sum + count(nested), 0);
        if (item && typeof item === 'object') {
            if (item.inlineData || item.type === 'input_image') return 131_072;
            return Object.entries(item).reduce((sum, [key, nested]) => sum + key.length + count(nested), 0);
        }
        return 16;
    };
    return 4096 + count(value);
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
    beforeRequest?: (request: VideoProviderRequest) => void | Promise<void>;
    onUsage?: (usage: VideoProviderUsage) => void | Promise<void>;
    onAttempt?: (attempt: VideoProviderAttempt) => void | Promise<void>;
}

export interface VideoFrontierCallOptions extends VideoProviderHooks {
    maxRequestAttempts?: 1 | 2;
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
    'gpt-6-astra': { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
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
        const longContext = input + cacheRead + cacheWrite > 272_000;
        return multiplier * (
            (input * pricing.input + cacheRead * pricing.cachedInput + cacheWrite * pricing.cacheWrite)
                * (longContext ? 2 : 1) / 1_000_000
            + output * pricing.output * (longContext ? 1.5 : 1) / 1_000_000
        );
    }
    if (/^gemini-3\.[78]-flash(?:$|-)/.test(usage.model)) {
        const multiplier = (usage.pricingDate || new Date().toISOString().slice(0, 10)) >= '2027-01-01' ? 2 : 1;
        return multiplier * (input * 0.75 / 1_000_000
            + output * 3.75 / 1_000_000
            + cacheRead * 0.075 / 1_000_000);
    }
    if (usage.model.startsWith('gemini-3.5-flash-lite')) {
        return input * 0.30 / 1_000_000
            + output * 2.50 / 1_000_000
            + cacheRead * 0.03 / 1_000_000;
    }
    if (usage.model.startsWith('gemini-3-pro-image')) {
        return input * 2 / 1_000_000 + output * 12 / 1_000_000
            + (usage.imageOutputTokens ?? images * 1120) * 120 / 1_000_000;
    }
    if (usage.model.startsWith('gemini-3.1-flash-lite-image')) {
        return input * 0.25 / 1_000_000 + output * 1.5 / 1_000_000
            + (usage.imageOutputTokens ?? images * 1120) * 30 / 1_000_000;
    }
    if (usage.model.startsWith('gemini-3.1-flash-image')) {
        return input * 0.5 / 1_000_000 + output * 3 / 1_000_000
            + (usage.imageOutputTokens ?? images * 1680) * 60 / 1_000_000;
    }
    if (usage.model.startsWith('gpt-image-2')) {
        const imageInput = Math.min(input, usage.imageInputTokens ?? input);
        return ((input - imageInput) * 5 + imageInput * 8 + cacheRead * 2
            + (usage.imageOutputTokens ?? (output || images * 5500)) * 30) / 1_000_000;
    }
    if (usage.model === 'google-custom-search') {
        return searches * 0.005;
    }
    if (['local', 'broker', 'corpus'].includes(usage.provider)) return 0;
    throw new Error(`Unknown video usage price for ${usage.provider}/${usage.model}.`);
}

/** Input totals include cache reads and writes. Reasoning is already part of output. */
export function openAIVideoUsage(body: any): Pick<VideoProviderUsage,
    'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'rawUsage' | 'usageMissing'> {
    const usage = body?.usage;
    const cacheReadTokens = finiteNonnegative(usage?.input_tokens_details?.cached_tokens);
    const cacheWriteTokens = finiteNonnegative(usage?.input_tokens_details?.cache_write_tokens);
    return {
        inputTokens: Math.max(0, finiteNonnegative(usage?.input_tokens) - cacheReadTokens - cacheWriteTokens),
        outputTokens: finiteNonnegative(usage?.output_tokens), cacheReadTokens, cacheWriteTokens,
        rawUsage: usage, usageMissing: !usage,
    };
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
