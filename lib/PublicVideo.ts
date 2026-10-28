import { RequestInit, Response } from 'node-fetch';
import { fetchPublicMedia, publicMediaUrl, discardMediaResponse } from './PublicMedia.js';
import type { SubmittedVideoSourceClip } from './VideoSourceClip.js';
import { stripTwitterPostLinks } from './TwitterVideo.js';
import { youtubeVideoFromMessage } from './YoutubeVideo.js';

const URLS = /https?:\/\/[^\s<>"`]+/gi;
const EXTENSIONS = /\.(mp4|mov|m4v|webm|mkv|gif)$/i;
const MIME_EXTENSIONS: Record<string, string> = {
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
    'video/x-matroska': 'mkv', 'image/gif': 'gif', 'video/x-m4v': 'm4v',
};
type Message = { content?: string; embeds?: ReadonlyArray<{
    url?: string | null; video?: { url?: string | null } | null;
    image?: { url?: string | null } | null;
}> };
type Fetcher = (url: string, options?: RequestInit) => Promise<Response>;
const specializedLink = (value: string) => Boolean(youtubeVideoFromMessage({ content: value }))
    || !stripTwitterPostLinks(value).trim();
const clean = (value: string) => value.replace(/[)\],.!?;:'\u2019]+$/, '');

function clip(value: string, page?: string, mime?: string, videoEmbed = false): SubmittedVideoSourceClip | null {
    const url = publicMediaUrl(value);
    if (!url) return null;
    const extension = EXTENSIONS.exec(url.pathname)?.[1].toLowerCase() || MIME_EXTENSIONS[mime || ''] || (videoEmbed ? 'mp4' : '');
    if (!extension) return null;
    return { clip_url: url.toString(), name: `source.${extension}`, ...(page ? { source_page_url: page } : {}) };
}

/** General public pages and direct media, after specialized extractors have had a chance. */
export async function publicVideoFromMessage(message: Message, fetcher: Fetcher = fetchPublicMedia): Promise<SubmittedVideoSourceClip | null> {
    const values = (message.content || '').match(URLS)?.map(clean) || [];
    const links = [...new Set(values.filter(value => !specializedLink(value)))];
    const embeds = message.embeds || [];
    if (!links.length) {
        for (const embed of embeds) {
            const media = embed.video?.url || (embed.image?.url && EXTENSIONS.test(publicMediaUrl(embed.image.url)?.pathname || '') ? embed.image.url : null);
            if (media && !specializedLink(embed.url || media)) links.push(embed.url || media);
        }
    }
    const unique = [...new Set(links)];
    if (!unique.length) return null;
    if (unique.length > 1) throw new Error('Use exactly one video or GIF link for the source.');
    const page = publicMediaUrl(unique[0]);
    if (!page) throw new Error('Use a public HTTP or HTTPS video/GIF link.');
    for (const embed of embeds) {
        if (publicMediaUrl(embed.url || '')?.toString() !== page.toString() && embed.video?.url !== unique[0]) continue;
        const playable = clip(embed.video?.url || '', page.toString(), undefined, true)
            || clip(embed.image?.url || '', page.toString());
        if (playable) return playable;
    }
    const direct = clip(page.toString());
    if (direct) return direct;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
        const response = await fetcher(page.toString(), { signal: controller.signal, size: 3 * 1024 * 1024 });
        if (!response.ok) { discardMediaResponse(response); throw new Error(`Could not load that media page (HTTP ${response.status}).`); }
        const base = response.url || page.toString();
        const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        const media = clip(base, page.toString(), mime);
        if (media) { discardMediaResponse(response); return media; }
        if (mime && !['text/html', 'application/xhtml+xml'].includes(mime)) { discardMediaResponse(response); return null; }
        const html = await response.text();
        const candidates: string[] = [];
        const attributes = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)]
            .map(match => [match[1].toLowerCase(), match[3].replace(/&amp;|&#38;|&#x26;/gi, '&')]));
        for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
            const a = attributes(tag), property = (a.property || a.name || '').toLowerCase();
            if (['og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream'].includes(property) && a.content) candidates.push(a.content);
            if (property === 'og:image' && /\.gif(?:\?|$)/i.test(a.content || '')) candidates.push(a.content);
        }
        for (const block of html.match(/<video\b[\s\S]*?<\/video\s*>/gi) || []) {
            for (const tag of block.match(/<(?:video|source)\b[^>]*>/gi) || []) {
                const source = attributes(tag).src;
                if (source) candidates.push(source);
            }
        }
        for (const candidate of candidates) {
            let url: string;
            try { url = new URL(candidate, base).toString(); } catch { continue; }
            const found = clip(url, page.toString(), undefined, true);
            if (found) return found;
        }
        return null;
    } finally { clearTimeout(timer); }
}

export function stripResolvedVideoLinks(text: string, source?: { clip_url: string; source_page_url?: string } | null): string {
    if (!source) return text;
    const urls = [source.clip_url, source.source_page_url].filter(Boolean);
    return text.replace(URLS, value => urls.includes(publicMediaUrl(clean(value))?.toString())
        ? value.slice(clean(value).length) : value).replace(/<>/g, '').replace(/\[([^\]]*)\]\(\)|\(\)/g, '$1').trim();
}
