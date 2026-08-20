import assert from 'node:assert/strict';
import test from 'node:test';

import {
    fetchRecentMessagesForSummarization,
    summarizeMessages,
} from '../dist/Summarize.js';

function makeMessage({
    id,
    content,
    authorId = 'person',
    createdTimestamp,
    attachmentUrls = [],
    reply,
}) {
    return {
        attachments: new Map(attachmentUrls.map((url, index) => [String(index), { url }])),
        author: { id: authorId },
        content,
        createdTimestamp,
        id,
        reference: reply ? { messageId: reply } : null,
    };
}

test('backfills summary messages from Discord history in chronological order', async () => {
    const batches = [
        Array.from({ length: 100 }, (_, index) => makeMessage({
            id: String(200 - index),
            content: `message ${200 - index}`,
            createdTimestamp: 200 - index,
        })),
        [
            makeMessage({
                id: '100',
                content: 'oldest message',
                createdTimestamp: 100,
            }),
            makeMessage({
                id: '99',
                content: 'second oldest message',
                createdTimestamp: 99,
            }),
        ],
    ];
    const fetchOptions = [];
    const msg = {
        channel: {
            messages: {
                async fetch(options) {
                    fetchOptions.push(options);
                    const values = batches.shift() || [];
                    return {
                        size: values.length,
                        values: () => values.values(),
                    };
                },
            },
        },
        client: { user: { id: 'summary-bot' } },
        id: '201',
    };

    const messages = await fetchRecentMessagesForSummarization(msg, 150);

    assert.equal(messages.length, 102);
    assert.equal(messages[0].id, '99');
    assert.equal(messages.at(-1).id, '200');
    assert.deepEqual(fetchOptions, [
        { before: '201', cache: false, limit: 100 },
        { before: '101', cache: false, limit: 50 },
    ]);
});

test('history backfill excludes bot and command messages while retaining attachments and replies', async () => {
    const history = [
        makeMessage({
            id: '4',
            content: 'bot status',
            authorId: 'summary-bot',
            createdTimestamp: 4,
        }),
        makeMessage({
            id: '3',
            content: '$summary',
            createdTimestamp: 3,
        }),
        makeMessage({
            id: '25',
            content: 'message from the other deployment bot',
            authorId: '446154284514541579',
            createdTimestamp: 2.5,
        }),
        makeMessage({
            id: '2',
            content: '',
            createdTimestamp: 2,
            attachmentUrls: ['https://example.com/image.png'],
            reply: '1',
        }),
        makeMessage({
            id: '1',
            content: 'hello',
            createdTimestamp: 1,
        }),
    ];
    const msg = {
        channel: {
            messages: {
                async fetch() {
                    return {
                        size: history.length,
                        values: () => history.values(),
                    };
                },
            },
        },
        client: { user: { id: 'summary-bot' } },
        id: '5',
    };

    const messages = await fetchRecentMessagesForSummarization(msg, 50);

    assert.deepEqual(messages, [
        {
            author: 'person',
            content: 'hello',
            id: '1',
            reply: undefined,
        },
        {
            author: 'person',
            content: '\nhttps://example.com/image.png',
            id: '2',
            reply: '1',
        },
    ]);
});

test('summarizes fetched history when the in-memory cache is cold', async () => {
    const history = [makeMessage({
        id: '10',
        content: 'historical chat',
        createdTimestamp: 10,
    })];
    const msg = {
        channel: {
            messages: {
                async fetch() {
                    return {
                        size: history.length,
                        values: () => history.values(),
                    };
                },
            },
        },
        client: { user: { id: 'summary-bot' } },
        id: '11',
    };
    const originalFetch = globalThis.fetch;
    let requestBody;

    globalThis.fetch = async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {
            ok: true,
            async json() {
                return {
                    choices: [{ message: { content: 'summary result' } }],
                };
            },
        };
    };

    try {
        const response = await summarizeMessages(
            msg,
            'cold-cache-test-channel',
            null,
            'requesting-person',
            50,
            3000,
        );

        assert.deepEqual(response, { result: 'summary result' });
        assert.match(requestBody.messages[1].content, /<@person>: historical chat/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
