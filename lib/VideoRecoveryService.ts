import { pinVideoPlanToAudio, VideoSourceAudioLyrics } from './VideoSourceAudio.js';
import { configuredVideoPlannerVariant, createFrontierVideoPlan, FrontierPlannerRejectedError, VideoPlanSourceImage } from './VideoFrontierPlanner.js';
import { VideoFrontierCallOptions, VideoPlannerRequestLimitError, VideoUsagePersistenceError, withVideoPlannerRequestLimit } from './VideoUsage.js';
import { videoTextModelCapabilities } from './VideoModelCapabilities.js';
import { VIDEO_MUSE_PLANNER_MODEL, VIDEO_MODELS, VideoModelId } from './VideoProtocol.js';
import { approvedRecoveryContract, recoveryHash, repairVideoTiming, requireRecoveryPlanningPolicy } from './VideoRecovery.js';
import { classificationReviewHash, reviewVideoMinorClassification, VideoClassificationReview } from './VideoClassificationReview.js';

export class RecoveryStoppedError extends Error {}

/** The frontier planner rejected the request; the worker must plan it with local Qwen. */
export class RecoveryLocalPlanRequired extends Error {
    constructor(readonly reasonCode: string, readonly promptAnalysis: Record<string, any> | null, message: string) {
        super(message);
        this.name = 'RecoveryLocalPlanRequired';
    }
}

interface ClassificationReviewContext {
    prompt: string;
    sources: VideoPlanSourceImage[];
    options: VideoFrontierCallOptions;
    classificationReviews?: VideoClassificationReview[];
    onClassificationReview?: (review: VideoClassificationReview) => Promise<void>;
    classificationReviewer?: typeof reviewVideoMinorClassification;
}

async function localPlanRequired(reasonCode: string, promptAnalysis: Record<string, any> | null,
    message: string, context: ClassificationReviewContext): Promise<Error> {
    if (reasonCode === 'minor_sexualization') {
        const input = { ...context, rejectedModel: context.options.plannerModel || configuredVideoPlannerVariant().plannerModel };
        const hash = classificationReviewHash(input);
        let review = context.classificationReviews?.find(item => item.input_hash === hash
            && item.rejected_model === input.rejectedModel);
        if (!review) {
            try {
                review = await (context.classificationReviewer || reviewVideoMinorClassification)(input);
                await context.onClassificationReview?.(review);
            } catch (error) {
                if (error instanceof VideoUsagePersistenceError) throw error;
                return new RecoveryStoppedError('Video planning stopped because the independent safety review could not be completed or saved. No video was rendered.');
            }
        }
        if (review.verdict !== 'cleared') {
            return new RecoveryStoppedError(review.verdict === 'confirmed'
                ? 'Independent review confirmed sexual content involving minors; this request cannot be planned.'
                : 'Video planning stopped because a safety classification could not be verified. No video was rendered.');
        }
        return new RecoveryLocalPlanRequired('classification_cleared', {
            ...promptAnalysis,
            // The worker re-analyzes policy-refused contracts against the original prompt.
            // Clearing the safety label does not certify the rejected analysis as faithful.
            frontier_handling: { disposition: 'reject', reason_code: 'provider_policy',
                reason: 'Independent review cleared an unsupported classification; a new local screenplay is required.' },
            classification_review: review,
        }, 'Independent review cleared the planner classification; continuing with local planning.');
    }
    return new RecoveryLocalPlanRequired(/^[a-z_]+$/.test(reasonCode) ? reasonCode : 'other', promptAnalysis, message);
}

export async function prepareRecoveryPlan(input: {
    prompt: string; model: VideoModelId; requester: string; sources: VideoPlanSourceImage[];
    options: VideoFrontierCallOptions; planner?: typeof createFrontierVideoPlan;
    sourceAudioSeconds?: number;
    sourceAudioLyrics?: VideoSourceAudioLyrics | null;
    requireSourceIdentity?: boolean; requireOriginalFirstFrame?: boolean;
} & Pick<ClassificationReviewContext, 'classificationReviews' | 'onClassificationReview' | 'classificationReviewer'>): Promise<any> {
    if ((input.requireSourceIdentity || input.requireOriginalFirstFrame) && !input.sources.length) {
        throw new RecoveryStoppedError('The required original character reference is missing.');
    }
    const prompt = input.prompt;
    const useSources = true;
    const planner = input.planner || createFrontierVideoPlan;
    const plannerModel = input.options.plannerModel || configuredVideoPlannerVariant().plannerModel;
    const options = videoTextModelCapabilities(plannerModel).provider === 'meta'
        ? withVideoPlannerRequestLimit(input.options, 2) : input.options;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const plan: any = await planner(prompt, input.model, input.requester,
                input.sources, {
                    ...options,
                    ...(input.sourceAudioSeconds ? { truncateAutomaticDuration: false } : {}),
                    plannerGuidance: `${input.options.plannerGuidance || ''}\nPreserve all permitted speech and major story beats. The requested total runtime is binding; preserve every requested scene and line, and never extend the runtime without authorization. Shot timings are flexible; divide long speech across segments rather than truncating it. For a mouthless source character, speech comes from its established speaker or voice mechanism without adding human facial anatomy or lip sync. When action must finish before speech, allocate separate timed action and speaking shots and reserve the full speaking duration after the action.`
                        + (input.requireSourceIdentity ? '\nThe supplied character identity is required. Do not invent a replacement person or change their anatomy, body proportions, hair, or clothing.' : '')
                        + (input.requireOriginalFirstFrame ? '\nFrame zero must be the supplied portrait itself, fully framed and unchanged. Set keyframe.recommended=false. Start in its exact pose, crop and background, then reveal the permitted story through motion or later shots.' : ''),
                });
            const handling = plan?.prompt_analysis?.frontier_handling;
            if (handling?.disposition === 'reject') {
                throw await localPlanRequired(String(handling.reason_code || 'other'), plan.prompt_analysis,
                    'The frontier planner rejected the original request.', input);
            }
            if (input.requireOriginalFirstFrame && plan.keyframe?.recommended !== false) {
                throw new Error('The screenplay did not retain the required original portrait as its opening frame.');
            }
            const isH3 = VIDEO_MODELS[input.model].generatorModel === 'h3';
            repairVideoTiming(plan, isH3 ? 15 : 20, isH3 ? 5 : 3);
            if (input.sourceAudioSeconds) pinVideoPlanToAudio(plan, input.sourceAudioSeconds, input.sourceAudioLyrics);
            requireRecoveryPlanningPolicy(plan, input.sourceAudioSeconds ?? input.options.requestedDurationSeconds);
            const notice = String(plan.generation_notice || '').trim();
            const contract = approvedRecoveryContract(plan, prompt, notice, useSources);
            if (input.requireSourceIdentity || input.requireOriginalFirstFrame) contract.source_reference_required = true;
            if (input.requireOriginalFirstFrame) contract.original_first_frame = true;
            return { plan, contract, contract_hash: recoveryHash(contract), prompt, notice };
        } catch (error) {
            if (error instanceof VideoUsagePersistenceError) throw error;
            if (error instanceof VideoPlannerRequestLimitError) {
                throw await localPlanRequired('planner_budget_exhausted', null, error.message, input);
            }
            if (error instanceof FrontierPlannerRejectedError) {
                throw await localPlanRequired(error.reasonCode, error.promptAnalysis, error.message, input);
            }
            if (error instanceof RecoveryStoppedError || error instanceof RecoveryLocalPlanRequired
                || attempt === 1) throw error;
        }
    }
    throw new Error('Waiting for an approved screenplay.');
}

function useMuseFallback(options: VideoFrontierCallOptions): boolean {
    return process.env.VIDEO_MUSE_FALLBACK !== '0'
        && (options.plannerModel || configuredVideoPlannerVariant().plannerModel) !== VIDEO_MUSE_PLANNER_MODEL;
}

function museFallbackOptions(options: VideoFrontierCallOptions): VideoFrontierCallOptions {
    return { ...options, plannerModel: VIDEO_MUSE_PLANNER_MODEL, plannerStrategy: 'single-pass',
        plannerPromptVariant: 'baseline', analysisReasoningEffort: 'low', screenplayReasoningEffort: 'low',
        maxRequestAttempts: 1, onProvisionalKeyframe: undefined };
}

/** Try the bounded cloud fallback before handing an unplanned recovery job to the GPU worker. */
export async function prepareRecoveryPlanWithMuseFallback(input: Parameters<typeof prepareRecoveryPlan>[0]): Promise<any> {
    try {
        return await prepareRecoveryPlan(input);
    } catch (original) {
        if (!(original instanceof RecoveryLocalPlanRequired) || !useMuseFallback(input.options)) throw original;
        try {
            const prepared = await prepareRecoveryPlan({ ...input, options: museFallbackOptions(input.options) });
            prepared.plan._planner_model = VIDEO_MUSE_PLANNER_MODEL;
            return prepared;
        } catch (error) {
            if (error instanceof RecoveryStoppedError || error instanceof VideoUsagePersistenceError) throw error;
            // Keep the original dialogue contract for the final local fallback, including on resume.
            throw new RecoveryLocalPlanRequired(original.reasonCode, original.promptAnalysis,
                `Muse fallback did not produce an approved plan: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

/** Legacy worker planning uses the same fallback model and accounting hooks. */
export async function createVideoPlanWithMuseFallback(
    prompt: string, model: VideoModelId, requester: string,
    sources: VideoPlanSourceImage | VideoPlanSourceImage[] | undefined,
    options: VideoFrontierCallOptions, planner = createFrontierVideoPlan,
): Promise<Record<string, any>> {
    const checkedPlan = async (callOptions: VideoFrontierCallOptions, fallback = false): Promise<Record<string, any>> => {
        try {
            const plan = await planner(prompt, model, requester, sources, callOptions);
            const handling = (plan.prompt_analysis as any)?.frontier_handling;
            if (handling?.disposition === 'reject' && (fallback || handling.reason_code === 'minor_sexualization')) {
                throw new FrontierPlannerRejectedError(handling.reason_code || 'other',
                    'Video planner declined the request.', plan.prompt_analysis as any);
            }
            return plan;
        } catch (error) {
            if (!(error instanceof FrontierPlannerRejectedError) || error.reasonCode !== 'minor_sexualization') throw error;
            const reviewed = await localPlanRequired(error.reasonCode, error.promptAnalysis, error.message, {
                prompt, sources: Array.isArray(sources) ? sources : sources ? [sources] : [], options: callOptions,
            });
            if (reviewed instanceof RecoveryLocalPlanRequired) {
                throw new FrontierPlannerRejectedError(reviewed.reasonCode, reviewed.message, reviewed.promptAnalysis);
            }
            throw new FrontierPlannerRejectedError('minor_sexualization', reviewed.message, error.promptAnalysis);
        }
    };
    try {
        return await checkedPlan(options);
    } catch (original) {
        if (!useMuseFallback(options) || original instanceof VideoUsagePersistenceError
            || (original instanceof FrontierPlannerRejectedError && original.reasonCode === 'minor_sexualization')) throw original;
        try {
            const plan = await checkedPlan(museFallbackOptions(options), true);
            return { ...plan, _planner_model: VIDEO_MUSE_PLANNER_MODEL };
        } catch (error) {
            if (error instanceof VideoUsagePersistenceError
                || (error instanceof FrontierPlannerRejectedError && error.reasonCode === 'minor_sexualization')) throw error;
            throw new FrontierPlannerRejectedError(
                original instanceof FrontierPlannerRejectedError ? original.reasonCode : 'other',
                `Muse fallback did not produce an approved plan: ${error instanceof Error ? error.message : String(error)}`,
                original instanceof FrontierPlannerRejectedError ? original.promptAnalysis : null,
            );
        }
    }
}
