import { GoogleGenAI, ThinkingLevel } from '@google/genai';

import { AI_MODELS } from './AIModels.js';
import { config } from './Config.js';
import { geminiCompatibleResponseSchema } from './VideoFrontierPlanner.js';
import { VideoProviderHooks, VideoUsagePersistenceError } from './VideoUsage.js';

export const VIDEO_SEGMENT_KEYFRAME_PLANNER_MODEL = AI_MODELS.geminiChat;

const MOTION_FIELDS = [
    'subject_orientation',
    'gaze_direction',
    'travel_direction',
    'camera_relation',
    'first_second_action',
] as const;

export interface VideoSegmentKeyframeContract {
    segment_index: number;
    prompt: string;
    motion_contract: Record<typeof MOTION_FIELDS[number], string>;
}

const SEGMENT_KEYFRAME_CONTRACT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['contracts'],
    properties: {
        contracts: {
            type: 'array',
            maxItems: 7,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['segment_index', 'prompt', 'motion_contract'],
                properties: {
                    segment_index: { type: 'integer', minimum: 2, maximum: 8 },
                    prompt: { type: 'string' },
                    motion_contract: {
                        type: 'object',
                        additionalProperties: false,
                        required: MOTION_FIELDS,
                        properties: Object.fromEntries(MOTION_FIELDS.map(field => [field, { type: 'string' }])),
                    },
                },
            },
        },
    },
} as const;

export function videoSegmentKeyframeTargetIndexes(plan: Record<string, any>): number[] {
    return (Array.isArray(plan?.segments) ? plan.segments : []).flatMap((segment: any, index: number) =>
        index >= 1 && ['cut', 'dissolve'].includes(String(segment?.transition)) ? [index + 1] : []);
}

function validatedContracts(value: any, targets: number[]): VideoSegmentKeyframeContract[] {
    const expected = new Set(targets);
    const seen = new Set<number>();
    const contracts: VideoSegmentKeyframeContract[] = [];
    for (const candidate of Array.isArray(value?.contracts) ? value.contracts : []) {
        const segmentIndex = Number(candidate?.segment_index);
        const prompt = String(candidate?.prompt || '').trim();
        const motion = Object.fromEntries(MOTION_FIELDS.map(field => [
            field,
            String(candidate?.motion_contract?.[field] || '').trim(),
        ])) as VideoSegmentKeyframeContract['motion_contract'];
        if (!expected.has(segmentIndex) || seen.has(segmentIndex) || !prompt
            || MOTION_FIELDS.some(field => !motion[field])) continue;
        seen.add(segmentIndex);
        contracts.push({ segment_index: segmentIndex, prompt, motion_contract: motion });
    }
    if (contracts.length !== targets.length || targets.some(index => !seen.has(index))) {
        throw new Error('Gemini Flash omitted or duplicated a hard-cut frame-zero contract.');
    }
    return contracts.sort((left, right) => left.segment_index - right.segment_index);
}

export async function createVideoSegmentKeyframeContracts(
    prompt: string,
    plan: Record<string, any>,
    hooks: VideoProviderHooks = {},
): Promise<VideoSegmentKeyframeContract[]> {
    const targets = videoSegmentKeyframeTargetIndexes(plan);
    if (!targets.length) return [];
    const targetContext = targets.map(segmentIndex => ({
        segment_index: segmentIndex,
        previous_segment: plan.segments[segmentIndex - 2] || null,
        target_segment: plan.segments[segmentIndex - 1],
    }));
    const client = new GoogleGenAI({ apiKey: config.geminiApiKey, apiVersion: 'v1alpha' });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    const started = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let detail: string | undefined;
    try {
        const response = await client.models.generateContent({
            model: VIDEO_SEGMENT_KEYFRAME_PLANNER_MODEL,
            contents: [{
                role: 'user',
                parts: [{
                    text: [
                        `Original request: ${prompt}`,
                        `Intent: ${String(plan.intent || '')}`,
                        `Continuity bible: ${String(plan.continuity_bible || '')}`,
                        `Targets: ${JSON.stringify(targetContext)}`,
                    ].join('\n'),
                }],
            }],
            config: {
                abortSignal: controller.signal,
                systemInstruction: [
                    'Write exact frame-zero contracts for hard-cut image-to-video segments. Do not rewrite the screenplay.',
                    'Each prompt describes only the frozen visible state at precisely 0.00 seconds, never a sequence or completed beat.',
                    'Move all change after frame zero into first_second_action. For approach, boarding, insertion, ignition, landing, stepping, reveal, opening, or transformation, stage the instant immediately before or at onset so MiniMax H3 can visibly perform it.',
                    'Make subject orientation, gaze, physical front or vehicle nose, travel vector, visible path ahead, lead room, camera side, and vanishing direction mutually consistent.',
                    'Preserve recurring identity, closed cast and count, wardrobe, props, scale, location, and the distinctive premise. Use positive-only visual wording.',
                    'Return exactly one contract for every supplied target index.',
                ].join('\n'),
                responseMimeType: 'application/json',
                responseJsonSchema: geminiCompatibleResponseSchema(
                    SEGMENT_KEYFRAME_CONTRACT_SCHEMA as unknown as Record<string, any>,
                ),
                maxOutputTokens: 8_000,
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            },
        });
        const usage = response.usageMetadata;
        const contracts = validatedContracts(JSON.parse(String(response.text || '')), targets);
        await hooks.onUsage?.({
            stage: 'segment_keyframe_contracts',
            attempt: 1,
            outcome: 'success',
            provider: 'google',
            model: response.modelVersion || VIDEO_SEGMENT_KEYFRAME_PLANNER_MODEL,
            serviceTier: 'default',
            inputTokens: Math.max(
                0,
                Number(usage?.promptTokenCount || 0) - Number(usage?.cachedContentTokenCount || 0),
            ),
            outputTokens: Number(usage?.candidatesTokenCount || 0) + Number(usage?.thoughtsTokenCount || 0),
            cacheReadTokens: Number(usage?.cachedContentTokenCount || 0),
        });
        outcome = 'success';
        return contracts;
    } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
        if (error instanceof VideoUsagePersistenceError) throw error;
        throw error;
    } finally {
        clearTimeout(timeout);
        await hooks.onAttempt?.({
            stage: 'segment_keyframe_contracts',
            attempt: 1,
            outcome,
            provider: 'google',
            model: VIDEO_SEGMENT_KEYFRAME_PLANNER_MODEL,
            serviceTier: 'default',
            durationSeconds: (Date.now() - started) / 1000,
            detail,
        });
    }
}
