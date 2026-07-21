import { AsyncLocalStorage } from 'node:async_hooks';

import { Database } from 'sqlite3';
import { Message } from 'discord.js';
import moment from 'moment';

import { insertQuery } from './Database.js';

export interface TokenSpendContext {
    userId: string;
    channelId: string;
    guildId: string | null;
    command: string;
}

/* Token counts for a single AI API call. `inputTokens` must EXCLUDE cached
 * tokens - providers that report cached tokens as part of their input count
 * (OpenAI, Gemini, xAI) should subtract them before recording. */
export interface TokenSpendUsage {
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    images?: number;
    webSearches?: number;
    /* Exact USD cost reported by the provider. Takes precedence over the
     * pricing table estimate when present. */
    costOverride?: number;
}

/* USD prices. Token prices are per million tokens, images and web searches
 * are priced per unit. Claude prices are current as of July 2026; the other
 * providers are estimates - update them when pricing changes. Models missing
 * from this table still have their tokens recorded, with a cost of 0. */
export interface ModelPricing {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    perImage?: number;
    perWebSearch?: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
    'claude-fable-5': {
        input: 10,
        output: 50,
        cacheRead: 1,
        cacheWrite: 12.5,
        perWebSearch: 0.01,
    },
    'gpt-5.5': {
        input: 1.25,
        output: 10,
        cacheRead: 0.125,
        /* image_generation tool output, medium quality estimate */
        perImage: 0.04,
    },
    'gpt-4o-transcribe': {
        input: 6,
        output: 10,
    },
    'grok-4.5': {
        input: 3,
        output: 15,
        cacheRead: 0.75,
    },
    'grok-imagine-image': {
        input: 0,
        output: 0,
        perImage: 0.07,
    },
    'gemini-3.5-flash': {
        input: 0.3,
        output: 2.5,
        cacheRead: 0.075,
    },
    'gemini-3-pro-image': {
        input: 2,
        output: 12,
        perImage: 0.12,
    },
};

const ONE_MILLION = 1_000_000;

const tokenSpendStorage = new AsyncLocalStorage<TokenSpendContext>();

let tokenSpendDb: Database | undefined;

export function initTokenSpend(db: Database): void {
    tokenSpendDb = db;
}

export async function runWithTokenSpendContext<T>(
    msg: Message,
    command: string,
    callback: () => Promise<T> | T,
): Promise<T> {
    const context: TokenSpendContext = {
        userId: msg.author.id,
        channelId: msg.channel.id,
        guildId: msg.guild?.id ?? null,
        command,
    };

    return tokenSpendStorage.run(context, async () => callback());
}

/* API responses report resolved model ids that may carry a version suffix,
 * e.g. 'grok-4.5-latest' or a dated snapshot. Match on the longest pricing
 * key the reported model starts with. */
export function resolveModelPricing(model: string): ModelPricing | undefined {
    let bestKey: string | undefined;

    for (const key of Object.keys(MODEL_PRICING)) {
        if (model.startsWith(key) && (!bestKey || key.length > bestKey.length)) {
            bestKey = key;
        }
    }

    return bestKey !== undefined
        ? MODEL_PRICING[bestKey]
        : undefined;
}

export function estimateTokenSpendCost(usage: TokenSpendUsage): number {
    if (usage.costOverride !== undefined) {
        return usage.costOverride;
    }

    const pricing = resolveModelPricing(usage.model);

    if (!pricing) {
        return 0;
    }

    const inputCost = (usage.inputTokens ?? 0) * pricing.input / ONE_MILLION;
    const outputCost = (usage.outputTokens ?? 0) * pricing.output / ONE_MILLION;
    const cacheReadCost = (usage.cacheReadTokens ?? 0) * (pricing.cacheRead ?? pricing.input) / ONE_MILLION;
    const cacheWriteCost = (usage.cacheWriteTokens ?? 0) * (pricing.cacheWrite ?? pricing.input) / ONE_MILLION;
    const imageCost = (usage.images ?? 0) * (pricing.perImage ?? 0);
    const webSearchCost = (usage.webSearches ?? 0) * (pricing.perWebSearch ?? 0);

    return inputCost + outputCost + cacheReadCost + cacheWriteCost + imageCost + webSearchCost;
}

/* Record the token usage of a single AI API call. Attribution (user, channel,
 * command) comes from the context set up when the command was dispatched.
 * Fire and forget - failures are logged, never thrown. */
export function recordTokenSpend(usage: TokenSpendUsage): void {
    const context = tokenSpendStorage.getStore();

    if (!context) {
        console.warn(`[TokenSpend] No command context for ${usage.model} usage, skipping record`);
        return;
    }

    if (!tokenSpendDb) {
        console.warn(`[TokenSpend] Database not initialized, skipping record`);
        return;
    }

    insertQuery(
        `INSERT INTO token_usage
            (user_id, channel_id, guild_id, command, model, input_tokens,
             output_tokens, cache_read_tokens, cache_write_tokens, images,
             cost, timestamp)
        VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        tokenSpendDb,
        [
            context.userId,
            context.channelId,
            context.guildId,
            context.command,
            usage.model,
            usage.inputTokens ?? 0,
            usage.outputTokens ?? 0,
            usage.cacheReadTokens ?? 0,
            usage.cacheWriteTokens ?? 0,
            usage.images ?? 0,
            estimateTokenSpendCost(usage),
            moment.utc().format('YYYY-MM-DD HH:mm:ss'),
        ],
    ).catch((err) => {
        console.warn(`[TokenSpend] Failed to record usage: ${(err as any).toString()}`);
    });
}
