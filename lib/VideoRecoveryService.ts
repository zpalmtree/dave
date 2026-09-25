import { pinVideoPlanToAudio } from './VideoSourceAudio.js';
import { createFrontierVideoPlan, FrontierPlannerRejectedError, VideoPlanSourceImage } from './VideoFrontierPlanner.js';
import { VideoFrontierCallOptions } from './VideoUsage.js';
import { VideoModelId } from './VideoProtocol.js';
import { approvedRecoveryContract, recoveryHash, repairVideoTiming } from './VideoRecovery.js';

export class RecoveryStoppedError extends Error {}

/** The frontier planner rejected the request; the worker must plan it with local Qwen. */
export class RecoveryLocalPlanRequired extends Error {
    constructor(readonly reasonCode: string, readonly promptAnalysis: Record<string, any> | null, message: string) {
        super(message);
        this.name = 'RecoveryLocalPlanRequired';
    }
}

function localPlanRequired(reasonCode: string, promptAnalysis: Record<string, any> | null, message: string): Error {
    if (reasonCode === 'minor_sexualization') {
        return new RecoveryStoppedError(`Video planner declined the request: ${message} Sexual content involving minors is never planned locally.`);
    }
    return new RecoveryLocalPlanRequired(/^[a-z_]+$/.test(reasonCode) ? reasonCode : 'other', promptAnalysis, message);
}

export async function prepareRecoveryPlan(input: {
    prompt: string; model: VideoModelId; requester: string; sources: VideoPlanSourceImage[];
    options: VideoFrontierCallOptions; planner?: typeof createFrontierVideoPlan;
    sourceAudioSeconds?: number;
    requireSourceIdentity?: boolean; requireOriginalFirstFrame?: boolean;
}): Promise<any> {
    if ((input.requireSourceIdentity || input.requireOriginalFirstFrame) && !input.sources.length) {
        throw new RecoveryStoppedError('The required original character reference is missing.');
    }
    const prompt = input.prompt;
    const notice = '';
    const useSources = true;
    const planner = input.planner || createFrontierVideoPlan;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const plan: any = await planner(prompt, input.model, input.requester,
                useSources ? input.sources : undefined, {
                    ...input.options,
                    plannerGuidance: `${input.options.plannerGuidance || ''}\nPreserve all permitted speech and major story beats. Shot timings are flexible; divide long speech across segments rather than truncating it. For a mouthless source character, speech comes from its established speaker or voice mechanism without adding human facial anatomy or lip sync. When action must finish before speech, allocate separate timed action and speaking shots and reserve the full speaking duration after the action.`
                        + (input.requireSourceIdentity ? '\nThe supplied character identity is required. Do not invent a replacement person or change their anatomy, body proportions, hair, or clothing.' : '')
                        + (input.requireOriginalFirstFrame ? '\nFrame zero must be the supplied portrait itself, fully framed and unchanged. Set keyframe.recommended=false. Start in its exact pose, crop and background, then reveal the permitted story through motion or later shots.' : ''),
                });
            const handling = plan?.prompt_analysis?.frontier_handling;
            if (handling?.disposition === 'reject') {
                throw localPlanRequired(String(handling.reason_code || 'other'), plan.prompt_analysis,
                    'The frontier planner rejected the original request.');
            }
            if (input.requireOriginalFirstFrame && plan.keyframe?.recommended !== false) {
                throw new Error('The screenplay did not retain the required original portrait as its opening frame.');
            }
            repairVideoTiming(plan, 15, 5);
            if (input.sourceAudioSeconds) pinVideoPlanToAudio(plan, input.sourceAudioSeconds);
            const contract = approvedRecoveryContract(plan, prompt, notice, useSources);
            if (input.requireSourceIdentity || input.requireOriginalFirstFrame) contract.source_reference_required = true;
            if (input.requireOriginalFirstFrame) contract.original_first_frame = true;
            return { plan, contract, contract_hash: recoveryHash(contract), prompt, notice };
        } catch (error) {
            if (error instanceof FrontierPlannerRejectedError) {
                throw localPlanRequired(error.reasonCode, error.promptAnalysis, error.message);
            }
            if (error instanceof RecoveryStoppedError || error instanceof RecoveryLocalPlanRequired
                || attempt === 1) throw error;
        }
    }
    throw new Error('Waiting for an approved screenplay.');
}
