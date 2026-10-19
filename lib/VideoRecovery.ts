import { createHash } from 'crypto';
import { requestedVideoDurationSeconds } from './VideoProtocol.js';

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

/** A policy refusal may replace requested speech with placeholders or a rewritten line.
 * Only its verbatim text actually present in the request can bind local fulfillment.
 * The local analysis and fidelity check remain responsible for the complete request.
 */
function localRecoveryDialogueAnalysis(analysis: any, prompt: string): any {
    const handling = analysis?.frontier_handling;
    if (handling?.disposition !== 'reject' || handling?.reason_code !== 'provider_policy') return analysis;
    const brief = ` ${normalizedRecoverySpeech(prompt)} `;
    const lines = (analysis.dialogue_contract?.lines || []).filter((line: any) => {
        const text = normalizedRecoverySpeech(line?.text);
        return line?.verbatim && text && brief.includes(` ${text} `);
    });
    return { dialogue_contract: { mode: lines.length ? 'verbatim' : 'none', lines } };
}

function requireProtectedRecoveryDialogue(plan: any, analyses: any[], prompt: string): void {
    const actual = normalizedRecoverySpeech(recoveryDialogue(videoPlanBeforeDurationCut(plan)).map(line => line.text).join(' '));
    for (const analysis of analyses) {
        const contract = localRecoveryDialogueAnalysis(analysis, prompt)?.dialogue_contract;
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
    // Keep this estimate in sync with video_gen.dialogue_floor_seconds. The
    // renderer validates approved plans too, including their final cut points.
    const spoken = lines.filter(line => String(line.text || '').trim());
    if (!spoken.length) return 0;
    return spoken.reduce((total, line) => {
        const text = String(line.text);
        const fast = /\b(?:fast|rapid|double[- ]?time|rap|rapping)\b/i.test(String(line.delivery || ''));
        return total + (text.match(/[\p{L}\p{N}_][\p{L}\p{N}_'-]*/gu) || []).length / ((fast ? 220 : 140) / 60)
            + (text.match(/[,;]/g) || []).length * (fast ? 0.12 : 0.25)
            // A run such as "..." or "?!" is one pause, not one per mark.
            + (text.match(/[.!?\u2026]+/g) || []).length * (fast ? 0.20 : 0.45);
    }, 1.25 + Math.max(0, spoken.length - 1) * 0.4);
}

export function videoDialogueFloorSeconds(segment: any): number {
    return speechSeconds((segment?.shots || []).flatMap((shot: any) => shot.dialogue || []));
}

/** A shot's physical place, or '' when the planner gave none (older and fallback plans). */
function shotLocation(shot: any): string {
    return String(shot?.location || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function locationChanges(shots: any[]): boolean {
    const places = shots.map(shotLocation).filter(Boolean);
    return places.some(place => place !== places[0]);
}

/**
 * Allocate legal render windows without deleting dialogue or story beats. A change of
 * shot location also starts a new scene: H3 invents an unanchored in-clip location from
 * text alone and drifts toward cartoon rendering, while a new scene gets its own opening.
 */
export function repairVideoTiming(plan: any, maximum: number, minimum: number): void {
    if (!Array.isArray(plan?.segments)) return;
    const repaired: any[] = [];
    const oldIndexes: number[] = [];
    for (const [originalIndex, original] of plan.segments.entries()) {
        if (!Array.isArray(original?.shots) || !original.shots.length) continue;
        oldIndexes[originalIndex] = repaired.length + 1;
        const lines = original.shots.flatMap((shot: any) => shot.dialogue || []);
        const relocated = locationChanges(original.shots);
        if (!relocated && original.shots.length <= 4 && Number(original.target_seconds) >= minimum
            && Number(original.target_seconds) <= maximum && speechSeconds(lines) <= Number(original.target_seconds)
            && speechSeconds(lines) <= Number(original.output_seconds ?? original.target_seconds)
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
                if (shotIndex > 0 && batchIndex === 0
                    && (shot.camera_transition !== 'continuous'
                        || shotLocation(shot) !== shotLocation(original.shots[shotIndex - 1]))) authoredCuts.add(piece);
                pieces.push(piece);
            }
        }
        let shots: any[] = [];
        const flush = () => {
            if (!shots.length) return;
            const authored = shots.reduce((sum, shot) => sum + shot.duration_seconds, 0);
            const target = Math.max(minimum, authored);
            const result = { ...original, shots, target_seconds: target };
            delete result.output_seconds;
            const first = repaired.length + 1 === oldIndexes[originalIndex];
            if (relocated) {
                // Render at least the minimum, but keep a short relocated beat short in the cut.
                if (authored < target) result.output_seconds = Math.max(0.5, authored);
                if (!first) result.overlay_label = 'N/A';
            }
            result.transition = repaired.length === 0 ? 'start'
                : first ? original.transition
                    : authoredCuts.has(shots[0]) ? 'cut' : 'continue';
            repaired.push(result);
            shots = [];
        };
        for (const piece of pieces) {
            if (shots.length && (shots.length >= 4
                || (relocated && shotLocation(piece)
                    && shotLocation(piece) !== (shots.map(shotLocation).find(Boolean) || shotLocation(piece)))
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

export const VIDEO_AUTOMATIC_LIMIT_SECONDS = 120;

/** Keep complete opening segments; preserve the omitted tail for fidelity checks and diagnostics. */
export function truncateAutomaticVideoPlan(plan: any, requestedSeconds?: number | null): void {
    if (requestedSeconds != null || plan.duration_truncation) return;
    const segments = plan.segments || [];
    let seconds = 0;
    let count = 0;
    for (const segment of segments) {
        const target = Number(segment.target_seconds);
        if (!Number.isFinite(target) || target <= 0) throw new Error('Invalid screenplay duration.');
        if (seconds + target > VIDEO_AUTOMATIC_LIMIT_SECONDS + 1e-6) break;
        seconds += target;
        count++;
    }
    if (count === segments.length) return;
    if (!count) throw new Error('No complete screenplay segment fits the automatic duration limit.');
    const retained = segments.slice(0, count);
    plan.duration_truncation = {
        retained_sha256: recoveryHash(retained),
        omitted_segments: segments.slice(count),
        original_segment_keyframes: plan.segment_keyframes,
    };
    plan.segments = retained;
    if (Array.isArray(plan.segment_keyframes)) {
        plan.segment_keyframes = plan.segment_keyframes.filter((frame: any) => frame.segment_index <= count);
    }
    delete plan.recovery_extended;
    plan.generation_notice = [String(plan.generation_notice || '').trim(),
        `This video keeps the first ${Number(seconds.toFixed(1))} seconds of planned footage; `
        + `the rest of the story was omitted to fit the ${VIDEO_AUTOMATIC_LIMIT_SECONDS}-second limit.`,
    ].filter(Boolean).join(' ');
}

/** Reconstruct only a verified, unchanged opening cut, never an arbitrary missing-dialogue waiver. */
export function videoPlanBeforeDurationCut(plan: any): any {
    const cut = plan?.duration_truncation;
    if (!cut) return plan;
    const seconds = (plan.segments || []).reduce((sum: number, segment: any) => sum + Number(segment.target_seconds), 0);
    const omitted = cut.omitted_segments;
    if (!Array.isArray(omitted) || !omitted.length || !plan.segments?.length
        || cut.retained_sha256 !== recoveryHash(plan.segments)
        || !Number.isFinite(seconds) || seconds <= 0 || seconds > VIDEO_AUTOMATIC_LIMIT_SECONDS + 1e-6
        || !(seconds + Number(omitted[0].target_seconds) > VIDEO_AUTOMATIC_LIMIT_SECONDS + 1e-6)) {
        throw new UnapprovedLocalRecoveryPlanError('The duration-limited screenplay is not an unchanged opening sequence.');
    }
    const original = { ...plan, segments: [...plan.segments, ...omitted],
        segment_keyframes: cut.original_segment_keyframes };
    delete original.duration_truncation;
    return original;
}

/** Approval cannot silently authorize omitted content or a different runtime. */
export function requireRecoveryPlanningPolicy(plan: any, requestedSeconds?: number | null): void {
    videoPlanBeforeDurationCut(plan);
    if (plan?.duration_truncation && requestedSeconds != null) {
        throw new UnapprovedLocalRecoveryPlanError('An explicit runtime cannot use an automatic duration cutoff.');
    }
    if (plan?.best_effort_truncated) {
        throw new UnapprovedLocalRecoveryPlanError('The screenplay was truncated; preserve every requested scene and line before rendering.');
    }
    if (requestedSeconds == null) return;
    const total = (plan?.segments || []).reduce((sum: number, segment: any) =>
        sum + Number(segment.output_seconds ?? segment.target_seconds), 0);
    if (!Number.isFinite(total) || Math.abs(total - requestedSeconds) > 0.05) {
        throw new UnapprovedLocalRecoveryPlanError(
            `Duration conflict: this screenplay delivers ${total.toFixed(2)}s, but the requested runtime is ${requestedSeconds}s. `
            + 'Preserve every requested scene and line and replan within the runtime; a longer video needs authorization.');
    }
}

export function approvedRecoveryContract(plan: any, prompt: string, notice = '', useSources = true): VideoRecoveryContract {
    requireRecoveryPlanningPolicy(plan, requestedVideoDurationSeconds(prompt));
    const analysis = plan?.prompt_analysis;
    if (!analysis || analysis.frontier_handling?.disposition !== 'fulfill') {
        throw new Error('Waiting for an approved story before rendering.');
    }
    if (!Array.isArray(plan.segments) || !plan.segments.length || plan.quality_gate_bypassed) {
        throw new Error('Waiting for a screenplay that preserves the approved story.');
    }
    const actual = normalizedRecoverySpeech(recoveryDialogue(videoPlanBeforeDurationCut(plan)).map(line => line.text).join(' '));
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
    requireRecoveryPlanningPolicy(plan, requestedVideoDurationSeconds(prompt));
    if (plan.quality_gate_bypassed) {
        const issues = (Array.isArray(plan.quality_gate_issues) ? plan.quality_gate_issues : [])
            .slice(0, 4).map((issue: any) => String(issue).replace(/\s+/g, ' ').slice(0, 400)).join('; ');
        const attempts = Number(plan.planner?.screenplay_attempts);
        throw new UnapprovedLocalRecoveryPlanError('The local screenplay failed its quality gate'
            + (Number.isInteger(attempts) && attempts > 0 ? ` after ${attempts} screenplay attempts` : '')
            + (issues ? `: ${issues}.` : '.') + ' No video was rendered.');
    }
    requireProtectedRecoveryDialogue(plan, [frontierAnalysis, plan.prompt_analysis, plan.semantic_analysis], prompt);
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
