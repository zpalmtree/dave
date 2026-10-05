import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VideoBroker } from '../dist/VideoBroker.js';
import { approvedRecoveryContract, recoveryHash } from '../dist/VideoRecovery.js';
import { mayWantComposedSong, validatedVideoSongDecision, VIDEO_COMPOSED_SONG_MAX_SECONDS } from '../dist/VideoComposedSong.js';
import { videoSourceDescription } from '../dist/VideoGeneration.js';

const CAPTION = 'Global Metadata: Cumbia, 95 BPM, A minor.\n\nVocal Details: Male lead.\n\nArrangement: Accordion and guiro.';

test('songwriter answers are bounded and only sung requests reach it', () => {
    assert.equal(mayWantComposedSong('official music video for "la cumbia de la plaga rusa"'), true);
    assert.equal(mayWantComposedSong('Meximutt sings about tacos'), true);
    assert.equal(mayWantComposedSong('una canción sobre el perro'), true);
    assert.equal(mayWantComposedSong('Meximutt yells at a pigeon'), false);
    const song = validatedVideoSongDecision({ mode: 'compose', reason: 'A music video.', seconds: 400, caption: CAPTION,
        lyrics: '[Intro]\n\n[Verse]\nEsta es la cumbia\n[Chorus]\nO algo' });
    assert.equal(song.mode, 'compose');
    assert.equal(song.seconds, VIDEO_COMPOSED_SONG_MAX_SECONDS);
    assert.match(song.lyrics, /^\[Verse\]/, 'A leading intro would hold the singer through a long instrumental.');
    assert.equal(validatedVideoSongDecision({ mode: 'compose', seconds: 30, caption: CAPTION, lyrics: '[Verse]\n[Chorus]' }).mode,
        'none', 'A song without sung lines is not composed.');
    assert.equal(validatedVideoSongDecision({ mode: 'compose', seconds: 30, caption: CAPTION, lyrics: '[Verse]\nla la' }, 20).seconds,
        20, 'A requested duration wins.');
    assert.equal(validatedVideoSongDecision({ mode: 'none', reason: 'Dialogue.' }).mode, 'none');
    assert.equal(videoSourceDescription({ has_source_audio: true, composed_song: true, source_kind: 'preset' }),
        'Starring Meximutt · Singing an original song');
});

test('a song request composes its soundtrack on the worker and then plans like an uploaded song', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'video-composed-song-'));
    const songFile = join(directory, 'song.flac');
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=12', '-ac', '2', songFile]);
    const value = { intent: 'A cumbia.', continuity_bible: 'Meximutt.', prompt_analysis: { frontier_handling: { disposition: 'fulfill' }, dialogue_contract: { mode: 'none', lines: [] } },
        keyframe: { recommended: true, prompt: 'Meximutt.' },
        segments: [{ title: 'Song', transition: 'start', target_seconds: 12,
            shots: [{ duration_seconds: 12, visual: 'He sings.', camera: 'Wide', audio: 'Song', dialogue: [] }] }] };
    const contract = approvedRecoveryContract(value, 'official music video for "la cumbia"');
    const prepared = { plan: value, contract, contract_hash: recoveryHash(contract), prompt: contract.prompt, notice: '' };
    const lyrics = { words: [{ start: 0.2, end: 1, text: 'esta' }], lines: [{ start: 0.2, end: 1, text: 'esta' }] };
    let songwriterCalls = 0, songwriterAnswer = 'compose', transcribed = 0;
    const planned = [];
    const broker = new VideoBroker({ host: '127.0.0.1', port: 0, dbPath: join(directory, 'queue.sqlite3'),
        resultsDir: join(directory, 'results'), botToken: 'bot', workerToken: 'worker',
        recoveryEnabled: true, preplanQueuedJobs: false,
        songWriter: async (input, options) => {
            songwriterCalls++;
            assert.equal(input.prompt, 'official music video for "la cumbia"');
            assert.match(options.plannerGuidance, /Meximutt persona/, 'The songwriter writes in the character\'s voice.');
            return songwriterAnswer === 'compose'
                ? { mode: 'compose', reason: 'A music video.', seconds: 30, caption: CAPTION, lyrics: '[Verse]\nEsta es la cumbia' }
                : { mode: 'none', reason: 'Dialogue.', seconds: 0, caption: '', lyrics: '' };
        },
        sourceAudioTranscriber: async () => { transcribed++; return lyrics; },
        recoveryPlanner: async input => {
            planned.push(input);
            const own = approvedRecoveryContract(structuredClone(value), input.prompt);
            return { ...structuredClone(prepared), contract: own, contract_hash: recoveryHash(own), prompt: input.prompt };
        },
    });
    await broker.start();
    try {
        const base = `http://127.0.0.1:${broker.listeningPort()}`;
        const submit = async prompt => {
            const response = await fetch(`${base}/v1/jobs`, { method: 'POST',
                headers: { authorization: 'Bearer bot', 'content-type': 'application/json' },
                body: JSON.stringify({ model: 'minimax', prompt, planner_guidance: 'Meximutt persona guidance.',
                    requester_id: String(Math.random()).slice(2), origin_bot_id: '2', channel_id: '3', command_message_id: String(Math.random()).slice(2),
                    status_message_id: '5' }),
            });
            assert.equal(response.status, 201);
            return (await response.json()).job.id;
        };
        const lease = async (id, songComposeVersion = 1) => {
            broker.worker = { id: 'test-worker', currentJob: id, leaseId: 'lease', ready: false, capabilities: ['minimax'],
                recoveryVersion: 3, sourceAudioVersion: 1, songComposeVersion, lastHeartbeat: Date.now(),
                scheduler: { available: false }, socket: { send() {}, close() {}, terminate() {} } };
            await broker.run("UPDATE video_jobs SET status='running', worker_id='test-worker', lease_token='lease', recovery_version=3 WHERE public_id=?", [id]);
        };
        const request = async (id, operation, body = {}) => {
            const response = await fetch(`${base}/v1/worker/jobs/${id}/recovery/${operation}`, { method: 'POST',
                headers: { authorization: 'Bearer worker', 'content-type': 'application/json', 'x-video-lease-id': 'lease' },
                body: JSON.stringify({ contract_hash: '', ...body }),
            });
            return { status: response.status, body: await response.json() };
        };
        const row = id => broker.get('SELECT * FROM video_jobs WHERE public_id=?', [id]);

        const id = await submit('official music video for "la cumbia"');
        await lease(id);
        const directive = await request(id, 'plan');
        assert.equal(directive.status, 200, JSON.stringify(directive.body));
        assert.deepEqual(directive.body.compose_song, { caption: CAPTION, lyrics: '[Verse]\nEsta es la cumbia', seconds: 30 });
        assert.equal((await request(id, 'plan')).body.compose_song.seconds, 30, 'A restarted worker composes the same song.');
        assert.equal(songwriterCalls, 1, 'The songwriter decision is kept for the job.');
        assert.equal(planned.length, 0, 'Nothing is planned before the song exists.');

        const stored = await request(id, 'soundtrack', { audio: readFileSync(songFile).toString('base64'), format: 'flac' });
        assert.equal(stored.status, 200, JSON.stringify(stored.body));
        assert.equal(stored.body.composed, true);
        assert.ok(Math.abs(stored.body.seconds - 12) < 0.1);
        const song = await row(id);
        assert.equal(song.source_audio_origin, 'composed');
        assert.ok(existsSync(song.source_audio_path));
        assert.equal(transcribed, 1);
        assert.equal((await request(id, 'soundtrack', { failed: 'late' })).status, 409, 'A stored song is final.');

        const plan = await request(id, 'plan');
        assert.equal(plan.status, 200, JSON.stringify(plan.body));
        assert.equal(plan.body.contract_hash, prepared.contract_hash);
        assert.ok(Math.abs(planned[0].sourceAudioSeconds - 12) < 0.1);
        assert.deepEqual(planned[0].sourceAudioLyrics, lyrics);
        assert.match(planned[0].options.plannerGuidance, /Meximutt persona guidance\.\nAn original song composed for this request is the fixed soundtrack\./);
        const view = (await broker.views([await row(id)]))[0];
        assert.equal(view.composed_song, true);
        assert.equal(view.has_source_audio, true);

        await broker.run("UPDATE video_jobs SET status='delivered' WHERE public_id=?", [id]);
        const regenerated = await fetch(`${base}/v1/jobs/${id}/regenerate`, { method: 'POST',
            headers: { authorization: 'Bearer bot', 'content-type': 'application/json' }, body: '{}' });
        assert.equal(regenerated.status, 200);
        const fresh = await row(id);
        assert.equal(fresh.source_audio_path, null, 'A regenerate composes a new song.');
        assert.equal(fresh.source_audio_origin, null);

        // A failed composition still renders the video, with each scene's own audio.
        await lease(id);
        assert.ok((await request(id, 'plan')).body.compose_song);
        assert.equal((await request(id, 'soundtrack', { failed: 'ComfyUI was unavailable.' })).body.composed, false);
        assert.equal((await request(id, 'plan')).body.contract_hash, prepared.contract_hash);
        assert.equal(planned.at(-1).sourceAudioSeconds, undefined);

        const before = songwriterCalls;
        const older = await submit('official music video for "la cumbia"');
        await lease(older, 0);
        assert.ok((await request(older, 'plan')).body.contract_hash, 'An older worker plans as before.');
        const spoken = await submit('Meximutt yells at a pigeon');
        await lease(spoken);
        assert.ok((await request(spoken, 'plan')).body.contract_hash);
        songwriterAnswer = 'none';
        const skit = await submit('Meximutt sings one word in a skit about his landlord');
        await lease(skit);
        assert.ok((await request(skit, 'plan')).body.contract_hash);
        assert.equal(songwriterCalls, before + 1, 'Only the possible song request asked the songwriter.');
    } finally {
        broker.worker = null;
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});
