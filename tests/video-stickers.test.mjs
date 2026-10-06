import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { StickerFormatType } from 'discord.js';
import { VideoBroker } from '../dist/VideoBroker.js';
import { videoSourceImageFromMessage, videoSourceImageFromMessages, videoSourcesFromMessages } from '../dist/VideoGeneration.js';
import { videoStickerFrameUrl } from '../dist/VideoSticker.js';

const sticker = { id: '1466329130122612786', name: 'cattongue', format: StickerFormatType.PNG };
const message = (stickers = [], attachments = []) => ({
    content: '', stickers: new Map(stickers.map((s, i) => [String(i), s])),
    attachments: new Map(attachments.map((a, i) => [String(i), a])),
});
const expected = { sticker_id: sticker.id, sticker_format: sticker.format, name: sticker.name };

test('video commands inherit the actual replied-to sticker, including MiniMax and replacement resolution', async () => {
    const reply = message([sticker]);
    assert.deepEqual(videoSourceImageFromMessage(reply), expected);
    assert.deepEqual(videoSourceImageFromMessages(message(), reply), expected);
    assert.deepEqual(await videoSourcesFromMessages(message(), reply, false, async () => null), { image: expected, clip: null });
    const clip = { url: 'https://cdn.discordapp.com/attachments/1/2/source.mp4', contentType: 'video/mp4', name: 'source.mp4', size: 10 };
    const replacement = await videoSourcesFromMessages(message([], [clip]), reply, true, async () => null);
    assert.deepEqual(replacement.image, expected);
    assert.equal(replacement.clip.clip_url, clip.url);
});

test('command sources and attached images keep precedence over reply stickers', () => {
    const image = { url: 'https://cdn.discordapp.com/attachments/1/2/source.png', contentType: 'image/png', name: 'source.png', size: 10 };
    assert.equal(videoSourceImageFromMessage(message([sticker], [image])).url, image.url);
    assert.equal(videoSourceImageFromMessages(message([], [image]), message([sticker])).url, image.url);
    assert.deepEqual(videoSourceImageFromMessages(message([sticker]), message([], [image])), expected);
    const clip = { ...image, contentType: 'video/mp4', name: 'source.mp4' };
    assert.equal(videoSourceImageFromMessages(message([], [clip]), message([sticker])).clip_url, clip.url);
});

test('PNG, APNG and GIF stickers request a static PNG; ambiguous and unsupported stickers fail explicitly', () => {
    for (const format of [StickerFormatType.PNG, StickerFormatType.APNG, StickerFormatType.GIF]) {
        const source = videoSourceImageFromMessage(message([{ ...sticker, format }]));
        const url = new URL(videoStickerFrameUrl(source));
        assert.equal(url.hostname, 'media.discordapp.net');
        assert.equal(url.pathname, `/stickers/${sticker.id}.${format === StickerFormatType.GIF ? 'gif' : 'png'}`);
        assert.equal(url.searchParams.get('format'), 'png');
        assert.equal(url.searchParams.get('passthrough'), 'false');
    }
    assert.throws(() => videoSourceImageFromMessage(message([sticker, sticker])), /just one sticker/);
    for (const format of [StickerFormatType.Lottie, undefined, 99]) {
        assert.throws(() => videoSourceImageFromMessage(message([{ ...sticker, format }])), /format is not supported/);
    }
});

test('broker accepts size-less sticker metadata, stores an image, and rejects unsafe or unsupported descriptors', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-video-sticker-'));
    const downloads = [];
    const broker = new VideoBroker({
        host: '127.0.0.1', port: 0, dbPath: join(directory, 'queue.sqlite3'), resultsDir: join(directory, 'results'),
        botToken: 'bot-secret', workerToken: 'worker-secret', preplanQueuedJobs: false,
        sourceImageDownloader: async (descriptor, target) => {
            downloads.push(descriptor);
            mkdirSync(target, { recursive: true });
            const path = join(target, 'source.png');
            writeFileSync(path, 'image');
            return { path, mimeType: 'image/png', bytes: 5 };
        },
    });
    await broker.start();
    let sequence = 0;
    const submit = source_image => fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/jobs`, {
        method: 'POST', headers: { authorization: 'Bearer bot-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'minimax', prompt: 'Make this cat sing', requester_id: 'user',
            origin_bot_id: 'bot', channel_id: 'channel', command_message_id: `command-${++sequence}`,
            status_message_id: `status-${sequence}`, source_image }),
    });
    try {
        const response = await submit(expected);
        assert.equal(response.status, 201);
        const { job } = await response.json();
        assert.equal(job.has_source_image, true);
        assert.equal(job.source_kind, 'image');
        const stored = await broker.get('SELECT source_image_bytes, source_image_path FROM video_jobs WHERE public_id=?', [job.id]);
        assert.equal(stored.source_image_bytes, 5);
        assert.ok(stored.source_image_path.endsWith('source.png'));
        assert.deepEqual(downloads, [expected]);
        for (const invalid of [
            { ...expected, sticker_id: '../private' },
            { ...expected, sticker_id: 'https://example.com/image.png' },
            { ...expected, sticker_format: StickerFormatType.Lottie },
            { ...expected, sticker_format: '1' },
            { url: 'https://cdn.discordapp.com/attachments/1/2/image.png', mime_type: 'image/png' },
        ]) {
            assert.equal((await submit(invalid)).status, 400);
        }
        assert.equal(downloads.length, 1);
    } finally {
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});
