import fetch from 'node-fetch';
import type { SubmittedVideoSourceClip } from './VideoSourceClip.js';

const TEXT_URLS = /https?:\/\/[^\s<>"`]+/gi;
const MEDIA_HOSTS = new Set([
    'media.tenor.com', 'media1.tenor.com', 'c.tenor.com',
    'media.giphy.com', 'i.giphy.com',
    ...[0, 1, 2, 3, 4].map(index => `media${index}.giphy.com`),
]);

function safeUrl(value: string): URL | null {
    try {
        const url = new URL(value.replace(/[)\],.!?;:'\u2019]+$/, ''));
        return url.protocol === 'https:' && !url.port && !url.username && !url.password ? url : null;
    } catch { return null; }
}

/** Restrict downloads to media files on the providers' actual CDNs. */
export function isGifVideoUrl(value: string): boolean {
    const url = safeUrl(value);
    return Boolean(url && MEDIA_HOSTS.has(url.hostname) && /\.(?:gif|mp4|webm)$/i.test(url.pathname));
}

function gifPage(value: string): string | null {
    const url = safeUrl(value);
    if (!url) return null;
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'tenor.com' && /^\/view\/[\w-]+-\d+\/?$/.test(url.pathname)) {
        return `https://tenor.com${url.pathname.replace(/\/$/, '')}`;
    }
    if (host === 'giphy.com' && /^\/(?:gifs|stickers)\/[\w-]+\/?$/.test(url.pathname)) {
        return `https://giphy.com${url.pathname.replace(/\/$/, '')}`;
    }
    return null;
}

function clip(value: string): SubmittedVideoSourceClip | null {
    if (!isGifVideoUrl(value)) return null;
    const url = safeUrl(value)!;
    return { clip_url: url.toString(), name: url.pathname.split('/').pop()! };
}

export function stripGifVideoLinks(text: string): string {
    return text.replace(TEXT_URLS, value => gifPage(value) || isGifVideoUrl(value)
        ? value.match(/[)\],.!?;:'\u2019]+$/)?.[0] || '' : value)
        .replace(/<>/g, '').replace(/\[([^\]]*)\]\(\)|\(\)/g, '$1').trim();
}

type GifMessage = { content?: string; embeds?: ReadonlyArray<{
    url?: string | null;
    video?: { url?: string | null } | null;
    image?: { url?: string | null } | null;
}> };

/** Prefer Discord's playable embed; fetch public share-page metadata when it is absent. */
export async function gifVideoFromMessage(message: GifMessage, fetcher: typeof fetch = fetch): Promise<SubmittedVideoSourceClip | null> {
    const content = (message.content || '').match(TEXT_URLS) || [];
    const candidates = content.filter(value => gifPage(value) || isGifVideoUrl(value));
    const embeds = message.embeds || [];
    if (!candidates.length) {
        for (const embed of embeds) {
            const value = [embed.url, embed.video?.url, embed.image?.url]
                .find(value => value && (gifPage(value) || isGifVideoUrl(value)));
            if (value) candidates.push(value);
        }
    }
    const links = [...new Set(candidates.map(value => gifPage(value) || safeUrl(value)!.toString()))];
    if (!links.length) return null;
    if (links.length > 1) throw new Error('Use exactly one Tenor/Giphy GIF for the source.');
    const link = links[0];
    const direct = clip(link);
    if (direct) return direct;
    for (const embed of embeds) {
        if (gifPage(embed.url || '') !== link) continue;
        const media = clip(embed.video?.url || '') || clip(embed.image?.url || '');
        if (media) return media;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
        const response = await fetcher(link, { signal: controller.signal, redirect: 'error', size: 3 * 1024 * 1024 });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        const media: Array<{ property: string; source: SubmittedVideoSourceClip }> = [];
        for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
            const attributes: Record<string, string> = {};
            for (const match of tag.matchAll(/([\w:]+)\s*=\s*(["'])(.*?)\2/g)) {
                attributes[match[1].toLowerCase()] = match[3].replace(/&amp;|&#38;|&#x26;/gi, '&');
            }
            const property = attributes.property?.toLowerCase();
            if (!['og:video', 'og:video:secure_url', 'og:image'].includes(property)) continue;
            const source = clip(attributes.content || '');
            if (source) media.push({ property, source });
        }
        const result = media.find(value => value.property.startsWith('og:video')) || media[0];
        if (result) return result.source;
        throw new Error('No playable media');
    } catch {
        throw new Error('Could not load that Tenor/Giphy GIF. Try again or upload the GIF directly.');
    } finally { clearTimeout(timeout); }
}
