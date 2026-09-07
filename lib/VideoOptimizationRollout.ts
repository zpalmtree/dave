import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { videoTextModelCapabilities } from './VideoModelCapabilities.js';
import type { VideoKeyframeOptions } from './VideoKeyframeProvider.js';

export interface VideoOptimizationSelection {
    experimentId: string;
    variantId: string;
    options: VideoKeyframeOptions;
    rendererProfile?: 'fasth3-fixed-duration';
}

/** An audited release file is opt-in; absent/incomplete evidence always keeps the control. */
export function selectVideoOptimization(
    release: any, command: string, jobId: string,
): VideoOptimizationSelection | null {
    if (release?.schema_version !== 1 || !/^[a-zA-Z0-9_-]{1,80}$/.test(release.experiment_id || '')) return null;
    const arm = release.commands?.[command];
    if (!['minimax', 'oalgo'].includes(command) || !arm || ![10, 50, 100].includes(arm.percentage)) return null;
    const proof = arm.evidence;
    if (!proof || proof.decision !== 'qualified' || proof.accounting_complete !== true
        || proof.human_video_review_complete !== true || !/^[a-f0-9]{64}$/.test(proof.report_sha256 || '')) return null;
    const reviews = Array.isArray(arm.delivery_reviews) ? arm.delivery_reviews : [];
    if (reviews.some((review: any) => review.material_failure === true || review.failed === true)) return null;
    const reviewed = new Set(reviews.filter((review: any) => review.review_complete === true
        && review.delivered === true && review.material_failure === false && typeof review.job_id === 'string')
        .map((review: any) => review.job_id)).size;
    if ((arm.percentage >= 50 && reviewed < 10) || (arm.percentage === 100 && reviewed < 30)) return null;
    const bucket = Number.parseInt(createHash('sha256').update(`${release.experiment_id}:${command}:${jobId}`).digest('hex').slice(0, 8), 16) % 100;
    if (bucket >= arm.percentage) return null;
    const options: VideoKeyframeOptions = {};
    if (arm.planner) {
        if (proof.planner_holdout_passed !== true) return null;
        const capability = videoTextModelCapabilities(arm.planner.model);
        if (!['low', 'medium', 'high'].includes(arm.planner.effort) || !capability.efforts.includes(arm.planner.effort)) return null;
        Object.assign(options, { plannerModel: arm.planner.model, plannerStrategy: 'single-pass',
            analysisReasoningEffort: arm.planner.effort, screenplayReasoningEffort: arm.planner.effort });
    }
    if (arm.reviewer) {
        if (proof.human_frame_review_complete !== true || proof.reviewer_passed !== true) return null;
        const capability = videoTextModelCapabilities(arm.reviewer.model);
        if (!['low', 'medium', 'high'].includes(arm.reviewer.effort) || !capability.efforts.includes(arm.reviewer.effort)) return null;
        Object.assign(options, { reviewModel: arm.reviewer.model, reviewReasoningEffort: arm.reviewer.effort });
    }
    if (arm.composite) {
        if (command !== 'oalgo' || proof.human_frame_review_complete !== true || proof.composite_passed !== true
            || arm.composite.model !== 'gemini-3.1-flash-image' || arm.composite.size !== '1K') return null;
        Object.assign(options, { geminiModel: arm.composite.model, imageSize: arm.composite.size });
    }
    if (arm.renderer && (arm.renderer !== 'fasth3-fixed-duration' || proof.renderer_passed !== true)) return null;
    if (!arm.planner && !arm.reviewer && !arm.composite && !arm.renderer) return null;
    return { experimentId: release.experiment_id, variantId: `${command}-candidate`, options,
        ...(arm.renderer ? { rendererProfile: arm.renderer } : {}) };
}

export function configuredVideoOptimization(command: string, jobId: string): VideoOptimizationSelection | null {
    const path = process.env.VIDEO_OPTIMIZATION_RELEASE_FILE;
    if (!path) return null;
    try { return selectVideoOptimization(JSON.parse(readFileSync(path, 'utf8')), command, jobId); }
    catch (error) {
        console.warn('[Video optimization] Invalid rollout configuration; keeping the control.', error instanceof Error ? error.message : 'Invalid release');
        return null;
    }
}
