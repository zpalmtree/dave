import { execFile } from 'child_process';
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'fs';
import { join } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import fetch from 'node-fetch';

export const VIDEO_EDIT_MIN_SECONDS = 5;
export const VIDEO_EDIT_MAX_SECONDS = 15;
export const VIDEO_EDIT_MAX_BYTES = 100 * 1024 * 1024;
const EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv']);

export interface SubmittedVideoSourceClip {
    clip_url: string;
    name: string;
    bytes?: number;
}

export interface StoredVideoSourceClip {
    path: string;
    bytes: number;
    duration: number;
}

function discordAttachmentUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' &&
            ['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname);
    } catch { return false; }
}

export function sourceClipDescriptor(value: any): SubmittedVideoSourceClip | null {
    if (value === null || value === undefined) return null;
    if (!value || typeof value !== 'object' || !discordAttachmentUrl(String(value.clip_url || ''))) {
        throw new Error('The source video must be a Discord attachment.');
    }
    const name = String(value.name || 'clip.mp4').slice(0, 255);
    const extension = name.split('.').pop()?.toLowerCase();
    if (!extension || !EXTENSIONS.has(extension)) {
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
    if (!Number.isFinite(duration) || duration < VIDEO_EDIT_MIN_SECONDS || duration > VIDEO_EDIT_MAX_SECONDS) {
        throw new Error(`Video replacement supports clips from ${VIDEO_EDIT_MIN_SECONDS} to ${VIDEO_EDIT_MAX_SECONDS} seconds.`);
    }
    return duration;
}

export async function storeVideoSourceClip(source: SubmittedVideoSourceClip, directory: string): Promise<StoredVideoSourceClip> {
    const extension = source.name.split('.').pop()!.toLowerCase();
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, 'source-video.part');
    const destination = join(directory, `source-video.${extension}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    rmSync(temporary, { force: true });
    try {
        const response = await fetch(source.clip_url, { signal: controller.signal, redirect: 'manual' });
        if (!response.ok || !response.body || !discordAttachmentUrl(response.url)) {
            throw new Error(`Discord could not provide the source video (HTTP ${response.status}).`);
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
        renameSync(temporary, destination);
        return { path: destination, bytes, duration };
    } finally {
        clearTimeout(timeout);
        rmSync(temporary, { force: true });
    }
}
