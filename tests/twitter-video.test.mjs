import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Response } from 'node-fetch';
import { twitterVideoFromMessage, twitterPostFromMessage, stripTwitterPostLinks, isTwitterVideoUrl, isTwitterImageUrl } from '../dist/TwitterVideo.js';
import { sourceImageDescriptor, storeVideoSourceImage } from '../dist/VideoSourceImage.js';
import { sourceClipDescriptor } from '../dist/VideoSourceClip.js';
import { videoSourcesFromMessages, videoPromptFromMessages, videoReplacementUsesPreset, resolveVideoEditRequest } from '../dist/VideoGeneration.js';
import { ARGENMUTT, MEXIMUTT } from '../dist/VideoCharacters.js';

const post = 'https://fxtwitter.com/juhrafftrades/status/2103886182404772256';
const mp4 = 'https://video.twimg.com/amplify_video/123/vid/1280x720/example.mp4?tag=14';
const low = mp4.replace('1280x720', '480x270');
const video = { type: 'video', url: low, formats: [
    { url: mp4.replace('.mp4', '.m3u8'), bitrate: 999999 },
    { url: low, bitrate: 288000 }, { url: mp4, bitrate: 2176000 },
] };
const payload = videos => ({ code: 200, status: { media: { all: videos, videos } } });
const fetcher = body => async () => new Response(JSON.stringify(body));
const message = (content = '', attachments = [], embeds = []) => ({ content, attachments: new Map(attachments.map((a, i) => [i, a])), embeds });
const clip = { name: 'clip.mp4', contentType: 'video/mp4', size: 123, url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4' };
const image = { name: 'slug.png', contentType: 'image/png', size: 456, url: 'https://cdn.discordapp.com/attachments/1/2/slug.png' };

test('Twitter aliases and reply embeds resolve the highest-bitrate MP4 using a fixed API host', async () => {
    for (const host of ['twitter.com', 'x.com', 'mobile.twitter.com', 'fxtwitter.com', 'fixupx.com', 'vxtwitter.com', 'd.fxtwitter.com']) {
        const result = await twitterVideoFromMessage(message(`(<${post.replace('fxtwitter.com', host)}?s=20>)`), async (url, options) => {
            assert.equal(url, 'https://api.fxtwitter.com/2/status/2103886182404772256');
            assert.equal(options.redirect, 'error');
            assert.equal(options.size, 1024 * 1024);
            assert.ok(options.signal);
            return new Response(JSON.stringify(payload([video])));
        });
        assert.deepEqual(result, { clip_url: mp4, name: 'twitter-2103886182404772256.mp4' });
    }
    assert.equal((await twitterVideoFromMessage(message('', [], [{ url: post }]), fetcher(payload([video])))).clip_url, mp4);
    assert.equal((await twitterVideoFromMessage(message(`clip: [watch](${post})`), fetcher(payload([video])))).clip_url, mp4);
    const noFormats = { type: 'video', url: mp4 };
    assert.equal((await twitterVideoFromMessage(message(post), fetcher(payload([noFormats])))).clip_url, mp4);
});

test('duplicate aliases deduplicate, and ambiguous posts or videos need an explicit selection', async () => {
    let calls = 0;
    const resolve = async () => { calls++; return new Response(JSON.stringify(payload([video]))); };
    await twitterVideoFromMessage(message(`${post} ${post.replace('fxtwitter.com', 'x.com')}`, [], [{ url: post }]), resolve);
    assert.equal(calls, 1);
    await assert.rejects(twitterVideoFromMessage(message(`${post} https://x.com/a/status/123`), resolve), /exactly one/);
    assert.equal(calls, 1);
    const second = { type: 'video', url: mp4.replace('example', 'second') };
    await assert.rejects(twitterVideoFromMessage(message(post), fetcher(payload([video, second]))), /multiple videos/);
    const selected = await twitterVideoFromMessage(message(`${post}/video/2`, [], [{ url: post }]), fetcher(payload([video, second])));
    assert.equal(selected.clip_url, second.url);
    await assert.rejects(twitterVideoFromMessage(message(`${post}/video/3`), fetcher(payload([video, second]))), /No video/);
});

test('unavailable posts, API errors, and missing media produce actionable failures', async () => {
    for (const reply of [{ code: 404 }, { code: 200, status: { type: 'tombstone' } }]) {
        await assert.rejects(twitterVideoFromMessage(message(post), fetcher(reply)), /private, deleted/);
    }
    for (const resolve of [async () => { throw new Error('timeout'); }, async () => new Response('rate limit', { status: 429 }), async () => new Response('not json')]) {
        await assert.rejects(twitterVideoFromMessage(message(post), resolve), /Try again or attach/);
    }
    await assert.rejects(twitterVideoFromMessage(message(post), fetcher(payload([]))), /No video/);
    await assert.rejects(twitterVideoFromMessage(message(post), fetcher(payload([{ url: 'https://example.com/clip.mp4' }]))), /no downloadable MP4/);
});

test('only recognized post hosts trigger lookup and only Twitter CDN MP4s are accepted', async () => {
    for (const url of ['https://fxtwitter.com.evil.test/a/status/123', 'https://fxtwitter.com@evil.test/a/status/123', 'https://x.com/a', 'https://x.com:444/a/status/123']) {
        assert.equal(await twitterVideoFromMessage(message(url), async () => { assert.fail('unexpected API call'); }), null);
    }
    assert.equal(isTwitterVideoUrl(mp4), true);
    for (const url of ['http://video.twimg.com/clip.mp4', 'https://video.twimg.com.evil.test/clip.mp4', 'https://video.twimg.com:444/clip.mp4', 'https://user@video.twimg.com/clip.mp4', 'https://video.twimg.com/clip.m3u8', 'file:///tmp/clip.mp4']) {
        assert.equal(isTwitterVideoUrl(url), false);
        assert.throws(() => sourceClipDescriptor({ clip_url: url, name: 'clip.mp4' }), /Discord attachment/);
    }
    assert.deepEqual(sourceClipDescriptor({ clip_url: mp4, name: 'clip.mp4' }), { clip_url: mp4, name: 'clip.mp4' });
    assert.throws(() => sourceClipDescriptor({ clip_url: mp4, name: 'clip.mp4', bytes: 101 * 1024 * 1024 }), /100 MiB/);
});

test('replacement inputs combine a command image with a replied Twitter video; ordinary requests use a starting frame', async () => {
    const resolve = msg => twitterPostFromMessage(msg, fetcher(payload([video])));
    const sources = await videoSourcesFromMessages(message('replace the character with slugs', [image]), message(post), true, resolve);
    assert.equal(sources.image.url, image.url);
    assert.equal(sources.clip.clip_url, mp4);
    const generated = await videoSourcesFromMessages(message('replace the character with slugs'), message(post), true, resolve);
    assert.equal(generated.image, null);
    assert.equal(generated.clip.clip_url, mp4);
    const frame = await videoSourcesFromMessages(message('animate this'), message(post), false, resolve);
    assert.equal(frame.image.clip_url, mp4);
    assert.equal(frame.clip, null);
    assert.equal((await videoSourcesFromMessages(message(post), message('', [clip]), true, resolve)).clip.clip_url, mp4);
});

test('attachments take precedence without calling the API', async () => {
    const unexpected = async () => { assert.fail('should use attachment'); };
    assert.equal((await videoSourcesFromMessages(message(post, [clip]), message(post), true, unexpected)).clip.clip_url, clip.url);
    assert.equal((await videoSourcesFromMessages(message(post, [image]), message(post), false, unexpected)).image.url, image.url);
});

test('post URLs are removed from planner instructions and explicit replacements override OALGO identity', () => {
    assert.equal(stripTwitterPostLinks(`replace the character with slugs ${post}?s=20`), 'replace the character with slugs');
    assert.equal(stripTwitterPostLinks(`<${post}>`), '');
    assert.equal(stripTwitterPostLinks(`[this clip](${post})`), 'this clip');
    assert.equal(videoPromptFromMessages('slugs', { content: post }), 'slugs');
    assert.equal(videoReplacementUsesPreset('slugs', MEXIMUTT), false);
    assert.equal(videoReplacementUsesPreset('a robot', MEXIMUTT), false);
    assert.equal(videoReplacementUsesPreset('Meximutt, keeping the moves', MEXIMUTT), true);
    assert.equal(videoReplacementUsesPreset('', MEXIMUTT), true);
    assert.equal(videoReplacementUsesPreset('Argenmutt, keeping the moves', ARGENMUTT), true);
    assert.equal(videoReplacementUsesPreset('Meximutt, keeping the moves', ARGENMUTT), false,
        'Another character named as the replacement is a description, not this command\'s preset.');
});

const photo = { type: 'photo', url: 'https://pbs.twimg.com/media/example.jpg', width: 1200, height: 800 };
const tweetText = 'Hey guys I know your cities are burning\n\nBut I really need $70,000,000,000\n\nThanks';
const photoPayload = (photos = [photo]) => ({ code: 200, status: { text: tweetText, media: { all: photos, photos } } });

test('photo posts supply the photo and full tweet text from content links or embed links', async () => {
    for (const reply of [message(post), message('', [], [{ url: post, description: 'preview with engagement counts' }])]) {
        const resolve = msg => twitterPostFromMessage(msg, fetcher(photoPayload()));
        const result = await resolveVideoEditRequest('react to this', message('$oalgo react to this'), reply, '', MEXIMUTT,
            async () => assert.fail('photo posts must not invoke the video edit classifier'),
            (command, referenced, edit) => videoSourcesFromMessages(command, referenced, edit, resolve));
        assert.equal(result.replacement, null);
        assert.equal(result.sources.clip, null);
        assert.equal(result.sources.image.url, photo.url);
        assert.equal(result.sources.postText, tweetText);
        assert.deepEqual(sourceImageDescriptor(result.sources.image), result.sources.image);
        const prompt = videoPromptFromMessages('react to this', reply, undefined, result.sources.postText);
        assert.ok(prompt.includes(tweetText));
        assert.match(prompt, /Current instruction \(takes priority\):\nreact to this$/);
        assert.ok(!prompt.includes(post));
        assert.ok(!prompt.includes('engagement counts'));
        assert.ok(videoPromptFromMessages('', reply, undefined, result.sources.postText).includes(tweetText), 'bare $oalgo must retain tweet context');
    }
});

test('direct post links and custom attached images keep tweet text', async () => {
    const resolve = msg => twitterPostFromMessage(msg, fetcher(photoPayload()));
    const direct = await videoSourcesFromMessages(message(`$oalgo ${post}`), null, false, resolve);
    assert.equal(direct.image.url, photo.url);
    assert.equal(direct.postText, tweetText);
    const overridden = await resolveVideoEditRequest('react', message('$oalgo react', [image]), message(post), '', MEXIMUTT,
        async () => assert.fail('photo is not a clip'),
        (command, referenced, edit) => videoSourcesFromMessages(command, referenced, edit, resolve));
    assert.equal(overridden.sources.image.url, image.url);
    assert.equal(overridden.sources.postText, tweetText);
});

test('text-only posts are context and photos need an explicit selection when ambiguous', async () => {
    const text = await twitterPostFromMessage(message(post), fetcher({ code: 200, status: { text: tweetText } }));
    assert.deepEqual(text, { text: tweetText, image: null, clip: null });
    const second = { ...photo, url: photo.url.replace('example', 'second') };
    await assert.rejects(twitterPostFromMessage(message(post), fetcher(photoPayload([photo, second]))), /multiple photos/);
    const selected = await twitterPostFromMessage(message(`${post}/photo/2`, [], [{ url: post }]), fetcher(photoPayload([photo, second])));
    assert.equal(selected.image.url, second.url);
    assert.equal(stripTwitterPostLinks(`react ${post}/photo/2`), 'react');
    await assert.rejects(twitterPostFromMessage(message(`${post}/photo/3`), fetcher(photoPayload())), /media index/);
    const mixed = { code: 200, status: { text: tweetText, media: { all: [photo, video], photos: [photo], videos: [video] } } };
    assert.equal((await twitterPostFromMessage(message(`${post}/photo/1`), fetcher(mixed))).image.url, photo.url);
    assert.equal((await twitterPostFromMessage(message(`${post}/video/2`), fetcher(mixed))).clip.clip_url, mp4);
});

test('photo URLs remain restricted and only trusted photos may omit a declared length', async () => {
    assert.ok(isTwitterImageUrl(photo.url));
    assert.ok(isTwitterImageUrl('https://pbs.twimg.com/media/example?format=png&name=orig'));
    const metadata = { mime_type: 'image/jpeg', name: 'photo.jpg' };
    for (const url of ['http://pbs.twimg.com/media/example.jpg', 'https://pbs.twimg.com.evil.test/media/example.jpg',
        'https://user@pbs.twimg.com/media/example.jpg', 'https://pbs.twimg.com:444/media/example.jpg',
        'https://pbs.twimg.com/profile_images/example.jpg', 'https://pbs.twimg.com/media/example.svg', 'https://example.com/image.jpg']) {
        assert.equal(isTwitterImageUrl(url), false);
        await assert.rejects(twitterPostFromMessage(message(post), fetcher(photoPayload([{ ...photo, url }]))), /no downloadable photo/);
        assert.throws(() => sourceImageDescriptor({ ...metadata, url }), /20 MiB/);
        await assert.rejects(storeVideoSourceImage({ ...metadata, url, bytes: 12 }, '/unused-twitter-photo-test'), /not a Discord attachment/);
    }
    for (const bytes of [0, -1, 20 * 1024 * 1024 + 1]) {
        assert.throws(() => sourceImageDescriptor({ ...metadata, url: photo.url, bytes }), /20 MiB/);
    }
    assert.throws(() => sourceImageDescriptor({ ...metadata, url: image.url }), /20 MiB/);
});


test('broker downloads Twitter photos with actual size enforcement and cleans failed downloads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-twitter-photo-'));
    const descriptor = sourceImageDescriptor((await twitterPostFromMessage(message(post), fetcher(photoPayload()))).image);
    const bytes = Buffer.from('image-content');
    try {
        const stored = await storeVideoSourceImage(descriptor, directory, async (url, options) => {
            assert.equal(url, photo.url);
            assert.equal(options.redirect, 'error', 'photo redirects must not escape the trusted host');
            assert.ok(options.signal);
            return new Response(Readable.from([bytes]), { url, headers: { 'content-type': 'image/jpeg' } });
        });
        assert.equal(stored.bytes, bytes.length);
        assert.deepEqual(readFileSync(stored.path), bytes);
        const oversize = 20 * 1024 * 1024 + 1;
        for (const [body, headers, pattern] of [
            [bytes, { 'content-type': 'text/html' }, /unsupported image type/],
            [bytes, { 'content-length': String(oversize) }, /20 MiB/],
            [Buffer.alloc(oversize), {}, /20 MiB/],
            [Buffer.alloc(0), {}, /empty/],
        ]) {
            await assert.rejects(storeVideoSourceImage(descriptor, directory,
                async () => new Response(Readable.from([body]), { url: photo.url, headers })), pattern);
            assert.equal(existsSync(join(directory, 'source.part')), false);
        }
        await assert.rejects(storeVideoSourceImage(descriptor, directory,
            async () => new Response(Readable.from([bytes]), { url: 'https://example.com/image.jpg' })), /HTTP/);
        await assert.rejects(storeVideoSourceImage(descriptor, directory,
            async () => { throw new Error('network unavailable'); }), /network unavailable/);
        assert.equal(existsSync(join(directory, 'source.part')), false);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});


test('long tweet context cannot truncate the command at the broker prompt limit', () => {
    const instruction = 'Use the photo but say exactly "Thanks".';
    const prompt = videoPromptFromMessages(instruction, { content: post }, undefined, 'Long tweet. '.repeat(1000));
    assert.equal(prompt.length, 4000);
    assert.ok(prompt.endsWith(instruction));
    assert.equal(videoPromptFromMessages('', { content: post }, undefined, 'x'.repeat(8000)).length, 4000);
});
