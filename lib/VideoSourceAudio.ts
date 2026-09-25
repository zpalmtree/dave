import { execFile } from 'child_process';
import { createWriteStream, mkdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import fetch from 'node-fetch';

export const VIDEO_SOURCE_AUDIO_MAX_BYTES = 25 * 1024 * 1024;
export const VIDEO_SOURCE_AUDIO_GUIDANCE = 'The user supplied the original song as the fixed soundtrack. Animate the visible performer lip-syncing and performing to that recording from time zero. Preserve character identity and the requested visual scene. Do not invent, transcribe, speak, sing, or add any new dialogue or lyrics: every shot dialogue array must be empty. The original vocals and music supply all sound. This overrides character voice, accent, catchphrase, dialogue lead-in and silence instructions. Plan continuous performance with readable mouth movement and natural rhythmic gestures; no opening pause, time skips, slow motion, or dissolves. Timings follow the supplied audio duration exactly.';
const FORMATS: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac' };
export interface SubmittedVideoSourceAudio { url: string; name: string; bytes: number; }
export interface StoredVideoSourceAudio { path: string; bytes: number; duration: number; }

export function videoSourceAudioFromMessages(...messages: any[]): SubmittedVideoSourceAudio | null {
    for (const message of messages) {
        if (!message) continue;
        const candidates = [...message.attachments.values()].filter((item: any) =>
            item.contentType?.toLowerCase().startsWith('audio/') || FORMATS[item.name?.split('.').pop()?.toLowerCase()]);
        if (candidates.length > 1) throw new Error('Attach exactly one song for lip-sync.');
        if (!candidates.length) continue;
        const item: any = candidates[0];
        return sourceAudioDescriptor({ url: item.url, name: item.name, bytes: item.size });
    }
    return null;
}

export function sourceAudioDescriptor(value: any): SubmittedVideoSourceAudio | null {
    if (value == null) return null;
    if (!value || typeof value !== 'object') throw new Error('Invalid song attachment.');
    let url: URL;
    try { url = new URL(value.url); } catch { throw new Error('The song must be a Discord attachment.'); }
    if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
        || url.username || url.password || url.port || !url.pathname.startsWith('/attachments/')) {
        throw new Error('The song must be a Discord attachment.');
    }
    const name = String(value.name || '').slice(0, 255);
    if (!FORMATS[name.split('.').pop()!.toLowerCase()]) throw new Error('The song must be MP3, WAV, FLAC, OGG, Opus, M4A, or AAC.');
    if (!Number.isInteger(value.bytes) || value.bytes <= 0 || value.bytes > VIDEO_SOURCE_AUDIO_MAX_BYTES) {
        throw new Error('The song must be no larger than 25 MiB.');
    }
    return { url: url.href, name, bytes: value.bytes };
}

const run = promisify(execFile);
export async function normalizeVideoSourceAudio(input: string, output: string): Promise<StoredVideoSourceAudio> {
    try {
        await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe',
            '-format_whitelist', 'mp3,wav,flac,ogg,mov,aac', '-i', input, '-map', '0:a:0', '-vn',
            '-t', '121', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', output], { timeout: 60_000 });
        const result = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', output], { timeout: 10_000 });
        const duration = Number(JSON.parse(result.stdout).format?.duration);
        if (!Number.isFinite(duration) || duration < 4 || duration > 120) {
            throw new Error('Use a song excerpt between 4 and 120 seconds long.');
        }
        return { path: output, bytes: statSync(output).size, duration };
    } catch (error) {
        rmSync(output, { force: true });
        if (error instanceof Error && error.message.startsWith('Use a song excerpt')) throw error;
        throw new Error('Could not decode the song. Upload a valid MP3, WAV, FLAC, OGG, Opus, M4A, or AAC file.');
    }
}

export async function storeVideoSourceAudio(source: SubmittedVideoSourceAudio, directory: string): Promise<StoredVideoSourceAudio> {
    sourceAudioDescriptor(source);
    mkdirSync(directory, { recursive: true });
    const input = join(directory, 'song-upload.part');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
        const response = await fetch(source.url, { redirect: 'error', signal: controller.signal });
        if (!response.ok || !response.body) throw new Error('Could not download the song from Discord.');
        if (Number(response.headers.get('content-length')) > VIDEO_SOURCE_AUDIO_MAX_BYTES) throw new Error('The song exceeds 25 MiB.');
        let bytes = 0;
        const meter = new Transform({ transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            callback(bytes > VIDEO_SOURCE_AUDIO_MAX_BYTES ? new Error('The song exceeds 25 MiB.') : null, chunk);
        } });
        await pipeline(response.body, meter, createWriteStream(input, { flags: 'wx' }));
        if (!bytes) throw new Error('The song is empty.');
        return await normalizeVideoSourceAudio(input, join(directory, 'source-audio.wav'));
    } finally {
        clearTimeout(timeout);
        rmSync(input, { force: true });
    }
}

/** Frame-aligned cuts keep every rendered scene on the same immutable song timeline. */
export function pinVideoPlanToAudio(plan: any, seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 4 || seconds > 120 || !plan.segments?.length) throw new Error('Invalid song timeline.');
    const totalFrames = Math.ceil(seconds * 24 - 1e-6);
    const originalWeight = plan.segments.reduce((sum: number, s: any) => sum + Number(s.target_seconds), 0);
    if (!Number.isFinite(originalWeight) || originalWeight <= 0) throw new Error('Invalid song screenplay timings.');
    const segments = plan.segments.flatMap((segment: any) => {
        const count = Math.max(1, Math.ceil(seconds * Number(segment.target_seconds) / originalWeight / 14));
        return Array.from({ length: count }, (_, index) => ({ ...JSON.parse(JSON.stringify(segment)),
            target_seconds: Number(segment.target_seconds) / count,
            transition: index ? 'continue' : segment.transition }));
    });
    const weight = segments.reduce((sum: number, s: any) => sum + Number(s.target_seconds), 0);
    if (!Number.isFinite(weight) || weight <= 0 || segments.length * 12 > totalFrames) throw new Error('The screenplay cannot fit the song timeline.');
    let cursor = 0;
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const end = i === segments.length - 1 ? totalFrames : Math.round(totalFrames *
            segments.slice(0, i + 1).reduce((sum: number, s: any) => sum + Number(s.target_seconds), 0) / weight);
        // Preserve weights until all boundaries are calculated.
        segment.source_audio_start_seconds = cursor / 24;
        segment.source_audio_frames = end - cursor;
        if (segment.source_audio_frames < 12 || segment.source_audio_frames > 360) throw new Error('The screenplay needs shorter scenes to fit the song.');
        cursor = end;
    }
    for (const [index, segment] of segments.entries()) {
        const duration = segment.source_audio_frames / 24;
        segment.target_seconds = segment.output_seconds = duration;
        segment.transition = index === 0 ? 'start' : segment.transition === 'continue' ? 'continue' : 'cut';
        segment.audio_transition = 'cut';
        segment.music = 'The supplied original song is the immutable soundtrack.';
        const shotTotal = segment.shots.reduce((sum: number, shot: any) => sum + Number(shot.duration_seconds || 0), 0);
        for (const shot of segment.shots) {
            shot.duration_seconds = shotTotal > 0 ? duration * Number(shot.duration_seconds) / shotTotal : duration / segment.shots.length;
            shot.dialogue = [];
            shot.audio = 'The original uploaded song, unchanged; synchronize the visible performance to its vocals and rhythm.';
        }
    }
    plan.segments = segments;
    // The supplied waveform owns speech; the renderer must not regenerate textual lyrics.
    for (const analysis of [plan.prompt_analysis, plan.semantic_analysis]) {
        if (analysis) analysis.dialogue_contract = { mode: 'none', lines: [] };
    }
    plan.speaker_profiles = [];
    plan.source_audio = { duration_seconds: seconds, output_frames: totalFrames };
    plan.target_total_seconds = plan.generation_total_seconds = totalFrames / 24;
    plan.duration_mode = 'explicit';
    delete plan.segment_keyframes;
}
