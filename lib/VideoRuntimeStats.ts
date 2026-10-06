export function videoPlanRuntimeScale({
    plannedDuration,
    plannedSegments,
    sampleDuration,
    sampleSegments,
    sourceFactor = 1,
}: {
    plannedDuration: number;
    plannedSegments: number;
    sampleDuration: number;
    sampleSegments: number;
    sourceFactor?: number;
}): number {
    const plannedAverage = plannedDuration / Math.max(1, plannedSegments);
    const sampleAverage = sampleDuration / Math.max(1, sampleSegments);
    const segmentRatio = Math.max(0.01, plannedSegments / Math.max(1, sampleSegments));
    // Each generated clip has a fixed setup/decode cost, while sampling grows
    // with frames per clip. Scale the full clip count and only compare average
    // clip duration so duration and segment count are not counted twice.
    const perSegmentDurationRatio = plannedAverage / Math.max(0.01, sampleAverage);
    const perSegmentFactor = Math.max(0.25, Math.min(
        4,
        0.25 + 0.75 * perSegmentDurationRatio,
    ));
    // Roughly 15% of a normal job is fixed planning/delivery work. The old
    // combined 4x ceiling made every unusually long screenplay underestimate.
    return Math.max(0.15, 0.15 + 0.85 * segmentRatio * perSegmentFactor * sourceFactor);
}

export function projectedVideoFinishAt({
    now,
    startedAt,
    expectedRuntime,
    progress,
    progressScope,
}: {
    now: number;
    startedAt: number;
    expectedRuntime: number;
    progress: number | null;
    progressScope: 'job' | 'stage' | null;
}): number {
    const historicalFinish = startedAt + Math.max(1, expectedRuntime);
    if (progressScope !== 'job' || progress === null || progress < 0.02 || progress >= 1) {
        return Math.max(now + 30, Math.round(historicalFinish));
    }
    const elapsed = Math.max(1, now - startedAt);
    const observedRuntime = elapsed / Math.max(0.001, progress);
    // Let measured pace take over gradually, reaching 90% authority after
    // roughly one third of the render while retaining a little historical
    // stability for pauses and coarse progress boundaries.
    const observedWeight = Math.min(0.9, Math.max(0, (progress - 0.02) * 3));
    // An expired historical estimate has zero remaining work, not negative work
    // that can cancel out the time still needed at the measured render pace.
    const historicalRemaining = Math.max(0, historicalFinish - now);
    const observedRemaining = Math.max(0, observedRuntime - elapsed);
    const remaining = historicalRemaining * (1 - observedWeight)
        + observedRemaining * observedWeight;
    return Math.max(now + 30, Math.round(now + remaining));
}

export function average(values: Array<number | null | undefined>): number | null {
    const finite = values.filter((value): value is number => Number.isFinite(value));
    return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

export function median(values: Array<number | null | undefined>): number | null {
    const finite = values
        .filter((value): value is number => Number.isFinite(value))
        .sort((a, b) => a - b);
    if (!finite.length) return null;
    const middle = Math.floor(finite.length / 2);
    return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

export function percentile(values: Array<number | null | undefined>, fraction: number): number | null {
    const finite = values
        .filter((value): value is number => Number.isFinite(value))
        .sort((a, b) => a - b);
    if (!finite.length) return null;
    return finite[Math.min(finite.length - 1, Math.max(0, Math.ceil(finite.length * fraction) - 1))];
}

export function minimum(values: Array<number | null | undefined>): number | null {
    const finite = values.filter((value): value is number => Number.isFinite(value));
    return finite.length ? Math.min(...finite) : null;
}

export function maximum(values: Array<number | null | undefined>): number | null {
    const finite = values.filter((value): value is number => Number.isFinite(value));
    return finite.length ? Math.max(...finite) : null;
}
