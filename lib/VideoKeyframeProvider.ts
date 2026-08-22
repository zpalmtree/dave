import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';

import { AI_MODELS } from './AIModels.js';
import { config } from './Config.js';

export const VIDEO_KEYFRAME_MODEL = AI_MODELS.geminiImage;
export const VIDEO_KEYFRAME_PROVIDER = 'gemini';
export const VIDEO_KEYFRAME_MAX_BYTES = 25 * 1024 * 1024;

export interface VideoKeyframeResult {
    bytes: Buffer;
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
    provider: string;
    model: string;
}

function keyframeString(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function buildVideoKeyframePrompt(plan: Record<string, any>): string {
    const keyframe = plan?.keyframe || {};
    const motion = keyframe.motion_contract || {};
    return [
        keyframeString(keyframe.prompt, 'A polished cinematic opening frame matching the screenplay.'),
        '',
        'This image is exactly frame 0.00 of a video, not a poster, collage, or sequence.',
        `Subject orientation: ${keyframeString(motion.subject_orientation, 'consistent with the first action')}`,
        `Gaze: ${keyframeString(motion.gaze_direction, 'consistent with the first action')}`,
        `Travel direction: ${keyframeString(motion.travel_direction, 'consistent with the first action')}`,
        `Camera: ${keyframeString(motion.camera_relation, 'the camera position used by the first shot')}`,
        `First-second continuation: ${keyframeString(motion.first_second_action, 'continue the depicted action smoothly')}`,
        'Preserve the explicitly requested closed cast and identity details. Give moving subjects clear lead room.',
        'Compose frame 0 so the described continuation requires no turn, reversal, gaze snap, axis crossing, teleport, or reframe.',
    ].join('\n');
}

function recordUsage(response: GenerateContentResponse): void {
    const usage = response.usageMetadata;
    console.log(
        `[Video keyframe] ${VIDEO_KEYFRAME_MODEL}: ${Number(usage?.promptTokenCount || 0)} input, `
        + `${Number(usage?.candidatesTokenCount || 0) + Number(usage?.thoughtsTokenCount || 0)} output tokens, 1 image`,
    );
}

export async function createFrontierVideoKeyframe(
    plan: Record<string, any>,
): Promise<VideoKeyframeResult> {
    const client = new GoogleGenAI({
        apiKey: config.geminiApiKey,
        apiVersion: 'v1alpha',
    });
    const generation = client.models.generateContent({
        model: VIDEO_KEYFRAME_MODEL,
        contents: [{ role: 'user', parts: [{ text: buildVideoKeyframePrompt(plan) }] }],
        config: {
            responseModalities: ['IMAGE'],
            imageConfig: {
                aspectRatio: '16:9',
                imageSize: '2K',
            },
        },
    });
    let timeout: NodeJS.Timeout | undefined;
    const response = await Promise.race([
        generation,
        new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('Gemini first-frame generation timed out.')), 3 * 60 * 1000);
        }),
    ]).finally(() => {
        if (timeout) clearTimeout(timeout);
    });
    const imagePart = response.candidates
        ?.flatMap(candidate => candidate.content?.parts || [])
        .find(part => part.inlineData?.mimeType?.startsWith('image/') && part.inlineData?.data);
    if (!imagePart?.inlineData?.data) {
        throw new Error('Gemini returned no first-frame image.');
    }
    const mimeType = imagePart.inlineData.mimeType?.split(';')[0].toLowerCase();
    if (mimeType !== 'image/jpeg' && mimeType !== 'image/png' && mimeType !== 'image/webp') {
        throw new Error(`Gemini returned unsupported image type ${mimeType || 'unknown'}.`);
    }
    const bytes = Buffer.from(imagePart.inlineData.data, 'base64');
    if (!bytes.length || bytes.length > VIDEO_KEYFRAME_MAX_BYTES) {
        throw new Error('Gemini first-frame image was empty or too large.');
    }
    recordUsage(response);
    return {
        bytes,
        mimeType,
        provider: VIDEO_KEYFRAME_PROVIDER,
        model: VIDEO_KEYFRAME_MODEL,
    };
}
