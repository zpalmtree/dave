import {
    VIDEO_MODELS,
    VideoGeneratorModelId,
    VideoMetricSpan,
    VideoModelId,
    VideoWorkerMetrics,
    VideoWorkerSchedulerState,
    isVideoModel,
    sanitizeVideoWorkerText,
} from './VideoProtocol.js';

export function generatorModel(value: unknown): VideoGeneratorModelId | null {
    return value === 'ltx' || value === 'h3' ? value : null;
}

export function workerScheduler(value: unknown): VideoWorkerSchedulerState {
    if (!value || typeof value !== 'object') {
        return { available: true, mode: 'normal', health: 'healthy' };
    }
    const scheduler = value as Record<string, unknown>;
    return {
        available: scheduler.available === true,
        mode: typeof scheduler.mode === 'string'
            ? scheduler.mode as VideoWorkerSchedulerState['mode']
            : null,
        gaming_ready: scheduler.gaming_ready === true,
        health: typeof scheduler.health === 'string'
            ? scheduler.health as VideoWorkerSchedulerState['health']
            : null,
    };
}

export function schedulerPausesDispatch(value: VideoWorkerSchedulerState): boolean {
    return value.mode === 'enteringGaming' || value.mode === 'gaming';
}

export function schedulerAcceptsReservations(value: VideoWorkerSchedulerState): boolean {
    return value.available && !schedulerPausesDispatch(value);
}

export interface WorkerProgressFields {
    progress: number | null;
    scope: 'job' | 'stage' | null;
    segmentIndex: number | null;
    segmentCount: number | null;
    segmentProgress: number | null;
}

export function workerProgressFields(message: any): WorkerProgressFields {
    const progress = typeof message.progress === 'number' && Number.isFinite(message.progress)
        ? Math.min(1, Math.max(0, message.progress))
        : null;
    const scope = message.progress_scope === 'job'
        ? 'job'
        : message.progress_scope === 'stage' ? 'stage' : null;
    const segmentCount = Number.isInteger(message.segment_count)
        ? Math.min(100, Math.max(1, Number(message.segment_count)))
        : null;
    const segmentIndexCandidate = Number.isInteger(message.segment_index)
        ? Math.max(1, Number(message.segment_index))
        : null;
    const segmentIndex = segmentCount !== null && segmentIndexCandidate !== null
        ? Math.min(segmentCount, segmentIndexCandidate)
        : null;
    const segmentProgress = typeof message.segment_progress === 'number'
        && Number.isFinite(message.segment_progress)
        ? Math.min(1, Math.max(0, message.segment_progress))
        : null;
    return { progress, scope, segmentIndex, segmentCount, segmentProgress };
}

export function boundedNumber(
    value: unknown,
    minimum: number,
    maximum: number,
    nullable = true,
): number | null {
    if ((value === null || value === undefined || value === '') && nullable) return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) {
        throw new Error(`Metric must be a finite number between ${minimum} and ${maximum}.`);
    }
    return number;
}

function boundedMetricText(value: unknown, maximum = 160): string | null {
    if (value === null || value === undefined || value === '') return null;
    const text = sanitizeVideoWorkerText(value, '', maximum);
    if (!text || text.includes('[local file]')) throw new Error('Metric text contains a local path.');
    return text;
}

function optionalGeneratorModel(value: unknown): VideoGeneratorModelId | null {
    if (value === null || value === undefined || value === '') return null;
    const model = generatorModel(value);
    if (!model) throw new Error('Invalid warm model metric.');
    return model;
}

export function normalizedMetricSpan(value: any): VideoMetricSpan {
    if (!value || typeof value !== 'object') throw new Error('Invalid metric span.');
    if (!['broker', 'worker', 'comfy'].includes(String(value.source))) {
        throw new Error('Invalid metric span source.');
    }
    const name = boundedMetricText(value.name, 120);
    if (!name) throw new Error('Metric span name is required.');
    const segment = value.segment_index === null || value.segment_index === undefined
        ? null
        : boundedNumber(value.segment_index, 1, 100, false);
    const metadata: VideoMetricSpan['metadata'] = {};
    if (typeof value.metadata?.cached === 'boolean') metadata.cached = value.metadata.cached;
    if (['ok', 'error', 'skipped'].includes(value.metadata?.status)) metadata.status = value.metadata.status;
    if (['t2v', 'i2v'].includes(value.metadata?.mode)) metadata.mode = value.metadata.mode;
    if (['draft', 'final'].includes(value.metadata?.quality)) metadata.quality = value.metadata.quality;
    if (['start', 'cut', 'continue', 'dissolve'].includes(value.metadata?.transition)) {
        metadata.transition = value.metadata.transition;
    }
    if (['pytorch', 'comfy_kitchen_int8'].includes(value.metadata?.attention_backend)) {
        metadata.attention_backend = value.metadata.attention_backend;
    }
    if (['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'].includes(
        value.metadata?.aspect,
    )) {
        metadata.aspect = value.metadata.aspect;
    }
    for (const [name, minimum, maximum] of [
        ['segment_duration_seconds', 0.01, 60],
        ['frame_count', 1, 10_000],
        ['run_index', 1, 20],
        ['steps_observed', 1, 1_000],
        ['steps_total', 1, 1_000],
        ['first_step_seconds', 0, 3_600],
        ['steady_step_mean_seconds', 0, 3_600],
        ['steady_step_median_seconds', 0, 3_600],
        ['steady_step_p90_seconds', 0, 3_600],
    ] as const) {
        if (value.metadata?.[name] === undefined) continue;
        const number = boundedNumber(value.metadata[name], minimum, maximum, false)!;
        metadata[name] = ['frame_count', 'run_index', 'steps_observed', 'steps_total'].includes(name)
            ? Math.round(number)
            : number;
    }
    if (value.metadata?.references_requested !== undefined) {
        metadata.references_requested = Math.round(
            boundedNumber(value.metadata.references_requested, 0, 4, false)!,
        );
    }
    if (value.metadata?.references_resolved !== undefined) {
        metadata.references_resolved = Math.round(
            boundedNumber(value.metadata.references_resolved, 0, 4, false)!,
        );
    }
    if (value.metadata?.contracts !== undefined) {
        metadata.contracts = Math.round(
            boundedNumber(value.metadata.contracts, 0, 7, false)!,
        );
    }
    if (['prefetch', 'on_demand'].includes(value.metadata?.origin)) {
        metadata.origin = value.metadata.origin;
    }
    if (typeof value.metadata?.joined === 'boolean') metadata.joined = value.metadata.joined;
    if (typeof value.metadata?.prefetched === 'boolean') metadata.prefetched = value.metadata.prefetched;
    return {
        source: value.source,
        name,
        duration_seconds: boundedNumber(value.duration_seconds, 0, 24 * 60 * 60, false)!,
        segment_index: segment === null ? null : Math.round(segment),
        ...(Object.keys(metadata).length ? { metadata } : {}),
    };
}

export function normalizedWorkerMetrics(value: any, expectedModel: VideoModelId): VideoWorkerMetrics {
    if (!value || typeof value !== 'object' || value.schema_version !== 1) {
        throw new Error('Unsupported video metrics payload.');
    }
    if (value.model !== expectedModel || !isVideoModel(value.model)) {
        throw new Error('Metrics model does not match the leased job.');
    }
    const expectedGenerator = VIDEO_MODELS[expectedModel].generatorModel;
    if (value.generator_model !== expectedGenerator) {
        throw new Error('Metrics generator model does not match the leased job.');
    }
    if (!Array.isArray(value.spans) || value.spans.length > 2_000) {
        throw new Error('Metrics spans must be an array of at most 2,000 entries.');
    }
    const output = value.output && typeof value.output === 'object' ? {
        duration_seconds: boundedNumber(value.output.duration_seconds, 0.01, 300) ?? undefined,
        generated_duration_seconds: boundedNumber(
            value.output.generated_duration_seconds,
            0.01,
            1_500,
        ) ?? undefined,
        width: Math.round(boundedNumber(value.output.width, 16, 16384) ?? 0) || undefined,
        height: Math.round(boundedNumber(value.output.height, 16, 16384) ?? 0) || undefined,
        fps: boundedNumber(value.output.fps, 0.1, 240) ?? undefined,
        segment_count: Math.round(boundedNumber(value.output.segment_count, 1, 100) ?? 0) || undefined,
        bytes: Math.round(boundedNumber(value.output.bytes, 1, 1024 * 1024 * 1024) ?? 0) || undefined,
        source_image: Boolean(value.output.source_image),
    } : undefined;
    const gpu = value.gpu && typeof value.gpu === 'object' ? {
        name: boundedMetricText(value.gpu.name) ?? undefined,
        driver_version: boundedMetricText(value.gpu.driver_version, 80) ?? undefined,
        vram_total_mb: boundedNumber(value.gpu.vram_total_mb, 1, 1024 * 1024) ?? undefined,
        vram_peak_mb: boundedNumber(value.gpu.vram_peak_mb, 0, 1024 * 1024) ?? undefined,
        vram_average_mb: boundedNumber(value.gpu.vram_average_mb, 0, 1024 * 1024) ?? undefined,
        vram_free_min_mb: boundedNumber(value.gpu.vram_free_min_mb, 0, 1024 * 1024) ?? undefined,
        utilization_average_percent: boundedNumber(value.gpu.utilization_average_percent, 0, 100) ?? undefined,
        utilization_peak_percent: boundedNumber(value.gpu.utilization_peak_percent, 0, 100) ?? undefined,
        power_average_watts: boundedNumber(value.gpu.power_average_watts, 0, 5000) ?? undefined,
        temperature_peak_c: boundedNumber(value.gpu.temperature_peak_c, 0, 200) ?? undefined,
        pcie_link_width_min: boundedNumber(value.gpu.pcie_link_width_min, 1, 32) ?? undefined,
        pcie_link_width_max: boundedNumber(value.gpu.pcie_link_width_max, 1, 32) ?? undefined,
        hardware_slowdown_samples: Math.round(boundedNumber(value.gpu.hardware_slowdown_samples, 0, 1_000_000) ?? 0),
        thermal_slowdown_samples: Math.round(boundedNumber(value.gpu.thermal_slowdown_samples, 0, 1_000_000) ?? 0),
        power_brake_slowdown_samples: Math.round(boundedNumber(value.gpu.power_brake_slowdown_samples, 0, 1_000_000) ?? 0),
        samples: Math.round(boundedNumber(value.gpu.samples, 0, 1_000_000) ?? 0),
    } : undefined;
    const environment = value.environment && typeof value.environment === 'object' ? {
        worker_sha256: boundedMetricText(value.environment.worker_sha256, 64) ?? undefined,
        generator_sha256: boundedMetricText(value.environment.generator_sha256, 64) ?? undefined,
        python_version: boundedMetricText(value.environment.python_version, 160) ?? undefined,
        comfy_aimdo_version: boundedMetricText(value.environment.comfy_aimdo_version, 80) ?? undefined,
        warm_model_before: optionalGeneratorModel(value.environment.warm_model_before),
        warm_model_after: optionalGeneratorModel(value.environment.warm_model_after),
        experiment_id: boundedMetricText(value.environment.experiment_id, 80) ?? undefined,
        variant_id: boundedMetricText(value.environment.variant_id, 80) ?? undefined,
        planner_fingerprint: boundedMetricText(value.environment.planner_fingerprint, 80) ?? undefined,
        keyframe_strategy: boundedMetricText(value.environment.keyframe_strategy, 80) ?? undefined,
    } : undefined;
    for (const hash of [environment?.worker_sha256, environment?.generator_sha256]) {
        if (hash && !/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid environment fingerprint.');
    }
    const quality = ['draft', 'final'].includes(value.flags?.quality)
        ? value.flags.quality as 'draft' | 'final'
        : undefined;
    const failureKind = ['nvidia_driver_reset', 'generator_failure'].includes(value.failure?.kind)
        ? value.failure.kind as 'nvidia_driver_reset' | 'generator_failure'
        : null;
    const eventIds = Array.isArray(value.failure?.event_ids)
        ? value.failure.event_ids
            .map((eventId: unknown) => Number(eventId))
            .filter((eventId: number) => Number.isFinite(eventId) && eventId >= 0 && eventId <= 65535)
            .map((eventId: number) => Math.round(eventId))
            .slice(0, 20)
        : undefined;
    const failure = failureKind ? {
        kind: failureKind,
        event_count: Math.round(boundedNumber(value.failure?.event_count, 0, 1_000_000) ?? 0),
        ...(eventIds ? { event_ids: eventIds } : {}),
        ...(value.failure?.latest_utc
            ? { latest_utc: boundedMetricText(value.failure.latest_utc, 80) ?? undefined }
            : {}),
    } : undefined;
    const spans: VideoMetricSpan[] = value.spans.map((span: unknown) => normalizedMetricSpan(span));
    const observedSegments = new Set(spans
        .filter(span => span.source === 'comfy' && span.name === 'segment_total'
            && span.segment_index !== null && span.segment_index !== undefined)
        .map(span => span.segment_index)).size;
    if (output && observedSegments > 0) output.segment_count = observedSegments;
    const generatedSegments = new Map<number, number>();
    for (const span of spans) {
        if (span.source !== 'comfy' || span.name !== 'segment_total'
            || span.segment_index === null || span.segment_index === undefined
            || !Number.isFinite(span.metadata?.segment_duration_seconds)) continue;
        generatedSegments.set(span.segment_index, Number(span.metadata!.segment_duration_seconds));
    }
    if (output && generatedSegments.size > 0) {
        output.generated_duration_seconds = [...generatedSegments.values()]
            .reduce((sum, duration) => sum + duration, 0);
    }
    return {
        schema_version: 1,
        model: expectedModel,
        generator_model: expectedGenerator,
        total_seconds: boundedNumber(value.total_seconds, 0.01, 24 * 60 * 60, false)!,
        ...(output ? { output } : {}),
        ...(gpu ? { gpu } : {}),
        ...(environment ? { environment } : {}),
        ...(failure ? { failure } : {}),
        flags: {
            fast: Boolean(value.flags?.fast),
            turbo4: Boolean(value.flags?.turbo4),
            ltx_one_stage: Boolean(value.flags?.ltx_one_stage),
            ...(quality ? { quality } : {}),
        },
        spans,
    };
}
