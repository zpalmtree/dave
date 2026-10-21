import { createCanvas, loadImage } from 'canvas';

// Bound the encoded payload, not just the file: base64 adds roughly one third.
// Leave headroom below the provider limit for both single and paired references.
const MAX_ENCODED_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PREVIEW_EDGE = 2048;

export async function anthropicPlannerImage(url: string): Promise<{
    type: 'image'; source: { type: 'base64'; media_type: string; data: string };
}> {
    const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
    if (!match) throw new Error('Unsupported Anthropic planner image.');
    let [, mimeType, data] = match;
    if (data.length > MAX_ENCODED_IMAGE_BYTES) {
        // Work on a preview only; the original remains the rendering reference.
        const image = await loadImage(Buffer.from(data, 'base64'));
        if (!image.width || !image.height) throw new Error('Invalid Anthropic planner image dimensions.');
        let scale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(image.width, image.height));
        for (;;) {
            const width = Math.max(1, Math.round(image.width * scale));
            const height = Math.max(1, Math.round(image.height * scale));
            const canvas = createCanvas(width, height);
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0, width, height);
            // Prefer lossless PNG, preserving text and transparency when it fits.
            data = canvas.toBuffer('image/png').toString('base64');
            mimeType = 'image/png';
            if (data.length <= MAX_ENCODED_IMAGE_BYTES) break;
            // Give transparent images a neutral background before JPEG encoding.
            context.globalCompositeOperation = 'destination-over';
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, width, height);
            data = canvas.toBuffer('image/jpeg', 90).toString('base64');
            mimeType = 'image/jpeg';
            if (data.length <= MAX_ENCODED_IMAGE_BYTES) break;
            if (width === 1 && height === 1) throw new Error('Unable to fit Anthropic planner image.');
            scale *= 0.75;
        }
    }
    return { type: 'image', source: { type: 'base64', media_type: mimeType, data } };
}
