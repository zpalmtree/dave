import { VIDEO_MODELS, VideoJobView } from './VideoProtocol.js';

/** Statuses in which a job can be sitting in the GPU coordinator's queue. */
const GPU_WAITING_STATUSES = new Set(['leased', 'planning', 'running', 'uploading']);

export interface VideoStallThresholds {
    /** Seconds a job may wait for GPU admission with nothing ahead before it counts as stalled. */
    alertAfterSeconds: number;
    /** Seconds between repeat alerts while the same job stays stalled. */
    realertSeconds: number;
}

export interface VideoStallAlert {
    kind: 'stalled' | 'recovered';
    jobId: string;
    waitedSeconds: number;
    text: string;
}

interface TrackedStall {
    alertedAt: number;
    alerts: number;
}

/** Seconds a job has spent waiting for GPU admission, or null when it is not waiting. */
export function videoGpuWaitSeconds(job: VideoJobView, nowSeconds: number): number | null {
    if (!GPU_WAITING_STATUSES.has(job.status)) return null;
    if (job.gpu_queue_state !== 'queued') return null;
    const submittedAt = Number(job.gpu_queue_submitted_at);
    if (!Number.isFinite(submittedAt) || submittedAt <= 0) return null;
    return Math.max(0, Math.floor(nowSeconds - submittedAt));
}

/**
 * A stall is a long GPU wait that queue depth does not explain: either nothing is ahead of the
 * job, or the coordinator has said outright that it is holding the job back.
 */
export function videoGpuWaitIsStalled(
    job: VideoJobView,
    nowSeconds: number,
    alertAfterSeconds: number,
): boolean {
    const waited = videoGpuWaitSeconds(job, nowSeconds);
    if (waited === null || waited < alertAfterSeconds) return false;
    const ahead = Number(job.gpu_queue_jobs_ahead);
    const nothingAhead = !Number.isFinite(ahead) || ahead <= 0;
    return nothingAhead || Boolean(job.gpu_queue_block_reason);
}

function formatWait(seconds: number): string {
    const whole = Math.max(0, Math.round(seconds));
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    if (hours && minutes) return `${hours}h ${minutes}m`;
    if (hours) return `${hours}h`;
    if (minutes) return `${minutes}m`;
    return `${whole}s`;
}

function describeJob(job: VideoJobView): string {
    const model = (VIDEO_MODELS as Record<string, { displayName: string }>)[String(job.model)]?.displayName
        || String(job.model);
    return `Job \`${job.id.slice(0, 8)}\` (${model}, requested by <@${job.requester_id}>)`;
}

export function formatVideoStalledAlert(
    job: VideoJobView,
    waitedSeconds: number,
    queuedBehind: number,
    repeat: boolean,
): string {
    const lead = repeat ? '⚠️ **Video queue still stalled.**' : '⚠️ **Video queue stalled.**';
    const ahead = Number(job.gpu_queue_jobs_ahead) > 0
        ? ` with ${job.gpu_queue_jobs_ahead} GPU job${Number(job.gpu_queue_jobs_ahead) === 1 ? '' : 's'} ahead of it`
        : ' with nothing ahead of it';
    const parts = [
        `${lead} ${describeJob(job)} has waited **${formatWait(waitedSeconds)}** for GPU admission${ahead}.`,
    ];
    if (job.gpu_queue_block_reason) {
        const detail = job.gpu_queue_block_detail ? ` ${job.gpu_queue_block_detail}` : '';
        parts.push(`gpuq reports \`${job.gpu_queue_block_reason}\`.${detail}`);
    }
    if (queuedBehind > 0) {
        parts.push(`${queuedBehind} more job${queuedBehind === 1 ? ' is' : 's are'} queued behind it.`);
    }
    if (job.gpu_queue_block_reason === 'external_gpu_busy') {
        parts.push('Free VRAM on the desktop (close video players, browsers, or other GPU apps) to let it start.');
    }
    return parts.join(' ');
}

export function formatVideoRecoveredAlert(job: VideoJobView | null, jobId: string, waitedSeconds: number): string {
    const label = job ? describeJob(job) : `Job \`${jobId.slice(0, 8)}\``;
    if (job && job.gpu_queue_state === 'admitted') {
        return `✅ **Video queue resumed.** ${label} was admitted to the GPU after **${formatWait(waitedSeconds)}**.`;
    }
    if (job && GPU_WAITING_STATUSES.has(job.status) && job.gpu_queue_state === 'queued') {
        return `✅ **Video queue moving again.** ${label} is no longer blocked after **${formatWait(waitedSeconds)}**; other GPU work is now ahead of it.`;
    }
    const outcome = job ? `now ${job.status}` : 'no longer in the queue';
    return `ℹ️ **Video queue stall ended.** ${label} is ${outcome} after waiting **${formatWait(waitedSeconds)}**.`;
}

/**
 * Tracks which jobs the owner has already been alerted about, so each stall produces one alert,
 * an occasional reminder, and one recovery notice.
 */
export class VideoStallMonitor {
    private readonly tracked = new Map<string, TrackedStall>();

    observe(jobs: VideoJobView[], nowSeconds: number, thresholds: VideoStallThresholds): VideoStallAlert[] {
        const alerts: VideoStallAlert[] = [];
        const byId = new Map(jobs.map(job => [job.id, job]));
        const queuedBehind = jobs.filter(job => job.status === 'queued').length;

        for (const job of jobs) {
            if (!videoGpuWaitIsStalled(job, nowSeconds, thresholds.alertAfterSeconds)) continue;
            const waited = videoGpuWaitSeconds(job, nowSeconds) || 0;
            const existing = this.tracked.get(job.id);
            if (existing && nowSeconds - existing.alertedAt < thresholds.realertSeconds) continue;
            this.tracked.set(job.id, { alertedAt: nowSeconds, alerts: (existing?.alerts || 0) + 1 });
            alerts.push({
                kind: 'stalled',
                jobId: job.id,
                waitedSeconds: waited,
                text: formatVideoStalledAlert(job, waited, queuedBehind, Boolean(existing)),
            });
        }

        for (const [jobId, tracked] of [...this.tracked]) {
            const job = byId.get(jobId) || null;
            if (job && videoGpuWaitIsStalled(job, nowSeconds, thresholds.alertAfterSeconds)) continue;
            this.tracked.delete(jobId);
            const waited = job && job.gpu_queue_wait_seconds !== null && job.gpu_queue_wait_seconds !== undefined
                ? job.gpu_queue_wait_seconds
                : job && videoGpuWaitSeconds(job, nowSeconds) !== null
                    ? (videoGpuWaitSeconds(job, nowSeconds) as number)
                    : Math.max(0, nowSeconds - (tracked.alertedAt - thresholds.alertAfterSeconds));
            alerts.push({
                kind: 'recovered',
                jobId,
                waitedSeconds: waited,
                text: formatVideoRecoveredAlert(job, jobId, waited),
            });
        }
        return alerts;
    }
}
