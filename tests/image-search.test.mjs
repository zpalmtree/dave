import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createPublicImageLookup,
    downloadImageForUpload,
    downloadSearchResultImage,
    isUsableImageResult,
} from '../dist/ImageSearch.js';

function response(data, { ok = true, status = 200, url = 'https://images.example/result.jpg', length } = {}) {
    return {
        ok,
        status,
        url,
        headers: {
            get: (name) => name === 'content-length' && length !== undefined ? String(length) : null,
        },
        buffer: async () => data,
    };
}

test('detects the downloaded image format instead of trusting the URL extension', async () => {
    const webp = Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.alloc(4),
        Buffer.from('WEBP'),
        Buffer.alloc(8),
    ]);

    const image = await downloadImageForUpload(
        'https://images.example/result.jpg?width=1280',
        100,
        async () => response(webp),
    );

    assert.equal(image?.extension, 'webp');
    assert.deepEqual(image?.data, webp);
});

test('rejects non-image response bodies', async () => {
    const image = await downloadImageForUpload(
        'https://images.example/result.jpg',
        100,
        async () => response(Buffer.from('<html>blocked</html>')),
    );

    assert.equal(image, undefined);
});

test('refuses private image hosts without making a request', async () => {
    let requested = false;
    const image = await downloadImageForUpload(
        'https://127.0.0.1/private.jpg',
        100,
        async () => {
            requested = true;
            return response(Buffer.from([0xff, 0xd8, 0xff]));
        },
    );

    assert.equal(image, undefined);
    assert.equal(requested, false);
});

test('returns the lookup shape requested by Node HTTP clients', async () => {
    const addresses = [
        { address: '8.8.8.8', family: 4 },
        { address: '2001:4860:4860::8888', family: 6 },
    ];
    const lookup = createPublicImageLookup((_hostname, options, callback) => {
        assert.equal(options.all, true);
        callback(null, addresses);
    });
    const invoke = (options) => new Promise((resolve) => {
        lookup('images.example', options, (...args) => resolve(args));
    });

    assert.deepEqual(await invoke({ all: false }), [null, '8.8.8.8', 4]);
    assert.deepEqual(await invoke({ all: true }), [null, addresses]);
});

test('falls back to the Google thumbnail when the original cannot be downloaded', async () => {
    const requested = [];
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const image = await downloadSearchResultImage({
        title: 'Result',
        link: 'https://images.example/blocked.jpg',
        url: 'https://example.com/page',
        displayLink: 'example.com',
        thumbnailLink: 'https://encrypted-tbn0.gstatic.com/thumbnail',
    }, async (url) => {
        requested.push(url);
        return url.includes('blocked')
            ? response(Buffer.from('denied'))
            : response(jpeg, { url });
    });

    assert.deepEqual(requested, [
        'https://images.example/blocked.jpg',
        'https://encrypted-tbn0.gstatic.com/thumbnail',
    ]);
    assert.equal(image?.extension, 'jpg');
});

test('requires an HTTPS source and Google thumbnail for search results', () => {
    assert.equal(isUsableImageResult({
        link: 'https://images.example/dynamic?id=1',
        mime: 'image/jpeg',
        image: { thumbnailLink: 'https://encrypted-tbn0.gstatic.com/thumbnail' },
    }), true);
    assert.equal(isUsableImageResult({
        link: 'https://images.example/result.jpg',
        mime: 'image/jpeg',
        image: {},
    }), false);
});
