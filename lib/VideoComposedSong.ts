import { requestPlannerResponse, VIDEO_PLANNER_PRIMARY_MODEL, VideoPlanSourceImage } from './VideoFrontierPlanner.js';
import { VideoFrontierCallOptions } from './VideoUsage.js';

/**
 * A multi-scene H3 video renders each scene with its own generated soundtrack, so a sung song
 * restarts at every cut. For a song request the desktop worker composes one song with the local
 * MiniMax Music 3 model first; the job then plans and renders exactly like an uploaded song.
 */
export interface VideoSongDecision {
    mode: 'none' | 'compose' | 'recording';
    reason: string;
    seconds: number;
    caption: string;
    lyrics: string;
    recording?: { title: string; artist: string; url: string };
}

export const VIDEO_COMPOSED_SONG_MIN_SECONDS = 15;
export const VIDEO_COMPOSED_SONG_MAX_SECONDS = 45;
const DEFAULT_SONG_SECONDS = 30;

// Words that can mean a sung song. Only these requests pay for a songwriter call, which decides.
const SONG_REQUEST = /\b(?:songs?|music[\s-]*videos?|mv|sing(?:s|ing|er)?|sung|rap(?:s|ping|per)?|ballads?|anthems?|lyrics?|jingles?|chorus|karaoke|duets?|serenades?|hymns?|lullab(?:y|ies)|cumbias?|corridos?|rancheras?|reggaeton|opera|canci[oó]n(?:es)?|cantar?|canta(?:ndo)?)\b/i;

export function mayWantComposedSong(prompt: string): boolean {
    return SONG_REQUEST.test(prompt) || /\b(?:lip[ -]?sync|dance\s+to|soundtrack)\b/i.test(prompt);
}

export function videoComposedSongEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
    return !['0', 'false', 'no', 'off'].includes(String(environment.VIDEO_COMPOSED_SONG ?? '1').trim().toLowerCase());
}

const SONG_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'reason', 'seconds', 'caption', 'lyrics', 'recording_title', 'recording_artist', 'recording_url'],
    properties: {
        mode: { type: 'string', enum: ['none', 'compose', 'recording'] },
        reason: { type: 'string' },
        seconds: { type: 'number' },
        caption: { type: 'string' },
        lyrics: { type: 'string' },
        recording_title: { type: 'string' },
        recording_artist: { type: 'string' },
        recording_url: { type: 'string' },
    },
} as const;

export const VIDEO_SONGWRITER_INSTRUCTIONS = `You are the songwriter for a short AI music video. A local music model (MiniMax Music 3) composes the song before anything is filmed. The video is then planned around the song and lip-synced to it, so the song is the whole soundtrack and its vocals are the only voice.

Decide mode. Choose compose when the request asks for a song, a music video, or someone singing or rapping a song. Choose none when the request is mainly speech, dialogue, or a skit whose characters talk; when it only wants background music or sound effects; or when singing would be a few words inside an otherwise spoken video. When mode is none, return seconds 0 and an empty caption and lyrics.

Choose recording when the request asks to sing, lip-sync, dance to, or use a specific EXISTING song or a supplied YouTube song link. Return its recording_title and recording_artist (infer the artist only when unambiguous, e.g. Electric Feel is MGMT). recording_url must be an actual YouTube URL present in the request, never an invented link. The desktop finds the recording and the broker selects the requested verse or chorus. Return empty caption and lyrics, and seconds 0; do not quote the song's lyrics or replace it with an inspired original. If an artist or version is ambiguous, leave recording_artist empty so the user can specify it or supply a link. The song's recorded voice is retained, not changed into the character's voice.

When composing, write an original song for the request. A request for a new song about a subject or in an artist's style uses compose; an existing song's name uses recording. For compose and none, all recording fields are empty. Follow the character guidance for who sings and how they sound, including accent, vocabulary and slang. The lyrics are what that character sings, so slang and catchphrases the guidance asks for belong in them. Keep the lyrics in the language mix the request and guidance imply.

seconds: the finished song length, about ${DEFAULT_SONG_SECONDS} unless the request asks for a length, between ${VIDEO_COMPOSED_SONG_MIN_SECONDS} and ${VIDEO_COMPOSED_SONG_MAX_SECONDS}.

lyrics: section tags on their own lines, each followed by its sung lines. Start with [Verse] so the vocal enters on the first bar; never begin with [Intro], which produces a long instrumental opening. Use [Verse], [Chorus], [Bridge] and [Outro]. Write about two short, singable lines per five seconds of song, with a hook that the chorus repeats. Tell a small story with a setup, an escalation and a payoff that a video can act out. Write only words to be sung: no stage directions, speaker names or parenthetical notes.

caption: three paragraphs, each starting with its label.
Global Metadata: genre and subgenre, BPM, key, mood and how it develops, then "A complete N-second song: the vocal enters on the first bar with no long intro, and it ends cleanly on a final hit." with N set to seconds.
Vocal Details: the singer's gender, age range, timbre, register, accent and delivery, matching the character who sings, plus any backing vocals.
Arrangement: the instruments and groove, what each section adds, and the clear final hit.

reason: one short sentence explaining the decision.`;

function songwriterInput(input: { prompt: string; plannerGuidance?: string; requestedDurationSeconds?: number | null;
    sources: VideoPlanSourceImage[] }): any[] {
    const text = [
        `Request: ${input.prompt}`,
        input.requestedDurationSeconds ? `Requested video length: ${input.requestedDurationSeconds} seconds.` : '',
        input.plannerGuidance ? `Character guidance:\n${input.plannerGuidance}` : '',
        input.sources.length ? 'The attached image shows who appears in the video.' : '',
    ].filter(Boolean).join('\n\n');
    return [{
        role: 'user',
        content: [
            { type: 'input_text', text },
            ...input.sources.map(source => ({
                type: 'input_image', detail: 'low',
                image_url: `data:${source.mimeType};base64,${source.data.toString('base64')}`,
            })),
        ],
    }];
}

/** Repairs and bounds a songwriter answer; a compose answer without usable lyrics becomes none. */
export function validatedVideoSongDecision(value: any, requestedDurationSeconds?: number | null): VideoSongDecision {
    const reason = String(value?.reason || '').trim().slice(0, 300);
    const none = (why = reason): VideoSongDecision => ({ mode: 'none', reason: why, seconds: 0, caption: '', lyrics: '' });
    if (value?.mode === 'recording') {
        const title = String(value.recording_title || '').trim().slice(0, 200);
        const artist = String(value.recording_artist || '').trim().slice(0, 200);
        const rawUrl = String(value.recording_url || '').trim();
        let url = '';
        if (rawUrl) {
            const parsed = new URL(rawUrl);
            const id = parsed.hostname === 'youtu.be' ? parsed.pathname.slice(1)
                : ['youtube.com', 'www.youtube.com', 'music.youtube.com'].includes(parsed.hostname)
                    && parsed.pathname === '/watch' ? parsed.searchParams.get('v') : null;
            if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !id || !/^[\w-]{11}$/.test(id)) {
                throw new Error('Use a YouTube song link or specify the song and artist.');
            }
            url = `https://www.youtube.com/watch?v=${id}`;
        }
        if (!url && (!title || !artist)) throw new Error('Please specify the song and artist, or attach the recording or a YouTube song link.');
        return { mode: 'recording', reason, seconds: 0, caption: '', lyrics: '', recording: { title, artist, url } };
    }
    if (value?.mode !== 'compose') return none();
    const caption = String(value.caption || '').trim().slice(0, 3000);
    // A leading intro section gives a long instrumental opening the singer has to stand through.
    const lyrics = String(value.lyrics || '').replace(/^\s*\[intro\][^\S\n]*\n(?:[^\S\n]*\n)*/i, '').trim().slice(0, 3000);
    const sung = lyrics.split('\n').filter(line => line.trim() && !/^\s*\[[^\]]+\]\s*$/.test(line));
    if (caption.length < 40 || !sung.length) return none('The songwriter returned no usable song.');
    const requested = Number(requestedDurationSeconds) || Number(value.seconds) || DEFAULT_SONG_SECONDS;
    const seconds = Math.round(Math.min(VIDEO_COMPOSED_SONG_MAX_SECONDS, Math.max(VIDEO_COMPOSED_SONG_MIN_SECONDS, requested)));
    return { mode: 'compose', reason, seconds, caption, lyrics };
}

/** Decides whether a request is a song and, if so, writes the song the worker composes. */
export async function writeVideoSong(
    input: { prompt: string; sources: VideoPlanSourceImage[]; requestedDurationSeconds?: number | null },
    options: VideoFrontierCallOptions,
): Promise<VideoSongDecision> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);
    try {
        const body = await requestPlannerResponse({
            model: options.plannerModel || VIDEO_PLANNER_PRIMARY_MODEL,
            reasoning: { effort: 'medium' },
            max_output_tokens: 12_000,
            instructions: VIDEO_SONGWRITER_INSTRUCTIONS,
            input: songwriterInput({ ...input, plannerGuidance: options.plannerGuidance }),
            text: { format: { type: 'json_schema', name: 'video_song', strict: true, schema: SONG_SCHEMA } },
        }, controller.signal, 'song_writing', options);
        const value = JSON.parse(String(body.output_text || ''));
        if (value.mode === 'recording' && value.recording_url && !input.prompt.includes(value.recording_url)) {
            throw new Error('The requested song link could not be verified. Attach the recording or provide its YouTube link.');
        }
        return validatedVideoSongDecision(value, input.requestedDurationSeconds);
    } finally {
        clearTimeout(timeout);
    }
}
