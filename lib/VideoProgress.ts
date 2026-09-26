/** Recovery runs the generator once per scene. Its local 1/1 is not job progress. */
export interface VideoProgress {
    progress: number;
    progress_scope: 'job';
    segment_index: number;
    segment_count: number;
    segment_progress: number | null;
}

export function recoveryProgressContext(row: any, state = JSON.parse(row.recovery_json || '{}')) {
    const segments = state.prepared?.plan?.segments;
    if (!row.recovery_version || !Array.isArray(segments) || !segments.length) return null;
    const scenes = state.checkpoint?.scenes || {};
    const next = segments.findIndex((_: any, index: number) => !scenes[index]?.video_accepted);
    const index = next < 0 ? segments.length - 1 : next;
    // Include per-clip setup/decode cost, then weight sampling by generated duration.
    // Use target_seconds, not output_seconds: an opening trimmed to two seconds
    // can still require a five-second render.
    const weights = segments.map((segment: any) => {
        const seconds = Number(segment.target_seconds);
        return 0.25 + 0.75 * (Number.isFinite(seconds) && seconds > 0 ? seconds : 5) / 5;
    });
    return { index, count: segments.length, scene: scenes[index] || {}, scenes, weights,
        total: weights.reduce((sum: number, weight: number) => sum + weight, 0), done: next < 0 };
}

/** Also repairs pre-update rows whose local scene progress was stored as job progress. */
export function recoveryVideoProgress(row: any, message?: any, reset = false): VideoProgress | null {
    const context = recoveryProgressContext(row);
    if (!context || ['ready', 'delivered', 'failed', 'cancelled'].includes(row.status)) return null;
    const { index, count, scene, scenes, weights, total, done } = context;
    const sameScene = row.segment_index === index + 1 && row.segment_count === count;
    const legacySample = row.segment_count === 1 && count > 1 && scene.render_interrupted;
    let fraction: number | null = !reset && (sameScene || legacySample) ? row.segment_progress : null;
    if (message && !done && scene.render_interrupted) {
        // A checkpoint resets the sample at scene/attempt boundaries. Heartbeats
        // can still carry the previous scene's 100% until the next generator starts.
        const starting = message.type === 'event'
            && /^Generating\s+\S+\s+segment\s+\d+\/\d+\b/i.test(message.stage || '');
        if (starting) fraction = 0;
        else if (fraction !== null && typeof message.segment_progress === 'number'
            && Number.isFinite(message.segment_progress)) fraction = message.segment_progress;
    }
    fraction = typeof fraction === 'number' && Number.isFinite(fraction)
        ? Math.min(1, Math.max(0, fraction)) : null;
    const completed = weights.reduce((sum: number, weight: number, i: number) =>
        sum + (scenes[i]?.video_accepted ? weight : 0), 0);
    return {
        progress: row.status === 'uploading' ? 0.99 : done ? 0.98
            : 0.98 * (completed + (done ? 0 : weights[index] * (fraction || 0))) / total,
        progress_scope: 'job', segment_index: index + 1, segment_count: count,
        segment_progress: done ? 1 : fraction,
    };
}

export function recoveryCheckpointProgress(row: any, state: any): VideoProgress | null {
    const before = recoveryProgressContext(row);
    const after = recoveryProgressContext(row, state);
    const reset = before?.index !== after?.index
        || before?.scene.video_attempts !== after?.scene.video_attempts
        || before?.scene.cycles !== after?.scene.cycles;
    return recoveryVideoProgress({ ...row, recovery_json: JSON.stringify(state) }, undefined, reset);
}
