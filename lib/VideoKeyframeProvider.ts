import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';

import { AI_MODELS } from './AIModels.js';
import { config } from './Config.js';

export const VIDEO_KEYFRAME_MODEL = AI_MODELS.geminiImage;
export const VIDEO_KEYFRAME_PROVIDER = 'gemini';
export const VIDEO_KEYFRAME_FALLBACK_MODEL = AI_MODELS.openAIImage;
export const VIDEO_KEYFRAME_REVIEW_MODEL = AI_MODELS.openAIChat;
export const VIDEO_KEYFRAME_MAX_BYTES = 25 * 1024 * 1024;

export interface VideoKeyframeResult {
    bytes: Buffer;
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
    provider: string;
    model: string;
}

export interface VideoKeyframeReview {
    acceptable: boolean;
    issues: string[];
    correction_prompt: string;
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

export function buildVideoKeyframeReviewPrompt(plan: Record<string, any>): string {
    const firstSegment = Array.isArray(plan?.segments) ? plan.segments[0] : null;
    const firstShot = Array.isArray(firstSegment?.shots) ? firstSegment.shots[0] : null;
    return [
        `Requested intent: ${keyframeString(plan?.intent, 'match the supplied screenplay')}`,
        `Frame-zero specification: ${keyframeString(plan?.keyframe?.prompt, 'match the supplied screenplay')}`,
        `Motion contract: ${JSON.stringify(plan?.keyframe?.motion_contract || {})}`,
        `First-shot visual: ${keyframeString(firstShot?.visual, 'continue the depicted action')}`,
        `First-shot camera: ${keyframeString(firstShot?.camera, 'continue from the depicted camera')}`,
        '',
        'Audit the attached candidate as the literal first frame of that video. Treat stylized or caricatured likenesses as valid when the named people remain readily distinguishable.',
        'Reject it if the requested closed cast/count is wrong, key identities are not visibly distinguishable, important subjects or props are missing, or the composition contradicts the motion contract.',
        'For moving subjects, explicitly trace the physical front/nose, visible road or path ahead, gaze, screen direction, and vanishing point. Reject a frame that would require an immediate turn, reversal, gaze snap, axis crossing, teleport, or reframe.',
        'If rejected, correction_prompt must be a concrete positive-only description of the corrected visible frame. Describe only wanted subjects and geometry; do not repeat unwanted names or write negations.',
    ].join('\n');
}

function recordUsage(response: GenerateContentResponse): void {
    const usage = response.usageMetadata;
    console.log(
        `[Video keyframe] ${VIDEO_KEYFRAME_MODEL}: ${Number(usage?.promptTokenCount || 0)} input, `
        + `${Number(usage?.candidatesTokenCount || 0) + Number(usage?.thoughtsTokenCount || 0)} output tokens, 1 image`,
    );
}

function checkedImageResult(
    bytes: Buffer,
    mimeType: string,
    provider: string,
    model: string,
): VideoKeyframeResult {
    const normalized = mimeType.split(';')[0].toLowerCase();
    if (normalized !== 'image/jpeg' && normalized !== 'image/png' && normalized !== 'image/webp') {
        throw new Error(`${provider} returned unsupported image type ${normalized || 'unknown'}.`);
    }
    if (!bytes.length || bytes.length > VIDEO_KEYFRAME_MAX_BYTES) {
        throw new Error(`${provider} first-frame image was empty or too large.`);
    }
    return {
        bytes,
        mimeType: normalized,
        provider,
        model,
    } as VideoKeyframeResult;
}

async function generateGeminiKeyframe(prompt: string): Promise<VideoKeyframeResult> {
    const client = new GoogleGenAI({
        apiKey: config.geminiApiKey,
        apiVersion: 'v1alpha',
    });
    const generation = client.models.generateContent({
        model: VIDEO_KEYFRAME_MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
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
    recordUsage(response);
    return checkedImageResult(
        Buffer.from(imagePart.inlineData.data, 'base64'),
        imagePart.inlineData.mimeType || '',
        VIDEO_KEYFRAME_PROVIDER,
        VIDEO_KEYFRAME_MODEL,
    );
}

async function generateOpenAIKeyframe(prompt: string): Promise<VideoKeyframeResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3 * 60 * 1000);
    try {
        const response = await fetch('https://api.openai.com/v1/images/generations', {
            method: 'POST',
            signal: controller.signal,
            headers: {
                authorization: `Bearer ${config.openaiApiKey}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: VIDEO_KEYFRAME_FALLBACK_MODEL,
                prompt,
                size: '1536x864',
                quality: 'high',
                output_format: 'png',
                moderation: 'low',
                n: 1,
            }),
        });
        const body: any = await response.json();
        if (!response.ok) {
            throw new Error(body?.error?.message || `OpenAI returned HTTP ${response.status}.`);
        }
        const encoded = body?.data?.[0]?.b64_json;
        if (!encoded) throw new Error('OpenAI returned no first-frame image.');
        return checkedImageResult(
            Buffer.from(encoded, 'base64'),
            'image/png',
            'openai',
            VIDEO_KEYFRAME_FALLBACK_MODEL,
        );
    } finally {
        clearTimeout(timeout);
    }
}

function responseOutputText(response: any): string {
    if (typeof response?.output_text === 'string' && response.output_text.trim()) {
        return response.output_text.trim();
    }
    for (const item of response?.output || []) {
        if (item?.type !== 'message') continue;
        for (const content of item.content || []) {
            if (content?.type === 'output_text' && typeof content.text === 'string') {
                return content.text.trim();
            }
        }
    }
    throw new Error(response?.error?.message || 'First-frame reviewer returned no result.');
}

export async function reviewVideoKeyframe(
    plan: Record<string, any>,
    image: VideoKeyframeResult,
): Promise<VideoKeyframeReview> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3 * 60 * 1000);
    try {
        const response = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            signal: controller.signal,
            headers: {
                authorization: `Bearer ${config.openaiApiKey}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: VIDEO_KEYFRAME_REVIEW_MODEL,
                reasoning: { effort: 'high' },
                instructions: 'You are the final visual quality gate for an expensive image-to-video render. Judge only visible evidence and physical continuity. Output the required JSON.',
                input: [{
                    role: 'user',
                    content: [
                        { type: 'input_text', text: buildVideoKeyframeReviewPrompt(plan) },
                        {
                            type: 'input_image',
                            image_url: `data:${image.mimeType};base64,${image.bytes.toString('base64')}`,
                            detail: 'high',
                        },
                    ],
                }],
                text: {
                    verbosity: 'low',
                    format: {
                        type: 'json_schema',
                        name: 'video_keyframe_review',
                        strict: true,
                        schema: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['acceptable', 'issues', 'correction_prompt'],
                            properties: {
                                acceptable: { type: 'boolean' },
                                issues: {
                                    type: 'array',
                                    maxItems: 8,
                                    items: { type: 'string' },
                                },
                                correction_prompt: { type: 'string' },
                            },
                        },
                    },
                },
                max_output_tokens: 4000,
                store: false,
            }),
        });
        const body: any = await response.json();
        if (!response.ok) {
            throw new Error(body?.error?.message || `OpenAI review returned HTTP ${response.status}.`);
        }
        const review = JSON.parse(responseOutputText(body));
        if (typeof review?.acceptable !== 'boolean' || !Array.isArray(review?.issues)
            || typeof review?.correction_prompt !== 'string') {
            throw new Error('First-frame reviewer returned invalid structured output.');
        }
        const usage = body?.usage;
        console.log(
            `[Video keyframe review] ${VIDEO_KEYFRAME_REVIEW_MODEL}: ${Number(usage?.input_tokens || 0)} input, `
            + `${Number(usage?.output_tokens || 0)} output tokens; ${review.acceptable ? 'accepted' : 'rejected'}`,
        );
        return review as VideoKeyframeReview;
    } finally {
        clearTimeout(timeout);
    }
}

async function optionalReview(
    plan: Record<string, any>,
    image: VideoKeyframeResult,
): Promise<VideoKeyframeReview | null> {
    try {
        return await reviewVideoKeyframe(plan, image);
    } catch (error) {
        console.warn('Frontier first-frame visual review was unavailable; accepting the generated candidate.', error);
        return null;
    }
}

export async function createFrontierVideoKeyframe(
    plan: Record<string, any>,
): Promise<VideoKeyframeResult> {
    const basePrompt = buildVideoKeyframePrompt(plan);
    const first = await generateGeminiKeyframe(basePrompt);
    const firstReview = await optionalReview(plan, first);
    if (!firstReview || firstReview.acceptable) return first;

    console.warn(`Gemini first-frame candidate rejected: ${firstReview.issues.join('; ')}`);
    const retryPrompt = [
        basePrompt,
        '',
        'Regenerate the image using this positive-only quality-control correction:',
        keyframeString(firstReview.correction_prompt, 'Strictly align every subject with the declared motion contract and keep every requested identity clearly visible.'),
    ].join('\n');
    const second = await generateGeminiKeyframe(retryPrompt);
    const secondReview = await optionalReview(plan, second);
    if (!secondReview || secondReview.acceptable) return second;

    console.warn(`Second Gemini first-frame candidate rejected: ${secondReview.issues.join('; ')}`);
    const fallbackPrompt = [
        retryPrompt,
        '',
        'Final quality-control correction:',
        keyframeString(secondReview.correction_prompt, firstReview.correction_prompt),
    ].join('\n');
    const fallback = await generateOpenAIKeyframe(fallbackPrompt);
    const fallbackReview = await optionalReview(plan, fallback);
    if (!fallbackReview || fallbackReview.acceptable) return fallback;
    throw new Error(
        `All frontier first-frame candidates failed visual review: ${fallbackReview.issues.join('; ')}`,
    );
}
