import assert from 'node:assert/strict';
import test from 'node:test';
import { Response } from 'node-fetch';
import { twitterVideoFromMessage, stripTwitterPostLinks, isTwitterVideoUrl } from '../dist/TwitterVideo.js';
import { sourceClipDescriptor } from '../dist/VideoSourceClip.js';
import { videoSourcesFromMessages, videoPromptFromMessages, videoReplacementUsesPreset } from '../dist/VideoGeneration.js';

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
    const resolve = msg => twitterVideoFromMessage(msg, fetcher(payload([video])));
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
    assert.equal(videoReplacementUsesPreset('slugs'), false);
    assert.equal(videoReplacementUsesPreset('a robot'), false);
    assert.equal(videoReplacementUsesPreset('Meximutt, keeping the moves'), true);
    assert.equal(videoReplacementUsesPreset(''), true);
});
