import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { videoSourceAudioFromMessages, sourceAudioDescriptor, pinVideoPlanToAudio, normalizeVideoSourceAudio,
    songLyricsFromTranscription, resolveVideoSourceExcerptLyrics, videoSourceAudioPlannerGuidance, parseVideoSourceAudioLyrics,
    storeVideoSourceAudioFromClip, VIDEO_SOURCE_AUDIO_GUIDANCE, videoScoreTimingFromSamples } from '../dist/VideoSourceAudio.js';
import { VideoBroker } from '../dist/VideoBroker.js';
const descriptor = { url: 'https://cdn.discordapp.com/attachments/1/2/song.mp3', name: 'song.mp3', bytes: 1234 };
const message = (...items) => ({ attachments: new Map(items.map((v, i) => [i, v])) });
const attachment = (name, contentType) => ({ url: descriptor.url, name, contentType, size: 1234 });
const plan = () => ({ segments: [{ title: 'Performance', target_seconds: 6, transition: 'start',
    shots: [{ duration_seconds: 6, visual: 'The performer raps on stage', camera: 'Medium close-up', dialogue: [{ text: 'Invented words' }] }] }] });

test('excerpt timing recovers missing words locally without shifting the recovered timestamps twice', async () => {
    const excerpt = { start_seconds: 115, end_seconds: 150, source_seconds: 228, label: 'the chorus', chosen: 'auto' };
    const audio = { path: '/fixture/source-audio.wav', duration: 35, bytes: 1000 };
    const local = { words: [1, 2, 3].map(start => ({ start, end: start + 0.5, text: 'fixture' })),
        lines: [{ start: 1, end: 3.5, text: 'fixture fixture fixture' }] };
    const full = { words: local.words, lines: [{ start: 115, end: 149, text: 'poor whole-song alignment' }] };
    let calls = 0;
    const transcribe = async (input, hooks) => {
        calls++;
        assert.equal(input, audio);
        await hooks.onUsage({ stage: 'source_audio_transcription' });
        await hooks.onAttempt({ stage: 'source_audio_transcription' });
        return local;
    };
    const stages = [];
    const providerHooks = { onUsage: value => stages.push(value.stage), onAttempt: value => stages.push(value.stage) };
    assert.deepEqual(await resolveVideoSourceExcerptLyrics(full, excerpt, audio, providerHooks, transcribe), local);
    assert.equal(calls, 1);
    assert.deepEqual(stages, ['source_audio_excerpt_transcription', 'source_audio_excerpt_transcription']);
    const aligned = { words: local.words.map(w => ({ ...w, start: w.start + 115, end: w.end + 115 })),
        lines: local.lines.map(w => ({ ...w, start: w.start + 115, end: w.end + 115 })) };
    assert.deepEqual(await resolveVideoSourceExcerptLyrics(aligned, excerpt, audio, providerHooks, transcribe), local);
    assert.equal(calls, 1, 'valid timing needs no additional provider call');
    assert.equal(await resolveVideoSourceExcerptLyrics(null, null, audio, providerHooks, transcribe), null);
    assert.equal(calls, 1, 'uncut songs do not retry the same transcription');
    assert.equal(await resolveVideoSourceExcerptLyrics(full, excerpt, audio, {}, async () => null), null);
    assert.equal(await resolveVideoSourceExcerptLyrics(full, excerpt, audio, {}, async () => { throw Error('unavailable'); }), null);
});

test('song selection supports replies and independent image attachments, rejecting ambiguous or invalid songs', () => {
    const own = message(attachment('face.png', 'image/png'), attachment('own.MP3', 'audio/mpeg'));
    const reply = message(attachment('reply.wav', 'audio/wav'));
    assert.equal(videoSourceAudioFromMessages(own, reply).name, 'own.MP3');
    assert.equal(videoSourceAudioFromMessages(message(attachment('face.png', 'image/png')), reply).name, 'reply.wav');
    assert.throws(() => videoSourceAudioFromMessages(message(attachment('a.mp3'), attachment('b.wav'))), /exactly one/);
    assert.throws(() => sourceAudioDescriptor({ ...descriptor, bytes: 101 * 1024 * 1024 }), /100 MiB/);
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
        await assert.rejects(normalizeVideoSourceAudio(input, output), /between 1 second and 10 minutes/);
        writeFileSync(input, 'not audio');
        await assert.rejects(normalizeVideoSourceAudio(input, output), /Could not decode/);
        // Whole songs are accepted so an excerpt can be cut from them.
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '200', input]);
        assert.ok(Math.abs((await normalizeVideoSourceAudio(input, output)).duration - 200) < 0.01);
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '601.5', input]);
        await assert.rejects(normalizeVideoSourceAudio(input, output), /between 1 second and 10 minutes/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('broker persists decoded song duration, makes submissions idempotent, and refuses unsupported models', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'song-broker-'));
    let downloads = 0;
    const broker = new VideoBroker({ host: '127.0.0.1', port: 0, dbPath: join(directory, 'queue.db'),
        resultsDir: join(directory, 'results'), botToken: 'bot', workerToken: 'worker', preplanQueuedJobs: false,
        sourceAudioDownloader: async () => { downloads++; return { path: join(directory, 'song.wav'), bytes: 123, duration: 8.25 }; },
        sourceAudioTranscriber: async () => null, sourceAudioCutter: async song => song });
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

test('video soundtracks retain the full source for song excerpt selection and reject silent clips', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'video-soundtrack-'));
    const source = { clip_url: 'https://www.youtube.com/watch?v=abcdefghijk', name: 'clip.mp4' };
    const input = join(directory, 'input.mp4');
    const output = join(directory, 'job');
    const fetchClip = async (_url, destination) => copyFileSync(input, destination);
    try {
        execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=32x32:rate=1:duration=130',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000:duration=130',
            '-c:v', 'libx264', '-c:a', 'aac', '-shortest', input]);
        const audio = await storeVideoSourceAudioFromClip(source, output, fetchClip);
        assert.ok(audio.duration >= 130 && audio.duration < 131, 'must not apply the video-edit 120-second cap');
        assert.ok(existsSync(audio.path));
        assert.equal(existsSync(join(output, 'soundtrack-source')), false);
        for (const extension of ['webm', 'mkv']) {
            const container = join(directory, `input.${extension}`);
            execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=32x32:rate=1:duration=2',
                '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libvpx-vp9', '-c:a', 'libopus', container]);
            const decoded = await normalizeVideoSourceAudio(container, join(directory, `${extension}.wav`));
            assert.ok(Math.abs(decoded.duration - 2) < 0.05);
        }
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=size=32x32:rate=1:duration=2',
            '-c:v', 'libx264', input]);
        await assert.rejects(storeVideoSourceAudioFromClip(source, output, fetchClip), /must contain a decodable soundtrack/);
        assert.equal(existsSync(join(output, 'soundtrack-source')), false);
        assert.equal(existsSync(join(output, 'song-full.wav')), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('broker routes video audio into fixed-song planning with the preset and requested excerpt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'video-song-broker-'));
    const clip = { clip_url: 'https://video.twimg.com/ext_tw_video/123/pu/vid/clip.mp4', name: 'clip.mp4' };
    const range = { start_seconds: 125, end_seconds: 135 };
    let downloads = 0;
    const broker = new VideoBroker({ host: '127.0.0.1', port: 0, dbPath: join(directory, 'queue.db'),
        resultsDir: join(directory, 'results'), botToken: 'bot', workerToken: 'worker', preplanQueuedJobs: false,
        sourceAudioVideoDownloader: async source => {
            assert.deepEqual(source, clip); downloads++;
            return { path: join(directory, 'song.wav'), bytes: 123, duration: 150 };
        },
        sourceVideoDownloader: async () => { throw Error('must not edit the video'); },
        sourceAudioTranscriber: async () => null,
        sourceAudioExcerptSelector: async input => {
            assert.deepEqual(input.range, range);
            assert.equal(input.seconds, 150);
            return { ...range, source_seconds: 150, label: '', chosen: 'range' };
        },
        sourceAudioCutter: async song => ({ ...song, duration: 10 }),
        sourceImageDownloader: async source => {
            assert.deepEqual(source, { preset: 'meximutt' });
            return { path: join(directory, 'portrait.png'), mimeType: 'image/png', bytes: 123 };
        } });
    await broker.start();
    const submit = async (extra = {}) => {
        const res = await fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/jobs`, {
            method: 'POST', headers: { authorization: 'Bearer bot', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'minimax', command_variant: 'oalgo', prompt: 'make a music video for this song',
                source_audio_video: clip, source_image: { preset: 'meximutt' }, source_range: range,
                requester_id: 'u', origin_bot_id: 'b', channel_id: 'c', command_message_id: 'm', status_message_id: 's', ...extra }) });
        return [res.status, await res.json()];
    };
    try {
        const [status, body] = await submit();
        assert.equal(status, 201, JSON.stringify(body));
        assert.equal(body.job.has_source_audio, true);
        assert.equal(body.job.has_source_video, false);
        assert.equal(body.job.source_kind, 'preset');
        assert.equal(body.job.source_audio_seconds, 10);
        assert.equal(body.job.requested_duration_seconds, 10);
        assert.equal((await submit())[0], 200);
        assert.equal(downloads, 1);
        for (const extra of [{ model: 'ltx' }, { source_audio: descriptor }, { source_video: clip },
            { source_image: clip }, { source_image_composite: clip }, { video_edit_target: 'the singer' }]) {
            assert.equal((await submit({ command_message_id: 'invalid', ...extra }))[0], 400);
        }
        assert.equal(downloads, 1, 'invalid requests fail before downloading');
    } finally { await broker.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('only audio-capable workers lease song jobs and audio downloads require the active lease', async () => {
    const { WebSocket } = await import('ws');
    const directory = mkdtempSync(join(tmpdir(), 'song-worker-'));
    const source = join(directory, 'song.wav');
    writeFileSync(source, 'test-waveform');
    const broker = new VideoBroker({ host: '127.0.0.1', port: 0, dbPath: join(directory, 'q.db'),
        resultsDir: join(directory, 'results'), botToken: 'bot', workerToken: 'worker', preplanQueuedJobs: false,
        sourceAudioDownloader: async () => ({ path: source, bytes: 13, duration: 6 }), sourceAudioTranscriber: async () => null,
        sourceAudioCutter: async song => song });
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
    const words = sung(12, 10, 0.5);
    const timed = await prepareRecoveryPlan({ prompt: 'Rap this song', model: 'minimax', requester: 'u', sources: [],
        sourceAudioSeconds: 31.125, sourceAudioLyrics: { words, lines: [line(words)] }, options: {},
        planner: async () => ({ ...plan(), intent: 'Perform the song', continuity_bible: 'Same performer throughout',
            keyframe: { recommended: true }, prompt_analysis: { frontier_handling: { disposition: 'fulfill' } } }) });
    assert.deepEqual(timed.contract.segments.map(s => s.shots[0].source_audio_vocals), ['instrumental', 'vocals', 'instrumental']);
});

// Words of equal length laid end to end, as whisper-1 times sung lines.
const sung = (start, count, length) => Array.from({ length: count }, (_, i) => ({
    start: Math.round((start + i * length) * 100) / 100, end: Math.round((start + (i + 1) * length) * 100) / 100, text: `w${start}-${i}` }));
const line = words => ({ start: words[0].start, end: words[words.length - 1].end, text: words.map(w => w.text).join(' ') });

test('whisper transcripts keep confident sung lines and drop music hallucinations', () => {
    const word = (text, start, end) => ({ word: text, start, end });
    const value = {
        segments: [
            // Real singing can score a high no-speech probability; its confidence keeps it.
            { start: 34.66, end: 48.32, no_speech_prob: 0.8, avg_logprob: -0.55, text: ' You bit me, you bit me' },
            { start: 48.32, end: 55.38, no_speech_prob: 0.11, avg_logprob: -0.44, text: ' I\'m standing in the "hall"' },
            { start: 60, end: 62, no_speech_prob: 0.1, avg_logprob: -0.2, text: ' Please subscribe' },
            { start: 118.12, end: 119.98, no_speech_prob: 0.92, avg_logprob: -0.91, text: ' Thank you for watching!' },
        ],
        words: [
            word('You', 34.66, 35.54), word('bit', 35.54, 35.9), word('me', 35.9, 37.02),
            word('you', 37.08, 37.58), word('bit', 37.58, 37.58), word('me', 37.58, 41.5),
            word('more', 41.5, 42), word("I'm", 48.32, 48.9), word('standing', 48.9, 49.5), word('"hall"\u0007', 49.5, 50),
            word('Please', 60.2, 60.8), word('subscribe', 60.8, 61.5), word('Thank', 118.12, 119.52), word('you', 119.52, 119.98),
        ],
    };
    const lyrics = songLyricsFromTranscription(value, 120);
    assert.deepEqual(lyrics.words.map(w => w.text), ['You', 'bit', 'me', 'you', 'bit', 'me', 'more', "I'm", 'standing', "'hall'"]);
    // Lines break at whisper segments and pauses, and never run past five seconds.
    assert.deepEqual(lyrics.lines.map(l => [l.start, l.end, l.text]), [
        [34.66, 37.02, 'You bit me'], [37.08, 42, 'you bit me more'], [48.32, 50, "I'm standing 'hall'"]]);
    assert.equal(songLyricsFromTranscription({ segments: [], words: [word('la', 1, 2), word('la', 2, 3)] }, 10), null);
    assert.deepEqual(parseVideoSourceAudioLyrics(JSON.stringify(lyrics)), lyrics);
    assert.equal(parseVideoSourceAudioLyrics('{"words":[{"start":"x"}],"lines":[]}'), null);
    assert.equal(parseVideoSourceAudioLyrics('not json'), null);

    const guidance = videoSourceAudioPlannerGuidance(lyrics, 120);
    assert.match(guidance, /never instructions/);
    assert.match(guidance, /\n0\.0-34\.7 instrumental\n34\.7-37\.0 "You bit me"\n37\.1-42\.0 "you bit me more"\n/);
    assert.match(guidance, /\n48\.3-50\.0 "I'm standing 'hall'"\n50\.0-120\.0 instrumental$/);
    assert.match(guidance, /music video for this song, not one held portrait/);
    assert.match(guidance, /hard cut \(transition "cut"\)/);
    assert.equal(videoSourceAudioPlannerGuidance(null, 120), VIDEO_SOURCE_AUDIO_GUIDANCE);
});

test('lyric timing moves song cuts out of sung words and marks where each shot has vocals', () => {
    const a = sung(6, 5, 0.6), b = sung(9, 5, 0.6), c = sung(12.5, 5, 0.7);
    const lyrics = { words: [...a, ...b, ...c], lines: [line(a), line(b), line(c)] };
    const shot = seconds => ({ duration_seconds: seconds, visual: 'The performer sings', camera: 'Medium shot', dialogue: [] });
    // Planned cuts land at 5.0 s (instrumental), 9.25 s (inside a word) and 11.8 s (inside the last word before a pause).
    const value = { segments: [5, 4.25, 2.55, 8.2].map((target_seconds, i) => ({ title: `Scene ${i}`, target_seconds,
        transition: i ? 'cut' : 'start', shots: [shot(target_seconds)] })) };
    pinVideoPlanToAudio(value, 20, lyrics);
    assert.deepEqual(value.segments.map(s => s.source_audio_start_seconds), [0, 5, 9, 12.125]);
    assert.equal(value.segments.reduce((sum, s) => sum + s.source_audio_frames, 0), 480);
    for (const segment of value.segments.slice(1)) {
        const frame = segment.source_audio_start_seconds * 24;
        assert.ok(lyrics.words.every(w => !(Math.round(w.start * 24) < frame && frame < Math.round(w.end * 24))));
    }
    const shots = value.segments.map(s => s.shots[0]);
    assert.equal(shots[0].source_audio_vocals, 'instrumental');
    assert.match(shots[0].audio, /instrumental passage .* relaxed closed mouths/);
    assert.deepEqual([shots[1].source_audio_vocals, shots[1].source_audio_vocals_from_seconds, shots[1].source_audio_vocals_until_seconds], ['vocals', 1, undefined]);
    assert.match(shots[1].audio, /vocals play from 1 to 4 seconds into this shot/);
    assert.deepEqual([shots[2].source_audio_vocals, shots[2].source_audio_vocals_from_seconds, shots[2].source_audio_vocals_until_seconds], ['vocals', undefined, undefined]);
    assert.equal(shots[2].audio, 'The original uploaded song, unchanged; synchronize the visible performance to its vocals and rhythm.');
    assert.deepEqual([shots[3].source_audio_vocals_from_seconds, shots[3].source_audio_vocals_until_seconds], [undefined, 3.88]);
    const copy = structuredClone(value);
    pinVideoPlanToAudio(value, 20, lyrics);
    assert.deepEqual(value, copy);
});

test('a score\'s beat grid comes from its attacks, with the bar on the loudest kick', () => {
    // 150 BPM: a kick on every beat, a heavier one on each bar, starting 0.3 s in, over hiss.
    const rate = 11025, samples = new Float32Array(rate * 20);
    let noise = 1;
    for (let i = 0; i < samples.length; i++) {
        noise = (noise * 16807) % 2147483647;
        samples[i] = (noise / 2147483647 - 0.5) * 0.02;
    }
    for (let beat = 0; 0.3 + beat * 0.4 < 19.8; beat++) {
        const start = Math.round((0.3 + beat * 0.4) * rate), gain = beat % 4 === 1 ? 0.9 : 0.35;
        for (let i = 0; i < rate * 0.12; i++) samples[start + i] += gain * Math.exp(-i / (rate * 0.04)) * Math.sin(2 * Math.PI * 60 * i / rate);
    }
    for (const hint of [0, 150]) {
        const timing = videoScoreTimingFromSamples(samples, rate, hint);
        assert.ok(Math.abs(timing.bpm - 150) <= 1, `bpm ${timing.bpm} with hint ${hint}`);
        assert.ok(timing.beats.length >= 46);
        for (const time of timing.beats) assert.ok(Math.abs(((time - 0.3) / 0.4) - Math.round((time - 0.3) / 0.4)) * 0.4 < 0.03, `beat ${time}`);
        assert.ok(Math.abs(timing.bars[0] - 0.7) < 0.03, `first bar ${timing.bars[0]}`);
        assert.ok(timing.bars.every((time, i) => !i || Math.abs(time - timing.bars[i - 1] - 1.6) < 0.05));
    }
    assert.deepEqual(videoScoreTimingFromSamples(new Float32Array(rate * 10), rate), { bpm: 0, beats: [], bars: [] }, 'Silence has no beat.');
});

test('a score pins scene cuts to bars and shot cuts to beats, with every shot instrumental', () => {
    const beats = Array.from({ length: 50 }, (_, i) => 0.25 + i * 0.4);
    const score = { bpm: 150, beats, bars: beats.filter((_, i) => i % 4 === 0) };
    const lyrics = { words: [], lines: [], score };
    assert.deepEqual(parseVideoSourceAudioLyrics(JSON.stringify(lyrics)), lyrics);
    const shot = seconds => ({ duration_seconds: seconds, visual: 'He stares down the lens', camera: 'Close-up', dialogue: [] });
    const value = { segments: [[3.5, 2.5], [3, 3], [3.5, 3.5]].map((shots, i) => ({ title: `Scene ${i}`,
        target_seconds: shots[0] + shots[1], transition: i ? 'cut' : 'start', shots: shots.map(shot) })) };
    pinVideoPlanToAudio(value, 20, lyrics);
    // Planned cuts at 6.32 s and 12.63 s move to the bars at 6.65 s and 13.05 s.
    assert.deepEqual(value.segments.map(s => s.source_audio_start_seconds * 24), [0, 160, 313]);
    const beatFrames = new Set(beats.map(time => Math.round(time * 24)));
    for (const segment of value.segments) {
        const start = segment.source_audio_start_seconds * 24;
        const inner = start + Math.round(segment.shots[0].duration_seconds * 24);
        assert.ok(beatFrames.has(inner), `shot cut at frame ${inner}`);
        assert.equal(Math.round(segment.shots.reduce((sum, s) => sum + s.duration_seconds, 0) * 24), segment.source_audio_frames);
        assert.match(segment.music, /instrumental score/);
        for (const item of segment.shots) {
            assert.equal(item.source_audio_vocals, 'instrumental');
            assert.match(item.audio, /instrumental score, unchanged/);
        }
    }
    const copy = structuredClone(value);
    pinVideoPlanToAudio(value, 20, lyrics);
    assert.deepEqual(value, copy);

    const guidance = videoSourceAudioPlannerGuidance(lyrics, 20, 'composed');
    assert.match(guidance, /^An original instrumental score composed for this request is the fixed soundtrack\./);
    assert.match(guidance, /nobody speaks, sings or lip-syncs/);
    assert.match(guidance, /about 150 BPM, one beat every 0\.40 seconds\. Its bars start at 0\.25, 1\.85, 3\.45,/);
    assert.doesNotMatch(videoSourceAudioPlannerGuidance({ words: [], lines: [], score: { bpm: 0, beats: [], bars: [] } }, 20), /BPM|lip-syncing/);
});

test('broker plans songs against transcribed lyric timing and queues them when transcription fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'song-lyrics-'));
    const words = sung(2, 6, 0.5);
    let transcribe = async () => ({ words, lines: [line(words)] });
    const broker = new VideoBroker({ host: '127.0.0.1', port: 0, dbPath: join(directory, 'queue.db'),
        resultsDir: join(directory, 'results'), botToken: 'bot', workerToken: 'worker', preplanQueuedJobs: false,
        sourceAudioDownloader: async () => ({ path: join(directory, 'song.wav'), bytes: 123, duration: 8.25 }),
        sourceAudioTranscriber: (...args) => transcribe(...args), sourceAudioCutter: async song => song });
    await broker.start();
    const submit = async id => {
        const res = await fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/jobs`, {
            method: 'POST', headers: { authorization: 'Bearer bot', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'minimax', prompt: 'Perform this song', source_audio: descriptor,
                requester_id: 'u', origin_bot_id: 'b', channel_id: 'c', command_message_id: id, status_message_id: 's' }) });
        assert.equal(res.status, 201);
        return broker.get('SELECT planner_guidance, source_audio_lyrics_json FROM video_jobs WHERE public_id=?', [(await res.json()).job.id]);
    };
    try {
        const timed = await submit('m1');
        assert.match(timed.planner_guidance, /\n0\.0-2\.0 instrumental\n2\.0-5\.0 "w2-0 w2-1 w2-2 w2-3 w2-4 w2-5"\n5\.0-8\.3 instrumental$/);
        assert.deepEqual(parseVideoSourceAudioLyrics(timed.source_audio_lyrics_json).words, words);
        transcribe = async () => { throw new Error('transcription unavailable'); };
        const plain = await submit('m2');
        assert.equal(plain.planner_guidance, VIDEO_SOURCE_AUDIO_GUIDANCE);
        assert.equal(plain.source_audio_lyrics_json, null);
    } finally { await broker.stop(); rmSync(directory, { recursive: true, force: true }); }
});
