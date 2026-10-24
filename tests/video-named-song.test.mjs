import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VideoBroker } from '../dist/VideoBroker.js';
import { validatedVideoSongDecision, videoSongDecisionForPrompt, mayWantComposedSong } from '../dist/VideoComposedSong.js';

const recording = { title: 'Electric Feel', artist: 'MGMT', url: '' };
const decision = { mode: 'recording', reason: 'An existing song was requested.', seconds: 0, caption: '', lyrics: '', recording };
const coverUrl = 'https://www.youtube.com/watch?v=J7ATTjg7tpE';
const coverPrompt = `oalgo guy cover of this with also a pack of taco bell dogs and trump eating a taco salad: ${coverUrl}`;

test('cover wording and bare YouTube links reach song classification without inventing a recording identity', () => {
    assert.ok(mayWantComposedSong(coverPrompt), 'Regression: ccaa392d skipped song classification.');
    assert.ok(mayWantComposedSong('an acoustic cover of Electric Feel'));
    for (const url of [coverUrl, 'https://youtu.be/J7ATTjg7tpE?t=30', 'https://www.youtube.com/shorts/J7ATTjg7tpE',
        'https://music.youtube.com/watch?v=J7ATTjg7tpE']) {
        const prompt = `oalgo guy does this: ${url}`;
        assert.ok(mayWantComposedSong(prompt));
        for (const selected of ['', url, coverUrl]) {
            assert.deepEqual(videoSongDecisionForPrompt({ mode: 'recording', recording_url: selected }, prompt).recording,
                { title: '', artist: '', url: coverUrl });
        }
    }
    assert.throws(() => videoSongDecisionForPrompt({ mode: 'recording', recording_url: 'https://youtu.be/MmZexg8sxyk' }, coverPrompt), /could not be verified/);
    assert.throws(() => videoSongDecisionForPrompt({ mode: 'recording', recording_url: coverUrl }, 'sing Electric Feel'), /could not be verified/);
    assert.equal(mayWantComposedSong('look at https://youtube.com.evil.test/watch?v=J7ATTjg7tpE'), false);
    assert.equal(videoSongDecisionForPrompt({ mode: 'none', reason: 'A book cover.' }, `animate this book cover ${coverUrl}`).mode, 'none');
});

test('named songs retain recording identity instead of becoming inspired originals', () => {
    assert.deepEqual(validatedVideoSongDecision({ mode: 'recording', reason: decision.reason,
        recording_title: recording.title, recording_artist: recording.artist }), decision);
    assert.throws(() => validatedVideoSongDecision({ mode: 'recording', recording_title: 'Hello' }), /song and artist/);
    assert.throws(() => validatedVideoSongDecision({ mode: 'recording', recording_url: 'https://example.com/song' }), /YouTube/);
    assert.equal(validatedVideoSongDecision({ mode: 'recording', recording_url: 'https://youtu.be/MmZexg8sxyk' }).recording.url,
        'https://www.youtube.com/watch?v=MmZexg8sxyk');
    assert.ok(mayWantComposedSong('lip-sync to Electric Feel'));
});

test('named recording is fetched once, cut to the requested chorus, and never silently substituted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'video-named-song-'));
    const mp3 = join(directory, 'fixture.mp3');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=90', '-b:a', '128k', mp3]);
    const lyrics = { words: [31, 32, 33].map(start => ({ start, end: start + 0.5, text: 'fixture' })),
        lines: [{ start: 31, end: 33.5, text: 'fixture fixture fixture' }] };
    let written = 0, recoverTiming = false;
    const transcriptionDurations = [];
    const broker = new VideoBroker({ host: '127.0.0.1', port: 0, dbPath: join(directory, 'db'), resultsDir: directory,
        botToken: 'bot', workerToken: 'worker', recoveryEnabled: true, preplanQueuedJobs: false,
        songWriter: async input => {
            written++;
            return input.prompt === coverPrompt
                ? videoSongDecisionForPrompt({ mode: 'recording', reason: 'Use the linked recording.' }, input.prompt)
                : decision;
        }, sourceAudioTranscriber: async audio => {
            transcriptionDurations.push(Math.round(audio.duration));
            if (!recoverTiming) return lyrics;
            return { words: lyrics.words.map(w => ({ ...w, start: w.start - 30, end: w.end - 30 })),
                lines: Math.round(audio.duration) === 90 ? lyrics.lines
                    : lyrics.lines.map(w => ({ ...w, start: w.start - 30, end: w.end - 30 })) };
        },
        sourceAudioExcerptSelector: async input => {
            assert.match(input.prompt, /chorus/);
            assert.equal(Math.round(input.seconds), 90);
            return { start_seconds: 30, end_seconds: 50, source_seconds: input.seconds, label: 'the chorus', chosen: 'auto' };
        },
    });
    await broker.start();
    const base = `http://127.0.0.1:${broker.listeningPort()}`;
    const submit = async (id, prompt = 'Make this cat sing the chorus to Electric Feel') => {
        const response = await fetch(base + '/v1/jobs', { method: 'POST',
            headers: { authorization: 'Bearer bot', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'minimax', prompt,
                requester_id: id, origin_bot_id: 'bot', channel_id: 'channel', command_message_id: id, status_message_id: id }),
        });
        return (await response.json()).job.id;
    };
    const lease = async id => {
        broker.worker = { id: 'desktop', currentJob: id, leaseId: 'lease', ready: false, capabilities: ['minimax'],
            recoveryVersion: 3, sourceAudioVersion: 1, songComposeVersion: 1, songDownloadVersion: 1,
            lastHeartbeat: Date.now(), scheduler: { available: false }, socket: { send() {}, close() {}, terminate() {} } };
        await broker.run("UPDATE video_jobs SET status='running', worker_id='desktop', lease_token='lease', recovery_version=3 WHERE public_id=?", [id]);
    };
    const request = async (id, op, data = {}) => {
        const r = await fetch(`${base}/v1/worker/jobs/${id}/recovery/${op}`, { method: 'POST',
            headers: { authorization: 'Bearer worker', 'content-type': 'application/json', 'x-video-lease-id': 'lease' },
            body: JSON.stringify(data) });
        return { status: r.status, body: await r.json() };
    };
    try {
        const id = await submit('first');
        await lease(id);
        assert.deepEqual((await request(id, 'plan')).body.compose_song.recording, recording);
        await request(id, 'plan');
        assert.equal(written, 1);
        const stored = await request(id, 'soundtrack', { audio: readFileSync(mp3).toString('base64'), format: 'mp3',
            recording: { title: 'MGMT - Electric Feel', url: 'https://www.youtube.com/watch?v=MmZexg8sxyk' } });
        assert.equal(stored.status, 200, JSON.stringify(stored.body));
        assert.equal(stored.body.seconds, 20);
        const row = await broker.get('SELECT * FROM video_jobs WHERE public_id=?', [id]);
        assert.equal(row.source_audio_origin, 'recording');
        assert.equal(row.source_audio_seconds, 20);
        assert.equal(JSON.parse(row.source_excerpt_json).start_seconds, 30);
        assert.equal(JSON.parse(row.source_audio_lyrics_json).words[0].start, 1);
        assert.match(broker.frontierOptions(row, true).plannerGuidance, /preserve its original recorded vocals/);
        const guidance = broker.frontierOptions(row, true).plannerGuidance;
        assert.ok(guidance.includes(JSON.stringify({ title: recording.title, artist: recording.artist })),
            'resolved title and artist must survive soundtrack storage into visual planning');
        const urlOnly = { ...row, recovery_json: JSON.stringify({ song: {
            recording: { title: '', artist: '', url: 'https://youtu.be/MmZexg8sxyk' },
            source: { title: 'Actual downloaded track title', channel: 'An uploader is not the artist' },
        } }) };
        const urlGuidance = broker.frontierOptions(urlOnly, true).plannerGuidance;
        assert.ok(urlGuidance.includes(JSON.stringify({ title: 'Actual downloaded track title' })));
        assert.ok(!urlGuidance.includes('An uploader is not the artist'));
        assert.ok(!broker.frontierOptions({ ...row, recovery_json: null }, true).plannerGuidance.includes('Resolved recording metadata'));
        assert.equal((await broker.views([row]))[0].composed_song, false);
        await broker.run("UPDATE video_jobs SET status='delivered' WHERE public_id=?", [id]);
        const failed = await submit('second');
        await lease(failed);
        await request(failed, 'plan');
        const failure = await request(failed, 'soundtrack', { failed: 'Song unavailable.' });
        assert.equal(failure.status, 422);
        assert.match(failure.body.error, /Attach the recording/);
        assert.equal((await request(failed, 'plan')).status, 422);
        await broker.run("UPDATE video_jobs SET status='failed' WHERE public_id=?", [failed]);
        recoverTiming = true;
        const recovered = await submit('third');
        await lease(recovered);
        await request(recovered, 'plan');
        const retry = await request(recovered, 'soundtrack', { audio: readFileSync(mp3).toString('base64'), format: 'mp3' });
        assert.equal(retry.status, 200, JSON.stringify(retry.body));
        const recoveredRow = await broker.get('SELECT * FROM video_jobs WHERE public_id=?', [recovered]);
        assert.equal(JSON.parse(recoveredRow.source_audio_lyrics_json).words[0].start, 1);
        assert.equal(retry.body.lyric_lines, 1);
        assert.deepEqual(transcriptionDurations, [90, 90, 20]);
        assert.match(broker.frontierOptions(recoveredRow, true).plannerGuidance, /vocal timeline/);
        await broker.run("UPDATE video_jobs SET status='delivered' WHERE public_id=?", [recovered]);
        const cover = await submit('ccaa392d-regression', coverPrompt);
        await lease(cover);
        const beforeCover = written;
        const coverPlan = await request(cover, 'plan');
        assert.equal(coverPlan.status, 200, JSON.stringify(coverPlan.body));
        assert.equal(coverPlan.body.compose_song.recording.url, coverUrl);
        assert.equal(written, beforeCover + 1);
        const coverRow = await broker.get('SELECT * FROM video_jobs WHERE public_id=?', [cover]);
        assert.equal(coverRow.planner_json, null, 'The screenplay must wait for the linked recording.');
        assert.equal(JSON.parse(coverRow.recovery_json).prepared, undefined);
        const unavailable = await request(cover, 'soundtrack', { failed: 'YouTube recording unavailable.' });
        assert.equal(unavailable.status, 422, 'A failed linked cover must not turn into an original song.');
        assert.equal((await request(cover, 'plan')).status, 422);
    } finally {
        broker.worker = null;
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});
