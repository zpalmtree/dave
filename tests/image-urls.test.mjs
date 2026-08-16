import assert from 'node:assert/strict';
import test from 'node:test';

import { getImageURLsFromMessage } from '../dist/Utilities.js';

function makeMessage({ attachments = [], embeds = [], content = '' } = {}) {
    return {
        attachments: new Map(attachments.map((attachment, index) => [String(index), attachment])),
        embeds,
        content,
    };
}

test('can ignore Discord link-preview images while retaining explicit images', () => {
    const message = makeMessage({
        attachments: [{
            contentType: 'image/jpeg',
            name: 'upload.jpg',
            url: 'https://cdn.discordapp.com/upload.jpg',
        }],
        embeds: [{
            image: { url: 'https://pbs.twimg.com/video-preview.jpg' },
            thumbnail: { url: 'https://pbs.twimg.com/avatar.jpg' },
        }],
        content: 'https://x.com/example/status/123 https://example.com/direct.webp',
    });

    assert.deepEqual(getImageURLsFromMessage(message, undefined, { includeEmbeds: false }), [
        'https://cdn.discordapp.com/upload.jpg',
        'https://example.com/direct.webp',
    ]);
});

test('includes Discord embed images by default', () => {
    const message = makeMessage({
        embeds: [{ image: { url: 'https://example.com/preview.jpg' } }],
    });

    assert.deepEqual(getImageURLsFromMessage(message), [
        'https://example.com/preview.jpg',
    ]);
});
