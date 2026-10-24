import type { SubmittedVideoSourceClip } from './VideoSourceClip.js';

const VIDEO_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const TEXT_URLS = /https?:\/\/[^\s<>"`]+/gi;

function youtubeVideoId(value: string): string | null {
    try {
        const url = new URL(value.replace(/[)\],.!?;:'’]+$/, ''));
        if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
        const id = url.hostname === 'youtu.be' ? url.pathname.slice(1)
            : !VIDEO_HOSTS.has(url.hostname) ? ''
            : url.pathname === '/watch' ? url.searchParams.get('v') || ''
            : /^\/(?:shorts|live|embed)\/([\w-]+)\/?$/.exec(url.pathname)?.[1] || '';
        return /^[\w-]{11}$/.test(id) ? id : null;
    } catch { return null; }
}

/** The one form the broker and desktop accept: no playlists, timestamps or tracking parameters. */
export function isYoutubeVideoUrl(value: string): boolean {
    const id = youtubeVideoId(value);
    return Boolean(id) && value === `https://www.youtube.com/watch?v=${id}`;
}

type MessageWithLinks = { content?: string; embeds?: ReadonlyArray<{ url?: string | null }> };

/** A YouTube video or Short linked in a message, for the desktop to download as an edit's source. */
export function youtubeVideoFromMessage(message: MessageWithLinks): SubmittedVideoSourceClip | null {
    // Embeds can repeat or canonicalize a content URL; prefer explicit content.
    let ids = ((message.content || '').match(TEXT_URLS) || []).map(youtubeVideoId).filter(Boolean);
    if (!ids.length) ids = (message.embeds || []).map(embed => youtubeVideoId(embed.url || '')).filter(Boolean);
    const unique = [...new Set(ids)];
    if (!unique.length) return null;
    if (unique.length > 1) throw new Error('Use exactly one YouTube link for the source video.');
    return { clip_url: `https://www.youtube.com/watch?v=${unique[0]}`, name: `youtube-${unique[0]}.mp4` };
}
