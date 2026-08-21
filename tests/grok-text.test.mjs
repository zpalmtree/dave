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
