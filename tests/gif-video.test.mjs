import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Response } from 'node-fetch';
import { gifVideoFromMessage, isGifVideoUrl, stripGifVideoLinks } from '../dist/GifVideo.js';
import { videoSourcesFromMessages, videoSourceImageFromMessage, videoClipSourceImageFromMessage,
    resolveVideoEditRequest, videoReplacementUsesPreset, videoPromptFromMessages } from '../dist/VideoGeneration.js';
import { sourceClipDescriptor, storeVideoSourceClip } from '../dist/VideoSourceClip.js';
import { MEXIMUTT } from '../dist/VideoCharacters.js';
import { VideoBroker } from '../dist/VideoBroker.js';

const tenor = 'https://tenor.com/view/referee-gif-123456';
const giphy = 'https://giphy.com/gifs/referee-abc123';
const media = 'https://media.tenor.com/abc/referee.mp4';
const gif = { url: 'https://cdn.discordapp.com/attachments/1/2/referee.gif', name: 'referee.gif', contentType: 'image/gif', size: 321 };
const portrait = { url: 'https://cdn.discordapp.com/attachments/1/2/portrait.png', name: 'portrait.png', contentType: 'image/png', size: 123 };
const message = (content = '', attachments = [], embeds = []) => ({ content, attachments: new Map(attachments.map((value, i) => [i, value])), embeds });
const noTwitter = async () => null;
const noFetch = async () => assert.fail('unexpected network call');

test('GIF uploads are full source clips, including MIME-only filenames and case-insensitive extensions', async () => {
    for (const attachment of [gif, { ...gif, name: 'REF.GIF', contentType: null }, { ...gif, name: 'download' }]) {
        const reply = message('', [attachment]);
        assert.equal(videoSourceImageFromMessage(reply), null);
        const clip = videoClipSourceImageFromMessage(reply);
        assert.match(clip.name, /\.gif$/i);
        assert.equal(sourceClipDescriptor(clip).clip_url, gif.url);
        const sources = await videoSourcesFromMessages(message(), reply, true, noTwitter);
        assert.equal(sources.clip.clip_url, gif.url);
        assert.equal(sources.image, null);
        const still = await videoSourcesFromMessages(message(), reply, false, noTwitter);
        assert.equal(still.image.clip_url, gif.url);
        assert.equal(still.clip, null);
    }
});

test('referee replacement uses replied GIF motion and Meximutt portrait; explicit images and command clips retain priority', async () => {
    const command = message('replace the referee with meximutt, keeping the same movements');
    const resolved = await resolveVideoEditRequest(command.content, command, message('', [gif]), '', MEXIMUTT, noFetch);
    assert.equal(resolved.replacement.target, 'the referee');
    assert.equal(resolved.sources.clip.clip_url, gif.url);
    assert.equal(videoReplacementUsesPreset(resolved.replacement.prompt, MEXIMUTT), true);
    const sources = await videoSourcesFromMessages(message('', [portrait]), message('', [gif]), true, noTwitter);
    assert.equal(sources.image.url, portrait.url);
    assert.equal(sources.clip.clip_url, gif.url);
    const own = { ...gif, url: gif.url.replace('referee', 'own') };
    assert.equal((await videoSourcesFromMessages(message('', [own]), message('', [gif]), true, noTwitter)).clip.clip_url, own.url);
    assert.throws(() => videoClipSourceImageFromMessage(message('', [gif, own])), /just one video/);
});

test('Tenor/Giphy content and embed links use playable media without fetching when available', async () => {
    for (const page of [tenor, giphy]) {
        const reply = message(page, [], [{ url: page, video: { url: media }, image: { url: media.replace('.mp4', '.gif') } }]);
        assert.equal((await gifVideoFromMessage(reply, noFetch)).clip_url, media);
        const sources = await videoSourcesFromMessages(message(), reply, true, noTwitter);
        assert.equal(sources.clip.clip_url, media);
        assert.equal(sources.image, null);
        assert.equal((await gifVideoFromMessage({ embeds: reply.embeds }, noFetch)).clip_url, media);
    }
    assert.equal((await gifVideoFromMessage(message(media), noFetch)).clip_url, media);
    assert.equal((await gifVideoFromMessage(message('', [], [{ video: { url: media } }]), noFetch)).clip_url, media);
    assert.equal(stripGifVideoLinks(`replace the referee with meximutt (<${tenor}>)`), 'replace the referee with meximutt');
    assert.equal(videoPromptFromMessages('replace the referee with meximutt', { content: giphy }), 'replace the referee with meximutt');
});

test('missing embeds resolve bounded share-page metadata and prefer animation over thumbnails', async () => {
    for (const page of [tenor, giphy]) {
        const source = await gifVideoFromMessage(message(page), async (url, options) => {
            assert.equal(url, page);
            assert.equal(options.redirect, 'error');
            assert.equal(options.size, 3 * 1024 * 1024);
            assert.ok(options.signal);
            return new Response(`<meta property="og:image" content="${media.replace('.mp4', '.gif')}">
                <meta content='${media}?a=1&amp;b=2' property='og:video:secure_url'>`);
        });
        assert.equal(source.clip_url, `${media}?a=1&b=2`);
    }
    const source = await gifVideoFromMessage(message(tenor), async () => new Response(
        '<meta property="og:image" content="https://media1.tenor.com/m/abc/ref.gif">'));
    assert.equal(source.name, 'ref.gif');
});

test('GIF resolution rejects ambiguous, unavailable, redirected and untrusted sources', async () => {
    await assert.rejects(gifVideoFromMessage(message(`${tenor} ${giphy}`), noFetch), /exactly one/);
    for (const url of ['http://media.tenor.com/a.gif', 'https://media.tenor.com.evil.test/a.gif',
        'https://user@media.tenor.com/a.gif', 'https://media.tenor.com:444/a.gif', 'https://media.tenor.com/a.m3u8',
        'file:///tmp/a.gif', 'https://127.0.0.1/a.gif']) {
        assert.equal(isGifVideoUrl(url), false);
        assert.throws(() => sourceClipDescriptor({ clip_url: url, name: 'a.gif' }), /Discord attachment/);
        assert.equal(await gifVideoFromMessage(message(url), noFetch), null);
    }
    for (const resolve of [async () => new Response('missing', { status: 404 }),
        async () => { throw new Error('redirect'); },
        async () => new Response('<meta property="og:video" content="http://127.0.0.1/private.mp4">')]) {
        await assert.rejects(gifVideoFromMessage(message(tenor), resolve), /upload the GIF directly/);
    }
    assert.throws(() => sourceClipDescriptor({ clip_url: gif.url, name: gif.name, bytes: 101 * 1024 * 1024 }), /100 MiB/);
});

test('broker normalizes one GIF loop into playable MP4 with motion, duration, odd dimensions and excerpt support', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gif-source-test-'));
    try {
        const fixture = join(directory, 'fixture.gif');
        execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=65x49:rate=10:duration=2',
            '-loop', '0', fixture]);
        const bytes = readFileSync(fixture);
        const source = { clip_url: gif.url, name: gif.name, bytes: bytes.length };
        const fetcher = async (url, options) => {
            assert.equal(url, source.clip_url);
            assert.equal(options.redirect, 'manual');
            return new Response(Readable.from([bytes]), { url, headers: { 'content-type': 'image/gif' } });
        };
        const full = await storeVideoSourceClip(source, join(directory, 'full'), null, undefined, { fetcher });
        assert.match(full.path, /source-video\.mp4$/);
        assert.ok(Math.abs(full.duration - 2) < 0.11, full.duration);
        assert.equal(full.excerpt, null);
        const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', full.path]));
        assert.equal(probe.streams.length, 1, 'GIF conversion does not invent audio');
        assert.equal(probe.streams[0].codec_name, 'h264');
        assert.equal(probe.streams[0].width, 66);
        assert.equal(probe.streams[0].height, 50);
        const frame = seconds => execFileSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', full.path,
            '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
        assert.notDeepEqual(frame(0), frame(1.5), 'animation survives normalization');
        assert.equal(existsSync(join(directory, 'full', 'source-video.part')), false);
        const cut = await storeVideoSourceClip(source, join(directory, 'cut'), { start_seconds: 0.5, end_seconds: 1.5 }, undefined, { fetcher });
        assert.ok(Math.abs(cut.duration - 1) < 0.11, cut.duration);
        assert.equal(cut.excerpt.start_seconds, 0.5);
        const broker = new VideoBroker({ host: '127.0.0.1', port: 0,
            dbPath: join(directory, 'queue.sqlite3'), resultsDir: join(directory, 'results'),
            botToken: 'fixture-bot', workerToken: 'fixture-worker', preplanQueuedJobs: false, recoveryEnabled: false,
            sourceVideoDownloader: (descriptor, destination, range) => storeVideoSourceClip(descriptor, destination, range, undefined, { fetcher }),
            videoEditGrounder: async (stored, target) => {
                assert.match(stored.path, /source-video\.mp4$/);
                assert.ok(Math.abs(stored.duration - 2) < 0.11);
                return { action: 'replace', target, clarification: '' };
            },
        });
        await broker.start();
        try {
            for (const command of ['oalgo', 'minimax']) {
                const response = await fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/jobs`, {
                    method: 'POST', headers: { authorization: 'Bearer fixture-bot', 'content-type': 'application/json' },
                    body: JSON.stringify({ model: 'minimax', command_variant: command, prompt: 'meximutt',
                        requester_id: command, origin_bot_id: 'bot', channel_id: 'channel', command_message_id: command,
                        status_message_id: 'status', source_video: source, source_image: { preset: 'meximutt' }, video_edit_target: 'the referee' }),
                });
                const body = await response.json();
                assert.equal(response.status, 201, JSON.stringify(body));
                assert.equal(body.job.source_kind, 'video_edit');
                assert.equal(body.job.has_source_video, true);
                const row = await broker.get('SELECT source_video_path, source_video_seconds FROM video_jobs WHERE public_id=?', [body.job.id]);
                assert.match(row.source_video_path, /source-video\.mp4$/);
                assert.ok(Math.abs(row.source_video_seconds - 2) < 0.11);
            }
        } finally { await broker.stop(); }
        await assert.rejects(storeVideoSourceClip(source, join(directory, 'bad'), null, undefined, {
            fetcher: async url => new Response(Readable.from(['not a GIF']), { url }),
        }), /decode/);
        assert.equal(existsSync(join(directory, 'bad', 'source-video.part')), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
