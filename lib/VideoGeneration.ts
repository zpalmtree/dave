import { existsSync } from 'fs';
import fetch, { RequestInit, Response } from 'node-fetch';
import { Client, Message, PermissionFlagsBits } from 'discord.js';

import { formatDiscordDateAndRelative } from './DiscordTime.js';
import {
    VIDEO_IMAGE_ONLY_AUTO_PROMPT,
    VIDEO_MODELS,
    VIDEO_SOURCE_IMAGE_MAX_BYTES,
    VIDEO_SOURCE_IMAGE_MIME_TYPES,
    VideoJobView,
    VideoModelId,
    parsePauseDuration,
    sanitizeVideoWorkerText,
} from './VideoProtocol.js';
import { loadVideoSettings } from './VideoSettings.js';
import { config } from './Config.js';
import { recordExternalTokenSpend } from './TokenSpend.js';
import { VideoUsageEvent } from './VideoUsage.js';
import { classifyPromptTease } from './PromptTease.js';

interface BrokerState {
    worker_online: boolean;
    worker_busy: boolean;
    worker_id: string | null;
    current_job: string | null;
    paused_until: number | null;
    dispatch_paused?: boolean;
    preparation_busy?: boolean;
    active_jobs?: number;
    scheduler?: {
        mode?: 'normal' | 'draining' | 'enteringGaming' | 'gaming' | null;
        gaming_ready?: boolean;
    } | null;
    queued: number;
}

interface UsageEventsResponse {
    events: VideoUsageEvent[];
}

interface JobsResponse {
    jobs: VideoJobView[];
    state: BrokerState;
}

interface VideoStatsResponse {
    samples: number;
    models: Array<{
        model: VideoModelId;
        display_name: string;
        samples: number;
        total_seconds: { average: number | null; median: number | null };
        output_duration_average: number | null;
        seconds_per_output_second_average: number | null;
        segment_count_average: number | null;
        phases: Record<'planning' | 'first_frame' | 'generator' | 'compression' | 'upload' | 'discord_delivery', number | null>;
        gpu: {
            vram_peak_average_mb: number | null;
            utilization_average_percent: number | null;
            power_average_watts: number | null;
        };
        cold_starts: number;
        bottlenecks: Array<{
            source: string;
            name: string;
            average_seconds: number | null;
            samples: number;
        }>;
        latest_environment: {
            planner_model: string | null;
            keyframe_provider: string | null;
            keyframe_model: string | null;
        };
    }>;
}

class BrokerError extends Error {
    constructor(message: string, public readonly status: number) {
        super(message);
    }
}

function shortJobId(id: string): string {
    return id.slice(0, 8);
}

function truncatePrompt(prompt: string, length = 180): string {
    const safeLength = Math.max(0, Math.floor(length));
    if (prompt.length <= safeLength) return prompt;
    if (safeLength === 0) return '';
    if (safeLength === 1) return '…';
    return `${prompt.slice(0, safeLength - 1)}…`;
}

const DISCORD_MESSAGE_CONTENT_LIMIT = 1999;

function formatVideoReplyWithFullPrompt(
    prefix: string,
    job: VideoJobView,
    includePromptTease = false,
): string {
    const direction = videoJobDirection(job);
    const separator = '\n> ';
    const promptTease = includePromptTease
        ? sanitizeVideoWorkerText(job.prompt_tease, '', 120).trim()
        : '';
    const tease = promptTease ? `\n${promptTease}` : '';
    const availablePrefixLength = DISCORD_MESSAGE_CONTENT_LIMIT
        - separator.length
        - direction.length
        - tease.length;
    if (availablePrefixLength > 0) {
        return `${truncatePrompt(prefix, availablePrefixLength)}${tease}${separator}${direction}`;
    }

    // A replied-to Discord message can use the entire content allowance, leaving
    // no room for even the quote separator. Keep the useful status text in that
    // boundary case and trim the repeated prompt instead of exceeding the limit.
    const availableBodyLength = DISCORD_MESSAGE_CONTENT_LIMIT - separator.length - tease.length;
    const displayedPrefix = truncatePrompt(prefix, Math.max(0, availableBodyLength - 1));
    const displayedDirection = truncatePrompt(
        direction,
        Math.max(0, availableBodyLength - displayedPrefix.length),
    );
    return `${displayedPrefix}${tease}${separator}${displayedDirection}`;
}

const DEFAULT_SINGLE_VIDEO_RESPONDER_CHANNEL_ID = '483470443001413675';
const DEFAULT_SINGLE_VIDEO_RESPONDER_BOT_ID = '446154284514541579';

function singleResponderChannelId(): string {
    return process.env.VIDEO_SINGLE_RESPONDER_CHANNEL_ID
        || DEFAULT_SINGLE_VIDEO_RESPONDER_CHANNEL_ID;
}

function singleResponderBotId(): string {
    return process.env.VIDEO_SINGLE_RESPONDER_BOT_ID
        || DEFAULT_SINGLE_VIDEO_RESPONDER_BOT_ID;
}

export function singleVideoResponderGate(msg: Message): { canAccess: boolean; error?: string } {
    if (msg.channel.id !== singleResponderChannelId()) {
        return { canAccess: true };
    }
    return msg.client.user?.id === singleResponderBotId()
        ? { canAccess: true }
        : { canAccess: false };
}

export function canViewGlobalVideoQueue(msg: Message): boolean {
    if (msg.channel.id !== singleResponderChannelId()) return false;
    if (msg.author.id === config.god) return true;
    return Boolean(msg.member?.permissions.has(PermissionFlagsBits.ManageMessages));
}

export function formatVideoRuntime(seconds: number | null | undefined): string | null {
    if (!Number.isFinite(seconds) || Number(seconds) <= 0) return null;
    let remaining = Math.max(1, Math.round(Number(seconds)));
    const hours = Math.floor(remaining / 3600);
    remaining %= 3600;
    const minutes = Math.floor(remaining / 60);
    remaining %= 60;
    const parts: string[] = [];
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (remaining || parts.length === 0) parts.push(`${remaining}s`);
    return parts.join(' ');
}

function displayedVideoPrompt(prompt: string): string {
    const legacyPrefix = 'Context from the replied message:\n';
    const legacyMarker = '\n\nCurrent instruction (takes priority):\n';
    if (!prompt.startsWith(legacyPrefix)) return prompt;
    const instructionAt = prompt.lastIndexOf(legacyMarker);
    if (instructionAt < 0) return prompt;
    return prompt.slice(instructionAt + legacyMarker.length).trim() || prompt;
}

function videoModelDisplayName(model: unknown): string {
    return (VIDEO_MODELS as Record<string, { displayName: string }>)[String(model)]?.displayName
        || 'Retired video model';
}

export function videoJobDirection(job: Pick<VideoJobView, 'prompt' | 'planned_intent'>): string {
    if (job.prompt !== VIDEO_IMAGE_ONLY_AUTO_PROMPT) return displayedVideoPrompt(job.prompt);
    const intent = sanitizeVideoWorkerText(job.planned_intent, '', 1000).trim();
    return intent ? `Auto-direction: ${intent}` : 'Auto-directing the attached image.';
}

export function completedVideoPost(job: VideoJobView): string {
    const runtime = formatVideoRuntime(job.runtime_seconds);
    const notice = sanitizeVideoWorkerText(job.generation_notice, '', 1000).trim();
    const result = `${videoModelDisplayName(job.model)} video **${shortJobId(job.id)}** is ready${
        runtime ? ` — completed in **${runtime}**` : ''
    }.${notice ? `\n**Note:** ${notice}` : ''}`;
    return formatVideoReplyWithFullPrompt(result, job, true);
}

function videoFailureDetail(job: VideoJobView, maxLength: number): string {
    const error = sanitizeVideoWorkerText(job.error, 'Unknown worker error.', maxLength);
    const generic = /^(?:(?:generator|local planner) exited with code \d+|worker failure|unknown worker error)\.?$/i;
    if (!generic.test(error)) return error;
    const stage = sanitizeVideoWorkerText(job.stage, '', 500).trim().replace(/[.!]+$/, '');
    return stage ? `${error} Last reported stage: ${stage}.` : error;
}

export function failedVideoPost(job: VideoJobView): string {
    const error = videoFailureDetail(job, 1500);
    return formatVideoReplyWithFullPrompt(
        `${videoModelDisplayName(job.model)} video **${shortJobId(job.id)}** failed.\n${error}`,
        job,
    );
}

export interface SubmittedVideoSourceImage {
    url: string;
    mime_type: typeof VIDEO_SOURCE_IMAGE_MIME_TYPES[number];
    bytes: number;
    name: string;
}

function inferredImageMime(name: string | null | undefined): string | null {
    const extension = name?.split('.').pop()?.toLowerCase();
    if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
    if (extension === 'png') return 'image/png';
    if (extension === 'webp') return 'image/webp';
    if (extension === 'gif') return 'image/gif';
    return null;
}

export function videoSourceImageFromMessage(msg: Message): SubmittedVideoSourceImage | null {
    const candidates = [...msg.attachments.values()].filter(attachment => {
        const mime = attachment.contentType?.split(';')[0].toLowerCase();
        return Boolean(mime?.startsWith('image/') || inferredImageMime(attachment.name));
    });
    if (candidates.length > 1) {
        throw new Error('LTX and MiniMax accept one starting image. Attach exactly one image.');
    }
    if (!candidates.length) return null;
    const attachment = candidates[0];
    const mime = attachment.contentType?.split(';')[0].toLowerCase()
        || inferredImageMime(attachment.name);
    if (!VIDEO_SOURCE_IMAGE_MIME_TYPES.includes(mime as any)) {
        throw new Error('The starting image must be a PNG, JPEG, or WebP file.');
    }
    if (!attachment.size || attachment.size > VIDEO_SOURCE_IMAGE_MAX_BYTES) {
        throw new Error(`The starting image must be no larger than ${VIDEO_SOURCE_IMAGE_MAX_BYTES / 1024 / 1024} MiB.`);
    }
    return {
        url: attachment.url,
        mime_type: mime as SubmittedVideoSourceImage['mime_type'],
        bytes: attachment.size,
        name: attachment.name || 'start-frame',
    };
}

export function videoSourceImageFromMessages(
    commandMessage: Message,
    referencedMessage: Message | null,
): SubmittedVideoSourceImage | null {
    return videoSourceImageFromMessage(commandMessage)
        || (referencedMessage ? videoSourceImageFromMessage(referencedMessage) : null);
}

export function videoPromptFromMessages(commandPrompt: string, referencedMessage: Message | null): string {
    const current = commandPrompt.trim();
    const referenced = referencedMessage?.content?.trim() || '';
    return current || referenced;
}

async function fetchReferencedVideoMessage(msg: Message): Promise<Message | null> {
    const messageId = msg.reference?.messageId;
    if (!messageId || !('messages' in msg.channel)) return null;
    try {
        return await msg.channel.messages.fetch(messageId);
    } catch (error) {
        console.warn(`[Video] Could not fetch referenced message ${messageId}: ${String(error)}`);
        return null;
    }
}

function percentage(value: number | null): string {
    if (value === null) return '';
    return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function pauseText(until: number | null): string {
    return until ? ` Video generation resumes ${formatDiscordDateAndRelative(until)}.` : '';
}

function roughRuntimeRange(job: Pick<VideoJobView, 'estimate_low_seconds' | 'estimate_high_seconds'>): string {
    const low = formatVideoRuntime(job.estimate_low_seconds) || 'a few minutes';
    const high = formatVideoRuntime(job.estimate_high_seconds) || low;
    return low === high ? low : `${low}–${high}`;
}

function completionEstimate(job: VideoJobView, rough: boolean): string {
    if (job.expected_finish_at) {
        const label = rough ? 'Rough estimated completion' : 'Estimated completion';
        return ` ${label} ${formatDiscordDateAndRelative(job.expected_finish_at)}.`;
    }
    return ` Rough render ETA: **${roughRuntimeRange(job)}** after this job can start.`;
}

export function initialVideoRequestStatus(model: VideoModelId): string {
    const definition = VIDEO_MODELS[model];
    const fallback = roughRuntimeRange({
        estimate_low_seconds: definition.fallbackLowSeconds,
        estimate_high_seconds: definition.fallbackHighSeconds,
    });
    return `**Video request received.** Preparing ${definition.displayName}. Rough ETA: **${fallback}** plus any work already queued; checking the current position now.`;
}

export function formatVideoJob(job: VideoJobView): string {
    const name = videoModelDisplayName(job.model);
    const imageLabel = job.has_source_image
        ? (job.prompt === VIDEO_IMAGE_ONLY_AUTO_PROMPT ? ' · auto-directed image' : ' · user start frame')
        : '';
    const head = `**${name} · ${shortJobId(job.id)}**${imageLabel}`;
    if (job.status === 'queued') {
        const position = job.queue_position ? `Queue position: **${job.queue_position}**.` : 'Queued.';
        const timing = completionEstimate(job, true);
        if (job.paused_until) return `${head}\n**Accepted.** ${position}${timing}${pauseText(job.paused_until)}`;
        if (job.dispatch_paused) {
            return `${head}\n**Accepted.** ${position}${timing} Dispatch is temporarily paused, so this assumes dispatch resumes now.`;
        }
        if (!job.worker_online) {
            return `${head}\n**Accepted.** ${position}${timing} Desktop worker is offline, so this assumes it reconnects now.`;
        }
        const basis = job.estimate_ready
            ? ' GPU admission or new queue work can move it.'
            : ' This uses current queue depth and historical render times and will refine after planning.';
        return `${head}\n**Accepted.** ${position}${timing}${basis}`;
    }
    if (job.status === 'running_disconnected') {
        const timing = completionEstimate(job, true);
        return `${head}\nThe desktop connection was lost during generation. The job is preserved and will resume or retry after reconnecting.${timing} This assumes it reconnects now.`;
    }
    if (['leased', 'planning', 'running', 'uploading', 'pausing', 'cancelling'].includes(job.status)) {
        const rough = !job.estimate_ready || !job.worker_online || Boolean(job.paused_until)
            || job.gpu_queue_state === 'submitting' || job.gpu_queue_state === 'queued';
        const timing = completionEstimate(job, rough);
        if (job.gpu_queue_state === 'submitting') {
            return `${head}\n**Reserving this video's GPU queue position.**${timing} Planning and rendering will run under the same reservation; admission can move the estimate later.`;
        }
        if (job.gpu_queue_state === 'queued') {
            const position = job.gpu_queue_position && job.gpu_queue_position > 0
                ? ` GPU queue position: **${job.gpu_queue_position}**.`
                : '';
            const ahead = job.gpu_queue_jobs_ahead !== null && job.gpu_queue_jobs_ahead !== undefined
                ? ` **${job.gpu_queue_jobs_ahead}** job${job.gpu_queue_jobs_ahead === 1 ? '' : 's'} ahead.`
                : '';
            const basis = job.gpu_estimated_admission_low_at || job.gpu_estimated_admission_high_at
                ? ' The completion estimate includes the GPU work currently ahead; higher-priority submissions or external GPU pressure can still delay it.'
                : ' The GPU coordinator has not provided a work-ahead estimate yet, so this currently assumes admission now.';
            return `${head}\n**Waiting in the GPU queue.**${position}${ahead}${timing}${basis}`;
        }
        const progress = percentage(job.progress);
        const segment = job.segment_index && job.segment_count
            ? ` Segment **${job.segment_index}/${job.segment_count}**.`
            : '';
        const processing = progress
            ? `**Processing — roughly ${progress} complete.**${segment}`
            : '**Processing your video.**';
        return `${head}\n${processing}${timing}${pauseText(job.paused_until)}`;
    }
    if (job.status === 'ready') return `${head}\nGeneration complete; delivering the video…`;
    if (job.status === 'delivered') return `${head}\nDelivered.`;
    if (job.status === 'cancelled') return `${head}\nCancelled.`;
    return `${head}\nFailed: ${videoFailureDetail(job, 1800)}`;
}

export function formatVideoStatusPost(job: VideoJobView): string {
    return formatVideoReplyWithFullPrompt(formatVideoJob(job), job);
}

export function formatGlobalVideoQueueJob(
    job: VideoJobView,
    viewerGuildId: string | null,
    promptLength?: number,
    revealAllRequesters = false,
): string {
    const sameServer = viewerGuildId !== null && job.guild_id === viewerGuildId;
    const mayIdentifyRequester = sameServer || revealAllRequesters;
    const requester = mayIdentifyRequester && /^\d+$/.test(job.requester_id)
        ? `<@${job.requester_id}>`
        : mayIdentifyRequester ? 'unknown requester' : 'requester hidden';
    const direction = videoJobDirection(job).replace(/\s+/g, ' ').trim();
    const displayedDirection = promptLength === undefined
        ? direction
        : truncatePrompt(direction, promptLength);
    const position = job.queue_position ? `#${job.queue_position} · ` : '';
    let status: string;
    if (job.status === 'queued') {
        if (job.paused_until) status = `${position}Paused`;
        else if (!job.worker_online) status = `${position}Worker offline`;
        else status = `${position}Queued`;
    } else if (job.status === 'running_disconnected') {
        status = 'Reconnecting';
    } else if (job.gpu_queue_state === 'submitting') {
        status = 'Reserving GPU';
    } else if (job.gpu_queue_state === 'queued') {
        const gpuPosition = job.gpu_queue_position && job.gpu_queue_position > 0
            ? ` #${job.gpu_queue_position}`
            : '';
        const ahead = job.gpu_queue_jobs_ahead !== null && job.gpu_queue_jobs_ahead !== undefined
            ? ` · ${job.gpu_queue_jobs_ahead} ahead`
            : '';
        status = `GPU queue${gpuPosition}${ahead}`;
    } else if (job.status === 'planning') {
        status = 'Planning';
    } else if (job.status === 'uploading') {
        status = 'Uploading';
    } else if (job.status === 'pausing') {
        status = 'Pausing';
    } else if (job.status === 'cancelling') {
        status = 'Cancelling';
    } else if (['leased', 'running'].includes(job.status)) {
        const progress = percentage(job.progress);
        const segment = job.segment_index && job.segment_count
            ? ` · segment ${job.segment_index}/${job.segment_count}`
            : '';
        status = progress ? `Rendering · ${progress}${segment}` : `Rendering${segment}`;
    } else if (job.status === 'ready') {
        status = 'Delivering';
    } else if (job.status === 'delivered') {
        status = 'Delivered';
    } else if (job.status === 'cancelled') {
        status = 'Cancelled';
    } else {
        status = 'Failed';
    }
    const eta = job.expected_finish_at
        ? `ETA <t:${Math.floor(job.expected_finish_at)}:R>`
        : ['ready', 'delivered', 'cancelled', 'failed'].includes(job.status)
            ? ''
            : `ETA ${roughRuntimeRange(job)} after start`;
    return `**${status}** · ${requester}${eta ? ` · ${eta}` : ''}\n> ${displayedDirection}`;
}

export function globalVideoQueueChunks(
    jobs: VideoJobView[],
    viewerGuildId: string | null,
    limit = 3900,
    revealAllRequesters = false,
): string[] {
    if (!jobs.length) return ['The server video queue is empty.'];
    const chunks: string[] = [];
    let current = '';
    for (const job of jobs) {
        let block = formatGlobalVideoQueueJob(job, viewerGuildId, undefined, revealAllRequesters);
        if (current && `${current}\n\n${block}`.length > limit) {
            chunks.push(current);
            current = '';
        }
        if (block.length > limit) {
            const withoutPrompt = formatGlobalVideoQueueJob(job, viewerGuildId, 1, revealAllRequesters);
            const availablePromptLength = Math.max(
                1,
                limit - withoutPrompt.length + 1,
            );
            block = formatGlobalVideoQueueJob(
                job,
                viewerGuildId,
                availablePromptLength,
                revealAllRequesters,
            );
        }
        current += `${current ? '\n\n' : ''}${block}`;
    }
    if (current) chunks.push(current);
    return chunks;
}

export function globalVideoQueueEmbeds(
    jobs: VideoJobView[],
    viewerGuildId: string | null,
    limit = 3900,
    revealAllRequesters = false,
    dispatchPaused = false,
): Array<{ title: string; description: string; color: number; footer?: { text: string } }> {
    if (!jobs.length) return [];
    const chunks = globalVideoQueueChunks(jobs, viewerGuildId, limit, revealAllRequesters);
    const title = `Video queue · ${jobs.length} job${jobs.length === 1 ? '' : 's'}`;
    return chunks.map((description, index) => ({
        title: `${title}${index ? ' · continued' : ''}`,
        description,
        color: 0x5865F2,
        ...(dispatchPaused ? { footer: { text: 'Dispatch paused' } } : {}),
    }));
}

class VideoGenerationService {
    private timer: NodeJS.Timeout | null = null;
    private polling = false;
    private nextPollMs = 15_000;
    private readonly rendered = new Map<string, string>();

    constructor(private readonly client: Client) {}

    start(): void {
        if (this.timer) return;
        this.timer = setTimeout(() => void this.tick(), 0);
    }

    async refresh(): Promise<void> {
        await this.poll();
    }

    private async tick(): Promise<void> {
        this.timer = null;
        await this.poll();
        if (!this.timer) this.timer = setTimeout(() => void this.tick(), this.nextPollMs);
    }

    private async statusMessage(job: VideoJobView): Promise<any | null> {
        try {
            const channel = await this.client.channels.fetch(job.channel_id);
            if (!channel || !channel.isTextBased() || !('messages' in channel)) return null;
            return await (channel as any).messages.fetch(job.status_message_id);
        } catch (error) {
            console.warn(`[Video] Could not fetch status message for ${job.id}: ${String(error)}`);
            return null;
        }
    }

    private async acknowledge(
        job: VideoJobView,
        endpoint: 'delivered' | 'notified',
        durationSeconds?: number,
    ): Promise<void> {
        await brokerRequest(`/v1/jobs/${job.id}/${endpoint}`, {
            method: 'POST',
            body: JSON.stringify(durationSeconds === undefined ? {} : { duration_seconds: durationSeconds }),
        });
    }

    private async existingDelivery(job: VideoJobView, channel: any): Promise<any | null> {
        try {
            const recent = await channel.messages.fetch({ limit: 100 });
            const marker = `video **${shortJobId(job.id)}** is ready`;
            return recent.find((candidate: any) => candidate.id !== job.status_message_id
                && candidate.author?.id === this.client.user?.id
                && candidate.content?.includes(marker)) || null;
        } catch (error) {
            console.warn(`[Video] Could not check for an existing delivery of ${job.id}: ${String(error)}`);
            return null;
        }
    }

    private async existingFailure(job: VideoJobView, channel: any): Promise<any | null> {
        try {
            const recent = await channel.messages.fetch({ limit: 100 });
            const marker = `video **${shortJobId(job.id)}** failed`;
            return recent.find((candidate: any) => candidate.id !== job.status_message_id
                && candidate.author?.id === this.client.user?.id
                && candidate.content?.includes(marker)) || null;
        } catch (error) {
            console.warn(`[Video] Could not check for an existing failure notice for ${job.id}: ${String(error)}`);
            return null;
        }
    }

    private async postDelivery(job: VideoJobView, statusMessage: any): Promise<any> {
        const channel = statusMessage.channel;
        const payload = {
            content: completedVideoPost(job),
            files: [{ attachment: job.result_path, name: `${job.model}-${shortJobId(job.id)}.mp4` }],
            allowedMentions: { repliedUser: true },
        };
        const existing = await this.existingDelivery(job, channel);
        if (existing) return existing;
        try {
            const commandMessage = await channel.messages.fetch(job.command_message_id);
            return await commandMessage.reply(payload);
        } catch (error) {
            console.warn(`[Video] Could not reply to original command for ${job.id}; posting in channel: ${String(error)}`);
            return channel.send(payload);
        }
    }

    private async postFailure(job: VideoJobView, statusMessage: any): Promise<any> {
        const channel = statusMessage.channel;
        const payload = {
            content: failedVideoPost(job),
            allowedMentions: { repliedUser: true },
        };
        const existing = await this.existingFailure(job, channel);
        if (existing) return existing;
        try {
            const commandMessage = await channel.messages.fetch(job.command_message_id);
            return await commandMessage.reply(payload);
        } catch (error) {
            console.warn(`[Video] Could not reply with failure for ${job.id}; posting in channel: ${String(error)}`);
            return channel.send(payload);
        }
    }

    private async updateJob(job: VideoJobView): Promise<void> {
        const message = await this.statusMessage(job);
        if (!message) return;
        const content = formatVideoStatusPost(job);
        if (job.status === 'ready') {
            if (!job.result_path || !existsSync(job.result_path)) {
                console.warn(`[Video] Result is not readable for ${job.id}: ${job.result_path}`);
                return;
            }
            const deliveryStarted = Date.now();
            const delivery = await this.postDelivery(job, message);
            const deliverySeconds = (Date.now() - deliveryStarted) / 1000;
            await message.edit({
                content: `**${videoModelDisplayName(job.model)} · ${shortJobId(job.id)}**\nDelivered in ${delivery.url}.`,
                attachments: [],
            });
            await this.acknowledge(job, 'delivered', deliverySeconds);
            this.rendered.delete(job.id);
            return;
        }
        if (job.status === 'failed') {
            const failure = await this.postFailure(job, message);
            await message.edit({
                content: `**${videoModelDisplayName(job.model)} · ${shortJobId(job.id)}**\nFailed. See ${failure.url}.`,
                attachments: [],
            });
            await this.acknowledge(job, 'notified');
            this.rendered.delete(job.id);
            return;
        }
        if (this.rendered.get(job.id) !== content) {
            await message.edit({ content });
            this.rendered.set(job.id, content);
        }
        if (job.status === 'cancelled') {
            await this.acknowledge(job, 'notified');
            this.rendered.delete(job.id);
        }
    }

    private async poll(): Promise<void> {
        if (this.polling || !this.client.user) return;
        const settings = loadVideoSettings();
        if (!settings.botToken) return;
        this.polling = true;
        try {
            const response = await brokerRequest<JobsResponse>(
                `/v1/bots/${encodeURIComponent(this.client.user.id)}/jobs`,
            );
            this.nextPollMs = videoPollDelayMs(response.jobs, response.state);
            for (const job of response.jobs) {
                try {
                    await this.updateJob(job);
                } catch (error) {
                    console.warn(`[Video] Could not update ${job.id}: ${String(error)}`);
                }
            }
            void syncVideoUsageForBot(this.client.user.id);
        } catch (error) {
            console.warn(`[Video] Broker poll failed: ${String(error)}`);
        } finally {
            this.polling = false;
        }
    }
}

export function videoPollDelayMs(jobs: VideoJobView[], state: BrokerState): number {
    const active = jobs.length > 0
        || state.queued > 0
        || Boolean(state.active_jobs)
        || state.worker_busy
        || Boolean(state.preparation_busy);
    return active ? 3_000 : 15_000;
}

const services = new Map<string, VideoGenerationService>();
const usageSyncs = new Map<string, Promise<void>>();

export async function syncVideoUsageForBot(botId: string): Promise<void> {
    const active = usageSyncs.get(botId);
    if (active) return active;
    const syncing = (async () => {
        try {
            while (true) {
                const response = await brokerRequest<UsageEventsResponse>(
                    `/v1/bots/${encodeURIComponent(botId)}/usage-events?limit=100`,
                );
                if (!response.events.length) return;
                const imported: string[] = [];
                for (const event of response.events) {
                    try {
                        await recordExternalTokenSpend({
                            userId: event.user_id,
                            channelId: event.channel_id,
                            guildId: event.guild_id,
                            command: event.command,
                        }, {
                            model: event.model,
                            inputTokens: event.input_tokens,
                            outputTokens: event.output_tokens,
                            cacheReadTokens: event.cache_read_tokens,
                            cacheWriteTokens: event.cache_write_tokens,
                            images: event.images,
                            webSearches: event.web_searches,
                            costOverride: event.cost,
                        }, {
                            eventId: event.event_id,
                            sourceJobId: event.job_id,
                            stage: event.stage,
                            attempt: event.attempt,
                            serviceTier: event.service_tier,
                            outcome: event.outcome,
                        });
                        imported.push(event.event_id);
                    } catch (error) {
                        console.warn(`[Video] Could not import usage event ${event.event_id}: ${String(error)}`);
                        break;
                    }
                }
                if (!imported.length) return;
                await brokerRequest(`/v1/bots/${encodeURIComponent(botId)}/usage-events/ack`, {
                    method: 'POST',
                    body: JSON.stringify({ event_ids: imported }),
                });
                if (response.events.length < 100 || imported.length < response.events.length) return;
            }
        } catch (error) {
            console.warn(`[Video] Usage sync failed for bot ${botId}: ${String(error)}`);
        }
    })();
    usageSyncs.set(botId, syncing);
    try {
        await syncing;
    } finally {
        if (usageSyncs.get(botId) === syncing) usageSyncs.delete(botId);
    }
}

export function startVideoGenerationService(client: Client): void {
    if (!client.user) return;
    let service = services.get(client.user.id);
    if (!service) {
        service = new VideoGenerationService(client);
        services.set(client.user.id, service);
    }
    service.start();
}

async function brokerRequest<T = any>(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<T> {
    const settings = loadVideoSettings();
    if (!settings.botToken) throw new BrokerError('Video generation is not configured on this bot.', 503);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
        response = await fetch(`${settings.brokerUrl}${path}`, {
            ...init,
            signal: controller.signal,
            headers: {
                authorization: `Bearer ${settings.botToken}`,
                'content-type': 'application/json',
                ...(init.headers || {}),
            },
        });
    } catch (error) {
        throw new BrokerError(`Video queue service is unavailable: ${String(error)}`, 503);
    } finally {
        clearTimeout(timeout);
    }
    const text = await response.text();
    let body: any = {};
    try {
        body = text ? JSON.parse(text) : {};
    } catch {
        body = { error: text || `HTTP ${response.status}` };
    }
    if (!response.ok) throw new BrokerError(body.error || `Video broker returned HTTP ${response.status}.`, response.status);
    return body as T;
}

export function discordOnlyGate(msg: Message): { canAccess: boolean; error?: string } {
    return (msg as any).platform === 'uproar'
        ? { canAccess: false, error: 'Local video generation is available on Discord only.' }
        : { canAccess: true };
}

export function ownerOnlyVideoGate(msg: Message): { canAccess: boolean; error?: string } {
    return msg.author.id === config.god
        ? { canAccess: true }
        : { canAccess: false, error: 'Only the bot owner can control the video worker.' };
}

export async function handleVideoRequest(model: VideoModelId, msg: Message, prompt: string): Promise<void> {
    const referencedMessage = await fetchReferencedVideoMessage(msg);
    let sourceImage: SubmittedVideoSourceImage | null;
    try {
        sourceImage = videoSourceImageFromMessages(msg, referencedMessage);
    } catch (error) {
        await msg.reply(error instanceof Error ? error.message : String(error));
        return;
    }
    prompt = videoPromptFromMessages(prompt, referencedMessage);
    if (!prompt && sourceImage) {
        prompt = VIDEO_IMAGE_ONLY_AUTO_PROMPT;
    }
    if (!prompt) {
        await msg.reply(`Usage: \`${config.prefix}${VIDEO_MODELS[model].command} <prompt>\` (or reply to a message containing a prompt or image).`);
        return;
    }
    if (!msg.client.user) throw new Error('Discord client is not ready.');
    startVideoGenerationService(msg.client);
    const promptTease = classifyPromptTease(prompt);
    const pending = await msg.reply(initialVideoRequestStatus(model));
    let response: { job: VideoJobView };
    try {
        response = await brokerRequest<{ job: VideoJobView }>(`/v1/jobs`, {
            method: 'POST',
            body: JSON.stringify({
                model,
                prompt,
                requester_id: msg.author.id,
                origin_bot_id: msg.client.user.id,
                channel_id: msg.channel.id,
                guild_id: msg.guild?.id || null,
                command_message_id: msg.id,
                status_message_id: pending.id,
                source_image: sourceImage,
            }),
        }, 45_000);
    } catch (error) {
        await pending.edit(`Could not add the video job: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }

    let job = response.job;
    try {
        await pending.edit({ content: formatVideoStatusPost(job) });
        const tease = await promptTease;
        if (tease) {
            try {
                const updated = await brokerRequest<{ job: VideoJobView }>(
                    `/v1/jobs/${job.id}/prompt-tease`,
                    { method: 'POST', body: JSON.stringify({ prompt_tease: tease }) },
                );
                job = updated.job;
                await pending.edit({ content: formatVideoStatusPost(job) });
            } catch (error) {
                console.warn(`[Video] Could not attach prompt tease to ${job.id}: ${String(error)}`);
            }
        }
        try {
            const prepared = await brokerRequest<{ job: VideoJobView }>(
                `/v1/jobs/${job.id}/prepare`,
                { method: 'POST', body: '{}' },
                5 * 60 * 1000,
            );
            job = prepared.job;
        } catch (error) {
            console.warn(`[Video] Could not prepare the first ETA for ${job.id}: ${String(error)}`);
        }
        await pending.edit({ content: formatVideoStatusPost(job) });
        await services.get(msg.client.user.id)?.refresh();
    } catch (error) {
        console.warn(`[Video] Job ${job.id} was added, but its Discord status could not be updated: ${String(error)}`);
    }
}

export async function handleLtxVideo(msg: Message, prompt: string): Promise<void> {
    await handleVideoRequest('ltx', msg, prompt);
}

export async function handleMinimaxVideo(msg: Message, prompt: string): Promise<void> {
    await handleVideoRequest('minimax', msg, prompt);
}

export async function handleLtxFastVideo(msg: Message, prompt: string): Promise<void> {
    await handleVideoRequest('ltxfast', msg, prompt);
}

export async function handleMinimaxFastVideo(msg: Message, prompt: string): Promise<void> {
    await handleVideoRequest('minimaxfast', msg, prompt);
}

export async function handleVideoQueue(msg: Message, args: string): Promise<void> {
    const guildId = msg.guild?.id || '';
    const showGlobalQueue = canViewGlobalVideoQueue(msg);
    const queueScope = showGlobalQueue
        ? ''
        : `?guild_id=${encodeURIComponent(guildId)}`;
    const response = await brokerRequest<JobsResponse>(
        `/v1/queue${queueScope}`,
    );
    const [action, requestedId] = args.trim().split(/\s+/, 2);
    if (action?.toLowerCase() === 'cancel') {
        if (!requestedId) {
            await msg.reply(`Usage: \`${config.prefix}videoqueue cancel <job-id>\``);
            return;
        }
        const matches = response.jobs.filter(job => job.id.toLowerCase().startsWith(requestedId.toLowerCase()));
        if (matches.length !== 1) {
            await msg.reply(matches.length ? 'That job prefix is ambiguous.' : 'No matching recent video job was found.');
            return;
        }
        const result = await brokerRequest<{ ok: boolean; error?: string }>(`/v1/jobs/${matches[0].id}/cancel`, {
            method: 'POST',
            body: JSON.stringify({ requester_id: msg.author.id, is_admin: false }),
        });
        await msg.reply(result.ok ? `Cancellation requested for **${shortJobId(matches[0].id)}**.` : result.error || 'Could not cancel the job.');
        return;
    }
    const unfinished = response.jobs.filter(job => !['delivered', 'failed', 'cancelled'].includes(job.status));
    if (!unfinished.length) {
        await msg.reply(`The server video queue is empty.${pauseText(response.state.paused_until)}`);
        return;
    }
    const embeds = globalVideoQueueEmbeds(
        unfinished,
        msg.guild?.id ?? null,
        3900,
        showGlobalQueue,
        Boolean(response.state.dispatch_paused),
    );
    await msg.reply({
        embeds: [embeds[0]],
        allowedMentions: { parse: [], repliedUser: false },
    });
    for (const embed of embeds.slice(1)) {
        await msg.reply({
            embeds: [embed],
            allowedMentions: { parse: [], repliedUser: false },
        });
    }
}

export async function handleVideoAdmin(msg: Message, args: string): Promise<void> {
    const [action = 'status', value] = args.trim().split(/\s+/, 2);
    if (action.toLowerCase() === 'pause') {
        const seconds = parsePauseDuration(value);
        const result = await brokerRequest<{ paused_until: number }>('/v1/control/pause', {
            method: 'POST',
            body: JSON.stringify({ seconds, actor_id: msg.author.id }),
        });
        await msg.reply(`Video generation paused until ${formatDiscordDateAndRelative(result.paused_until)}. Any active render is being stopped and returned to the front of the queue, and GPUq Gaming Mode is being enabled for all managed GPU work. Use \`${config.prefix}videogen resume\` to release GPUq explicitly.`);
        return;
    }
    if (action.toLowerCase() === 'resume') {
        await brokerRequest('/v1/control/resume', { method: 'POST', body: '{}' });
        await msg.reply('Video generation resumed. GPUq Gaming Mode is being released explicitly.');
        return;
    }
    if (action.toLowerCase() === 'cancel') {
        if (!value) {
            await msg.reply(`Usage: \`${config.prefix}videogen cancel <job-id>\``);
            return;
        }
        const result = await brokerRequest<{ ok: boolean; error?: string }>(`/v1/jobs/${value}/cancel`, {
            method: 'POST',
            body: JSON.stringify({ requester_id: msg.author.id, is_admin: true }),
        });
        await msg.reply(result.ok ? `Cancellation requested for **${shortJobId(value)}**.` : result.error || 'Could not cancel the job.');
        return;
    }
    if (action.toLowerCase() !== 'status') {
        await msg.reply(`Usage: \`${config.prefix}videogen pause [6h]|resume|status|cancel <job-id>\``);
        return;
    }
    const state = await brokerRequest<BrokerState>('/v1/control');
    const worker = state.worker_online
        ? `online${state.worker_busy ? ' and rendering' : ' and idle'}`
        : 'offline';
    const gpuq = state.scheduler?.mode === 'gaming' || state.scheduler?.mode === 'enteringGaming'
        ? ` GPUq Gaming Mode is **${state.scheduler.gaming_ready ? 'ready' : 'being enabled'}**.`
        : '';
    await msg.reply(`Desktop worker: **${worker}**. Queued jobs: **${state.queued}**.${pauseText(state.paused_until)}${gpuq}`);
}

function metricDuration(value: number | null): string {
    return value === null ? '—' : formatVideoRuntime(value) || '—';
}

function metricNumber(value: number | null, suffix = ''): string {
    return value === null ? '—' : `${value.toFixed(1)}${suffix}`;
}

export async function handleVideoStats(msg: Message, args: string): Promise<void> {
    const requested = args.trim().toLowerCase() || 'all';
    if (requested !== 'all' && !Object.prototype.hasOwnProperty.call(VIDEO_MODELS, requested)) {
        await msg.reply(`Usage: \`${config.prefix}videostats [all|ltx|ltxfast|minimax|minimaxfast]\``);
        return;
    }
    const stats = await brokerRequest<VideoStatsResponse>(
        `/v1/stats?model=${encodeURIComponent(requested)}&limit=100`,
    );
    if (!stats.samples) {
        await msg.reply('No structured video performance samples have been recorded yet. The next completed render will populate this report.');
        return;
    }
    const blocks = stats.models.map(model => {
        const phases = model.phases;
        const bottlenecks = model.bottlenecks
            .filter(span => span.average_seconds !== null)
            .slice(0, 3)
            .map(span => `${span.name} ${metricDuration(span.average_seconds)}`)
            .join(', ') || '—';
        const peakVram = model.gpu.vram_peak_average_mb === null
            ? '—'
            : `${(model.gpu.vram_peak_average_mb / 1024).toFixed(1)} GiB`;
        return [
            `**${model.display_name}** · ${model.samples} sample${model.samples === 1 ? '' : 's'}`,
            `Total median **${metricDuration(model.total_seconds.median)}**, average ${metricDuration(model.total_seconds.average)} · ${metricNumber(model.seconds_per_output_second_average, 's')} per output second · ${metricNumber(model.output_duration_average, 's')} output`,
            `Pipeline avg: plan ${metricDuration(phases.planning)} · frame ${metricDuration(phases.first_frame)} · generator ${metricDuration(phases.generator)} · compress ${metricDuration(phases.compression)} · upload ${metricDuration(phases.upload)} · Discord ${metricDuration(phases.discord_delivery)}`,
            `Latest planner/frame: ${model.latest_environment.planner_model || '—'} · ${model.latest_environment.keyframe_provider || 'none'} / ${model.latest_environment.keyframe_model || 'none'}`,
            `GPU avg: peak VRAM ${peakVram} · utilization ${metricNumber(model.gpu.utilization_average_percent, '%')} · power ${metricNumber(model.gpu.power_average_watts, 'W')} · cold starts ${model.cold_starts}/${model.samples}`,
            `Largest spans: ${bottlenecks}`,
        ].join('\n');
    });
    const heading = `**Video performance · latest ${stats.samples} structured run${stats.samples === 1 ? '' : 's'}**`;
    const chunks: string[] = [];
    let current = heading;
    for (const block of blocks) {
        if (`${current}\n\n${block}`.length > 1900) {
            chunks.push(current);
            current = block;
        } else {
            current = `${current}\n\n${block}`;
        }
    }
    chunks.push(current);
    await msg.reply(chunks[0]);
    for (const chunk of chunks.slice(1)) await (msg.channel as any).send(chunk);
}
