import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import fetch from 'node-fetch';

import { composeOalgoSourceImages, oalgoSourceImageCompositePlan, oalgoCompositionFailureMessage, VideoBroker } from '../dist/VideoBroker.js';
import { createFrontierVideoKeyframe, VideoKeyframeError } from '../dist/VideoKeyframeProvider.js';
import { VideoUsagePersistenceError } from '../dist/VideoUsage.js';

const identityBytes = Buffer.from('original-oalgo-portrait');
const attachedBytes = Buffer.from('classroom-reference');
const references = [{
    label: 'OALGO', kind: 'identity', bytes: identityBytes, mimeType: 'image/png',
    visualFactsToPreserve: 'Exact face, heavy build, and upright hair.',
    sourceUrl: 'built-in:oalgo', contextUrl: 'built-in:oalgo',
}];
const plan = oalgoSourceImageCompositePlan('OALGO looks toward the teacher behind the laptop.');
const approved = { acceptable: true, best_effort_worthy: true, identity_preserved: true, issues: [], correction_prompt: '' };
const rejected = {
    acceptable: false, best_effort_worthy: false, identity_preserved: false,
    issues: ['Different face, slim build, and side-parted hair.'],
    correction_prompt: 'Restore the huge rounded cheeks, heavy torso, and upright black haircut from Reference 1.',
};

function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function providers(t, reviews, imageErrors = []) {
    const requests = { gemini: [], openai: [], reviews: [] };
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        const url = String(input);
        if (url.includes('generativelanguage.googleapis.com')) {
            requests.gemini.push(JSON.parse(init.body));
            return json({ candidates: [{ content: { parts: [{ inlineData: {
                mimeType: 'image/png', data: Buffer.from(`gemini-${requests.gemini.length}`).toString('base64'),
            } }] } }], usageMetadata: { promptTokenCount: 10 } });
        }
        if (url.endsWith('/v1/images/edits')) {
            requests.openai.push(init.body);
            const error = imageErrors[requests.openai.length - 1];
            if (error) return json({ error }, 400);
            return json({ data: [{ b64_json: Buffer.from(`openai-${requests.openai.length}`).toString('base64') }] });
        }
        if (url.endsWith('/v1/responses')) {
            requests.reviews.push(JSON.parse(init.body));
            const review = reviews[Math.min(requests.reviews.length - 1, reviews.length - 1)];
            if (review instanceof Error) throw review;
            return json({ output_text: JSON.stringify(review), usage: { input_tokens: 10, output_tokens: 10 } });
        }
        throw new Error(`Unexpected provider: ${url}`);
    });
    return requests;
}

function storedImage(directory, name, bytes) {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, name);
    writeFileSync(path, bytes);
    return { path, bytes: bytes.length, mimeType: 'image/png' };
}

test('production OALGO compositor repairs identity failures against both original inputs', async t => {
    const requests = providers(t, [{ ...rejected, acceptable: true, best_effort_worthy: true }, approved]);
    const attempts = [];
    const budgets = [];
    const directory = mkdtempSync(join(tmpdir(), 'oalgo-composite-'));
    try {
        const result = await composeOalgoSourceImages(
            storedImage(directory, 'oalgo.png', identityBytes),
            storedImage(directory, 'attachment.png', attachedBytes),
            'OALGO looks toward the teacher behind the laptop.',
            { onAttempt: event => attempts.push(event), beforeRequest: request => budgets.push(request) },
        );
        assert.equal(result.bytes.toString(), 'openai-2');
        assert.equal(result.reviewStatus, 'accepted');
        assert.equal(requests.gemini.length, 0);
        assert.equal(requests.openai.length, 2);
        for (const [index, request] of requests.openai.entries()) {
            assert.deepEqual(await Promise.all(request.getAll('image[]').map(async image =>
                Buffer.from(await image.arrayBuffer()))), index === 0
                ? [identityBytes, attachedBytes]
                : [identityBytes, attachedBytes, Buffer.from('openai-1')]);
            const prompt = request.get('prompt');
            assert.match(prompt, /Declared use: identity/);
            assert.match(prompt, /huge full cheeks and jowls/);
            assert.match(prompt, /heavy torso/);
            assert.match(prompt, /one additional, separate person/);
            assert.match(prompt, /props with their original owners/);
            assert.doesNotMatch(prompt, /requires no turn|not starting frames|First-second continuation/);
            assert.equal(request.get('size'), '1024x1024');
        }
        assert.match(requests.openai[1].get('prompt'), /Restore the huge rounded cheeks/);
        assert.match(requests.openai[1].get('prompt'), /Image 3 is the EDIT TARGET/);
        assert.match(requests.openai[1].get('prompt'), /Edit the supplied EDIT TARGET in place/);
        const imageBudgets = budgets.filter(request => request.stage === 'keyframe_candidate_openai');
        assert.ok(imageBudgets[1].maxInputTokens > imageBudgets[0].maxInputTokens + 131_072,
            'the repair budget includes the extra candidate image');
        const repairedReviewImages = requests.reviews[1].input[0].content
            .filter(part => part.type === 'input_image').map(part => part.image_url.split(',')[1]);
        assert.deepEqual(repairedReviewImages.map(value => Buffer.from(value, 'base64').toString()),
            ['openai-2', identityBytes.toString(), attachedBytes.toString()],
            'review against the original inputs, never the rejected candidate');
        assert.match(requests.reviews[0].input[0].content[0].text, /recognizable inspiration alone is insufficient/);
        assert.match(requests.reviews[0].input[0].content[0].text, /Correctable gaze or pose differences alone do not fail/);
        assert.match(requests.reviews[0].input[0].content[0].text, /missing or substituted attached primary subject/);
        assert.deepEqual(attempts.filter(event => event.stage === 'keyframe_review').map(event => event.outcome),
            ['rejected', 'accepted']);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('failed Gemini identity repairs use a reviewed GPT Image edit with the original portrait', async t => {
    const requests = providers(t, [rejected, rejected, approved]);
    const result = await createFrontierVideoKeyframe(plan, references, { requireIdentityPreservation: true });
    assert.equal(result.bytes.toString(), 'openai-1');
    assert.equal(result.reviewStatus, 'accepted');
    assert.equal(requests.gemini.length, 2);
    assert.equal(requests.openai.length, 1);
    const image = requests.openai[0].get('image[]');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), identityBytes);
    assert.match(requests.openai[0].get('prompt'), /Restore the huge rounded cheeks/);
    for (const review of requests.reviews) {
        assert.ok(review.input[0].content.some(part => part.image_url?.endsWith(identityBytes.toString('base64'))));
    }
});

test('strict identity review rejects missing identity verdicts even when the reviewer says acceptable', async t => {
    const { identity_preserved, ...missingIdentity } = approved;
    const requests = providers(t, [missingIdentity]);
    await assert.rejects(createFrontierVideoKeyframe(plan, references, {
        requireIdentityPreservation: true, strategy: 'conditional-v2',
    }), /failed visual review/);
    assert.equal(requests.reviews.length, 4);
    assert.equal(requests.openai.length, 2);
});

test('preserving OALGO alone cannot pass a composite that loses the attached subject', async t => {
    const requests = providers(t, [{
        ...rejected, identity_preserved: true,
        issues: ['The teacher and classroom are missing.'], correction_prompt: 'Include the teacher behind the laptop.',
    }]);
    await assert.rejects(createFrontierVideoKeyframe(plan, references, {
        requireIdentityPreservation: true,
    }), /teacher and classroom are missing/);
    assert.equal(requests.reviews.length, 4);
});

for (const [label, reviews, imageErrors, expectedMessage] of [
    ['all candidates change identity', [rejected], [], /changed OALGO's likeness/],
    ['the attached scene is lost', [{ ...rejected, identity_preserved: true }], [], /did not preserve the attached scene/],
    ['the identity reviewer is unavailable', [new Error('review service unavailable')], [], /review service was unavailable/],
    ['the provider declines the first image', [approved], [{ code: 'content_policy_violation', message: 'Request declined.' }], /safety rules/],
    ['the provider declines the repair', [rejected], [null, { code: 'moderation_blocked', message: 'Request declined.' }], /safety rules/],
    ['the image provider has an error', [approved], [{ code: 'invalid_api_key', message: 'Private provider details' }], /image service could not complete/],
]) {
    test(`broker queues no video and reports composition failure when ${label}`, async t => {
        const requests = providers(t, reviews, imageErrors);
        const directory = mkdtempSync(join(tmpdir(), 'oalgo-broker-'));
        const broker = new VideoBroker({
            host: '127.0.0.1', port: 0, dbPath: join(directory, 'queue.sqlite3'),
            resultsDir: join(directory, 'results'), botToken: 'bot-secret', workerToken: 'worker-secret',
            preplanQueuedJobs: false,
            sourceImageDownloader: async (descriptor, target) => storedImage(
                target, 'source.png', 'preset' in descriptor ? identityBytes : attachedBytes,
            ),
        });
        await broker.start();
        try {
            const response = await fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/jobs`, {
                method: 'POST', headers: { authorization: 'Bearer bot-secret', 'content-type': 'application/json' },
                body: JSON.stringify({
                    model: 'minimax', command_variant: 'oalgo', prompt: 'OALGO visits the classroom.',
                    requester_id: 'user', origin_bot_id: 'bot', channel_id: 'channel',
                    command_message_id: 'command', status_message_id: 'status',
                    source_image: { preset: 'oalgo' }, source_image_composite: {
                        url: 'https://cdn.discordapp.com/attachments/1/2/attached.png', mime_type: 'image/png', bytes: attachedBytes.length,
                    },
                }),
            });
            assert.equal(response.status, 400);
            const body = await response.json();
            assert.match(body.error, /Could not combine OALGO with your attached image\. No video was queued/);
            assert.match(body.error, expectedMessage);
            assert.doesNotMatch(body.error, /Private provider details/);
            assert.equal(body.job, undefined);
            assert.deepEqual(await broker.all('SELECT public_id FROM video_jobs'), []);
            const submissions = await broker.all('SELECT * FROM video_submission_metrics');
            assert.equal(submissions.length, 1);
            assert.equal(submissions[0].outcome, 'rejected');
            assert.equal(submissions[0].job_public_id, null);
            assert.equal(typeof submissions[0].source_composition_seconds, 'number');
            assert.equal(existsSync(join(directory, 'results', submissions[0].public_id)), false);
            const usage = await broker.all('SELECT * FROM video_usage_events WHERE job_public_id = ?', [submissions[0].public_id]);
            assert.equal(usage.length > 0, !imageErrors[0],
                'paid image attempts remain accounted for even when no video is queued');
            const attempts = await broker.all('SELECT stage, outcome FROM video_provider_attempt_metrics');
            assert.ok(attempts.some(event => event.stage === 'source_image_composite_failed'));
            assert.ok(!attempts.some(event => event.stage === 'source_image_composite_fallback'));
            assert.equal(attempts.some(event => event.stage === 'source_image_composite_keyframe_review'), !imageErrors[0]);
            assert.ok(attempts.every(event => event.outcome !== 'unreviewed'));
            assert.equal(requests.gemini.length, 0, 'no provider switch on a refused composite');
            if (imageErrors.length) {
                assert.equal(requests.openai.length, imageErrors.length, 'a refusal must not be retried');
                if (expectedMessage.source === 'safety rules') assert.doesNotMatch(body.error, /Please try again|You can retry/);
            }
            if (reviews[0] instanceof Error) {
                assert.equal(requests.gemini.length, 0);
                assert.equal(requests.reviews.length, 2);
                assert.equal(requests.openai.length, 1);
            }
        } finally { await broker.stop(); rmSync(directory, { recursive: true, force: true }); }
    });
}

test('composition messages distinguish deadlines and hide unexpected provider details', () => {
    assert.match(oalgoCompositionFailureMessage(new VideoKeyframeError('timeout', 'aborted')), /took too long/);
    assert.match(oalgoCompositionFailureMessage(new Error('secret request payload')), /image service could not complete/);
    assert.doesNotMatch(oalgoCompositionFailureMessage(new Error('secret request payload')), /secret/);
});

test('a corrective composite still receives its review after five minutes of provider work', async t => {
    const requests = providers(t, [rejected, approved]);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const providerFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        // Reproduce f4f1cd08: two successful ~135s edits plus their reviews.
        t.mock.timers.tick(String(input).endsWith('/v1/images/edits') ? 137_000 : 27_000);
        assert.equal(init.signal.aborted, false, 'a paid candidate must have time for its visual review');
        return providerFetch(input, init);
    });
    const directory = mkdtempSync(join(tmpdir(), 'oalgo-composite-timeout-'));
    try {
        const result = await composeOalgoSourceImages(
            storedImage(directory, 'oalgo.png', identityBytes),
            storedImage(directory, 'attachment.png', attachedBytes),
            'OALGO joins the pictured scene.', {},
        );
        assert.equal(result.reviewStatus, 'accepted');
        assert.equal(requests.openai.length, 2);
        assert.equal(requests.reviews.length, 2);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the shared composition deadline reports a timeout and starts no further image calls', async t => {
    const requests = providers(t, [approved]);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    t.mock.method(globalThis, 'fetch', async (_input, init) => {
        t.mock.timers.tick(9 * 60 * 1000);
        assert.equal(init.signal.aborted, true);
        throw new Error('This operation was aborted');
    });
    const directory = mkdtempSync(join(tmpdir(), 'oalgo-composite-deadline-'));
    const attempts = [];
    try {
        await assert.rejects(composeOalgoSourceImages(
            storedImage(directory, 'oalgo.png', identityBytes),
            storedImage(directory, 'attachment.png', attachedBytes),
            'OALGO joins the classroom.', { onAttempt: event => attempts.push(event) },
        ), error => error instanceof VideoKeyframeError && error.code === 'timeout');
        assert.equal(attempts.length, 1);
        assert.equal(requests.reviews.length, 0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('required identity review cannot run without an identity reference', async t => {
    const requests = providers(t, [approved]);
    await assert.rejects(createFrontierVideoKeyframe(plan, [], { requireIdentityPreservation: true }), /original identity reference/);
    assert.equal(requests.gemini.length, 0);
});

test('accounting failures stop the composite pipeline without buying another image', async t => {
    const requests = providers(t, [approved]);
    await assert.rejects(createFrontierVideoKeyframe(plan, references, {
        requireIdentityPreservation: true,
        onUsage: () => { throw new VideoUsagePersistenceError('usage database unavailable'); },
    }), VideoUsagePersistenceError);
    assert.equal(requests.gemini.length, 1);
    assert.equal(requests.openai.length, 0);
});

test('a cancelled composite stops an in-flight review and never starts a repair', async t => {
    const requests = providers(t, [approved]);
    const controller = new AbortController();
    const mockFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        if (String(input).endsWith('/v1/responses')) {
            return new Promise((_resolve, reject) => {
                init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                controller.abort();
            });
        }
        return mockFetch(input, init);
    });
    await assert.rejects(createFrontierVideoKeyframe(plan, references, {
        requireIdentityPreservation: true, abortSignal: controller.signal,
    }), /Required identity review unavailable/);
    assert.equal(requests.gemini.length, 1);
    assert.equal(requests.openai.length, 0);
});

test('a cancelled composite aborts an in-flight GPT Image fallback', async t => {
    const requests = providers(t, [rejected]);
    const controller = new AbortController();
    const mockFetch = globalThis.fetch;
    let fallbackCalls = 0;
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        if (String(input).endsWith('/v1/images/edits')) {
            fallbackCalls += 1;
            return new Promise((_resolve, reject) => {
                init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                controller.abort();
            });
        }
        return mockFetch(input, init);
    });
    await assert.rejects(createFrontierVideoKeyframe(plan, references, {
        requireIdentityPreservation: true, abortSignal: controller.signal,
    }), /aborted/);
    assert.equal(requests.gemini.length, 2);
    assert.equal(requests.reviews.length, 2);
    assert.equal(fallbackCalls, 1);
});
