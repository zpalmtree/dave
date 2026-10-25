import assert from 'node:assert/strict';
import test from 'node:test';
import { classificationReviewHash, reviewVideoMinorClassification } from '../dist/VideoClassificationReview.js';
import { prepareRecoveryPlanWithMuseFallback, RecoveryLocalPlanRequired, RecoveryStoppedError,
    createVideoPlanWithMuseFallback } from '../dist/VideoRecoveryService.js';
import { FrontierPlannerRejectedError } from '../dist/VideoFrontierPlanner.js';
import { VideoUsagePersistenceError } from '../dist/VideoUsage.js';

const prompt = 'An adult gamer plays on a 5-person team, argues with 2 teammates, and gets reported and banned.';
const cleared = { minors: 'absent', sexual_content: 'absent', sexualized_minor: 'absent',
    minor_evidence: [], sexual_evidence: [], reason: 'The request concerns a gaming argument with no sexual content.' };
function reply(value) { return new Response(JSON.stringify({ status: 'completed', output_text: JSON.stringify(value),
    usage: { input_tokens: 100, output_tokens: 50 } })); }

for (const [label, value, verdict] of [
    ['nonsexual gaming', cleared, 'cleared'],
    ['uncertain assessment', { ...cleared, minors: 'uncertain', sexual_content: 'uncertain', sexualized_minor: 'uncertain' }, 'unresolved'],
    ['unsupported clearance', { ...cleared, minors: 'uncertain', sexual_content: 'uncertain' }, 'unresolved'],
    ['fabricated evidence', { ...cleared, minor_evidence: [{ source: 'prompt', image_index: 0, text: 'not in the request' }] }, 'unresolved'],
    ['missing present evidence', { ...cleared, minors: 'present', sexual_content: 'present', sexualized_minor: 'present' }, 'unresolved'],
    ['invalid image reference', { ...cleared, minor_evidence: [{ source: 'image', image_index: 2, text: 'age cue' }] }, 'unresolved'],
]) {
    test(`independent review: ${label}`, async t => {
        let calls = 0;
        const events = [], usages = [];
        t.mock.method(globalThis, 'fetch', async (url, init) => {
            calls++;
            assert.equal(url, 'https://api.openai.com/v1/responses');
            const body = JSON.parse(init.body);
            assert.equal(body.model, 'gpt-6-sol');
            assert.equal(body.text.format.strict, true);
            assert.equal(body.store, false);
            assert.match(body.input[0].content[0].text, /5-person team/);
            assert.equal(body.input[0].content[1].image_url, 'data:image/png;base64,aW1hZ2U=');
            return reply(value);
        });
        const result = await reviewVideoMinorClassification({ prompt, sources: [{ mimeType: 'image/png', data: Buffer.from('image') }],
            rejectedModel: 'muse-wonder-1.0', options: { onAttempt: event => events.push(event), onUsage: event => usages.push(event) } });
        assert.equal(result.verdict, verdict);
        assert.equal(calls, 1);
        assert.equal(usages.length, 1);
        assert.equal(JSON.parse(events.at(-1).detail).verdict, verdict);
    });
}

test('grounded confirmed classification stays blocked and retains private evidence', async t => {
    const content = 'Classification fixture: minor age cue; sexual content cue.';
    t.mock.method(globalThis, 'fetch', async () => reply({ minors: 'present', sexual_content: 'present', sexualized_minor: 'present',
        minor_evidence: [{ source: 'prompt', image_index: 0, text: 'minor age cue' }],
        sexual_evidence: [{ source: 'prompt', image_index: 0, text: 'sexual content cue' }], reason: 'Fixture finding.' }));
    const result = await reviewVideoMinorClassification({ prompt: content, sources: [], rejectedModel: 'muse-wonder-1.0', options: {} });
    assert.equal(result.verdict, 'confirmed');
    assert.equal(result.evidence.minor_evidence[0].text, 'minor age cue');
});

test('OpenAI classification is reviewed by a different provider', async t => {
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, 'https://api.anthropic.com/v1/messages');
        assert.equal(JSON.parse(init.body).model, 'claude-opus-5-5');
        return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(cleared) }] }));
    });
    assert.equal((await reviewVideoMinorClassification({ prompt, sources: [], rejectedModel: 'gpt-6-sol', options: {} })).verdict, 'cleared');
});

for (const kind of ['refusal', 'invalid-json', 'outage', 'incomplete']) {
    test(`review ${kind} never clears a classification and is not retried`, async t => {
        let calls = 0;
        t.mock.method(globalThis, 'fetch', async () => {
            calls++;
            if (kind === 'outage') throw new Error('offline');
            return new Response(JSON.stringify(kind === 'refusal'
                ? { output: [{ content: [{ type: 'refusal', refusal: 'Declined.' }] }] }
                : kind === 'incomplete' ? { status: 'incomplete' } : { output_text: 'invalid' }));
        });
        const result = await reviewVideoMinorClassification({ prompt, sources: [], rejectedModel: 'muse-wonder-1.0', options: {} });
        assert.equal(result.verdict, 'unresolved');
        assert.equal(calls, 1);
    });
}

test('review accounting errors propagate instead of becoming a routing decision', async t => {
    t.mock.method(globalThis, 'fetch', async () => reply(cleared));
    await assert.rejects(reviewVideoMinorClassification({ prompt, sources: [], rejectedModel: 'muse-wonder-1.0', options: {
        onUsage: () => { throw new VideoUsagePersistenceError('disk full'); },
    } }), VideoUsagePersistenceError);
});

for (const [label, response, errorClass] of [['cleared', cleared, RecoveryLocalPlanRequired],
    ['unresolved', { ...cleared, sexualized_minor: 'uncertain' }, RecoveryStoppedError]]) {
    test(`Claude rejection then Muse misclassification: ${label}, persisted and reused`, async t => {
        const calls = [], reviews = [];
        let reviewCalls = 0;
        t.mock.method(globalThis, 'fetch', async () => { reviewCalls++; return reply(response); });
        const analysis = { dialogue_contract: { mode: 'verbatim', lines: [{ text: 'We made it home.', verbatim: true }] },
            frontier_handling: { disposition: 'reject', reason_code: 'provider_policy' } };
        const input = { prompt, model: 'minimax', requester: 'test', sources: [], options: { plannerModel: 'claude-opus-5-5' },
            classificationReviews: reviews, onClassificationReview: async review => reviews.push(review),
            planner: async (actualPrompt, _model, _requester, _sources, options) => {
                assert.ok([prompt, `${prompt} Changed.`].includes(actualPrompt));
                calls.push(options.plannerModel);
                if (options.plannerModel !== 'muse-wonder-1.0') throw new FrontierPlannerRejectedError('provider_policy', 'Declined.', analysis);
                return { prompt_analysis: { frontier_handling: { disposition: 'reject', reason_code: 'minor_sexualization' } } };
            } };
        for (let resume = 0; resume < 2; resume++) {
            await assert.rejects(prepareRecoveryPlanWithMuseFallback(input), error => {
                assert.ok(error instanceof errorClass);
                if (label === 'cleared') assert.equal(error.promptAnalysis, analysis, 'Keep original dialogue and story requirements.');
                else assert.doesNotMatch(error.message, /sexual content involving minors/i);
                return true;
            });
        }
        assert.deepEqual(calls, ['claude-opus-5-5', 'muse-wonder-1.0', 'claude-opus-5-5', 'muse-wonder-1.0']);
        assert.equal(reviews.length, 1);
        assert.equal(reviewCalls, 1);
        assert.equal(reviews[0].verdict, label);
        await assert.rejects(prepareRecoveryPlanWithMuseFallback({ ...input, prompt: `${prompt} Changed.` }), errorClass);
        assert.equal(reviewCalls, 2, 'Changed input must not reuse a clearance.');
    });
}

test('legacy route also reviews a Muse flag before falling back locally', async t => {
    t.mock.method(globalThis, 'fetch', async () => reply(cleared));
    const models = [];
    await assert.rejects(createVideoPlanWithMuseFallback(prompt, 'minimax', 'test', undefined,
        { plannerModel: 'claude-opus-5-5' }, async (_prompt, _model, _requester, _sources, options) => {
            models.push(options.plannerModel);
            throw new FrontierPlannerRejectedError(models.length === 1 ? 'provider_policy' : 'minor_sexualization');
        }), error => error instanceof FrontierPlannerRejectedError && error.reasonCode === 'provider_policy');
    assert.deepEqual(models, ['claude-opus-5-5', 'muse-wonder-1.0']);
});

test('review cache is bound to prompt, guidance, image content and image MIME type', () => {
    const input = { prompt, sources: [{ mimeType: 'image/png', data: Buffer.from('one') }], options: {} };
    const baseline = classificationReviewHash(input);
    for (const change of [{ prompt: `${prompt}!` }, { options: { plannerGuidance: 'New source context' } },
        { sources: [{ mimeType: 'image/png', data: Buffer.from('two') }] },
        { sources: [{ mimeType: 'image/jpeg', data: Buffer.from('one') }] }]) {
        assert.notEqual(classificationReviewHash({ ...input, ...change }), baseline);
    }
});

for (const failure of ['reviewer', 'persistence']) {
    test(`a ${failure} exception during Muse review cannot fall through to Qwen`, async () => {
        await assert.rejects(prepareRecoveryPlanWithMuseFallback({ prompt, model: 'minimax', requester: 'test', sources: [],
            options: { plannerModel: 'claude-opus-5-5' },
            planner: async (_prompt, _model, _requester, _sources, options) => {
                throw new FrontierPlannerRejectedError(options.plannerModel === 'muse-wonder-1.0'
                    ? 'minor_sexualization' : 'provider_policy');
            },
            classificationReviewer: async () => {
                if (failure === 'reviewer') throw new Error('review failed');
                return { verdict: 'cleared' };
            },
            onClassificationReview: async () => { throw new Error('disk full'); },
        }), error => error instanceof RecoveryStoppedError && /could not be completed or saved/.test(error.message));
    });
}

test('clearing a primary flag does not certify its rejected analysis as a binding local contract', async t => {
    t.mock.method(globalThis, 'fetch', async () => reply(cleared));
    await assert.rejects(prepareRecoveryPlanWithMuseFallback({ prompt, model: 'minimax', requester: 'test', sources: [],
        options: { plannerModel: 'claude-opus-5-5' },
        planner: async (_prompt, _model, _requester, _sources, options) => {
            throw new FrontierPlannerRejectedError(options.plannerModel === 'muse-wonder-1.0'
                ? 'provider_policy' : 'minor_sexualization', 'Declined.', { dialogue_contract: { mode: 'none', lines: [] } });
        },
    }), error => error instanceof RecoveryLocalPlanRequired && error.reasonCode === 'classification_cleared'
        && error.promptAnalysis.frontier_handling.reason_code === 'provider_policy'
        && error.promptAnalysis.classification_review.verdict === 'cleared');
});
