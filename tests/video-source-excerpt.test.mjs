import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { extractVideoSourceRange, videoSourceRange, defaultSongExcerptLines, selectVideoSourceAudioExcerpt,
    describeVideoSourceExcerpt } from '../dist/VideoSourceExcerpt.js';
import { cutVideoSourceAudio, excerptVideoSourceAudioLyrics, parseVideoSourceAudioLyrics } from '../dist/VideoSourceAudio.js';
import { videoSourceClipExcerpt, cutVideoSourceClip } from '../dist/VideoSourceClip.js';
import { VideoBroker } from '../dist/VideoBroker.js';
import { videoSourceDescription } from '../dist/VideoGeneration.js';

const probe = path => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).toString());
// A song of four-second lines, with a repeated chorus line from 60 s to 84 s.
const songLines = seconds => Array.from({ length: Math.floor(seconds / 4) - 1 }, (_, i) => ({
    start: 4 + i * 4, end: 7.5 + i * 4, text: i >= 14 && i < 20 ? 'still tippin on four fours' : `verse line ${i}` }));
const songLyrics = seconds => {
    const lines = songLines(seconds);
    const words = lines.flatMap(line => line.text.split(' ').map((text, i, all) => ({ text,
        start: line.start + (line.end - line.start) * i / all.length, end: line.start + (line.end - line.start) * (i + 1) / all.length })));
    return { words, lines };
};

test('time ranges are read from prompts and validated', () => {
    assert.deepEqual(extractVideoSourceRange('1:05-1:50 rap this at a gas station'),
        { prompt: 'rap this at a gas station', range: { start_seconds: 65, end_seconds: 110 } });
    assert.deepEqual(extractVideoSourceRange('make it from 0:30 to 1:00.'),
        { prompt: 'make it.', range: { start_seconds: 30, end_seconds: 60 } });
    assert.deepEqual(extractVideoSourceRange('rap this, starting at 2:10'),
        { prompt: 'rap this', range: { start_seconds: 130, end_seconds: null } });
    assert.deepEqual(extractVideoSourceRange('swap him 0:12.5–0:20').range, { start_seconds: 12.5, end_seconds: 20 });
    for (const prompt of ['a clock showing 12:30', 'meet at 3:30-4:00pm', 'version 1:05-1:50:30']) {
        assert.equal(extractVideoSourceRange(prompt).range, null, prompt);
    }
    assert.equal(videoSourceRange(null), null);
    assert.throws(() => videoSourceRange({ start_seconds: 70, end_seconds: 65 }), /end after the start/);
    assert.throws(() => videoSourceRange({ start_seconds: 0, end_seconds: 121 }), /at most 2:00/);
});

test('long songs use about thirty seconds the request names or their hook, cut between lines', async () => {
    const lyrics = songLyrics(200);
    assert.deepEqual(defaultSongExcerptLines(lyrics.lines), { first: 14, last: 20, label: 'the hook' });
    assert.equal(await selectVideoSourceAudioExcerpt({ prompt: 'p', lyrics, seconds: 34, range: null }), null);
    // The picker's lines are padded into the gaps around them.
    let excerpt = await selectVideoSourceAudioExcerpt({ prompt: 'do the chorus', lyrics, seconds: 200, range: null }, {},
        async () => ({ first_line: 14, last_line: 19, label: 'The chorus!' }));
    assert.deepEqual(excerpt, { start_seconds: 59.5, end_seconds: 84, source_seconds: 200, label: 'The chorus', chosen: 'auto' });
    // A picker failure or an unusable answer falls back to the most repeated lines.
    for (const picker of [async () => { throw new Error('offline'); }, async () => ({ first_line: 40, last_line: 99, label: 'x' }),
        async () => ({ first_line: 3, last_line: 4, label: 'too short' })]) {
        excerpt = await selectVideoSourceAudioExcerpt({ prompt: 'p', lyrics, seconds: 200, range: null }, {}, picker);
        assert.deepEqual([excerpt.start_seconds, excerpt.end_seconds, excerpt.label], [59.5, 88, 'the hook']);
    }
    // An overlong pick is shortened from its end.
    excerpt = await selectVideoSourceAudioExcerpt({ prompt: 'p', lyrics, seconds: 200, range: null }, {},
        async () => ({ first_line: 0, last_line: 30, label: 'everything' }));
    assert.deepEqual([excerpt.start_seconds, excerpt.end_seconds], [3.5, 48]);
    excerpt = await selectVideoSourceAudioExcerpt({ prompt: 'p', lyrics: null, seconds: 200, range: null });
    assert.deepEqual([excerpt.start_seconds, excerpt.end_seconds, excerpt.label], [0, 30, 'the opening']);
    // A user range is kept exactly; an open one ends on the line nearest thirty seconds in.
    excerpt = await selectVideoSourceAudioExcerpt({ prompt: 'p', lyrics, seconds: 200, range: { start_seconds: 65, end_seconds: 110 } });
    assert.deepEqual([excerpt.start_seconds, excerpt.end_seconds, excerpt.chosen], [65, 110, 'range']);
    excerpt = await selectVideoSourceAudioExcerpt({ prompt: 'p', lyrics, seconds: 200, range: { start_seconds: 64, end_seconds: null } });
    assert.deepEqual([excerpt.start_seconds, excerpt.end_seconds], [64, 92]);
    await assert.rejects(selectVideoSourceAudioExcerpt({ prompt: 'p', lyrics, seconds: 200, range: { start_seconds: 230, end_seconds: null } }),
        /starts after your song ends; it is 3:20 long/);
    assert.equal(await selectVideoSourceAudioExcerpt({ prompt: 'p', lyrics, seconds: 40, range: { start_seconds: 0, end_seconds: 50 } }), null);

    assert.equal(describeVideoSourceExcerpt({ start_seconds: 65, end_seconds: 95, source_seconds: 222, label: 'the chorus', chosen: 'auto' }, 'song'),
        'the chorus, 1:05–1:35 of your 3:42 song');
    assert.equal(describeVideoSourceExcerpt({ start_seconds: 0, end_seconds: 120, source_seconds: 200, label: '', chosen: 'start' }, 'video'),
        'the first 2:00 of your 3:20 video');
    const job = { has_source_audio: true, source_excerpt: { start_seconds: 65, end_seconds: 95, source_seconds: 222, label: 'the chorus', chosen: 'auto' } };
    assert.equal(videoSourceDescription(job), 'Lip-syncing to the chorus, 1:05–1:35 of your 3:42 song');
    assert.match(videoSourceDescription(job, true), /\(add a range like 1:05-1:35 to pick another part\)$/);
    assert.equal(videoSourceDescription({ ...job, source_excerpt: { ...job.source_excerpt, chosen: 'range' } }, true),
        'Lip-syncing to 1:05–1:35 of your 3:42 song');
});

test('song excerpts are cut from the whole song with lyric timing moved onto them', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'song-excerpt-'));
    try {
        const full = join(directory, 'song-full.wav');
        execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=90', '-ac', '2', '-ar', '48000', full]);
        const cut = await cutVideoSourceAudio({ path: full, bytes: 1, duration: 90 },
            { start_seconds: 30, end_seconds: 60, source_seconds: 90, label: 'the hook', chosen: 'auto' }, directory);
        assert.equal(cut.path, join(directory, 'source-audio.wav'));
        assert.ok(Math.abs(cut.duration - 30) < 0.01);
        assert.equal(existsSync(full), false);
        execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', full]);
        const whole = await cutVideoSourceAudio({ path: full, bytes: 1, duration: 8 }, null, directory);
        assert.ok(Math.abs(probe(whole.path) - 8) < 0.01);
    } finally { rmSync(directory, { recursive: true, force: true }); }
    const lyrics = songLyrics(200);
    const shifted = excerptVideoSourceAudioLyrics(lyrics, { start_seconds: 59.5, end_seconds: 84, source_seconds: 200, label: '', chosen: 'auto' });
    assert.deepEqual(shifted.lines.map(l => [l.start, l.end]), [[0.5, 4], [4.5, 8], [8.5, 12], [12.5, 16], [16.5, 20], [20.5, 24]]);
    assert.ok(shifted.words.every(w => w.start >= 0 && w.end <= 24.5));
    assert.equal(excerptVideoSourceAudioLyrics(lyrics, { start_seconds: 0, end_seconds: 3, source_seconds: 200, label: '', chosen: 'auto' }), null);
    assert.equal(excerptVideoSourceAudioLyrics(lyrics, null), lyrics);
});

test('source videos keep a requested range or their first two minutes', async () => {
    assert.equal(videoSourceClipExcerpt(90, null), null);
    assert.deepEqual(videoSourceClipExcerpt(200, null), { start_seconds: 0, end_seconds: 120, source_seconds: 200, label: '', chosen: 'start' });
    assert.deepEqual(videoSourceClipExcerpt(200, { start_seconds: 150, end_seconds: null }),
        { start_seconds: 150, end_seconds: 200, source_seconds: 200, label: '', chosen: 'range' });
    assert.equal(videoSourceClipExcerpt(30, { start_seconds: 0, end_seconds: 45 }), null);
    assert.throws(() => videoSourceClipExcerpt(30, { start_seconds: 40, end_seconds: 50 }), /starts after your video ends/);
    const directory = mkdtempSync(join(tmpdir(), 'clip-excerpt-'));
    try {
        const input = join(directory, 'input.mp4');
        execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=24:duration=130',
            '-f', 'lavfi', '-i', 'sine=frequency=330:duration=130', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', input]);
        const output = join(directory, 'source-video.mp4');
        const seconds = await cutVideoSourceClip(input, output, videoSourceClipExcerpt(130, { start_seconds: 10, end_seconds: 20 }));
        assert.ok(Math.abs(seconds - 10) < 0.1, String(seconds));
        assert.ok(Math.abs(await cutVideoSourceClip(input, output, videoSourceClipExcerpt(130, null)) - 120) < 0.1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('broker queues a long song as its chosen excerpt with shifted lyric timing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'song-excerpt-broker-'));
    const lyrics = songLyrics(200);
    let cutExcerpt;
    const broker = new VideoBroker({ host: '127.0.0.1', port: 0, dbPath: join(directory, 'queue.db'),
        resultsDir: join(directory, 'results'), botToken: 'bot', workerToken: 'worker', preplanQueuedJobs: false,
        sourceAudioDownloader: async () => ({ path: join(directory, 'song-full.wav'), bytes: 123, duration: 200 }),
        sourceAudioTranscriber: async () => lyrics,
        sourceAudioExcerptSelector: (input, hooks) => selectVideoSourceAudioExcerpt(input, hooks,
            async () => ({ first_line: 14, last_line: 19, label: 'the chorus' })),
        sourceAudioCutter: async (song, excerpt) => {
            cutExcerpt = excerpt;
            return { path: join(directory, 'source-audio.wav'), bytes: 1, duration: excerpt.end_seconds - excerpt.start_seconds };
        } });
    await broker.start();
    const submit = async (id, extra = {}) => {
        const res = await fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/jobs`, {
            method: 'POST', headers: { authorization: 'Bearer bot', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'minimax', prompt: 'Rap the chorus', requester_id: 'u', origin_bot_id: 'b', channel_id: 'c',
                source_audio: { url: 'https://cdn.discordapp.com/attachments/1/2/song.mp3', name: 'song.mp3', bytes: 1234 },
                command_message_id: id, status_message_id: 's', ...extra }) });
        return [res.status, await res.json()];
    };
    try {
        const [status, body] = await submit('m1');
        assert.equal(status, 201);
        assert.deepEqual(body.job.source_excerpt, { start_seconds: 59.5, end_seconds: 84, source_seconds: 200, label: 'the chorus', chosen: 'auto' });
        assert.equal(body.job.source_audio_seconds, 24.5);
        assert.deepEqual(cutExcerpt, body.job.source_excerpt);
        const row = await broker.get('SELECT planner_guidance, source_audio_lyrics_json FROM video_jobs WHERE public_id=?', [body.job.id]);
        assert.match(row.planner_guidance, /\n0\.5-4\.0 "still tippin on four fours"\n/);
        assert.equal(parseVideoSourceAudioLyrics(row.source_audio_lyrics_json).lines[0].start, 0.5);
        const [badStatus, bad] = await submit('m2', { source_range: { start_seconds: 70, end_seconds: 60 } });
        assert.deepEqual([badStatus, bad.error], [400, 'Use a time range like 1:05-1:35, with the end after the start.']);
        const [lateStatus, late] = await submit('m3', { source_range: { start_seconds: 300, end_seconds: null } });
        assert.deepEqual([lateStatus, late.error], [400, 'That range starts after your song ends; it is 3:20 long.']);
    } finally { await broker.stop(); rmSync(directory, { recursive: true, force: true }); }
});
