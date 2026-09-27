import fetch from 'node-fetch';
import type { SubmittedVideoSourceClip } from './VideoSourceClip.js';

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
        const match = /^\/(?:[\w]+\/status|i\/web\/status|i\/status)\/(\d{2,20})(?:\/(?:video\/)?([1-9]\d*))?\/?$/.exec(url.pathname);
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
export async function twitterVideoFromMessage(
    message: MessageWithLinks,
    fetcher: typeof fetch = fetch,
): Promise<SubmittedVideoSourceClip | null> {
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
    if (links.size > 1) throw new Error('Use exactly one Twitter/X post link for the source video.');
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
        throw new Error('Could not fetch that Twitter/X video. The post may be private, deleted, or temporarily unavailable. Try again or attach the video directly.');
    } finally {
        clearTimeout(timeout);
    }
    const media = payload.status?.media;
    const videos = Array.isArray(media?.videos) ? media.videos : [];
    let video: any;
    if (link.mediaIndex) {
        video = (Array.isArray(media?.all) ? media.all : videos)[link.mediaIndex - 1];
        if (video?.type !== 'video' && video?.type !== 'gif') video = null;
    } else {
        if (videos.length > 1) throw new Error('That post has multiple videos. Use a link ending in /video/1 (or /video/2, etc.) to select one.');
        video = videos[0];
    }
    if (!video) throw new Error('No video was found in that Twitter/X post. Attach a video or use a post containing one.');
    const formats = Array.isArray(video.formats) ? video.formats : [];
    const best = formats.filter((format: any) => typeof format?.url === 'string' && isTwitterVideoUrl(format.url))
        .sort((a: any, b: any) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0];
    const url = best?.url || video.url;
    if (typeof url !== 'string' || !isTwitterVideoUrl(url)) {
        throw new Error('That Twitter/X post has no downloadable MP4 video. Attach the video directly.');
    }
    return { clip_url: url, name: `twitter-${link.id}${link.mediaIndex ? `-${link.mediaIndex}` : ''}.mp4` };
}
