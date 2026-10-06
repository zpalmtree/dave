import { GoogleGenAI, ThinkingLevel } from '@google/genai';

import { AI_MODELS } from './AIModels.js';
import { config } from './Config.js';
import { geminiCompatibleResponseSchema } from './VideoFrontierPlanner.js';
import { VideoProviderHooks, geminiVideoUsage, videoRequestInputTokenBound } from './VideoUsage.js';

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
    identity_scope: 'recurring' | 'new';
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
            maxItems: 63,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['segment_index', 'identity_scope', 'prompt', 'motion_contract'],
                properties: {
                    segment_index: { type: 'integer', minimum: 2, maximum: 64 },
                    identity_scope: { type: 'string', enum: ['recurring', 'new'] },
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
        const identityScope = candidate?.identity_scope === 'new' ? 'new' : 'recurring';
        const prompt = String(candidate?.prompt || '').trim();
        const motion = Object.fromEntries(MOTION_FIELDS.map(field => [
            field,
            String(candidate?.motion_contract?.[field] || '').trim(),
        ])) as VideoSegmentKeyframeContract['motion_contract'];
        if (!expected.has(segmentIndex) || seen.has(segmentIndex) || !prompt
            || MOTION_FIELDS.some(field => !motion[field])) continue;
        seen.add(segmentIndex);
        contracts.push({
            segment_index: segmentIndex,
            identity_scope: identityScope,
            prompt,
            motion_contract: motion,
        });
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
        await hooks.beforeRequest?.({ stage: 'segment_keyframe_contracts', attempt: 1,
            provider: 'google', model: VIDEO_SEGMENT_KEYFRAME_PLANNER_MODEL,
            maxInputTokens: videoRequestInputTokenBound({ prompt, plan, targetContext }), maxOutputTokens: 32_000 });
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
                    'Set identity_scope to recurring only when the target segment visibly includes the same source/frame-zero subject. Set it to new when the segment introduces different cast and the source subject is not present; a thematic relationship alone does not make a new person the same identity.',
                    'Preserve recurring identity, closed cast and count, wardrobe, props, scale, location, and the distinctive premise. Use positive-only visual wording.',
                    'Return exactly one contract for every supplied target index.',
                ].join('\n'),
                responseMimeType: 'application/json',
                responseJsonSchema: geminiCompatibleResponseSchema(
                    SEGMENT_KEYFRAME_CONTRACT_SCHEMA as unknown as Record<string, any>,
                ),
                maxOutputTokens: 32_000,
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            },
        });
        const usage = response.usageMetadata;
        await hooks.onUsage?.({
            stage: 'segment_keyframe_contracts',
            attempt: 1,
            outcome: 'success',
            provider: 'google',
            model: response.modelVersion || VIDEO_SEGMENT_KEYFRAME_PLANNER_MODEL,
            serviceTier: 'default',
            ...geminiVideoUsage(usage),
        });
        const contracts = validatedContracts(JSON.parse(String(response.text || '')), targets);
        outcome = 'success';
        return contracts;
    } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
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

export function videoSegmentUsesFrameZeroIdentity(
    plan: Record<string, any>,
    segmentIndex: number,
): boolean {
    const segments = Array.isArray(plan?.segments) ? plan.segments : [];
    const firstLabel = String(segments[0]?.overlay_label || '').trim();
    const targetLabel = String(segments[segmentIndex - 1]?.overlay_label || '').trim();
    if (targetLabel && targetLabel !== 'N/A' && targetLabel !== firstLabel) return false;
    const explicit = (Array.isArray(plan?.segment_keyframes) ? plan.segment_keyframes : [])
        .find((candidate: any) => Number(candidate?.segment_index) === segmentIndex);
    if (explicit?.identity_scope === 'new') return false;
    if (explicit?.identity_scope === 'recurring') return true;
    const segment = segments[segmentIndex - 1];
    const firstShot = Array.isArray(segment?.shots) ? segment.shots[0] : null;
    const targetText = [segment?.title, firstShot?.visual, explicit?.prompt]
        .map(value => String(value || ''))
        .join(' ');
    return !/\b(?:another|different|new|separate|independent)\s+(?:person|man|woman|girl|boy|worker|employee|character|subject|protagonist|cast\s+member|racer)\b/i
        .test(targetText);
}

export function derivedSegmentKeyframePlan(plan: Record<string, any>, segmentIndex: number): Record<string, any> | null {
    const segment = Array.isArray(plan?.segments) ? plan.segments[segmentIndex - 1] : null;
    const firstShot = Array.isArray(segment?.shots) ? segment.shots[0] : null;
    if (!segment || !firstShot || !['cut', 'dissolve'].includes(String(segment.transition))) return null;
    const title = String(segment.title || `Segment ${segmentIndex}`).trim();
    const overlayLabel = String(segment.overlay_label || '').trim();
    const independentlyLabeled = Boolean(overlayLabel && overlayLabel !== 'N/A');
    const usesFrameZeroIdentity = videoSegmentUsesFrameZeroIdentity(plan, segmentIndex);
    const visual = String(firstShot.visual || '').trim();
    const camera = String(firstShot.camera || '').trim();
    if (!visual || !camera) return null;
    const explicit = (Array.isArray(plan?.segment_keyframes) ? plan.segment_keyframes : [])
        .find((candidate: any) => Number(candidate?.segment_index) === segmentIndex);
    const explicitPrompt = String(explicit?.prompt || '').trim();
    const explicitMotion = explicit?.motion_contract;
    const hasExplicitContract = Boolean(explicitPrompt && [
        'subject_orientation',
        'gaze_direction',
        'travel_direction',
        'camera_relation',
        'first_second_action',
    ].every(field => String(explicitMotion?.[field] || '').trim()));
    return {
        intent: String(plan.intent || visual),
        continuity_bible: String(plan.continuity_bible || ''),
        keyframe: {
            recommended: true,
            reason: independentlyLabeled
                ? `Anchor the independently selected identity ${overlayLabel}.`
                : usesFrameZeroIdentity
                    ? `Preserve the recurring cast across the ${segment.transition} into ${title}.`
                    : `Establish the newly introduced cast for ${title}.`,
            prompt: [
                hasExplicitContract ? explicitPrompt : [
                    `Opening still for segment ${segmentIndex}, ${title}: ${visual}`,
                    `Camera and framing: ${camera}.`,
                    independentlyLabeled
                        ? `Depict ${overlayLabel} as the only selected identity; reserve a blank opaque nameplate with no readable text for postproduction.`
                        : usesFrameZeroIdentity
                            ? 'Use the supplied identity reference to depict the same recognizable recurring person or people in this new shot composition.'
                            : 'Establish only the newly introduced subject or cast required by this segment from the target visual.',
                    independentlyLabeled
                        ? 'Do not copy the preceding segment identity.'
                        : usesFrameZeroIdentity
                            ? 'Preserve their facial identity, body proportions, hair, skin tone, and defining appearance while placing them in the pose, wardrobe, environment, lighting, and action required by this segment.'
                            : 'Give the new cast internally consistent faces, body proportions, hair, skin tone, wardrobe, and defining appearance for this segment.',
                    'Show one frozen, motion-ready instant at 0.00 seconds of this segment.',
                ].join(' '),
                independentlyLabeled || !usesFrameZeroIdentity ? '' : (
                    'Treat the supplied identity reference as the sole authority for facial anatomy: '
                    + 'match its eye aperture, eye shape and spacing, iris and pupil scale, nose and '
                    + 'nostril shape, cheek contour, lip proportions, jaw width, and chin silhouette. '
                    + 'Match the reference haircut geometry: hairline, height, top contour, and outer silhouette. '
                    + 'The visible reference overrides conflicting written identity descriptions or haircut labels in the screenplay. '
                    + 'A new rendering style must not replace these features with generic face anatomy.'
                ),
            ].filter(Boolean).join(' '),
            reference_requirements: [],
            motion_contract: hasExplicitContract ? {
                subject_orientation: String(explicitMotion.subject_orientation).trim(),
                gaze_direction: String(explicitMotion.gaze_direction).trim(),
                travel_direction: String(explicitMotion.travel_direction).trim(),
                camera_relation: String(explicitMotion.camera_relation).trim(),
                first_second_action: String(explicitMotion.first_second_action).trim(),
            } : {
                subject_orientation: 'Orient each recurring subject for the opening action described by this segment.',
                gaze_direction: 'Direct each subject gaze toward the focus of the opening action.',
                travel_direction: 'Show the travel vector implied by the opening action and composition.',
                camera_relation: camera,
                first_second_action: `Continue directly into this action: ${visual}`,
            },
        },
        segments: [segment],
    };
}
