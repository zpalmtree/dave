import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VideoBroker } from '../dist/VideoBroker.js';
import { validatedVideoSongDecision, mayWantComposedSong } from '../dist/VideoComposedSong.js';

const recording = { title: 'Electric Feel', artist: 'MGMT', url: '' };
const decision = { mode: 'recording', reason: 'An existing song was requested.', seconds: 0, caption: '', lyrics: '', recording };

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
    let written = 0;
    const broker = new VideoBroker({ host: '127.0.0.1', port: 0, dbPath: join(directory, 'db'), resultsDir: directory,
        botToken: 'bot', workerToken: 'worker', recoveryEnabled: true, preplanQueuedJobs: false,
        songWriter: async () => { written++; return decision; }, sourceAudioTranscriber: async () => lyrics,
        sourceAudioExcerptSelector: async input => {
            assert.match(input.prompt, /chorus/);
            assert.equal(Math.round(input.seconds), 90);
            return { start_seconds: 30, end_seconds: 50, source_seconds: input.seconds, label: 'the chorus', chosen: 'auto' };
        },
    });
    await broker.start();
    const base = `http://127.0.0.1:${broker.listeningPort()}`;
    const submit = async id => {
        const response = await fetch(base + '/v1/jobs', { method: 'POST',
            headers: { authorization: 'Bearer bot', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'minimax', prompt: 'Make this cat sing the chorus to Electric Feel',
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
        assert.equal((await broker.views([row]))[0].composed_song, false);
        await broker.run("UPDATE video_jobs SET status='delivered' WHERE public_id=?", [id]);
        const failed = await submit('second');
        await lease(failed);
        await request(failed, 'plan');
        const failure = await request(failed, 'soundtrack', { failed: 'Song unavailable.' });
        assert.equal(failure.status, 422);
        assert.match(failure.body.error, /Attach the recording/);
        assert.equal((await request(failed, 'plan')).status, 422);
    } finally {
        broker.worker = null;
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});
