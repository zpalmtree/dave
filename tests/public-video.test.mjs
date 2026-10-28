import assert from 'node:assert/strict';
import test from 'node:test';
import { Response } from 'node-fetch';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicMediaUrl, isPublicMediaAddress, fetchPublicMedia, discardMediaResponse } from '../dist/PublicMedia.js';
import { publicVideoFromMessage, stripResolvedVideoLinks } from '../dist/PublicVideo.js';
import { storeVideoSourceClip } from '../dist/VideoSourceClip.js';
import { extractVideoClipSourceImage } from '../dist/VideoSourceImage.js';
import { resolveVideoEditRequest, videoSourcesFromMessages, videoPromptFromMessages } from '../dist/VideoGeneration.js';
import { videoOutputFormatForSources } from '../dist/VideoGifDelivery.js';
const message = (content = '', embeds = [], attachments = []) => ({ content, embeds, attachments: new Map(attachments.map((a, i) => [i, a])) });
const noFetch = async () => { throw new Error('Unexpected network access'); };
const lookup = async () => [{ address: '93.184.215.14', family: 4 }];

test('public URL gate accepts arbitrary domains but rejects credentials, private and encoded addresses', () => {
    for (const value of ['https://media.example.org/movie.mp4', 'http://93.184.215.14/movie', 'https://[2606:4700:4700::1111]/a']) assert.ok(publicMediaUrl(value), value);
    for (const value of ['file:///etc/passwd', 'ftp://example.org/a', 'http://user:pass@example.org/a', 'https://example.org:444/a',
        'http://localhost/a', 'http://foo.local/a', 'http://metadata/a', 'http://127.1/a', 'http://2130706433/a', 'http://0x7f000001/a',
        'http://0177.0.0.1/a', 'http://[::ffff:127.0.0.1]/a', 'http://[::1]/a']) assert.equal(publicMediaUrl(value), null, value);
    for (const ip of ['0.0.0.0', '10.1.2.3', '100.100.100.200', '127.0.0.1', '169.254.169.254', '172.16.1.1', '192.168.1.1',
        '192.0.2.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', 'fe80::1', 'fc00::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(isPublicMediaAddress(ip), false, ip);
});

test('downloads pin validated DNS at the socket and follow bounded public redirects without credentials', async () => {
    const urls = [];
    const result = await fetchPublicMedia('https://arbitrary.example.org/start', { headers: { authorization: 'never-forward', cookie: 'secret' } }, {
        lookup, fetcher: async (url, options) => {
            urls.push(url);
            assert.equal(options.redirect, 'manual');
            assert.equal(options.headers.authorization, undefined);
            assert.equal(options.headers.cookie, undefined);
            const pinned = await new Promise((resolve, reject) => options.agent.options.lookup('arbitrary.example.org', {},
                (error, address, family) => error ? reject(error) : resolve({ address, family })));
            assert.deepEqual(pinned, { address: '93.184.215.14', family: 4 });
            if (urls.length === 1) return new Response(null, { status: 302, headers: { location: '/actual.mp4' } });
            return new Response('video', { url });
        },
    });
    assert.equal(await result.text(), 'video');
    discardMediaResponse(result);
    assert.deepEqual(urls, ['https://arbitrary.example.org/start', 'https://arbitrary.example.org/actual.mp4']);
});

test('private redirects and mixed/private DNS never reach a connection; redirect loops stop', async () => {
    for (const address of ['127.0.0.1', '169.254.169.254', '::ffff:127.0.0.1']) {
        await assert.rejects(fetchPublicMedia('https://example.org/a', {}, {
            lookup: async () => [...await lookup(), { address, family: address.includes(':') ? 6 : 4 }], fetcher: noFetch,
        }), /private or reserved/);
    }
    let calls = 0;
    await assert.rejects(fetchPublicMedia('https://example.org/a', {}, { lookup, fetcher: async () => {
        calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
    } }), /public HTTP/);
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(fetchPublicMedia('https://example.org/a', {}, { lookup, fetcher: async () => {
        calls++; return new Response(null, { status: 302, headers: { location: '/again' } });
    } }), /too many/);
    assert.equal(calls, 5);
});

test('cancelling during DNS resolution does not wait for DNS or start a download', async () => {
    const controller = new AbortController();
    const result = fetchPublicMedia('https://example.org/a', { signal: controller.signal }, { lookup: () => new Promise(() => {}), fetcher: noFetch });
    controller.abort();
    await assert.rejects(result, /cancelled/);
});

test('any public host can supply direct media, extensionless MIME media, and matching Discord video embeds', async () => {
    for (const ext of ['mp4', 'webm', 'gif', 'mov', 'mkv', 'm4v']) {
        const url = `https://arbitrary.example.org/my-video.${ext}?signed=1`;
        const source = await publicVideoFromMessage(message(url), noFetch);
        assert.equal(source.clip_url, url);
        assert.equal(videoOutputFormatForSources(source), ext === 'gif' ? 'gif' : 'mp4');
    }
    const page = 'https://arbitrary.example.org/watch/123';
    const source = await publicVideoFromMessage(message(page, [{ url: page, video: { url: 'https://other.example.org/media?id=123' } }]), noFetch);
    assert.equal(source.clip_url, 'https://other.example.org/media?id=123');
    assert.equal(source.source_page_url, page);
    const mime = await publicVideoFromMessage(message(page), async (url, options) => {
        assert.equal(options.size, 3 * 1024 * 1024);
        assert.ok(options.signal);
        return new Response(null, { url, headers: { 'content-type': 'image/gif' } });
    });
    assert.equal(mime.name, 'source.gif');
    assert.equal((await publicVideoFromMessage(message('', [{ video: { url: source.clip_url } }]), noFetch)).clip_url, source.clip_url);
    assert.equal(await publicVideoFromMessage(message('', [{ image: { url: 'invalid' } }]), noFetch), null);
});

test('general pages resolve relative metadata and HTML video sources while ignoring posters and private destinations', async () => {
    const page = 'https://example.org/share/page';
    for (const html of ['<meta property="og:video:secure_url" content="../movie.mp4?a=1&amp;b=2">',
        '<video poster="poster.jpg"><source src="../movie.mp4?a=1&amp;b=2" type="video/mp4"></video>',
        '<meta name="twitter:player:stream" content="../movie.mp4?a=1&amp;b=2">']) {
        const source = await publicVideoFromMessage(message(page), async () => new Response(html, { url: page, headers: { 'content-type': 'text/html' } }));
        assert.equal(source.clip_url, 'https://example.org/movie.mp4?a=1&b=2');
        assert.equal(source.source_page_url, page);
    }
    for (const html of ['<meta property="og:image" content="poster.jpg">', '<script>loadVideo()</script>',
        '<meta property="og:video" content="http://127.0.0.1/private.mp4">']) {
        assert.equal(await publicVideoFromMessage(message(page), async () => new Response(html, { headers: { 'content-type': 'text/html' } })), null);
    }
    await assert.rejects(publicVideoFromMessage(message(`${page} https://example.net/video.mp4`), noFetch), /exactly one/);
    await assert.rejects(publicVideoFromMessage(message(page), async () => new Response(null, { status: 403 })), /HTTP 403/);
    await assert.rejects(publicVideoFromMessage(message(page), async (_url, options) => new Response(Readable.from(['a'.repeat(options.size + 1)]), { ...options, headers: { 'content-type': 'text/html' } })), /size/);
    for (const url of ['https://www.youtube.com/watch?v=abcdefghijk', 'https://www.youtube.com/shorts/abcdefghijk',
        'https://youtu.be/abcdefghijk?t=4', 'https://x.com/user/status/123456']) {
        assert.equal(await publicVideoFromMessage(message(url), noFetch), null);
    }
    assert.equal((await publicVideoFromMessage(message('https://video.twimg.com/direct.mp4'), noFetch)).clip_url,
        'https://video.twimg.com/direct.mp4');
});

test('reply and command resolution keep source URLs out of edit intent and preserve attachment precedence', async () => {
    const url = 'https://arbitrary.example.org/movie.mp4';
    const prompt = `replace the dancer with meximutt <${url}>`;
    const result = await resolveVideoEditRequest(prompt, message(prompt), null, '', null, noFetch);
    assert.equal(result.sources.clip.clip_url, url);
    assert.equal(result.replacement.prompt, 'meximutt');
    assert.equal(videoPromptFromMessages('meximutt', message(url), undefined, '', result.sources.clip), 'meximutt');
    const attachment = { url: 'https://cdn.discordapp.com/attachments/1/2/own.mp4', name: 'own.mp4', contentType: 'video/mp4', size: 123 };
    const sources = await videoSourcesFromMessages(message('', [], [attachment]), message(url), true, async () => null);
    assert.equal(sources.clip.clip_url, attachment.url);
    const generated = await videoSourcesFromMessages(message('animate this'), message(url), false, async () => null);
    assert.equal(generated.image.clip_url, url);
    const source = { clip_url: url, source_page_url: 'https://example.org/watch' };
    assert.equal(stripResolvedVideoLinks('robot https://example.org/watch https://example.net/notes', source), 'robot  https://example.net/notes');
});

test('generic clips download once before local frame extraction; oversized and playlist downloads fail closed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'public-video-'));
    try {
        const fixture = join(directory, 'fixture.mp4');
        execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10:duration=1', '-c:v', 'libx264', fixture]);
        const bytes = readFileSync(fixture);
        const source = { clip_url: 'https://example.org/media', name: 'source.mp4' };
        let downloads = 0;
        const fetcher = async url => { downloads++; return new Response(Readable.from([bytes]), { url }); };
        const frame = await extractVideoClipSourceImage(source, join(directory, 'frame'), fetcher);
        assert.equal(downloads, 1);
        assert.equal(frame.mimeType, 'image/png');
        assert.ok(frame.bytes > 0);
        assert.deepEqual(readdirSync(join(directory, 'frame')), ['source.png']);
        await assert.rejects(storeVideoSourceClip(source, join(directory, 'large'), null, undefined, {
            fetcher: async url => new Response('x', { url, headers: { 'content-length': String(101 * 1024 * 1024) } }),
        }), /100 MiB/);
        await assert.rejects(storeVideoSourceClip(source, join(directory, 'playlist'), null, undefined, {
            fetcher: async url => new Response(Readable.from(['#EXTM3U\n#EXTINF:1,\nhttp://127.0.0.1/private\n']), { url }),
        }), /decode/);
        assert.deepEqual(readdirSync(join(directory, 'playlist')), []);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
