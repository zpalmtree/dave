import { existsSync } from 'fs';
import { AttachmentBuilder, Client, Message } from 'discord.js';

import { config } from './Config.js';
import { classifyPromptTease } from './PromptTease.js';
import {
    QWEN_IMAGE_ASPECTS,
    QWEN_IMAGE_MAX_REFERENCES,
    QWEN_IMAGE_MODELS,
    QwenImageAspect,
    QwenImageJobView,
    QwenImageModelId,
    VIDEO_SOURCE_IMAGE_MAX_BYTES,
    VIDEO_SOURCE_IMAGE_MIME_TYPES,
} from './VideoProtocol.js';
import { loadVideoSettings } from './VideoSettings.js';
import { brokerRequest, SubmittedVideoAttachmentSourceImage } from './VideoGeneration.js';

function inferredImageMime(name: string | null | undefined): string | null {
    const extension = name?.split('.').pop()?.toLowerCase();
    if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
    if (extension === 'png') return 'image/png';
    if (extension === 'webp') return 'image/webp';
    return null;
}

/**
 * Leading options, in any order: `--aspect 16:9` (or `--ar`) picks the canvas, otherwise the
 * worker chooses; `--fast` selects the 4-step Lightning edit.
 */
export function parseQwenImageArgs(args: string): { prompt: string; aspect?: QwenImageAspect; fast?: boolean } {
    let rest = args;
    let aspect: QwenImageAspect | undefined;
    let fast: boolean | undefined;
    for (;;) {
        const option = /^\s*--(?:(aspect|ar)[=\s]+(\S+)|(fast))(?=\s|$)\s*/i.exec(rest);
        if (!option) break;
        if (option[3]) {
            fast = true;
        } else {
            if (!QWEN_IMAGE_ASPECTS.includes(option[2] as QwenImageAspect)) {
                throw new Error(`Aspect must be one of ${QWEN_IMAGE_ASPECTS.join(', ')}.`);
            }
            aspect = option[2] as QwenImageAspect;
        }
        rest = rest.slice(option[0].length);
    }
    return { prompt: rest.trim(), ...(aspect ? { aspect } : {}), ...(fast ? { fast } : {}) };
}

type QwenImageSourceMessage = Pick<Message, 'attachments'> & Partial<Pick<Message, 'content' | 'embeds'>>;

const DISCORD_IMAGE_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];

function attachmentReferences(message: QwenImageSourceMessage): SubmittedVideoAttachmentSourceImage[] {
    const references: SubmittedVideoAttachmentSourceImage[] = [];
    for (const attachment of message.attachments.values()) {
        const mime = attachment.contentType?.split(';')[0].toLowerCase() || inferredImageMime(attachment.name);
        if (!mime?.startsWith('image/')) continue;
        if (!VIDEO_SOURCE_IMAGE_MIME_TYPES.includes(mime as any)) {
            throw new Error('Reference images must be PNG, JPEG, or WebP files.');
        }
        if (!attachment.size || attachment.size > VIDEO_SOURCE_IMAGE_MAX_BYTES) {
            throw new Error(`Reference images must be no larger than ${VIDEO_SOURCE_IMAGE_MAX_BYTES / 1024 / 1024} MiB.`);
        }
        references.push({
            url: attachment.url,
            mime_type: mime as SubmittedVideoAttachmentSourceImage['mime_type'],
            bytes: attachment.size,
            name: attachment.name || 'reference',
        });
    }
    return references;
}

/**
 * Discord CDN links in a message's text or unfurled previews, such as `$avatar` output. The broker
 * only downloads from Discord's CDN, so other hosts are ignored.
 */
export function qwenImageLinksFromMessage(message: QwenImageSourceMessage): string[] {
    const links = new Set<string>(message.content?.match(/https:\/\/[^\s<>]+/g) || []);
    for (const embed of message.embeds || []) {
        if (embed.image?.url) links.add(embed.image.url);
        // A bare image link unfurls as an `image` embed that carries the picture as its thumbnail.
        if (embed.data?.type === 'image' && embed.thumbnail?.url) links.add(embed.thumbnail.url);
    }
    return [...links].filter(link => {
        try {
            return DISCORD_IMAGE_HOSTS.includes(new URL(link).hostname);
        } catch {
            return false;
        }
    });
}

/** Animated avatars and icons link to a GIF; the CDN serves the same path as a static PNG. */
function staticDiscordImageUrl(link: string): string {
    const url = new URL(link);
    if (!url.pathname.startsWith('/attachments/') && url.pathname.toLowerCase().endsWith('.gif')) {
        url.pathname = url.pathname.slice(0, -'.gif'.length) + '.png';
    }
    return url.toString();
}

export type QwenImageLinkProbe = (url: string) => Promise<{ mime: string; bytes: number } | null>;

/** A HEAD request, since only the type and size are needed before the broker downloads it. */
async function probeImageLink(url: string): Promise<{ mime: string; bytes: number } | null> {
    try {
        const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
        if (!response.ok) return null;
        return {
            mime: String(response.headers.get('content-type') || '').split(';')[0].toLowerCase(),
            bytes: Number(response.headers.get('content-length') || 0),
        };
    } catch {
        return null;
    }
}

async function linkedReference(
    link: string,
    probe: QwenImageLinkProbe,
): Promise<SubmittedVideoAttachmentSourceImage | null> {
    const url = staticDiscordImageUrl(link);
    const found = await probe(url);
    if (!found?.mime.startsWith('image/')) return null;
    if (!VIDEO_SOURCE_IMAGE_MIME_TYPES.includes(found.mime as any)) {
        throw new Error('Reference images must be PNG, JPEG, or WebP files.');
    }
    if (!found.bytes || found.bytes > VIDEO_SOURCE_IMAGE_MAX_BYTES) {
        throw new Error(`Reference images must be no larger than ${VIDEO_SOURCE_IMAGE_MAX_BYTES / 1024 / 1024} MiB.`);
    }
    return {
        url,
        mime_type: found.mime as SubmittedVideoAttachmentSourceImage['mime_type'],
        bytes: found.bytes,
        name: new URL(url).pathname.split('/').pop() || 'reference',
    };
}

/**
 * Images on the command message, then on the replied-to message. A message without image
 * attachments contributes its linked Discord images instead; `links` lists the ones used, so
 * callers can keep those URLs out of the prompt.
 */
export async function qwenImageReferencesFromMessages(
    messages: Array<QwenImageSourceMessage | null | undefined>,
    probe: QwenImageLinkProbe = probeImageLink,
): Promise<{ references: SubmittedVideoAttachmentSourceImage[]; links: string[] }> {
    const references: SubmittedVideoAttachmentSourceImage[] = [];
    const links: string[] = [];
    for (const message of messages) {
        if (!message) continue;
        const attached = attachmentReferences(message);
        if (attached.length) {
            references.push(...attached);
            continue;
        }
        for (const link of qwenImageLinksFromMessage(message)) {
            if (references.length > QWEN_IMAGE_MAX_REFERENCES) break;
            const reference = await linkedReference(link, probe);
            if (!reference || references.some(existing => existing.url === reference.url)) continue;
            references.push(reference);
            links.push(link);
        }
    }
    if (references.length > QWEN_IMAGE_MAX_REFERENCES) {
        throw new Error(`Attach at most ${QWEN_IMAGE_MAX_REFERENCES} images.`);
    }
    return { references, links };
}

function withoutLinks(text: string, links: string[]): string {
    return links.reduce((rest, link) => rest.split(`<${link}>`).join('').split(link).join(''), text).trim();
}

export function formatQwenImageStatus(job: QwenImageJobView): string {
    const title = `**${QWEN_IMAGE_MODELS[job.model].displayName}${job.fast ? ' (fast)' : ''}**`;
    if (job.status === 'running') return `${title} · ${job.stage || 'Generating'}…`;
    if (job.status === 'failed') return `${title} · Failed: ${job.error || 'unknown error'}`;
    if (job.status !== 'queued') return `${title} · Done.`;
    if (!job.worker_online) return `${title} · Queued; the desktop worker is offline.`;
    const ahead = (job.queue_position || 1) - 1;
    const wait = job.video_rendering ? 'waiting for the current video render to finish' : 'starting shortly';
    return `${title} · Queued${ahead ? ` behind ${ahead} image${ahead === 1 ? '' : 's'}` : ''}; ${wait}.`;
}

class QwenImageService {
    private timer: NodeJS.Timeout | null = null;
    private polling = false;
    private readonly rendered = new Map<string, string>();

    constructor(private readonly client: Client) {}

    start(delayMs = 0): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.tick(), delayMs);
    }

    private async tick(): Promise<void> {
        this.timer = null;
        const active = await this.poll();
        if (!this.timer) this.timer = setTimeout(() => void this.tick(), active ? 3_000 : 30_000);
    }

    private async statusMessage(job: QwenImageJobView): Promise<Message | null> {
        try {
            const channel = await this.client.channels.fetch(job.channel_id);
            if (!channel || !channel.isTextBased() || !('messages' in channel)) return null;
            return await channel.messages.fetch(job.status_message_id);
        } catch {
            return null;
        }
    }

    private async deliver(job: QwenImageJobView, status: Message | null): Promise<void> {
        if (!job.result_path || !existsSync(job.result_path)) {
            console.warn(`[QwenImage] Result is not readable for ${job.id}: ${job.result_path}`);
            return;
        }
        const payload = {
            files: [new AttachmentBuilder(job.result_path, { name: `${job.model}-${job.id.slice(0, 8)}.png` })
                .setSpoiler(Boolean(job.prompt_tease))],
            ...(job.prompt_tease ? { content: job.prompt_tease } : {}),
            allowedMentions: { repliedUser: true },
        };
        try {
            const channel = await this.client.channels.fetch(job.channel_id);
            if (!channel || !channel.isTextBased() || !('messages' in channel)) return;
            try {
                await (await channel.messages.fetch(job.command_message_id)).reply(payload);
            } catch {
                if ('send' in channel) await channel.send(payload);
            }
        } catch (error) {
            console.warn(`[QwenImage] Could not deliver ${job.id}: ${String(error)}`);
            return;
        }
        await status?.delete().catch(() => undefined);
        await brokerRequest(`/v1/image-jobs/${job.id}/notified`, { method: 'POST', body: '{}' });
        this.rendered.delete(job.id);
    }

    private async update(job: QwenImageJobView): Promise<void> {
        const status = await this.statusMessage(job);
        if (job.status === 'ready') {
            await this.deliver(job, status);
            return;
        }
        const content = formatQwenImageStatus(job);
        if (status && this.rendered.get(job.id) !== content) {
            await status.edit({ content });
            this.rendered.set(job.id, content);
        }
        if (job.status === 'failed') {
            await brokerRequest(`/v1/image-jobs/${job.id}/notified`, { method: 'POST', body: '{}' });
            this.rendered.delete(job.id);
        }
    }

    /** Returns whether any of this bot's image jobs are still unfinished. */
    private async poll(): Promise<boolean> {
        if (this.polling || !this.client.user || !loadVideoSettings().botToken) return false;
        this.polling = true;
        try {
            const response = await brokerRequest<{ jobs: QwenImageJobView[] }>(
                `/v1/bots/${encodeURIComponent(this.client.user.id)}/image-jobs`,
            );
            for (const job of response.jobs) {
                try {
                    await this.update(job);
                } catch (error) {
                    console.warn(`[QwenImage] Could not update ${job.id}: ${String(error)}`);
                }
            }
            return response.jobs.length > 0;
        } catch (error) {
            console.warn(`[QwenImage] Broker poll failed: ${String(error)}`);
            return false;
        } finally {
            this.polling = false;
        }
    }
}

const services = new Map<string, QwenImageService>();

export function startQwenImageService(client: Client, delayMs = 0): void {
    if (!client.user) return;
    let service = services.get(client.user.id);
    if (!service) {
        service = new QwenImageService(client);
        services.set(client.user.id, service);
    }
    service.start(delayMs);
}

async function handleQwenImageRequest(msg: Message, args: string, model: QwenImageModelId): Promise<void> {
    const definition = QWEN_IMAGE_MODELS[model];
    let referenced: Message | null = null;
    if (msg.reference?.messageId) {
        try {
            referenced = await msg.channel.messages.fetch(msg.reference.messageId);
        } catch {
            referenced = null;
        }
    }
    let prompt: string;
    let aspect: QwenImageAspect | undefined;
    let fast: boolean | undefined;
    let references: SubmittedVideoAttachmentSourceImage[];
    let links: string[];
    try {
        ({ prompt, aspect, fast } = parseQwenImageArgs(args));
        if (fast && model !== 'qwenedit') throw new Error('`--fast` only applies to `$qwenedit`.');
        ({ references, links } = await qwenImageReferencesFromMessages([msg, referenced]));
    } catch (error) {
        await msg.reply(error instanceof Error ? error.message : String(error));
        return;
    }
    // A linked image is the reference, not part of the prompt.
    prompt = withoutLinks(prompt, links);
    const repliedText = withoutLinks(referenced?.content || '', links);
    const effectivePrompt = repliedText ? (prompt ? `${repliedText}\n${prompt}` : repliedText) : prompt;
    if (!effectivePrompt) {
        await msg.reply(`Please describe the image you want ${definition.displayName} to ${references.length ? 'make from the attachment' : 'create'}.`);
        return;
    }
    if (definition.requiresReference && !references.length) {
        await msg.reply('Attach or reply to an image to edit. Use `$qwenimage` to create one from text.');
        return;
    }
    const tease = await classifyPromptTease(effectivePrompt);
    const pending = await msg.reply(`**${definition.displayName}** · Queueing…`);
    try {
        const { job } = await brokerRequest<{ job: QwenImageJobView }>('/v1/image-jobs', {
            method: 'POST',
            body: JSON.stringify({
                model,
                prompt: effectivePrompt,
                aspect,
                fast,
                prompt_tease: tease || undefined,
                references,
                requester_id: msg.author.id,
                is_admin: msg.author.id === config.god,
                origin_bot_id: msg.client.user.id,
                channel_id: msg.channel.id,
                guild_id: msg.guild?.id || null,
                command_message_id: msg.id,
                status_message_id: pending.id,
            }),
        }, 60_000);
        await pending.edit(formatQwenImageStatus(job));
    } catch (error) {
        await pending.edit(`Could not queue the image: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }
    startQwenImageService(msg.client, 3_000);
}

export async function handleQwenImage(msg: Message, args: string): Promise<void> {
    await handleQwenImageRequest(msg, args, 'qwenimage');
}

export async function handleQwenEdit(msg: Message, args: string): Promise<void> {
    await handleQwenImageRequest(msg, args, 'qwenedit');
}
