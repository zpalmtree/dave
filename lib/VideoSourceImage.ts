import { execFile } from 'child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

import { VIDEO_SOURCE_IMAGE_MAX_BYTES, VIDEO_SOURCE_IMAGE_MIME_TYPES } from './VideoProtocol.js';
import { VideoStickerSourceImage, videoStickerSourceImage, videoStickerFrameUrl } from './VideoSticker.js';
import { isVideoSourceClipUrl } from './VideoSourceClip.js';
import { imageExtension } from './VideoImageMime.js';
import type { VideoKeyframeResult } from './VideoKeyframeProvider.js';

const OALGO_VIDEO_PRESET_PATH = fileURLToPath(new URL('../images/oalgo.png', import.meta.url));

export interface VideoAttachmentSourceImageDescriptor {
    url: string;
    mime_type: typeof VIDEO_SOURCE_IMAGE_MIME_TYPES[number];
    bytes: number;
    name: string;
}

export interface VideoPresetSourceImageDescriptor {
    preset: 'meximutt' | 'oalgo';
}

export interface VideoClipSourceImageDescriptor {
    clip_url: string;
    name: string;
}

export type VideoSourceImageDescriptor =
    | VideoAttachmentSourceImageDescriptor
    | VideoStickerSourceImage
    | VideoPresetSourceImageDescriptor
    | VideoClipSourceImageDescriptor;

export interface StoredVideoSourceImage {
    path: string;
    mimeType: typeof VIDEO_SOURCE_IMAGE_MIME_TYPES[number];
    bytes: number;
}

export function sourceImageDescriptor(value: any): VideoSourceImageDescriptor | null {
    if (value === null || value === undefined) return null;
    if (!value || typeof value !== 'object') throw new Error('Invalid starting-image metadata.');
    if (value.sticker_id !== undefined) return videoStickerSourceImage(value);
    if (value.preset !== undefined) {
        if (!['meximutt', 'oalgo'].includes(value.preset)) throw new Error('Unknown starting-image preset.');
        return { preset: 'meximutt' };
    }
    if (value.clip_url !== undefined) {
        const clipUrl = String(value.clip_url);
        if (!isVideoSourceClipUrl(clipUrl)) throw new Error('The video clip is not a Discord attachment or resolved Twitter/X MP4.');
        return { clip_url: clipUrl, name: String(value.name || 'clip').slice(0, 255) };
    }
    const mimeType = String(value.mime_type || '').split(';')[0].toLowerCase();
    const bytes = Number(value.bytes || 0);
    if (!VIDEO_SOURCE_IMAGE_MIME_TYPES.includes(mimeType as any)) {
        throw new Error('The starting image must be PNG, JPEG, or WebP.');
    }
    if (!Number.isInteger(bytes) || bytes <= 0 || bytes > VIDEO_SOURCE_IMAGE_MAX_BYTES) {
        throw new Error('The starting image is empty or exceeds the 20 MiB limit.');
    }
    return {
        url: String(value.url || ''),
        mime_type: mimeType as VideoAttachmentSourceImageDescriptor['mime_type'],
        bytes,
        name: String(value.name || 'start-frame').slice(0, 255),
    };
}

export function isPresetSourceImage(
    descriptor: VideoSourceImageDescriptor,
): descriptor is VideoPresetSourceImageDescriptor {
    return 'preset' in descriptor;
}

export function isClipSourceImage(
    descriptor: VideoSourceImageDescriptor,
): descriptor is VideoClipSourceImageDescriptor {
    return 'clip_url' in descriptor;
}

function isDiscordAttachmentUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'https:'
            && (url.hostname === 'cdn.discordapp.com' || url.hostname === 'media.discordapp.net');
    } catch {
        return false;
    }
}

async function downloadDiscordSourceImage(
    descriptor: Pick<VideoAttachmentSourceImageDescriptor, 'url' | 'mime_type'>
        & Partial<Pick<VideoAttachmentSourceImageDescriptor, 'bytes' | 'name'>>,
    directory: string,
): Promise<StoredVideoSourceImage> {
    if (!isDiscordAttachmentUrl(descriptor.url)) {
        throw new Error('The starting image is not a Discord attachment.');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, 'source.part');
    rmSync(temporary, { force: true });
    try {
        const response = await fetch(descriptor.url, {
            signal: controller.signal,
            redirect: 'follow',
        });
        if (!response.ok || !response.body || !isDiscordAttachmentUrl(response.url)) {
            throw new Error(`Discord returned HTTP ${response.status} for the starting image.`);
        }
        const mimeType = String(response.headers.get('content-type') || descriptor.mime_type)
            .split(';')[0]
            .toLowerCase();
        if (!VIDEO_SOURCE_IMAGE_MIME_TYPES.includes(mimeType as any)) {
            throw new Error(`Discord returned unsupported image type ${mimeType || 'unknown'}.`);
        }
        const declaredLength = Number(response.headers.get('content-length') || 0);
        if (declaredLength > VIDEO_SOURCE_IMAGE_MAX_BYTES) {
            throw new Error('The starting image exceeds the 20 MiB limit.');
        }
        let bytes = 0;
        const meter = new Transform({
            transform(chunk, _encoding, callback) {
                bytes += chunk.length;
                if (bytes > VIDEO_SOURCE_IMAGE_MAX_BYTES) {
                    callback(new Error('The starting image exceeds the 20 MiB limit.'));
                    return;
                }
                callback(null, chunk);
            },
        });
        await pipeline(response.body, meter, createWriteStream(temporary, { flags: 'wx' }));
        if (!bytes) throw new Error('The starting image is empty.');
        const destination = join(directory, `source.${imageExtension(mimeType)}`);
        rmSync(destination, { force: true });
        renameSync(temporary, destination);
        return {
            path: destination,
            mimeType: mimeType as StoredVideoSourceImage['mimeType'],
            bytes,
        };
    } finally {
        clearTimeout(timeout);
        rmSync(temporary, { force: true });
    }
}

// Discord attachments are untrusted media, so ffmpeg may only read HTTPS and
// may only demux plain video containers; playlists could otherwise fetch
// arbitrary URLs through the broker.
const VIDEO_CLIP_FFMPEG_INPUT_ARGS = [
    '-protocol_whitelist', 'https,tls,tcp',
    '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm',
    '-rw_timeout', '30000000',
];
// Middle first; a nearly black frame (a fade or cut) tries the quarter points.
const VIDEO_CLIP_FRAME_POSITIONS = [0.5, 0.25, 0.75];
const VIDEO_CLIP_BLACK_FRAME_LUMA = 20;

function runVideoTool(command: string, args: string[]): Promise<string> {
    return new Promise((resolvePromise, reject) => {
        execFile(command, args, { timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`${command} failed: ${String(stderr || error.message).trim().slice(0, 500)}`));
                return;
            }
            resolvePromise(String(stdout));
        });
    });
}

export function videoClipProxyFrameUrl(clipUrl: string): string {
    const url = new URL(clipUrl);
    url.hostname = 'media.discordapp.net';
    url.searchParams.set('format', 'webp');
    url.searchParams.set('quality', 'lossless');
    return url.toString();
}

async function extractVideoClipFrame(
    clipUrl: string,
    seconds: number,
    destination: string,
    codecArgs: string[],
): Promise<number | null> {
    const stdout = await runVideoTool('ffmpeg', [
        '-nostdin', '-v', 'error',
        ...VIDEO_CLIP_FFMPEG_INPUT_ARGS,
        '-ss', seconds.toFixed(3),
        '-i', clipUrl,
        '-frames:v', '1',
        '-vf', 'signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=-',
        ...codecArgs,
        '-y', destination,
    ]);
    const luma = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(stdout);
    return luma ? Number(luma[1]) : null;
}

/** Store a representative frame of a supported video clip as the starting image. */
export async function extractVideoClipSourceImage(
    descriptor: VideoClipSourceImageDescriptor,
    directory: string,
): Promise<StoredVideoSourceImage> {
    mkdirSync(directory, { recursive: true });
    try {
        const duration = Number((await runVideoTool('ffprobe', [
            '-v', 'error',
            ...VIDEO_CLIP_FFMPEG_INPUT_ARGS,
            '-show_entries', 'format=duration',
            '-of', 'default=nw=1:nk=1',
            descriptor.clip_url,
        ])).trim());
        const destination = join(directory, 'source.png');
        for (const position of VIDEO_CLIP_FRAME_POSITIONS) {
            const seconds = Number.isFinite(duration) && duration > 0 ? duration * position : 0;
            rmSync(destination, { force: true });
            const luma = await extractVideoClipFrame(descriptor.clip_url, seconds, destination, []);
            if (!existsSync(destination)) continue;
            if (luma !== null && luma < VIDEO_CLIP_BLACK_FRAME_LUMA && position !== VIDEO_CLIP_FRAME_POSITIONS.at(-1)) {
                continue;
            }
            let stored: StoredVideoSourceImage = { path: destination, mimeType: 'image/png', bytes: statSync(destination).size };
            if (stored.bytes > VIDEO_SOURCE_IMAGE_MAX_BYTES) {
                const jpeg = join(directory, 'source.jpg');
                await extractVideoClipFrame(descriptor.clip_url, seconds, jpeg, ['-q:v', '2']);
                rmSync(destination, { force: true });
                stored = { path: jpeg, mimeType: 'image/jpeg', bytes: statSync(jpeg).size };
            }
            if (!stored.bytes || stored.bytes > VIDEO_SOURCE_IMAGE_MAX_BYTES) {
                throw new Error('The extracted clip frame is empty or exceeds the 20 MiB limit.');
            }
            return stored;
        }
        throw new Error('ffmpeg produced no frame.');
    } catch (error) {
        if (!isDiscordAttachmentUrl(descriptor.clip_url)) {
            throw new Error('Could not extract a starting frame from the Twitter/X video. Try attaching the video directly.');
        }
        console.warn(`[Video] Could not extract a frame from ${descriptor.name} with ffmpeg; using Discord's first frame.`, error);
        return downloadDiscordSourceImage({
            url: videoClipProxyFrameUrl(descriptor.clip_url),
            mime_type: 'image/webp',
            bytes: 1,
            name: descriptor.name,
        }, directory);
    }
}

export async function storeVideoSourceImage(
    descriptor: VideoSourceImageDescriptor,
    directory: string,
): Promise<StoredVideoSourceImage> {
    if ('sticker_id' in descriptor) {
        return downloadDiscordSourceImage({ url: videoStickerFrameUrl(descriptor), mime_type: 'image/png' }, directory);
    }
    if (isClipSourceImage(descriptor)) {
        return extractVideoClipSourceImage(descriptor, directory);
    }
    if (!isPresetSourceImage(descriptor)) {
        return downloadDiscordSourceImage(descriptor, directory);
    }
    if (!existsSync(OALGO_VIDEO_PRESET_PATH) || !statSync(OALGO_VIDEO_PRESET_PATH).isFile()) {
        throw new Error('The Meximutt starting-image preset is unavailable.');
    }
    const bytes = statSync(OALGO_VIDEO_PRESET_PATH).size;
    if (!bytes || bytes > VIDEO_SOURCE_IMAGE_MAX_BYTES) {
        throw new Error('The Meximutt starting-image preset is empty or too large.');
    }
    mkdirSync(directory, { recursive: true });
    const destination = join(directory, 'source.png');
    rmSync(destination, { force: true });
    copyFileSync(OALGO_VIDEO_PRESET_PATH, destination);
    return { path: destination, mimeType: 'image/png', bytes };
}

export function storeCompositedSourceImage(
    result: VideoKeyframeResult,
    directory: string,
): StoredVideoSourceImage {
    if (!result.bytes.length || result.bytes.length > VIDEO_SOURCE_IMAGE_MAX_BYTES) {
        throw new Error('The composited starting image is empty or exceeds the 20 MiB limit.');
    }
    mkdirSync(directory, { recursive: true });
    const extension = imageExtension(result.mimeType);
    const temporary = join(directory, `source.${extension}.part`);
    const destination = join(directory, `source.${extension}`);
    rmSync(temporary, { force: true });
    rmSync(destination, { force: true });
    writeFileSync(temporary, result.bytes, { flag: 'wx' });
    renameSync(temporary, destination);
    return { path: destination, mimeType: result.mimeType, bytes: result.bytes.length };
}
