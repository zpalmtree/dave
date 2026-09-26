import { createHash } from 'crypto';

// Version 3 workers can plan, compose opening images, and review locally.
export const VIDEO_RECOVERY_VERSION = 3;
export const VIDEO_RECOVERY_MAX_FAILURES = 3;
export const VIDEO_RECOVERY_MAX_RENDER_ATTEMPTS = 2;

/** Persisted budgets survive reconnects and broker/worker restarts. */
export function recoveryLimitReached(state: any): boolean {
    return Number(state?.waits || 0) >= VIDEO_RECOVERY_MAX_FAILURES
        || Object.values(state?.checkpoint?.scenes || {}).some((scene: any) =>
            !scene.video_accepted && !scene.pending_video && !scene.render_interrupted
            && (Number(scene.cycles || 0) > 0
                || Number(scene.video_attempts || 0) >= VIDEO_RECOVERY_MAX_RENDER_ATTEMPTS));
}
export type VideoOutputFormat = 'generated';
export interface VideoRecoveryContract {
    version: 1;
    prompt: string;
    analysis: Record<string, any>;
    segments: any[];
    notice: string;
    use_source_images: boolean;
    source_reference_required?: boolean;
    original_first_frame?: boolean;
    /** Set when the frontier planner rejected the request and local Qwen planned it. */
    planner?: 'local';
    local_reason?: string;
}

export function recoveryHash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function normalizedRecoverySpeech(value: unknown): string {
    return String(value || '').normalize('NFKC').toLowerCase()
        // Spanish spelling marks may be supplied by the planner or transcriber.
        // Fold vowel accents only: distinct letters such as ñ must still match.
        .replace(/[áéíóúü]/g, vowel => vowel.normalize('NFD')[0])
        .replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}']+/gu, ' ').trim();
}

export function recoveryDialogue(plan: any): any[] {
    return (plan?.segments || []).flatMap((segment: any) =>
        (segment.shots || []).flatMap((shot: any) => shot.dialogue || []));
}

export class UnapprovedLocalRecoveryPlanError extends Error {}

function requireProtectedRecoveryDialogue(plan: any, analyses: any[]): void {
    const actual = normalizedRecoverySpeech(recoveryDialogue(plan).map(line => line.text).join(' '));
    for (const analysis of analyses) {
        const contract = analysis?.dialogue_contract;
        if (!contract || contract.mode === 'none') continue;
        if (!actual) throw new UnapprovedLocalRecoveryPlanError('Required dialogue is missing from the local screenplay.');
        let cursor = 0;
        for (const line of contract.lines || []) {
            if (!line?.verbatim) continue;
            const required = normalizedRecoverySpeech(line.text);
            const index = actual.indexOf(required, cursor);
            if (required && index < 0) {
                throw new UnapprovedLocalRecoveryPlanError('Approved dialogue was lost during local planning.');
            }
            cursor = index + required.length;
        }
    }
}

function speechSeconds(lines: any[]): number {
    return lines.reduce((total, line) => total
        + (String(line.spoken_text || line.text || '').match(/[\p{L}\p{N}_'-]+/gu) || []).length / (140 / 60)
        // A run such as "..." or "?!" is one pause, not one per mark.
        + (String(line.spoken_text || line.text || '').match(/[.!?;,\u2026]+/g) || []).length * 0.15
        + 0.3, lines.length ? 1.25 : 0);
}

/** Allocate legal render windows without deleting dialogue or story beats. */
export function repairVideoTiming(plan: any, maximum: number, minimum: number): void {
    if (!Array.isArray(plan?.segments)) return;
    const repaired: any[] = [];
    const oldIndexes: number[] = [];
    for (const [originalIndex, original] of plan.segments.entries()) {
        if (!Array.isArray(original?.shots) || !original.shots.length) continue;
        oldIndexes[originalIndex] = repaired.length + 1;
        const lines = original.shots.flatMap((shot: any) => shot.dialogue || []);
        if (original.shots.length <= 4 && Number(original.target_seconds) >= minimum
            && Number(original.target_seconds) <= maximum && speechSeconds(lines) <= Number(original.target_seconds)
            && original.shots.every((shot: any) => speechSeconds(shot.dialogue || []) <= Number(shot.duration_seconds))) {
            repaired.push(original);
            continue;
        }
        const pieces: any[] = [];
        const authoredCuts = new Set<any>();
        for (const [shotIndex, shot] of original.shots.entries()) {
            const lines = Array.isArray(shot.dialogue) ? shot.dialogue : [];
            const batches: any[][] = [[]];
            for (const line of lines) {
                let words = String(line.text || '').trim().split(/\s+/).filter(Boolean);
                const parts: any[] = [];
                while (words.length) {
                    let count = 1;
                    while (count < words.length && speechSeconds([{ ...line,
                        text: words.slice(0, count + 1).join(' '), spoken_text: undefined }]) <= maximum - 0.5) count++;
                    if (count < words.length) {
                        // Prefer a sentence or clause boundary when it fits; never
                        // delete words to satisfy the renderer's duration limit.
                        for (let boundary = count; boundary >= Math.ceil(count / 2); boundary--) {
                            if (/[.!?;,:]$/.test(words[boundary - 1])) { count = boundary; break; }
                        }
                    }
                    const part = { ...line, text: words.slice(0, count).join(' ') };
                    if (part.text !== line.text) delete part.spoken_text;
                    parts.push(part);
                    words = words.slice(count);
                }
                for (const part of parts) {
                    const batch = batches[batches.length - 1];
                    if (batch.length && speechSeconds([...batch, part]) > maximum - 0.5) batches.push([]);
                    batches[batches.length - 1].push(part);
                }
            }
            for (const [batchIndex, batch] of batches.entries()) {
                const authored = Number(shot.duration_seconds) || minimum;
                const seconds = Math.max(0.5, Math.min(maximum, authored / batches.length), speechSeconds(batch));
                const piece = { ...shot, duration_seconds: Math.min(maximum, seconds), dialogue: batch };
                if (shotIndex > 0 && batchIndex === 0) authoredCuts.add(piece);
                pieces.push(piece);
            }
        }
        let shots: any[] = [];
        const flush = () => {
            if (!shots.length) return;
            const target = Math.max(minimum, shots.reduce((sum, shot) => sum + shot.duration_seconds, 0));
            const result = { ...original, shots, target_seconds: target };
            delete result.output_seconds;
            result.transition = repaired.length === 0 ? 'start'
                : repaired.length + 1 === oldIndexes[originalIndex] ? original.transition
                    : authoredCuts.has(shots[0]) ? 'cut' : 'continue';
            repaired.push(result);
            shots = [];
        };
        for (const piece of pieces) {
            if (shots.length && (shots.length >= 4
                || shots.reduce((sum, shot) => sum + shot.duration_seconds, 0) + piece.duration_seconds > maximum)) flush();
            shots.push(piece);
        }
        flush();
    }
    plan.segments = repaired;
    if (Array.isArray(plan.segment_keyframes)) {
        plan.segment_keyframes = plan.segment_keyframes.map((frame: any) => ({
            ...frame, segment_index: oldIndexes[Number(frame.segment_index) - 1],
        })).filter((frame: any) => frame.segment_index > 1);
    }
}

export function approvedRecoveryContract(plan: any, prompt: string, notice = '', useSources = true): VideoRecoveryContract {
    const analysis = plan?.prompt_analysis;
    if (!analysis || analysis.frontier_handling?.disposition !== 'fulfill') {
        throw new Error('Waiting for an approved story before rendering.');
    }
    if (!Array.isArray(plan.segments) || !plan.segments.length || plan.quality_gate_bypassed) {
        throw new Error('Waiting for a screenplay that preserves the approved story.');
    }
    const actual = normalizedRecoverySpeech(recoveryDialogue(plan).map(line => line.text).join(' '));
    let cursor = 0;
    for (const line of analysis.dialogue_contract?.lines || []) {
        if (!line.verbatim) continue;
        const required = normalizedRecoverySpeech(line.text);
        const index = actual.indexOf(required, cursor);
        if (required && index < 0) throw new Error('Approved dialogue was lost during planning.');
        cursor = index + required.length;
    }
    if (analysis.dialogue_contract?.mode !== 'none' && !actual) throw new Error('Required dialogue is missing.');
    return JSON.parse(JSON.stringify({
        version: 1, prompt, analysis, segments: plan.segments, notice, use_source_images: useSources,
    }));
}

/**
 * The local planner sometimes marks a segment that keeps the same shot as a hard cut.
 * Such a segment should open on the previous clip's last frame rather than on a newly
 * generated image of the same framing, which loses the source's look.
 */
export function continueUnbrokenLocalSegments(plan: any): void {
    for (const [index, segment] of (Array.isArray(plan?.segments) ? plan.segments : []).entries()) {
        if (index === 0 || segment?.transition !== 'cut') continue;
        const opening = String(segment.shots?.[0]?.visual || '').split(/(?<=[.!?])\s/)[0];
        if (/\b(?:remains?|is still|stays?|continues?)\b/i.test(opening)
            && !/\b(?:cuts?|new|elsewhere|meanwhile|later|another|different|flashback)\b/i.test(opening)) {
            segment.transition = 'continue';
        }
    }
}

/**
 * A frontier rejection hands planning to the desktop's local Qwen. Its screenplay
 * becomes the contract; the rejected frontier content decision no longer applies.
 */
export function approvedLocalRecoveryContract(plan: any, prompt: string, reason: string,
    notice = '', useSources = true, frontierAnalysis?: any): VideoRecoveryContract {
    if (!Array.isArray(plan?.segments) || !plan.segments.length
        || plan.segments.some((segment: any) => !Array.isArray(segment?.shots) || !segment.shots.length)) {
        throw new UnapprovedLocalRecoveryPlanError('The local screenplay has no renderable scenes.');
    }
    if (plan.quality_gate_bypassed) {
        throw new UnapprovedLocalRecoveryPlanError('The local screenplay failed its quality gate.');
    }
    requireProtectedRecoveryDialogue(plan, [frontierAnalysis, plan.prompt_analysis, plan.semantic_analysis]);
    let linkedScenes = 0;
    for (const segment of plan.segments) {
        linkedScenes = segment.transition === 'continue' ? linkedScenes + 1 : 1;
        if (linkedScenes > 4) {
            throw new UnapprovedLocalRecoveryPlanError(
                'The local screenplay needs a fresh shot after four linked scenes to prevent visual drift.');
        }
    }
    return JSON.parse(JSON.stringify({
        version: 1, prompt, analysis: plan.prompt_analysis || plan.semantic_analysis || {},
        segments: plan.segments, notice, use_source_images: useSources, planner: 'local', local_reason: reason,
    }));
}
