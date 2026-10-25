import { loadImage } from 'canvas';
import { VIDEO_KEYFRAME_ASPECT_RATIOS, VideoKeyframeAspectRatio } from './VideoKeyframeProvider.js';

/** Match the renderer's supported aspects; identity references do not set the canvas. */
export async function recoveryKeyframeAspect(
    requested: unknown,
    opening?: Buffer,
): Promise<VideoKeyframeAspectRatio> {
    if (requested !== undefined) {
        if (!VIDEO_KEYFRAME_ASPECT_RATIOS.includes(requested as VideoKeyframeAspectRatio)) {
            throw new Error('Invalid recovery canvas aspect ratio.');
        }
        return requested as VideoKeyframeAspectRatio;
    }
    // Compatibility with workers that do not yet send the accepted opening's aspect.
    if (!opening) return '16:9';
    try {
        const image = await loadImage(opening);
        const ratio = image.width / image.height;
        const distance = (aspect: string) => {
            const [width, height] = aspect.split(':').map(Number);
            return Math.abs(width / height - ratio);
        };
        return VIDEO_KEYFRAME_ASPECT_RATIOS.reduce((best, aspect) =>
            distance(aspect) < distance(best) ? aspect : best);
    } catch {
        return '16:9';
    }
}
