import assert from 'node:assert/strict';
import test from 'node:test';

import {
    VideoStallMonitor,
    formatVideoStalledAlert,
    videoGpuWaitIsStalled,
    videoGpuWaitSeconds,
} from '../dist/VideoStallAlerts.js';

const thresholds = { alertAfterSeconds: 900, realertSeconds: 3600 };

function job(overrides = {}) {
    return {
        id: '71792f59-c20f-4e2c-a392-a7d3e2ac1caa',
        model: 'minimax',
        prompt: 'test',
        requester_id: '1314260817390080061',
        origin_bot_id: 'b',
        channel_id: 'c',
        guild_id: null,
        command_message_id: 'm',
        status_message_id: 's',
        status: 'running',
        queue_position: null,
        estimate_low_seconds: 166,
        estimate_high_seconds: 572,
        estimate_ready: true,
        expected_start_at: null,
        expected_finish_at: null,
        stage: 'Waiting for GPU queue admission',
        progress: null,
        error: null,
        result_path: null,
        result_bytes: null,
        has_source_image: true,
        created_at: 1_000_000,
        updated_at: 1_000_000,
        started_at: 1_000_010,
        completed_at: null,
        runtime_seconds: null,
        delivered_at: null,
        worker_online: true,
        worker_busy: true,
        paused_until: null,
        dispatch_paused: false,
        gpu_queue_state: 'queued',
        gpu_queue_submitted_at: 1_000_012,
        gpu_admitted_at: null,
        gpu_queue_wait_seconds: null,
        gpu_queue_position: 1,
        gpu_queue_jobs_ahead: 0,
        gpu_queue_block_reason: 'external_gpu_busy',
        gpu_queue_block_detail: 'GPU admission requires 27952 MiB free; 26426 MiB available.',
        ...overrides,
    };
}

const queued = job({
    id: 'ead54b0b-3058-4506-b82c-e85756cde39f',
    status: 'queued',
    gpu_queue_state: null,
    gpu_queue_submitted_at: null,
    gpu_queue_block_reason: null,
    gpu_queue_block_detail: null,
});

test('GPU wait is measured only while queued in the coordinator', () => {
    assert.equal(videoGpuWaitSeconds(job(), 1_000_612), 600);
    assert.equal(videoGpuWaitSeconds(job({ gpu_queue_state: 'admitted' }), 1_000_612), null);
    assert.equal(videoGpuWaitSeconds(job({ status: 'queued', gpu_queue_state: null }), 1_000_612), null);
    assert.equal(videoGpuWaitSeconds(job({ gpu_queue_submitted_at: null }), 1_000_612), null);
});

test('a long wait counts as a stall when nothing is ahead or the coordinator blocks it', () => {
    assert.equal(videoGpuWaitIsStalled(job(), 1_000_012 + 899, 900), false);
    assert.equal(videoGpuWaitIsStalled(job(), 1_000_012 + 900, 900), true);
    const behindOthers = job({ gpu_queue_jobs_ahead: 2, gpu_queue_block_reason: null, gpu_queue_block_detail: null });
    assert.equal(videoGpuWaitIsStalled(behindOthers, 1_000_012 + 7200, 900), false);
    assert.equal(videoGpuWaitIsStalled(job({ gpu_queue_jobs_ahead: 2 }), 1_000_012 + 7200, 900), true);
});

test('stall alerts name the job, the wait, the reason, and the backlog', () => {
    const text = formatVideoStalledAlert(job(), 3 * 3600 + 10 * 60, 3, false);
    assert.match(text, /^⚠️ \*\*Video queue stalled\.\*\*/);
    assert.match(text, /Job `71792f59` \(MiniMax H3, requested by <@1314260817390080061>\)/);
    assert.match(text, /waited \*\*3h 10m\*\* for GPU admission with nothing ahead of it/);
    assert.match(text, /gpuq reports `external_gpu_busy`\. GPU admission requires 27952 MiB free; 26426 MiB available\./);
    assert.match(text, /3 more jobs are queued behind it/);
    assert.match(text, /Free VRAM on the desktop/);
    assert.match(formatVideoStalledAlert(job(), 1200, 0, true), /still stalled.*\*\*20m\*\*/);
});

test('the monitor alerts once, reminds after the re-alert interval, and reports recovery', () => {
    const monitor = new VideoStallMonitor();
    const submitted = 1_000_012;
    assert.deepEqual(monitor.observe([job(), queued], submitted + 600, thresholds), []);

    const first = monitor.observe([job(), queued], submitted + 900, thresholds);
    assert.equal(first.length, 1);
    assert.equal(first[0].kind, 'stalled');
    assert.equal(first[0].waitedSeconds, 900);
    assert.match(first[0].text, /1 more job is queued behind it/);

    assert.deepEqual(monitor.observe([job(), queued], submitted + 4499, thresholds), []);
    const reminder = monitor.observe([job(), queued], submitted + 4500, thresholds);
    assert.equal(reminder.length, 1);
    assert.match(reminder[0].text, /still stalled/);

    const admittedJob = job({
        gpu_queue_state: 'admitted',
        gpu_admitted_at: submitted + 5000,
        gpu_queue_wait_seconds: 5000,
        gpu_queue_block_reason: null,
        gpu_queue_block_detail: null,
    });
    const recovered = monitor.observe([admittedJob, queued], submitted + 5001, thresholds);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].kind, 'recovered');
    assert.equal(recovered[0].waitedSeconds, 5000);
    assert.match(recovered[0].text, /✅ \*\*Video queue resumed\.\*\* Job `71792f59`.*after \*\*1h 23m\*\*/);

    assert.deepEqual(monitor.observe([admittedJob, queued], submitted + 6000, thresholds), []);
});

test('a stalled job that disappears from the poll still closes the alert', () => {
    const monitor = new VideoStallMonitor();
    const submitted = 1_000_012;
    assert.equal(monitor.observe([job()], submitted + 1000, thresholds).length, 1);
    const closed = monitor.observe([], submitted + 1500, thresholds);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].kind, 'recovered');
    assert.match(closed[0].text, /stall ended.*no longer in the queue/);
    const failed = new VideoStallMonitor();
    failed.observe([job()], submitted + 1000, thresholds);
    const ended = failed.observe([job({ status: 'failed', gpu_queue_state: null })], submitted + 1500, thresholds);
    assert.match(ended[0].text, /is now failed after waiting/);
});
