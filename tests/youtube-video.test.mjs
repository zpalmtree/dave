import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { VideoBroker } from '../dist/VideoBroker.js';
import { videoSourcesFromMessages } from '../dist/VideoGeneration.js';
import { sourceClipDescriptor, storeVideoSourceClip } from '../dist/VideoSourceClip.js';
import { isYoutubeVideoUrl, youtubeVideoFromMessage } from '../dist/YoutubeVideo.js';

const canonical = 'https://www.youtube.com/watch?v=GG1d35jpizo';
const message = (content = '', attachments = [], embeds = []) => ({ content, attachments: new Map(attachments.map((a, i) => [i, a])), embeds });
const noTwitter = async () => null;

test('YouTube videos and Shorts resolve to one canonical watch link', () => {
    for (const link of ['https://www.youtube.com/shorts/GG1d35jpizo', 'https://youtube.com/shorts/GG1d35jpizo?feature=share',
        'https://youtu.be/GG1d35jpizo?t=4', 'https://m.youtube.com/watch?v=GG1d35jpizo&list=abc', `(<${canonical}>).`]) {
        assert.deepEqual(youtubeVideoFromMessage(message(`yo see what oalgo looks like in this video ${link}`)),
            { clip_url: canonical, name: 'youtube-GG1d35jpizo.mp4' });
    }
    assert.equal(youtubeVideoFromMessage(message('', [], [{ url: canonical }])).clip_url, canonical);
    assert.equal(youtubeVideoFromMessage(message(`${canonical} https://youtu.be/GG1d35jpizo`)).clip_url, canonical);
    assert.throws(() => youtubeVideoFromMessage(message(`${canonical} https://youtu.be/MmZexg8sxyk`)), /exactly one/);
    for (const link of ['http://www.youtube.com/watch?v=GG1d35jpizo', 'https://youtube.com/playlist?list=abc',
        'https://www.youtube.com/@channel', 'https://x@youtube.com/watch?v=GG1d35jpizo', 'https://youtube.com.evil.test/watch?v=GG1d35jpizo',
        'https://www.youtube.com/shorts/short']) {
        assert.equal(youtubeVideoFromMessage(message(link)), null);
        assert.equal(isYoutubeVideoUrl(link), false);
    }
    assert.equal(isYoutubeVideoUrl(canonical), true);
    assert.equal(isYoutubeVideoUrl(`${canonical}&list=abc`), false);
    assert.deepEqual(sourceClipDescriptor({ clip_url: canonical, name: 'youtube-GG1d35jpizo.mp4' }),
        { clip_url: canonical, name: 'youtube-GG1d35jpizo.mp4' });
    assert.throws(() => sourceClipDescriptor({ clip_url: 'https://www.youtube.com/shorts/GG1d35jpizo', name: 'clip.mp4' }), /YouTube video link/);
});

test('a YouTube link is an edit source only: other requests keep it for the song router', async () => {
    const reply = message('look at this https://www.youtube.com/shorts/GG1d35jpizo');
    const edit = await videoSourcesFromMessages(message('replace this character with meximutt'), reply, true, noTwitter);
    assert.equal(edit.clip.clip_url, canonical);
    assert.deepEqual(await videoSourcesFromMessages(message('sing this'), reply, false, noTwitter), { image: null, clip: null });
    const clip = { name: 'clip.mp4', contentType: 'video/mp4', size: 123, url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4' };
    assert.equal((await videoSourcesFromMessages(message(canonical, [clip]), null, true, noTwitter)).clip.clip_url, clip.url);
});

test('the broker has the desktop download a YouTube source and stores its upload', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-youtube-source-'));
    const broker = new VideoBroker({
        host: '127.0.0.1', port: 0,
        dbPath: join(directory, 'queue.sqlite3'), resultsDir: join(directory, 'results'),
        botToken: 'bot-secret', workerToken: 'worker-secret', preplanQueuedJobs: false,
        videoEditGrounder: async (_source, target) => ({ action: 'replace', target, clarification: '' }),
        // Stands in for storeVideoSourceClip's ffprobe; the fetch itself is the broker's.
        sourceVideoDownloader: async (source, target, _range, fetchYoutube) => {
            mkdirSync(target, { recursive: true });
            const path = join(target, 'source-video.mp4');
            await fetchYoutube(source.clip_url, path);
            return { path, bytes: readFileSync(path).length, duration: 12 };
        },
    });
    await broker.start();
    const base = `http://127.0.0.1:${broker.listeningPort()}`;
    const submit = id => fetch(`${base}/v1/jobs`, {
        method: 'POST', headers: { authorization: 'Bearer bot-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'minimax', prompt: 'meximutt', command_variant: 'oalgo',
            source_video: { clip_url: canonical, name: 'youtube-GG1d35jpizo.mp4' }, source_image: { preset: 'meximutt' },
            video_edit_target: 'this character', requester_id: id, origin_bot_id: 'bot', channel_id: 'channel',
            command_message_id: id, status_message_id: 'status' }),
    });
    let socket;
    try {
        const offline = await submit('offline');
        assert.equal(offline.status, 400);
        assert.match((await offline.json()).error, /GPU online/);

        const fetches = [];
        let reply = async request => {
            const upload = await fetch(`${base}/v1/worker/source-videos/${request.request_id}`, {
                method: 'PUT', headers: { authorization: 'Bearer worker-secret' }, body: 'youtube video' });
            assert.equal(upload.status, 200);
        };
        const connect = async extra => {
            socket?.terminate();
            socket = new WebSocket(base.replace('http:', 'ws:') + '/v1/worker', { headers: { authorization: 'Bearer worker-secret' } });
            socket.on('message', data => {
                const value = JSON.parse(String(data));
                if (value.type === 'source_video_fetch') { fetches.push(value); reply(value); }
            });
            const acknowledged = new Promise(resolve => socket.once('message', resolve));
            await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
            socket.send(JSON.stringify({ type: 'hello', protocol: 1, worker_id: 'edit-worker',
                capabilities: ['minimax'], current_job: 'busy', video_edit_version: 6, ...extra }));
            await acknowledged;
        };
        await connect({});
        assert.match((await (await submit('old-worker')).json()).error, /GPU online/);

        await connect({ source_video_download_version: 1 });
        const accepted = await submit('accepted');
        assert.equal(accepted.status, 201);
        assert.equal(fetches[0].url, canonical);
        const row = await broker.get('SELECT * FROM video_jobs WHERE public_id=?', [(await accepted.json()).job.id]);
        assert.equal(readFileSync(row.source_video_path, 'utf8'), 'youtube video');
        assert.equal(row.source_video_seconds, 12);

        reply = async request => socket.send(JSON.stringify({ type: 'source_video_event', event: 'failed',
            request_id: request.request_id, error: 'Video unavailable' }));
        const failed = await submit('failed');
        assert.equal(failed.status, 400);
        assert.match((await failed.json()).error, /Could not download that YouTube video: Video unavailable/);
        const stale = await fetch(`${base}/v1/worker/source-videos/${fetches[1].request_id}`, {
            method: 'PUT', headers: { authorization: 'Bearer worker-secret' }, body: 'late' });
        assert.equal(stale.status, 404);
    } finally {
        socket?.terminate();
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('a YouTube source is rejected where no desktop fetch is available', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-youtube-store-'));
    try {
        await assert.rejects(storeVideoSourceClip({ clip_url: canonical, name: 'youtube-GG1d35jpizo.mp4' }, directory), /Attach the video directly/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
