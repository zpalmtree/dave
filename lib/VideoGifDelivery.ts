import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { rename, rm, stat } from 'fs/promises';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { isGifVideoUrl, isGifPageUrl } from './GifVideo.js';
import { VIDEO_DISCORD_BASELINE_UPLOAD_BYTES, VideoJobView } from './VideoProtocol.js';

const run = promisify(execFile);
export type VideoOutputFormat = 'gif' | 'mp4';

/** GIF sites often supply an MP4 rendition; retain the original media's intent. */
export function videoOutputFormatForSources(...sources: unknown[]): VideoOutputFormat {
    return sources.some(source => {
        if (!source || typeof source !== 'object' || !('clip_url' in source)) return false;
        const clip = source as { clip_url: string; name?: string; source_page_url?: string };
        return /\.gif$/i.test(clip.name || '') || isGifVideoUrl(clip.clip_url) || isGifPageUrl(clip.source_page_url || '');
    }) ? 'gif' : 'mp4';
}

export interface VideoDeliveryMedia {
    path: string;
    format: VideoOutputFormat;
    notice?: string;
}

export const GIF_SIZE_FALLBACK_NOTICE = 'The GIF was too large for Discord, so I attached the MP4 instead.';
export const GIF_ERROR_FALLBACK_NOTICE = 'Couldn’t create the GIF, so I attached the MP4 instead.';

/** Keep the full timeline, reducing resolution/frame rate only to meet upload limits. */
export async function prepareVideoDelivery(job: Pick<VideoJobView, 'result_path' | 'output_format' | 'delivery_limit_bytes'>): Promise<VideoDeliveryMedia> {
    if (!job.result_path) throw new Error('The completed video is missing.');
    const original: VideoDeliveryMedia = { path: job.result_path, format: 'mp4' };
    if (job.output_format !== 'gif') return original;
    const suppliedLimit = Number(job.delivery_limit_bytes);
    const limit = Number.isFinite(suppliedLimit) && suppliedLimit > 0 ? suppliedLimit : VIDEO_DISCORD_BASELINE_UPLOAD_BYTES;
    const hash = createHash('sha256').update(`gif-delivery-v1:${limit}:`);
    for await (const chunk of createReadStream(job.result_path)) hash.update(chunk);
    const destination = join(dirname(job.result_path), `delivery-${hash.digest('hex').slice(0, 24)}.gif`);
    const cached = await stat(destination).catch(() => null);
    if (cached?.size && cached.size <= limit) return { path: destination, format: 'gif' };
    const temporary = `${destination}.${randomUUID()}.part.gif`;
    const palette = `${temporary}.png`;
    try {
        // Separate palette/render passes avoid buffering a whole long video in RAM.
        for (const [size, fps] of [[640, 20], [480, 15], [360, 12], [240, 10], [160, 8]]) {
            const filter = `fps=${fps},scale=w='min(${size},iw)':h='min(${size},ih)':force_original_aspect_ratio=decrease:flags=lanczos`;
            await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-threads', '2', '-i', job.result_path,
                '-vf', `${filter},palettegen=stats_mode=diff:max_colors=128:reserve_transparent=0`,
                '-frames:v', '1', '-update', '1', '-threads', '1', '-filter_threads', '1', palette],
            { timeout: 120_000, maxBuffer: 1024 * 1024 });
            await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-threads', '2', '-i', job.result_path, '-i', palette,
                '-filter_complex', `[0:v]${filter}[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=3`,
                '-filter_complex_threads', '1', '-an', '-loop', '0', '-f', 'gif', temporary],
            { timeout: 120_000, maxBuffer: 1024 * 1024 });
            const bytes = (await stat(temporary)).size;
            if (bytes > 0 && bytes <= limit) {
                await rename(temporary, destination);
                return { path: destination, format: 'gif' };
            }
            await rm(temporary, { force: true });
        }
        return { ...original, notice: GIF_SIZE_FALLBACK_NOTICE };
    } catch (error) {
        console.warn(`[Video] GIF delivery conversion failed: ${String(error).slice(0, 500)}`);
        return { ...original, notice: GIF_ERROR_FALLBACK_NOTICE };
    } finally {
        await rm(temporary, { force: true });
        await rm(palette, { force: true });
    }
}
