import { existsSync } from 'fs';
import fetch, { RequestInit, Response } from 'node-fetch';
import { Client, Message } from 'discord.js';

import { formatDiscordDateAndRelative } from './DiscordTime.js';
import {
    VIDEO_MODELS,
    VIDEO_PROMPT_MAX_LENGTH,
    VIDEO_SOURCE_IMAGE_MAX_BYTES,
    VIDEO_SOURCE_IMAGE_MIME_TYPES,
    VideoJobView,
    VideoModelId,
    parsePauseDuration,
    sanitizeVideoWorkerText,
} from './VideoProtocol.js';
import { loadVideoSettings } from './VideoSettings.js';
import { config } from './Config.js';

interface BrokerState {
    worker_online: boolean;
    worker_busy: boolean;
    worker_id: string | null;
    current_job: string | null;
    paused_until: number | null;
    queued: number;
}

interface JobsResponse {
    jobs: VideoJobView[];
    state: BrokerState;
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
    return prompt.length <= length ? prompt : `${prompt.slice(0, length - 1)}…`;
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

export function completedVideoPost(job: VideoJobView): string {
    const runtime = formatVideoRuntime(job.runtime_seconds);
    return `${VIDEO_MODELS[job.model].displayName} video **${shortJobId(job.id)}** is ready${
        runtime ? ` — completed in **${runtime}**` : ''
    }.\n> ${truncatePrompt(job.prompt)}`;
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
    if (!referenced) return current;
    if (!current) return referenced;
    return `Context from the replied message:\n${referenced}\n\nCurrent instruction (takes priority):\n${current}`;
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
    return ` (${Math.round(Math.max(0, Math.min(1, value)) * 100)}%)`;
}

function pauseText(until: number | null): string {
    return until ? ` Video generation resumes ${formatDiscordDateAndRelative(until)}.` : '';
}

function sentence(value: string): string {
    return `${value.trim().replace(/[.!?]+$/, '')}.`;
}

export function formatVideoJob(job: VideoJobView): string {
    const name = VIDEO_MODELS[job.model].displayName;
    const head = `**${name} · ${shortJobId(job.id)}**${job.has_source_image ? ' · user start frame' : ''}`;
    if (job.status === 'queued') {
        const position = job.queue_position ? `Queue position: **${job.queue_position}**.` : 'Queued.';
        if (job.paused_until) return `${head}\n${position}${pauseText(job.paused_until)}`;
        if (!job.worker_online) return `${head}\n${position} Desktop worker is offline; ETA will appear after it reconnects.`;
        const timing = job.expected_start_at && job.expected_finish_at
            ? ` Expected start ${formatDiscordDateAndRelative(job.expected_start_at)}; expected finish ${formatDiscordDateAndRelative(job.expected_finish_at)}.`
            : '';
        return `${head}\n${position}${timing}`;
    }
    if (job.status === 'running_disconnected') {
        return `${head}\nThe desktop connection was lost during generation. The job is preserved and will resume or retry after reconnecting.`;
    }
    if (['leased', 'planning', 'running', 'uploading', 'pausing', 'cancelling'].includes(job.status)) {
        const stage = sanitizeVideoWorkerText(job.stage, job.status.replace('_', ' '));
        const timing = job.worker_online && !job.paused_until && job.expected_finish_at
            ? ` Expected finish ${formatDiscordDateAndRelative(job.expected_finish_at)}.`
            : '';
        return `${head}\n${sentence(`${stage}${percentage(job.progress)}`)}${timing}${pauseText(job.paused_until)}`;
    }
    if (job.status === 'ready') return `${head}\nGeneration complete; delivering the video…`;
    if (job.status === 'delivered') return `${head}\nDelivered.`;
    if (job.status === 'cancelled') return `${head}\nCancelled.`;
    return `${head}\nFailed: ${sanitizeVideoWorkerText(job.error, 'Unknown worker error.', 1800)}`;
}

class VideoGenerationService {
    private timer: NodeJS.Timeout | null = null;
    private polling = false;
    private readonly rendered = new Map<string, string>();

    constructor(private readonly client: Client) {}

    start(): void {
        if (this.timer) return;
        void this.poll();
        this.timer = setInterval(() => void this.poll(), 15_000);
    }

    async refresh(): Promise<void> {
        await this.poll();
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

    private async acknowledge(job: VideoJobView, endpoint: 'delivered' | 'notified'): Promise<void> {
        await brokerRequest(`/v1/jobs/${job.id}/${endpoint}`, { method: 'POST', body: '{}' });
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

    private async updateJob(job: VideoJobView): Promise<void> {
        const message = await this.statusMessage(job);
        if (!message) return;
        const content = `${formatVideoJob(job)}\n> ${truncatePrompt(job.prompt)}`;
        if (job.status === 'ready') {
            if (!job.result_path || !existsSync(job.result_path)) {
                console.warn(`[Video] Result is not readable for ${job.id}: ${job.result_path}`);
                return;
            }
            const delivery = await this.postDelivery(job, message);
            await message.edit({
                content: `**${VIDEO_MODELS[job.model].displayName} · ${shortJobId(job.id)}**\nDelivered in ${delivery.url}.`,
                attachments: [],
            });
            await this.acknowledge(job, 'delivered');
            this.rendered.delete(job.id);
            return;
        }
        if (this.rendered.get(job.id) !== content) {
            await message.edit({ content });
            this.rendered.set(job.id, content);
        }
        if (job.status === 'failed' || job.status === 'cancelled') {
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
            for (const job of response.jobs) {
                try {
                    await this.updateJob(job);
                } catch (error) {
                    console.warn(`[Video] Could not update ${job.id}: ${String(error)}`);
                }
            }
        } catch (error) {
            console.warn(`[Video] Broker poll failed: ${String(error)}`);
        } finally {
            this.polling = false;
        }
    }
}

const services = new Map<string, VideoGenerationService>();

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
        prompt = 'Animate the supplied starting image with coherent, natural motion that fits the visible scene.';
    }
    if (!prompt) {
        await msg.reply(`Usage: \`${config.prefix}${VIDEO_MODELS[model].command} <prompt>\` (or reply to a message containing a prompt or image).`);
        return;
    }
    if (prompt.length > VIDEO_PROMPT_MAX_LENGTH) {
        await msg.reply(`Video prompts are limited to ${VIDEO_PROMPT_MAX_LENGTH} characters.`);
        return;
    }
    if (!msg.client.user) throw new Error('Discord client is not ready.');
    startVideoGenerationService(msg.client);
    const speedLabel = model.endsWith('fast') || model.endsWith('draft')
        ? 'fast-preview'
        : 'maximum-quality';
    const pending = await msg.reply(`Submitting a ${speedLabel} ${VIDEO_MODELS[model].displayName} video…`);
    try {
        const response = await brokerRequest<{ job: VideoJobView }>(`/v1/jobs`, {
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
        await pending.edit({ content: `${formatVideoJob(response.job)}\n> ${truncatePrompt(prompt)}` });
        await services.get(msg.client.user.id)?.refresh();
    } catch (error) {
        await pending.edit(`Could not add the video job: ${error instanceof Error ? error.message : String(error)}`);
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

export async function handleMinimaxDraftVideo(msg: Message, prompt: string): Promise<void> {
    await handleVideoRequest('minimaxdraft', msg, prompt);
}

export async function handleVideoQueue(msg: Message, args: string): Promise<void> {
    const response = await brokerRequest<JobsResponse>(`/v1/users/${encodeURIComponent(msg.author.id)}/jobs`);
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
        await msg.reply(`You have no unfinished video jobs.${pauseText(response.state.paused_until)}`);
        return;
    }
    await msg.reply(unfinished.map(job => `${formatVideoJob(job)}\n> ${truncatePrompt(job.prompt, 100)}`).join('\n\n'));
}

export async function handleVideoAdmin(msg: Message, args: string): Promise<void> {
    const [action = 'status', value] = args.trim().split(/\s+/, 2);
    if (action.toLowerCase() === 'pause') {
        const seconds = parsePauseDuration(value);
        const result = await brokerRequest<{ paused_until: number }>('/v1/control/pause', {
            method: 'POST',
            body: JSON.stringify({ seconds, actor_id: msg.author.id }),
        });
        await msg.reply(`Video generation paused until ${formatDiscordDateAndRelative(result.paused_until)}. Any active render is being stopped and returned to the front of the queue.`);
        return;
    }
    if (action.toLowerCase() === 'resume') {
        await brokerRequest('/v1/control/resume', { method: 'POST', body: '{}' });
        await msg.reply('Video generation resumed.');
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
    await msg.reply(`Desktop worker: **${worker}**. Queued jobs: **${state.queued}**.${pauseText(state.paused_until)}`);
}
