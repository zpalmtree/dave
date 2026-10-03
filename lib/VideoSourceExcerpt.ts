import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { AI_MODELS } from './AIModels.js';
import { config } from './Config.js';
import { VIDEO_MAX_TOTAL_DURATION_SECONDS } from './VideoProtocol.js';
import type { VideoSourceAudioLyrics, VideoSourceAudioWord } from './VideoSourceAudio.js';
import { VideoProviderHooks, videoRequestInputTokenBound } from './VideoUsage.js';

/** Longest song or source video accepted before an excerpt is cut from it. */
export const VIDEO_SOURCE_INPUT_MAX_SECONDS = 10 * 60;
/** About 40-55 minutes of H3 rendering: one verse or chorus. */
export const VIDEO_SONG_EXCERPT_SECONDS = 30;
/** A song this short is used whole rather than trimmed by a few seconds. */
const SONG_WHOLE_MAX_SECONDS = VIDEO_SONG_EXCERPT_SECONDS + 5;
const SONG_EXCERPT_MIN_SECONDS = 15;
const SONG_EXCERPT_MAX_SECONDS = 45;

export interface VideoSourceRange {
    start_seconds: number;
    end_seconds: number | null;
}

export interface VideoSourceExcerpt {
    start_seconds: number;
    end_seconds: number;
    source_seconds: number;
    /** A short name such as "the chorus" when the excerpt was chosen automatically. */
    label: string;
    chosen: 'range' | 'auto' | 'start';
}

const TIME = String.raw`(\d{1,2}):([0-5]\d)(?:\.(\d{1,2}))?`;
const RANGE = new RegExp(String.raw`(?<![\w:.])(?:from\s+)?${TIME}\s*(?:-|–|—|to|until|till)\s*${TIME}(?![\w:])`, 'i');
const START = new RegExp(String.raw`(?<![\w:.])(?:from|starting (?:at|from)|start(?:ing)? at)\s+${TIME}(?![\w:])`, 'i');
const clockSeconds = (minutes: string, seconds: string, fraction?: string) =>
    Number(minutes) * 60 + Number(seconds) + (fraction ? Number(`0.${fraction}`) : 0);
const round2 = (value: number) => Math.round(value * 100) / 100;

/** Pulls a time range such as "1:05-1:50" or "from 2:10" out of a video prompt. */
export function extractVideoSourceRange(prompt: string): { prompt: string; range: VideoSourceRange | null } {
    let range: VideoSourceRange | null = null;
    let match = RANGE.exec(prompt);
    if (match) {
        range = { start_seconds: clockSeconds(match[1], match[2], match[3]), end_seconds: clockSeconds(match[4], match[5], match[6]) };
    } else if ((match = START.exec(prompt))) {
        range = { start_seconds: clockSeconds(match[1], match[2], match[3]), end_seconds: null };
    }
    if (!match) return { prompt, range: null };
    const rest = `${prompt.slice(0, match.index)} ${prompt.slice(match.index + match[0].length)}`
        .replace(/[ \t]+/g, ' ').replace(/ ([.,;:!?])/g, '$1').replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '');
    return { prompt: rest, range };
}

export function videoSourceRange(value: any): VideoSourceRange | null {
    if (value === null || value === undefined) return null;
    const start = Number(value?.start_seconds);
    const end = value?.end_seconds === null || value?.end_seconds === undefined ? null : Number(value.end_seconds);
    if (!Number.isFinite(start) || start < 0 || start >= VIDEO_SOURCE_INPUT_MAX_SECONDS
        || (end !== null && (!Number.isFinite(end) || end <= start))) {
        throw new Error('Use a time range like 1:05-1:35, with the end after the start.');
    }
    if (end !== null && end - start > VIDEO_MAX_TOTAL_DURATION_SECONDS) throw new Error('Pick a range of at most 2:00.');
    return { start_seconds: start, end_seconds: end };
}

export function formatClock(seconds: number): string {
    const whole = Math.floor(seconds + 1e-6);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Applies a user's range to a source, defaulting an open range to `openSeconds`. */
export function rangeVideoSourceExcerpt(range: VideoSourceRange, sourceSeconds: number, openSeconds: number, kind: string): VideoSourceExcerpt {
    if (range.start_seconds > sourceSeconds - 1) {
        throw new Error(`That range starts after your ${kind} ends; it is ${formatClock(sourceSeconds)} long.`);
    }
    const end = Math.min(sourceSeconds, range.end_seconds ?? range.start_seconds + openSeconds);
    return { start_seconds: range.start_seconds, end_seconds: end, source_seconds: sourceSeconds, label: '', chosen: 'range' };
}

/** Pads a run of lyric lines into a cut that starts and ends between sung words. */
function songLineWindow(lines: VideoSourceAudioWord[], seconds: number, first: number, last: number) {
    const previous = lines[first - 1], next = lines[last + 1];
    let start = Math.max(previous ? previous.end : 0, lines[first].start - 0.5);
    let end = Math.min(next ? next.start : seconds, lines[last].end + 0.75);
    if (start < 3) start = 0;
    if (seconds - end < 3) end = seconds;
    return { start: round2(start), end: round2(end) };
}

const lineKey = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

/** Without a model, the hook is the window with the most repeated lyric lines, else the first vocals. */
export function defaultSongExcerptLines(lines: VideoSourceAudioWord[]): { first: number; last: number; label: string } {
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(lineKey(line.text), (counts.get(lineKey(line.text)) || 0) + 1);
    const extend = (first: number) => {
        let last = first;
        while (last + 1 < lines.length && lines[last + 1].end - lines[first].start <= VIDEO_SONG_EXCERPT_SECONDS) last++;
        return last;
    };
    let best = { first: 0, last: extend(0), score: 0 };
    for (let first = 0; first < lines.length; first++) {
        const last = extend(first);
        if (first && lines[last].end - lines[first].start < SONG_EXCERPT_MIN_SECONDS) continue;
        // Repeated lines score two each; starting on one breaks ties so the excerpt opens on the hook.
        let score = 0;
        for (let i = first; i <= last; i++) if ((counts.get(lineKey(lines[i].text)) || 0) > 1) score += i === first ? 3 : 2;
        if (score > best.score) best = { first, last, score };
    }
    return { first: best.first, last: best.last, label: best.score ? 'the hook' : 'the first vocals' };
}

export type SongExcerptPicker = (prompt: string, lyrics: VideoSourceAudioLyrics, seconds: number,
    hooks: VideoProviderHooks) => Promise<{ first_line: number; last_line: number; label: string }>;

const PICKER_INSTRUCTIONS = `You choose which part of a song a short AI music video will use. The input has the user's video request and the song's machine-transcribed lyric lines, numbered, with start and end times in seconds. The transcription may mishear words.
If the request names a part of the song (a chorus, verse, drop, intro, lyric, or moment), choose that part. Otherwise choose the most recognizable section: for a well-known song its best-known part, else the first full chorus or hook, usually its most repeated lines. Prefer that chorus over an intro, outro, or fade-out that repeats it.
Choose consecutive lines lasting about ${VIDEO_SONG_EXCERPT_SECONDS} seconds in total (between 20 and ${SONG_EXCERPT_MAX_SECONDS - 5}), starting at the beginning of a phrase. Return first_line and last_line as inclusive line numbers, and label: two to four lowercase words naming the part, such as "the chorus" or "the second verse".`;

export const pickSongExcerptWithGemini: SongExcerptPicker = async (prompt, lyrics, seconds, hooks) => {
    const stage = 'source_audio_excerpt';
    const model = AI_MODELS.geminiChat;
    const input = [`Request: ${prompt}`, `Song length: ${seconds.toFixed(1)} seconds`, 'Lyric lines:',
        ...lyrics.lines.map((line, index) => `${index}: ${line.start.toFixed(1)}-${line.end.toFixed(1)} ${line.text}`)].join('\n');
    const started = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let timeout: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    try {
        await hooks.beforeRequest?.({ stage, attempt: 1, provider: 'google', model,
            maxInputTokens: videoRequestInputTokenBound({ PICKER_INSTRUCTIONS, input }), maxOutputTokens: 512 });
        const client = new GoogleGenAI({ apiKey: config.geminiApiKey });
        const response = await Promise.race([
            client.models.generateContent({ model, contents: [{ role: 'user', parts: [{ text: input }] }], config: {
                abortSignal: controller.signal, systemInstruction: PICKER_INSTRUCTIONS,
                responseMimeType: 'application/json', responseJsonSchema: {
                    type: 'object', additionalProperties: false, required: ['first_line', 'last_line', 'label'],
                    properties: { first_line: { type: 'integer' }, last_line: { type: 'integer' }, label: { type: 'string' } },
                },
                maxOutputTokens: 512, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                httpOptions: { timeout: 30_000, retryOptions: { attempts: 1 } },
            } }),
            new Promise<never>((_, reject) => { timeout = setTimeout(() => {
                controller.abort();
                reject(new Error('Choosing the song excerpt timed out.'));
            }, 30_000); }),
        ]);
        const usage = response.usageMetadata;
        await hooks.onUsage?.({ stage, attempt: 1, outcome: 'success', provider: 'google',
            model: response.modelVersion || model, serviceTier: 'default',
            inputTokens: Math.max(0, Number(usage?.promptTokenCount || 0) - Number(usage?.cachedContentTokenCount || 0)),
            outputTokens: Number(usage?.candidatesTokenCount || 0) + Number(usage?.thoughtsTokenCount || 0),
            cacheReadTokens: Number(usage?.cachedContentTokenCount || 0),
            rawUsage: usage as unknown as Record<string, unknown>, usageMissing: !usage });
        const value = JSON.parse(String(response.text || ''));
        outcome = 'success';
        return value;
    } finally {
        clearTimeout(timeout);
        await hooks.onAttempt?.({ stage, attempt: 1, outcome, provider: 'google', model,
            serviceTier: 'default', durationSeconds: (Date.now() - started) / 1000 });
    }
};

/**
 * Chooses the part of a long song to render: the user's range, the whole of a short song,
 * otherwise about thirty seconds the request names or the song's hook, cut between sung lines.
 * Returns null when the whole song is used.
 */
export async function selectVideoSourceAudioExcerpt(
    input: { prompt: string; lyrics: VideoSourceAudioLyrics | null; seconds: number; range: VideoSourceRange | null },
    hooks: VideoProviderHooks = {},
    picker: SongExcerptPicker = pickSongExcerptWithGemini,
): Promise<VideoSourceExcerpt | null> {
    const { lyrics, seconds, range } = input;
    if (range) {
        const excerpt = rangeVideoSourceExcerpt(range, seconds, VIDEO_SONG_EXCERPT_SECONDS, 'song');
        // An open range ends on the line that finishes nearest thirty seconds in.
        const closing = range.end_seconds === null && lyrics?.lines.find(line =>
            line.end >= range.start_seconds + VIDEO_SONG_EXCERPT_SECONDS - 5 && line.end <= range.start_seconds + SONG_WHOLE_MAX_SECONDS);
        if (closing) excerpt.end_seconds = Math.min(seconds, round2(closing.end + 0.5));
        return excerpt.start_seconds <= 0 && excerpt.end_seconds >= seconds ? null : excerpt;
    }
    if (seconds <= SONG_WHOLE_MAX_SECONDS) return null;
    const lines = lyrics?.lines || [];
    if (!lines.length) {
        return { start_seconds: 0, end_seconds: VIDEO_SONG_EXCERPT_SECONDS, source_seconds: seconds, label: 'the opening', chosen: 'auto' };
    }
    let choice = defaultSongExcerptLines(lines);
    try {
        const picked = await picker(input.prompt, lyrics!, seconds, hooks);
        const first = Number(picked?.first_line), last = Number(picked?.last_line);
        if (Number.isInteger(first) && Number.isInteger(last) && first >= 0 && first <= last && last < lines.length) {
            let end = last;
            while (end > first && lines[end].end - lines[first].start > SONG_EXCERPT_MAX_SECONDS) end--;
            const label = String(picked.label || '').replace(/[^\p{L}\p{N} '-]/gu, '').trim().slice(0, 40);
            if (lines[end].end - lines[first].start >= SONG_EXCERPT_MIN_SECONDS || end === lines.length - 1) {
                choice = { first, last: end, label: label || 'the chosen part' };
            }
        }
    } catch (error) {
        console.warn('Could not choose a song excerpt with Gemini; using the most repeated lyrics.', error);
    }
    const window = songLineWindow(lines, seconds, choice.first, choice.last);
    return { start_seconds: window.start, end_seconds: window.end, source_seconds: seconds, label: choice.label, chosen: 'auto' };
}

/** Describes an excerpt for Discord status, for example "the chorus, 1:05–1:35 of your 3:42 song". */
export function describeVideoSourceExcerpt(excerpt: VideoSourceExcerpt, kind: 'song' | 'video'): string {
    const span = excerpt.chosen === 'start'
        ? `the first ${formatClock(excerpt.end_seconds)}`
        : `${formatClock(excerpt.start_seconds)}–${formatClock(excerpt.end_seconds)}`;
    const label = excerpt.chosen === 'auto' && excerpt.label ? `${excerpt.label}, ` : '';
    return `${label}${span} of your ${formatClock(excerpt.source_seconds)} ${kind}`;
}
