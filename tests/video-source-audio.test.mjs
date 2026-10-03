import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { videoSourceAudioFromMessages, sourceAudioDescriptor, pinVideoPlanToAudio, normalizeVideoSourceAudio,
    songLyricsFromTranscription, videoSourceAudioPlannerGuidance, parseVideoSourceAudioLyrics, VIDEO_SOURCE_AUDIO_GUIDANCE } from '../dist/VideoSourceAudio.js';
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
