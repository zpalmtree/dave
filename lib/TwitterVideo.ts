import fetch from 'node-fetch';
import type { SubmittedVideoSourceClip } from './VideoSourceClip.js';
import type { SubmittedVideoAttachmentSourceImage } from './VideoGeneration.js';

interface TwitterPostLink {
    id: string;
    mediaIndex?: number;
}

const POST_HOSTS = new Set([
    'twitter.com', 'www.twitter.com', 'mobile.twitter.com',
    'x.com', 'www.x.com', 'mobile.x.com',
    'fxtwitter.com', 'www.fxtwitter.com', 'd.fxtwitter.com', 'g.fxtwitter.com',
    'fixupx.com', 'www.fixupx.com', 'd.fixupx.com', 'g.fixupx.com',
    'vxtwitter.com', 'www.vxtwitter.com',
]);
const TEXT_URLS = /https?:\/\/[^\s<>"`]+/gi;

function twitterPostLink(value: string): TwitterPostLink | null {
    try {
        const url = new URL(value.replace(/[)\],.!?;:'\u2019]+$/, ''));
        if (!POST_HOSTS.has(url.hostname) || url.username || url.password || url.port) return null;
        const match = /^\/(?:[\w]+\/status|i\/web\/status|i\/status)\/(\d{2,20})(?:\/(?:(?:video|photo)\/)?([1-9]\d*))?\/?$/.exec(url.pathname);
        return match ? { id: match[1], ...(match[2] ? { mediaIndex: Number(match[2]) } : {}) } : null;
    } catch { return null; }
}

/** Keep post IDs and tracking parameters out of the video planner's prompt. */
export function stripTwitterPostLinks(text: string): string {
    return text.replace(TEXT_URLS, value => twitterPostLink(value)
        ? value.match(/[)\],.!?;:'\u2019]+$/)?.[0] || '' : value)
        .replace(/<>|\[([^\]]*)\]\(\)|\(\)/g, '$1').trim();
}

export function isTwitterVideoUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === 'video.twimg.com'
            && !url.port && !url.username && !url.password && /\.mp4$/i.test(url.pathname);
    } catch { return false; }
}

type MessageWithLinks = { content?: string; embeds?: ReadonlyArray<{ url?: string | null }> };

/** Resolve public post links without relying on Discord's embed preview. */
export async function twitterPostFromMessage(
    message: MessageWithLinks,
    fetcher: typeof fetch = fetch,
): Promise<TwitterPostSource | null> {
    const links = new Map<string, TwitterPostLink>();
    // Embeds can repeat or canonicalize a content URL; prefer explicit content.
    const contentLinks = (message.content || '').match(TEXT_URLS) || [];
    let candidates = contentLinks.map(twitterPostLink).filter((link): link is TwitterPostLink => Boolean(link));
    if (!candidates.length) {
        candidates = (message.embeds || []).map(embed => twitterPostLink(embed.url || ''))
            .filter((link): link is TwitterPostLink => Boolean(link));
    }
    for (const link of candidates) links.set(`${link.id}:${link.mediaIndex || ''}`, link);
    if (!links.size) return null;
    if (links.size > 1) throw new Error('Use exactly one Twitter/X post link for the source.');
    const link = [...links.values()][0];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let payload: any;
    try {
        const response = await fetcher(`https://api.fxtwitter.com/2/status/${link.id}`, {
            signal: controller.signal, redirect: 'error', size: 1024 * 1024,
            headers: { accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        payload = await response.json();
        if (payload?.code !== 200 || payload?.status?.type === 'tombstone') throw new Error('Post unavailable');
    } catch {
        throw new Error('Could not fetch that Twitter/X post. The post may be private, deleted, or temporarily unavailable. Try again or attach the media directly.');
    } finally {
        clearTimeout(timeout);
    }
    const text = typeof payload.status?.text === 'string' ? payload.status.text.slice(0, 8000) : '';
    const media = payload.status?.media;
    const photos = Array.isArray(media?.photos) ? media.photos : [];
    const videos = Array.isArray(media?.videos) ? media.videos : [];
    const all = Array.isArray(media?.all) ? media.all : [...photos, ...videos];
    const selected = link.mediaIndex ? all[link.mediaIndex - 1] : null;
    if (link.mediaIndex && !selected) throw new Error('No video or photo was found at that media index.');
    if (selected?.type === 'photo' || (!link.mediaIndex && photos.length && !videos.length)) {
        if (!selected && photos.length > 1) throw new Error('That post has multiple photos. Use a link ending in /photo/1 (or /photo/2, etc.) to select one.');
        const photo = selected || photos[0];
        if (typeof photo.url !== 'string' || !isTwitterImageUrl(photo.url)) {
            throw new Error('That Twitter/X post has no downloadable photo. Attach the image directly.');
        }
        const url = new URL(photo.url);
        const format = url.searchParams.get('format') || url.pathname.split('.').pop();
        const mime = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';
        return { text, clip: null, image: { url: photo.url, mime_type: mime, name: `twitter-${link.id}.${format}` } };
    }
    let video: any;
    if (link.mediaIndex) {
        video = selected;
        if (video?.type !== 'video' && video?.type !== 'gif') video = null;
    } else {
        if (videos.length > 1) throw new Error('That post has multiple videos. Use a link ending in /video/1 (or /video/2, etc.) to select one.');
        video = videos[0];
    }
    if (!video) return { text, image: null, clip: null };
    const formats = Array.isArray(video.formats) ? video.formats : [];
    const best = formats.filter((format: any) => typeof format?.url === 'string' && isTwitterVideoUrl(format.url))
        .sort((a: any, b: any) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0];
    const url = best?.url || video.url;
    if (typeof url !== 'string' || !isTwitterVideoUrl(url)) {
        throw new Error('That Twitter/X post has no downloadable MP4 video. Attach the video directly.');
    }
    return { text, image: null, clip: { clip_url: url, name: `twitter-${link.id}${link.mediaIndex ? `-${link.mediaIndex}` : ''}.mp4` } };
}

export interface TwitterPostSource {
    text: string;
    image: SubmittedVideoAttachmentSourceImage | null;
    clip: SubmittedVideoSourceClip | null;
}

/** Only actual post photos, never arbitrary hosts or profile images. */
export function isTwitterImageUrl(value: string): boolean {
    try {
        const url = new URL(value);
        const format = url.searchParams.get('format') || url.pathname.split('.').pop();
        return url.protocol === 'https:' && url.hostname === 'pbs.twimg.com'
            && !url.port && !url.username && !url.password
            && /^\/media\/[a-zA-Z0-9_-]+(?:\.(?:jpg|jpeg|png|webp))?$/.test(url.pathname)
            && ['jpg', 'jpeg', 'png', 'webp'].includes(format || '');
    } catch { return false; }
}

/** Strict video-only adapter for callers that explicitly require a clip. */
export async function twitterVideoFromMessage(
    message: MessageWithLinks,
    fetcher: typeof fetch = fetch,
): Promise<SubmittedVideoSourceClip | null> {
    const post = await twitterPostFromMessage(message, fetcher);
    if (!post) return null;
    if (!post.clip) throw new Error('No video was found in that Twitter/X post. Attach a video or use a post containing one.');
    return post.clip;
}
