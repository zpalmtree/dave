import assert from 'node:assert/strict';
import test from 'node:test';

import { handleGrok } from '../dist/Grok.js';

test('uses low reasoning effort for latency-sensitive Grok text replies', async () => {
    const originalFetch = globalThis.fetch;
    const replies = [];
    let requestUrl;
    let requestBody;

    globalThis.fetch = async (url, options) => {
        requestUrl = url;
        requestBody = JSON.parse(options.body);
        return {
            ok: true,
            async json() {
                return {
                    status: 'completed',
                    output: [{
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: 'Rewritten text.' }],
                    }],
                };
            },
        };
    };

    const msg = {
        attachments: new Map(),
        author: { id: 'requesting-person' },
        channel: { id: 'grok-text-test-channel' },
        content: '$grok rewrite this',
        embeds: [],
        guild: null,
        reference: null,
        async reply(payload) {
            replies.push(payload);
            return { id: 'bot-response' };
        },
    };

    try {
        await handleGrok(msg, 'rewrite this');

        assert.match(requestUrl, /\/responses$/);
        assert.equal(requestBody.model, 'grok-4.6');
        assert.deepEqual(requestBody.reasoning, { effort: 'low' });
        assert.equal(replies[0].content, 'Rewritten text.');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('uses the Responses API with search tools for image-backed Grok requests', async () => {
    const originalFetch = globalThis.fetch;
    const replies = [];
    let requestUrl;
    let requestBody;
    const imageUrl = 'https://cdn.discordapp.com/attachments/1/2/chart.png';
    const repliedMessage = {
        attachments: new Map([['chart', {
            contentType: 'image/png',
            name: 'chart.png',
            url: imageUrl,
        }]]),
        content: '',
        embeds: [],
    };

    globalThis.fetch = async (url, options) => {
        requestUrl = url;
        requestBody = JSON.parse(options.body);
        return {
            ok: true,
            async json() {
                return {
                    status: 'completed',
                    output: [{
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: 'Per-capita results.' }],
                    }],
                };
            },
        };
    };

    const msg = {
        attachments: new Map(),
        author: { id: 'requesting-person' },
        channel: {
            id: 'grok-image-search-test-channel',
            messages: {
                async fetch() {
                    return repliedMessage;
                },
            },
        },
        content: '$grok analyze this and research the underlying data',
        embeds: [],
        guild: null,
        reference: { messageId: 'source-message' },
        async reply(payload) {
            replies.push(payload);
            return { id: 'bot-response' };
        },
    };

    try {
        await handleGrok(msg, 'analyze this and research the underlying data');

        assert.match(requestUrl, /\/responses$/);
        assert.deepEqual(requestBody.tools.map(tool => tool.type), ['x_search', 'web_search']);
        assert.equal(requestBody.store, false);
        assert.deepEqual(requestBody.input[0].content.slice(-2), [
            {
                type: 'input_text',
                text: requestBody.input[0].content[0].text,
            },
            {
                type: 'input_image',
                image_url: imageUrl,
                detail: 'high',
            },
        ]);
        assert.equal(requestBody.messages, undefined);
        assert.equal(replies[0].content, 'Per-capita results.');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
