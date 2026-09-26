import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { videoSourceAudioFromMessages, sourceAudioDescriptor, pinVideoPlanToAudio, normalizeVideoSourceAudio } from '../dist/VideoSourceAudio.js';
import { VideoBroker } from '../dist/VideoBroker.js';
const descriptor = { url: 'https://cdn.discordapp.com/attachments/1/2/song.mp3', name: 'song.mp3', bytes: 1234 };
const message = (...items) => ({ attachments: new Map(items.map((v, i) => [i, v])) });
const attachment = (name, contentType) => ({ url: descriptor.url, name, contentType, size: 1234 });
const plan = () => ({ segments: [{ title: 'Performance', target_seconds: 6, transition: 'start',
    shots: [{ duration_seconds: 6, visual: 'The performer raps on stage', camera: 'Medium close-up', dialogue: [{ text: 'Invented words' }] }] }] });

test('song selection supports replies and independent image attachments, rejecting ambiguous or invalid songs', () => {
    const own = message(attachment('face.png', 'image/png'), attachment('own.MP3', 'audio/mpeg'));
    const reply = message(attachment('reply.wav', 'audio/wav'));
    assert.equal(videoSourceAudioFromMessages(own, reply).name, 'own.MP3');
    assert.equal(videoSourceAudioFromMessages(message(attachment('face.png', 'image/png')), reply).name, 'reply.wav');
    assert.throws(() => videoSourceAudioFromMessages(message(attachment('a.mp3'), attachment('b.wav'))), /exactly one/);
    assert.throws(() => sourceAudioDescriptor({ ...descriptor, bytes: 26 * 1024 * 1024 }), /25 MiB/);
    for (const url of ['http://cdn.discordapp.com/attachments/x', 'https://example.com/attachments/x', 'https://cdn.discordapp.com/elsewhere', 'https://cdn.discordapp.com:9000/attachments/x']) {
        assert.throws(() => sourceAudioDescriptor({ ...descriptor, url }), /Discord attachment/);
    }
    assert.throws(() => sourceAudioDescriptor({ ...descriptor, name: 'song.m3u8' }), /must be MP3/);
});

test('song timelines cover all original samples without accumulating H3 frame rounding or invented lyrics', () => {
    for (const seconds of [1, 2.5, 3.75, 4, 14, 15.123, 31.013, 119.99, 120]) {
        const value = plan();
        pinVideoPlanToAudio(value, seconds);
        let frames = 0;
        for (const segment of value.segments) {
            assert.equal(segment.source_audio_start_seconds, frames / 24);
            assert.ok(segment.source_audio_frames <= 360);
            frames += segment.source_audio_frames;
            assert.equal(segment.output_seconds, segment.source_audio_frames / 24);
            assert.deepEqual(segment.shots[0].dialogue, []);
            assert.equal(segment.audio_transition, 'cut');
        }
        assert.equal(frames, Math.ceil(seconds * 24 - 1e-6));
        const copy = structuredClone(value);
        pinVideoPlanToAudio(value, seconds);
        assert.deepEqual(value, copy);
    }
});

test('audio decoding accepts short clips and rejects invalid or overlong uploads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'song-decode-'));
    try {
        const input = join(directory, 'input.wav'), output = join(directory, 'output.wav');
        execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.5', input]);
        const value = await normalizeVideoSourceAudio(input, output);
        assert.ok(Math.abs(value.duration - 2.5) <= 1 / 48000 + 1e-6);
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.75', input]);
        await assert.rejects(normalizeVideoSourceAudio(input, output), /between 1 and 120/);
        writeFileSync(input, 'not audio');
        await assert.rejects(normalizeVideoSourceAudio(input, output), /Could not decode/);
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '121.5', input]);
        await assert.rejects(normalizeVideoSourceAudio(input, output), /between 1 and 120/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('broker persists decoded song duration, makes submissions idempotent, and refuses unsupported models', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'song-broker-'));
    let downloads = 0;
    const broker = new VideoBroker({ host: '127.0.0.1', port: 0, dbPath: join(directory, 'queue.db'),
        resultsDir: join(directory, 'results'), botToken: 'bot', workerToken: 'worker', preplanQueuedJobs: false,
        sourceAudioDownloader: async () => { downloads++; return { path: join(directory, 'song.wav'), bytes: 123, duration: 8.25 }; } });
    await broker.start();
    const submit = async (extra = {}) => {
        const res = await fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/jobs`, {
            method: 'POST', headers: { authorization: 'Bearer bot', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'minimax', prompt: 'Perform this song', source_audio: descriptor,
                requester_id: 'u', origin_bot_id: 'b', channel_id: 'c', command_message_id: 'm', status_message_id: 's', ...extra }) });
        return [res.status, await res.json()];
    };
    try {
        const [status, body] = await submit();
        assert.equal(status, 201);
        assert.equal(body.job.has_source_audio, true);
        assert.equal(body.job.requested_duration_seconds, 8.25);
        assert.equal(body.job.source_audio_seconds, 8.25);
        assert.equal((await submit())[0], 200);
        assert.equal(downloads, 1);
        assert.equal((await submit({ model: 'ltx', command_message_id: 'different' }))[0], 400);
    } finally { await broker.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('only audio-capable workers lease song jobs and audio downloads require the active lease', async () => {
    const { WebSocket } = await import('ws');
    const directory = mkdtempSync(join(tmpdir(), 'song-worker-'));
    const source = join(directory, 'song.wav');
    writeFileSync(source, 'test-waveform');
    const broker = new VideoBroker({ host: '127.0.0.1', port: 0, dbPath: join(directory, 'q.db'),
        resultsDir: join(directory, 'results'), botToken: 'bot', workerToken: 'worker', preplanQueuedJobs: false,
        sourceAudioDownloader: async () => ({ path: source, bytes: 13, duration: 6 }) });
    await broker.start();
    let socket;
    const connect = async version => {
        const ws = new WebSocket(`ws://127.0.0.1:${broker.listeningPort()}/v1/worker`, { headers: { authorization: 'Bearer worker' } });
        const messages = [];
        ws.on('message', data => messages.push(JSON.parse(data.toString())));
        await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        ws.send(JSON.stringify({ type: 'hello', protocol: 1, worker_id: 'audio-worker', capabilities: ['minimax'], current_job: null, source_audio_version: version }));
        return { ws, messages };
    };
    const waitFor = async predicate => {
        for (let i = 0; i < 100; i++) { const value = predicate(); if (value) return value; await new Promise(r => setTimeout(r, 20)); }
        throw new Error('Timed out waiting for worker');
    };
    try {
        const response = await fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/jobs`, {
            method: 'POST', headers: { authorization: 'Bearer bot', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'minimax', prompt: 'Perform this song', source_audio: descriptor,
                requester_id: 'u', origin_bot_id: 'b', channel_id: 'c', command_message_id: 'm', status_message_id: 's' }) });
        assert.equal(response.status, 201);
        const old = await connect(0); socket = old.ws;
        await waitFor(() => old.messages.find(m => m.type === 'hello_ack'));
        // Force a completed dispatch pass; the job must remain queued for an upgraded worker.
        await broker.dispatchNext();
        assert.equal(old.messages.some(m => m.type === 'job'), false);
        socket.close();
        const upgraded = await connect(1); socket = upgraded.ws;
        const lease = await waitFor(() => upgraded.messages.find(m => m.type === 'job'));
        assert.equal(lease.job.has_source_audio, true);
        const url = `http://127.0.0.1:${broker.listeningPort()}/v1/worker/jobs/${lease.job.id}/source-audio`;
        const get = token => fetch(url, { method: 'POST', headers: { authorization: 'Bearer worker', 'x-video-lease': token } });
        assert.equal((await get('stale-lease')).status, 409);
        const audio = await get(lease.job.lease_id);
        assert.equal(audio.status, 200);
        assert.equal(audio.headers.get('content-type'), 'audio/wav');
        assert.equal(await audio.text(), 'test-waveform');
    } finally { socket?.close(); await broker.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('recovery binds the contract to audio timing and never asks H3 to regenerate lyrics', async () => {
    const { prepareRecoveryPlan } = await import('../dist/VideoRecoveryService.js');
    const result = await prepareRecoveryPlan({ prompt: 'Rap this song', model: 'minimax', requester: 'u', sources: [],
        sourceAudioSeconds: 31.125, options: {}, planner: async () => ({ ...plan(),
            intent: 'Perform the song', continuity_bible: 'Same performer throughout', keyframe: { recommended: true },
            prompt_analysis: { frontier_handling: { disposition: 'fulfill' },
                dialogue_contract: { mode: 'generated', lines: [] } } }) });
    assert.equal(result.plan.source_audio.output_frames, 747);
    assert.equal(result.plan.prompt_analysis.dialogue_contract.mode, 'none');
    assert.equal(result.contract.segments.length, 3);
    assert.deepEqual(result.contract.segments, result.plan.segments);
    assert.ok(result.contract.segments.every(s => s.shots.every(shot => shot.dialogue.length === 0)));
});
