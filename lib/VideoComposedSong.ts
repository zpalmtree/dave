import { requestPlannerResponse, VIDEO_PLANNER_PRIMARY_MODEL, VideoPlanSourceImage } from './VideoFrontierPlanner.js';
import { VideoFrontierCallOptions } from './VideoUsage.js';
import { youtubeVideoFromMessage } from './YoutubeVideo.js';

/**
 * A multi-scene H3 video renders each scene with its own generated soundtrack, so a sung song
 * restarts at every cut. For a song request the desktop worker composes one song with the local
 * MiniMax Music 3 model first; the job then plans and renders exactly like an uploaded song.
 * A dialogue-free music-driven edit gets an instrumental score the same way, so its music
 * carries across the cuts instead of restarting in every scene.
 */
export interface VideoSongDecision {
    mode: 'none' | 'compose' | 'recording' | 'score';
    reason: string;
    seconds: number;
    caption: string;
    lyrics: string;
    recording?: { title: string; artist: string; url: string };
}

export const VIDEO_COMPOSED_SONG_MIN_SECONDS = 15;
export const VIDEO_COMPOSED_SONG_MAX_SECONDS = 45;
const DEFAULT_SONG_SECONDS = 30;

// Candidate words only: the songwriter distinguishes music from nonmusical uses of "cover".
const SONG_REQUEST = /\b(?:covers?|covering|songs?|music[\s-]*videos?|mv|sing(?:s|ing|er)?|sung|rap(?:s|ping|per)?|ballads?|anthems?|lyrics?|jingles?|chorus|karaoke|duets?|serenades?|hymns?|lullab(?:y|ies)|cumbias?|corridos?|rancheras?|reggaeton|opera|canci[oó]n(?:es)?|cantar?|canta(?:ndo)?)\b/i;

// Words that can mean a dialogue-free edit carried by music, which gets an instrumental score.
const SCORE_REQUEST = /\b(?:(?:hype|phonk|fan|sports?|highlight|aura|velocity|beat)[\s-]*edits?|edits?|montages?|amv|phonk|instrumental|beat[\s-]*(?:drop|sync(?:ed)?)|(?:background|epic|hype)\s+music|trailer|highlight\s+reel|aura\s+farm(?:ing)?|danc(?:e|es|ing))\b/i;

export function mayWantComposedSong(prompt: string): boolean {
    return SONG_REQUEST.test(prompt) || SCORE_REQUEST.test(prompt) || /\b(?:lip[ -]?sync|dance\s+to|soundtrack)\b/i.test(prompt)
        || Boolean(youtubeVideoFromMessage({ content: prompt }));
}

/** Music3 has no instrumental switch; an instrumental tag in place of lyrics keeps it from singing. */
export const VIDEO_SCORE_LYRICS = '[Instrumental]';

export function videoComposedSongEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
    return !['0', 'false', 'no', 'off'].includes(String(environment.VIDEO_COMPOSED_SONG ?? '1').trim().toLowerCase());
}

const SONG_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'reason', 'seconds', 'caption', 'lyrics', 'recording_title', 'recording_artist', 'recording_url'],
    properties: {
        mode: { type: 'string', enum: ['none', 'compose', 'recording', 'score'] },
        reason: { type: 'string' },
        seconds: { type: 'number' },
        caption: { type: 'string' },
        lyrics: { type: 'string' },
        recording_title: { type: 'string' },
        recording_artist: { type: 'string' },
        recording_url: { type: 'string' },
    },
} as const;

export const VIDEO_SONGWRITER_INSTRUCTIONS = `You are the songwriter for a short AI music video. A local music model (MiniMax Music 3) composes the song before anything is filmed. The video is then planned around the song and lip-synced to it, so the song is the whole soundtrack and its vocals are the only voice. An instrumental score is likewise the whole soundtrack, and the video is cut to it.

Decide mode. Choose compose when the request asks for a song, a music video, or someone singing or rapping a song. Choose score when nobody in the video speaks or sings and music carries it: a hype edit, phonk or aura-farming edit, montage, dance, workout or sports highlight, trailer, or another sequence cut to a beat, including a request for background music under such a video. Each scene would otherwise generate its own music, so a score is one original instrumental track that keeps the same groove across every cut. A score replaces all of the video's sound, so choose none when anyone talks, when the request is a skit, dialogue, narration or reaction whose characters speak, when it wants only ambience or sound effects, or when singing would be a few words inside an otherwise spoken video. When mode is none, return seconds 0 and an empty caption and lyrics.

Choose recording when the request asks to sing, lip-sync, dance to, or use a specific EXISTING song or a supplied YouTube song link. Return its recording_title and recording_artist (infer the artist only when unambiguous, e.g. Electric Feel is MGMT). recording_url must be an actual YouTube URL present in the request, never an invented link. The desktop finds the recording and the broker selects the requested verse or chorus. Return empty caption and lyrics, and seconds 0; do not quote the song's lyrics or replace it with an inspired original. If an artist or version is ambiguous, leave recording_artist empty so the user can specify it or supply a link. The song's recorded voice is retained, not changed into the character's voice.

"Cover of this" with a YouTube link is a recording request even without the words song or sing. Use that link with empty title and artist when its identity is unknown: the desktop can inspect and download it. Never choose compose or none merely because you cannot open the link, and never substitute invented cover lyrics. Extra requested characters, props, or comic action do not remove the requested recording. Nonmusical uses of cover (a book cover, covering an object, taking cover), or a YouTube link used only as visual or discussion context, do not by themselves request a song.

For score, return empty lyrics and write only the caption: an instrumental in the genre and energy the request implies (for example aggressive drift phonk for an aura-farming or hype edit), with a strong steady beat and an arrangement that builds so cuts can land on its hits. Describe it for the whole video, not one scene.

When composing, write an original song for the request. A request for a new song about a subject or in an artist's style uses compose; an existing song's name uses recording. For compose, score and none, all recording fields are empty. Follow the character guidance for who sings and how they sound, including accent, vocabulary and slang. The lyrics are what that character sings, so slang and catchphrases the guidance asks for belong in them. Keep the lyrics in the language mix the request and guidance imply.

seconds: the finished song length, about ${DEFAULT_SONG_SECONDS} unless the request asks for a length, between ${VIDEO_COMPOSED_SONG_MIN_SECONDS} and ${VIDEO_COMPOSED_SONG_MAX_SECONDS}.

lyrics: section tags on their own lines, each followed by its sung lines. Start with [Verse] so the vocal enters on the first bar; never begin with [Intro], which produces a long instrumental opening. Use [Verse], [Chorus], [Bridge] and [Outro]. Write about two short, singable lines per five seconds of song, with a hook that the chorus repeats. Tell a small story with a setup, an escalation and a payoff that a video can act out. Write only words to be sung: no stage directions, speaker names or parenthetical notes.

caption: three paragraphs, each starting with its label.
Global Metadata: genre and subgenre, BPM, key, mood and how it develops, then "A complete N-second song: the vocal enters on the first bar with no long intro, and it ends cleanly on a final hit." with N set to seconds.
Vocal Details: the singer's gender, age range, timbre, register, accent and delivery, matching the character who sings, plus any backing vocals.
Arrangement: the instruments and groove, what each section adds, and the clear final hit.
For score, Global Metadata ends with "A complete N-second instrumental track with no vocals: the beat starts on the first bar with no long intro, and it ends cleanly on a final hit." instead, and Vocal Details is "None. Purely instrumental: no singing, rapping, spoken words or vocal chops."

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
    if (value?.mode !== 'compose' && value?.mode !== 'score') return none();
    const caption = String(value.caption || '').trim().slice(0, 3000);
    const requested = Number(requestedDurationSeconds) || Number(value.seconds) || DEFAULT_SONG_SECONDS;
    const seconds = Math.round(Math.min(VIDEO_COMPOSED_SONG_MAX_SECONDS, Math.max(VIDEO_COMPOSED_SONG_MIN_SECONDS, requested)));
    if (value.mode === 'score') {
        return caption.length < 40 ? none('The songwriter returned no usable score.')
            : { mode: 'score', reason, seconds, caption, lyrics: VIDEO_SCORE_LYRICS };
    }
    // A leading intro section gives a long instrumental opening the singer has to stand through.
    const lyrics = String(value.lyrics || '').replace(/^\s*\[intro\][^\S\n]*\n(?:[^\S\n]*\n)*/i, '').trim().slice(0, 3000);
    const sung = lyrics.split('\n').filter(line => line.trim() && !/^\s*\[[^\]]+\]\s*$/.test(line));
    if (caption.length < 40 || !sung.length) return none('The songwriter returned no usable song.');
    return { mode: 'compose', reason, seconds, caption, lyrics };
}

/** Keep a requested recording tied to the supplied video, including shortened/Shorts URLs. */
export function videoSongDecisionForPrompt(value: any, prompt: string, requestedDurationSeconds?: number | null): VideoSongDecision {
    if (value?.mode === 'recording') {
        const supplied = youtubeVideoFromMessage({ content: prompt });
        const selected = value.recording_url
            ? youtubeVideoFromMessage({ content: String(value.recording_url) }) : null;
        if (value.recording_url && (!supplied || selected?.clip_url !== supplied.clip_url)) {
            throw new Error('The requested song link could not be verified. Attach the recording or provide its YouTube link.');
        }
        if (supplied) value = { ...value, recording_url: supplied.clip_url };
    }
    return validatedVideoSongDecision(value, requestedDurationSeconds);
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
        return videoSongDecisionForPrompt(value, input.prompt, input.requestedDurationSeconds);
    } finally {
        clearTimeout(timeout);
    }
}
