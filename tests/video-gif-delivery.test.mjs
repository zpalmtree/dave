import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareVideoDelivery, videoOutputFormatForSources, GIF_SIZE_FALLBACK_NOTICE, GIF_ERROR_FALLBACK_NOTICE } from '../dist/VideoGifDelivery.js';
import { completedVideoAttachmentName, VideoGenerationService } from '../dist/VideoGeneration.js';

function fixture(path, filter = 'testsrc2=size=160x96:rate=24:duration=1.5') {
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', filter,
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-shortest',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
        '-metadata', 'workflow={"nodes":[],"links":[]}', '-movflags', '+use_metadata_tags', path]);
}
const probe = path => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]));

test('GIF uploads and provider video renditions select GIF delivery, while ordinary videos and images stay MP4', () => {
    const attachment = { clip_url: 'https://cdn.discordapp.com/attachments/1/2/ref.GIF', name: 'ref.GIF' };
    assert.equal(videoOutputFormatForSources(attachment), 'gif');
    for (const host of ['media.tenor.com', 'media1.giphy.com']) {
        assert.equal(videoOutputFormatForSources(null, { clip_url: `https://${host}/abc/ref.mp4`, name: 'ref.mp4' }), 'gif');
    }
    assert.equal(videoOutputFormatForSources(null, { preset: 'meximutt' }), 'mp4');
    assert.equal(videoOutputFormatForSources({ ...attachment, name: 'ref.mp4', clip_url: attachment.clip_url.replace('.GIF', '.mp4') }), 'mp4');
    assert.equal(videoOutputFormatForSources({ url: attachment.clip_url, name: 'ref.GIF' }), 'mp4');
    assert.equal(completedVideoAttachmentName({ id: 'abcd1234-job', model: 'minimax', output_format: 'gif' }), 'minimax-abcd1234.gif');
    assert.equal(completedVideoAttachmentName({ id: 'abcd1234-job', model: 'minimax', output_format: 'gif', prompt_tease: 'tease' }, 'mp4'), 'SPOILER_minimax-abcd1234.mp4');
});

test('GIF delivery loops, keeps the full animation, meets the upload limit and preserves the original MP4 with audio', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gif-delivery-'));
    try {
        const path = join(directory, 'result.mp4');
        fixture(path);
        const original = readFileSync(path);
        const job = { result_path: path, output_format: 'gif', delivery_limit_bytes: 1024 * 1024 };
        const media = await prepareVideoDelivery(job);
        assert.equal(media.format, 'gif');
        const bytes = readFileSync(media.path);
        assert.equal(bytes.subarray(0, 6).toString(), 'GIF89a');
        assert.ok(bytes.includes(Buffer.from('NETSCAPE2.0')), 'infinite looping extension is present');
        assert.ok(bytes.length <= job.delivery_limit_bytes);
        const info = probe(media.path);
        assert.ok(Math.abs(Number(info.format.duration) - 1.5) <= 0.06);
        assert.equal(info.streams.length, 1);
        assert.equal(info.streams[0].codec_name, 'gif');
        const frame = time => execFileSync('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', media.path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
        assert.notDeepEqual(frame(0), frame(1), 'conversion preserves motion');
        assert.deepEqual(readFileSync(path), original, 'MP4 and its audio are untouched');
        assert.equal(probe(path).streams.some(stream => stream.codec_type === 'audio'), true);
        const mtime = statSync(media.path).mtimeMs;
        assert.deepEqual(await prepareVideoDelivery(job), media);
        assert.equal(statSync(media.path).mtimeMs, mtime, 'retries use the cached GIF');
        const smaller = await prepareVideoDelivery({ ...job, delivery_limit_bytes: Math.floor(bytes.length * 0.8) });
        assert.equal(smaller.format, 'gif');
        assert.ok(statSync(smaller.path).size <= bytes.length * 0.8);
        fixture(path, 'color=blue:size=160x96:rate=24:duration=1.5');
        const revised = await prepareVideoDelivery(job);
        assert.notEqual(revised.path, media.path, 'regeneration cannot reuse a stale GIF');
        assert.equal(readdirSync(directory).some(name => name.includes('.part.')), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('oversize or failed GIF conversion delivers the MP4 with an explicit notice and cleans temporary files', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gif-delivery-fallback-'));
    try {
        const path = join(directory, 'result.mp4');
        fixture(path);
        assert.deepEqual(await prepareVideoDelivery({ result_path: path, output_format: 'gif', delivery_limit_bytes: 1 }),
            { path, format: 'mp4', notice: GIF_SIZE_FALLBACK_NOTICE });
        writeFileSync(path, 'not a video');
        assert.deepEqual(await prepareVideoDelivery({ result_path: path, output_format: 'gif' }),
            { path, format: 'mp4', notice: GIF_ERROR_FALLBACK_NOTICE });
        assert.deepEqual(readdirSync(directory), ['result.mp4']);
        assert.deepEqual(await prepareVideoDelivery({ result_path: path }), { path, format: 'mp4' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Discord posts the GIF with a matching filename and keeps workflows privately downloadable from the MP4', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gif-discord-delivery-'));
    try {
        const path = join(directory, 'result.mp4');
        fixture(path);
        const service = new VideoGenerationService({ user: { id: 'bot' } }, join(directory, 'workflows'));
        const job = { id: 'abcd1234-job', model: 'minimax', prompt: 'meximutt', result_path: path,
            output_format: 'gif', command_message_id: 'command', delivery_limit_bytes: 1024 * 1024 };
        let sent;
        const channel = { messages: { fetch: async input => typeof input === 'object' ? [] : {
            reply: async payload => { sent = payload; return { id: 'posted' }; },
        } } };
        await service.postDelivery(job, { channel });
        assert.equal(sent.files.length, 1);
        assert.equal(sent.files[0].name, 'minimax-abcd1234.gif');
        assert.equal(readFileSync(sent.files[0].attachment).subarray(0, 6).toString(), 'GIF89a');
        assert.equal(sent.components[0].toJSON().components[0].label, 'Download workflows');
        await service.postDelivery({ ...job, delivery_limit_bytes: 1 }, { channel });
        assert.equal(sent.files[0].name, 'minimax-abcd1234.mp4');
        assert.equal(sent.files[0].attachment, path);
        assert.ok(sent.content.includes(GIF_SIZE_FALLBACK_NOTICE));
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
