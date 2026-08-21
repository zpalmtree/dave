import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildChunkSummaryPrompt,
    buildFinalSummaryPrompt,
    buildSummarySynthesisPrompt,
} from '../dist/Grok.js';
import {
    SUMMARY_OUTPUT_MAX_LENGTH,
    SUMMARY_WINDOW_MS,
    chunkSummaryInput,
    fetchRecentMessagesForSummarization,
    fitSummaryInDiscordMessage,
    handleSummarize,
    summarizeMessages,
} from '../dist/Summarize.js';

test('uses the original conditional-humor style for final summaries', () => {
    const prompt = buildFinalSummaryPrompt('Alice');

    assert.match(prompt, /Use dry humor and gentle roasts where appropriate/);
    assert.match(prompt, /End with a zinger or amusing observation if the material warrants it/);
    assert.doesNotMatch(prompt, /at least two/);
    assert.doesNotMatch(prompt, /never a neutral meeting summary/);
});

test('extracts flavor-preserving source notes instead of neutral prose', () => {
    const prompt = buildChunkSummaryPrompt(1, 3);

    assert.match(prompt, /do not write a polished summary/);
    assert.match(prompt, /short verbatim phrases/);
    assert.match(prompt, /callbacks, and running jokes/);
    assert.match(prompt, /one distinct conversational beat per bullet/);
    assert.match(prompt, /Do not invent jokes/);
});

test('synthesis selects coherent beats without forcing every note together', () => {
    const prompt = buildSummarySynthesisPrompt('Alice');

    assert.match(prompt, /Choose the strongest beats and through-lines/);
    assert.match(prompt, /one clear thought per sentence/);
    assert.match(prompt, /Do not copy the notes' bullet structure/);
    assert.match(prompt, /combine unrelated beats into one sentence/);
});

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

function makeBatch(values) {
    return {
        size: values.length,
        values: () => values.values(),
    };
}

function successfulGrokResponse(content) {
    return {
        ok: true,
        async json() {
            return {
                choices: [{ message: { content } }],
            };
        },
    };
}

test('fetches messages back to the 12-hour cutoff and returns chronological history', async () => {
    const commandTimestamp = 2 * SUMMARY_WINDOW_MS;
    const windowStartTimestamp = commandTimestamp - SUMMARY_WINDOW_MS;
    const batches = [
        Array.from({ length: 100 }, (_, index) => makeMessage({
            id: String(200 - index),
            content: `message ${200 - index}`,
            createdTimestamp: commandTimestamp - ((index + 1) * 1000),
        })),
        [
            makeMessage({
                id: '100',
                content: 'just inside window',
                createdTimestamp: windowStartTimestamp + 1,
            }),
            makeMessage({
                id: '99',
                content: 'exactly at cutoff',
                createdTimestamp: windowStartTimestamp,
            }),
            makeMessage({
                id: '98',
                content: 'outside window',
                createdTimestamp: windowStartTimestamp - 1,
            }),
        ],
    ];
    const fetchOptions = [];
    const msg = {
        channel: {
            messages: {
                async fetch(options) {
                    fetchOptions.push(options);
                    return makeBatch(batches.shift() || []);
                },
            },
        },
        client: { user: { id: 'summary-bot' } },
        id: '201',
    };

    const messages = await fetchRecentMessagesForSummarization(msg, windowStartTimestamp);

    assert.equal(messages.length, 102);
    assert.equal(messages[0].id, '99');
    assert.equal(messages.at(-1).id, '200');
    assert.deepEqual(fetchOptions, [
        { before: '201', cache: false, limit: 100 },
        { before: '101', cache: false, limit: 100 },
    ]);
});

test('history selection excludes bot and command messages while retaining attachments and replies', async () => {
    const history = [
        makeMessage({
            id: '5',
            content: 'bot status',
            authorId: 'summary-bot',
            createdTimestamp: 5,
        }),
        makeMessage({
            id: '4',
            content: '$summary',
            createdTimestamp: 4,
        }),
        makeMessage({
            id: '3',
            content: 'message from the other deployment bot',
            authorId: '446154284514541579',
            createdTimestamp: 3,
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
                    return makeBatch(history);
                },
            },
        },
        client: { user: { id: 'summary-bot' } },
        id: '6',
    };

    const messages = await fetchRecentMessagesForSummarization(msg, 0);

    assert.deepEqual(messages, [
        {
            author: 'person',
            content: 'hello',
            createdTimestamp: 1,
            id: '1',
            reply: undefined,
        },
        {
            author: 'person',
            content: '\nhttps://example.com/image.png',
            createdTimestamp: 2,
            id: '2',
            reply: '1',
        },
    ]);
});

test('chunks summary input only between complete message lines', () => {
    assert.deepEqual(chunkSummaryInput(['aaaaaa', 'bbbbbb', 'cccc'], 10), [
        'aaaaaa',
        'bbbbbbcccc',
    ]);
});

test('hard-limits summaries to one Discord message at a readable boundary', () => {
    const fitted = fitSummaryInDiscordMessage(
        `${'A'.repeat(1700)}. ${'word '.repeat(100)}`,
    );

    assert.ok(fitted.length <= SUMMARY_OUTPUT_MAX_LENGTH);
    assert.match(fitted, /…$/);
    assert.ok(!fitted.endsWith(' …'));
});

test('summarizes fetched history from the preceding 12 hours when the cache is cold', async () => {
    const commandTimestamp = 2 * SUMMARY_WINDOW_MS;
    const history = [makeMessage({
        id: '10',
        content: 'historical chat',
        createdTimestamp: commandTimestamp - 1000,
    })];
    const msg = {
        channel: {
            messages: {
                async fetch() {
                    return makeBatch(history);
                },
            },
        },
        client: { user: { id: 'summary-bot' } },
        createdTimestamp: commandTimestamp,
        id: '11',
    };
    const originalFetch = globalThis.fetch;
    let requestBody;

    globalThis.fetch = async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return successfulGrokResponse('summary result');
    };

    try {
        const response = await summarizeMessages(
            msg,
            'cold-cache-test-channel',
            null,
            'requesting-person',
        );

        assert.deepEqual(response, { result: 'summary result' });
        assert.equal(requestBody.model, 'grok-4.5-latest');
        assert.match(requestBody.messages[1].content, /UTC.*<@person>: historical chat/);
        assert.doesNotMatch(requestBody.messages[0].content, /\b(?:12|24)[ -]?hours?\b/i);
        assert.match(requestBody.messages[0].content, /Do not mention or refer to the duration/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('summarizes oversized days in chunks before producing one final synthesis', async () => {
    const commandTimestamp = 2 * SUMMARY_WINDOW_MS;
    const history = Array.from({ length: 61 }, (_, index) => makeMessage({
        id: String(100 - index),
        content: `${index}: ${'x'.repeat(2000)}`,
        createdTimestamp: commandTimestamp - ((index + 1) * 1000),
    }));
    const msg = {
        channel: {
            messages: {
                async fetch() {
                    return makeBatch(history);
                },
            },
        },
        client: { user: { id: 'summary-bot' } },
        createdTimestamp: commandTimestamp,
        id: '101',
    };
    const originalFetch = globalThis.fetch;
    const requestBodies = [];

    globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        requestBodies.push(body);

        if (body.messages[0].content.startsWith('Extract flavor-preserving')) {
            return successfulGrokResponse(`intermediate ${requestBodies.length}`);
        }

        return successfulGrokResponse('final synthesis');
    };

    try {
        const response = await summarizeMessages(
            msg,
            'chunked-summary-test-channel',
            null,
            'requesting-person',
        );

        assert.deepEqual(response, { result: 'final synthesis' });
        assert.equal(requestBodies.length, 3);
        assert.ok(requestBodies.every(({ model }) => model === 'grok-4.5-latest'));
        assert.equal(requestBodies[0].temperature, 0.3);
        assert.equal(requestBodies[1].temperature, 0.3);
        assert.equal(requestBodies[2].temperature, 0.8);
        assert.match(requestBodies[2].messages[0].content, /Choose the strongest beats/);
        assert.match(requestBodies[2].messages[1].content, /intermediate 1/);
        assert.match(requestBodies[2].messages[1].content, /intermediate 2/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('edits the progress reply into one final Discord message', async () => {
    const commandTimestamp = 2 * SUMMARY_WINDOW_MS;
    const history = [makeMessage({
        id: '20',
        content: 'one-day history',
        createdTimestamp: commandTimestamp - 1000,
    })];
    const replies = [];
    const edits = [];
    const msg = {
        author: { id: 'requesting-person' },
        channel: {
            id: 'single-message-test-channel',
            messages: {
                async fetch() {
                    return makeBatch(history);
                },
            },
        },
        client: { user: { id: 'summary-bot' } },
        createdTimestamp: commandTimestamp,
        guild: null,
        id: '21',
        async reply(content) {
            replies.push(content);
            return {
                async edit(updatedContent) {
                    edits.push(updatedContent);
                },
            };
        },
    };
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => successfulGrokResponse('concise final summary');

    try {
        await handleSummarize(msg);

        assert.deepEqual(replies, ['Generating summary, please wait...']);
        assert.deepEqual(edits, ['concise final summary']);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
