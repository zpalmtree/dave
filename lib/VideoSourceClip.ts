import { execFile } from 'child_process';
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import fetch from 'node-fetch';
import { VIDEO_MAX_TOTAL_DURATION_SECONDS } from './VideoProtocol.js';
import { isTwitterVideoUrl } from './TwitterVideo.js';
import { rangeVideoSourceExcerpt, VIDEO_SOURCE_INPUT_MAX_SECONDS, VideoSourceExcerpt, VideoSourceRange } from './VideoSourceExcerpt.js';

export const VIDEO_EDIT_MIN_SECONDS = 0.5;
export const VIDEO_EDIT_LEGACY_MIN_SECONDS = 5;
export const VIDEO_EDIT_SINGLE_PASS_MAX_SECONDS = 15;
export const VIDEO_EDIT_MAX_SECONDS = VIDEO_MAX_TOTAL_DURATION_SECONDS;
export const VIDEO_EDIT_MAX_BYTES = 100 * 1024 * 1024;
export const VIDEO_CLIP_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv']);

export interface SubmittedVideoSourceClip {
    clip_url: string;
    name: string;
    bytes?: number;
}

export interface StoredVideoSourceClip {
    path: string;
    bytes: number;
    duration: number;
    /** Set when only part of a longer or ranged source is kept. */
    excerpt?: VideoSourceExcerpt | null;
}

export function isVideoSourceClipUrl(value: string): boolean {
    if (isTwitterVideoUrl(value)) return true;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
            ['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname);
    } catch { return false; }
}

export function sourceClipDescriptor(value: any): SubmittedVideoSourceClip | null {
    if (value === null || value === undefined) return null;
    if (!value || typeof value !== 'object' || !isVideoSourceClipUrl(String(value.clip_url || ''))) {
        throw new Error('The source video must be a Discord attachment or a resolved Twitter/X MP4.');
    }
    const name = String(value.name || 'clip.mp4').slice(0, 255);
    const extension = name.split('.').pop()?.toLowerCase();
    if (!extension || !VIDEO_CLIP_EXTENSIONS.has(extension)) {
        throw new Error('The source video must be MP4, MOV, M4V, WebM, or MKV.');
    }
    const bytes = Number(value.bytes || 0);
    if (bytes && (!Number.isInteger(bytes) || bytes > VIDEO_EDIT_MAX_BYTES)) {
        throw new Error('The source video must be no larger than 100 MiB.');
    }
    return { clip_url: String(value.clip_url), name, ...(bytes ? { bytes } : {}) };
}

async function probeDuration(path: string): Promise<number> {
    const output = await new Promise<string>((resolve, reject) => execFile('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type:format=duration',
        '-of', 'json', path,
    ], { timeout: 30_000, maxBuffer: 64 * 1024 }, (error, stdout) =>
        error ? reject(new Error('Could not decode the source video.')) : resolve(String(stdout))));
    const value = JSON.parse(output);
    if (!value.streams?.length) throw new Error('The source clip has no video stream.');
    const duration = Number(value.format?.duration);
    if (!Number.isFinite(duration) || duration < VIDEO_EDIT_MIN_SECONDS || duration > VIDEO_SOURCE_INPUT_MAX_SECONDS) {
        throw new Error(`Video replacement supports clips from ${VIDEO_EDIT_MIN_SECONDS} seconds to 10 minutes.`);
    }
    return duration;
}

/**
 * Keeps the requested range of a source video, or its first two minutes when it is longer
 * and no range was given. Returns null when the whole clip is used.
 */
export function videoSourceClipExcerpt(duration: number, range: VideoSourceRange | null): VideoSourceExcerpt | null {
    if (range) {
        const excerpt = rangeVideoSourceExcerpt(range, duration, VIDEO_EDIT_MAX_SECONDS, 'video');
        if (excerpt.end_seconds - excerpt.start_seconds < VIDEO_EDIT_MIN_SECONDS) throw new Error('Pick a video range of at least half a second.');
        return excerpt.start_seconds <= 0 && excerpt.end_seconds >= duration ? null : excerpt;
    }
    if (duration <= VIDEO_EDIT_MAX_SECONDS) return null;
    return { start_seconds: 0, end_seconds: VIDEO_EDIT_MAX_SECONDS, source_seconds: duration, label: '', chosen: 'start' };
}

export async function cutVideoSourceClip(input: string, output: string, excerpt: VideoSourceExcerpt): Promise<number> {
    const length = excerpt.end_seconds - excerpt.start_seconds;
    // Re-encoding keeps the cut frame-accurate; a stream copy would snap to keyframes.
    await new Promise<void>((resolve, reject) => execFile('ffmpeg', ['-nostdin', '-v', 'error', '-y',
        '-ss', excerpt.start_seconds.toFixed(3), '-i', input, '-t', length.toFixed(3),
        '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output,
    ], { timeout: 600_000, maxBuffer: 1024 * 1024 }, error => error ? reject(new Error('Could not cut the source video.')) : resolve()));
    const duration = await probeDuration(output);
    if (duration > VIDEO_EDIT_MAX_SECONDS + 0.1) throw new Error('Could not cut the source video.');
    return duration;
}

export async function storeVideoSourceClip(source: SubmittedVideoSourceClip, directory: string,
    range: VideoSourceRange | null = null): Promise<StoredVideoSourceClip> {
    source = sourceClipDescriptor(source)!;
    const extension = source.name.split('.').pop()!.toLowerCase();
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, 'source-video.part');
    const destination = join(directory, `source-video.${extension}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    rmSync(temporary, { force: true });
    try {
        const response = await fetch(source.clip_url, { signal: controller.signal, redirect: 'manual' });
        if (!response.ok || !response.body || !isVideoSourceClipUrl(response.url)) {
            throw new Error(`Could not download the source video (HTTP ${response.status}).`);
        }
        if (Number(response.headers.get('content-length') || 0) > VIDEO_EDIT_MAX_BYTES) {
            throw new Error('The source video exceeds 100 MiB.');
        }
        let bytes = 0;
        const meter = new Transform({ transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            callback(bytes > VIDEO_EDIT_MAX_BYTES ? new Error('The source video exceeds 100 MiB.') : null, chunk);
        } });
        await pipeline(response.body, meter, createWriteStream(temporary, { flags: 'wx' }));
        if (!bytes) throw new Error('The source video is empty.');
        const duration = await probeDuration(temporary);
        const excerpt = videoSourceClipExcerpt(duration, range);
        if (excerpt) {
            const cut = join(directory, 'source-video.mp4');
            const cutDuration = await cutVideoSourceClip(temporary, cut, excerpt);
            return { path: cut, bytes: statSync(cut).size, duration: cutDuration, excerpt };
        }
        renameSync(temporary, destination);
        return { path: destination, bytes, duration };
    } finally {
        clearTimeout(timeout);
        rmSync(temporary, { force: true });
    }
}
