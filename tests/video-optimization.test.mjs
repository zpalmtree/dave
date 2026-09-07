import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';
import { createHash } from 'node:crypto';
import { REVIEW_PAGE } from '../scripts/video-cost-ab-review-ui.mjs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredVideoPlannerVariant, supportsSinglePassVideoPlanning, requestPlannerResponse, validateFrontierVideoPlanForKeyframe } from '../dist/VideoFrontierPlanner.js';
import { requestedVideoDurationSeconds, videoPromptContentNumbers } from '../dist/VideoProtocol.js';
import { openAIVideoUsage, videoUsageCost } from '../dist/VideoUsage.js';
import { VideoExperimentLedger, ledgerTotals, executionFingerprint } from '../scripts/video-experiment-ledger.mjs';
import { blindedPlan, bootstrapMeanInterval, summarizeOptimization } from '../scripts/video-optimization-analysis.mjs';
import { rendererArguments, validateRenderManifest, renderInputFingerprint } from '../scripts/video-optimization-renders.mjs';
import { reviewerEvidence } from '../scripts/benchmark-video-optimization-images.mjs';
import { selectVideoOptimization } from '../dist/VideoOptimizationRollout.js';
import { assessVideoComponent } from '../scripts/report-video-optimization.mjs';

test('requested models are explicit and Astra/Flash retain single-pass capability', () => {
    for (const model of ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gemini-3.8-flash']) {
        assert.equal(configuredVideoPlannerVariant({ VIDEO_PLANNER_MODEL: model }).plannerModel, model);
        assert.equal(supportsSinglePassVideoPlanning(model), true);
    }
    assert.throws(() => configuredVideoPlannerVariant({ VIDEO_PLANNER_MODEL: 'gpt-6-typo' }), /Unsupported/);
});

test('the served review page contains valid executable JavaScript', () => {
    assert.doesNotThrow(() => new Script(REVIEW_PAGE.match(/<script>([\s\S]*?)<\/script>/)[1]));
});

test('usage separates cache writes, bills reasoning once, and refuses unknown pricing', () => {
    const usage = openAIVideoUsage({ usage: { input_tokens: 1000, output_tokens: 200,
        input_tokens_details: { cached_tokens: 300, cache_write_tokens: 400 },
        output_tokens_details: { reasoning_tokens: 150 } } });
    assert.equal(usage.inputTokens, 300);
    assert.equal(usage.outputTokens, 200);
    assert.equal(usage.cacheWriteTokens, 400);
    assert.throws(() => videoUsageCost({ provider: 'openai', model: 'unknown' }), /Unknown video usage price/);
    assert.ok(videoUsageCost({ model: 'gemini-3.1-flash-lite-image', inputTokens: 500, outputTokens: 300, images: 0 }) > 0);
    assert.equal(videoUsageCost({ model: 'gemini-3.8-flash', inputTokens: 1000, pricingDate: '2027-01-01' }),
        2 * videoUsageCost({ model: 'gemini-3.8-flash', inputTokens: 1000, pricingDate: '2026-09-07' }));
});

test('budget reserves before a provider call, counts retries and holds unknown timeout bills across restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-ledger-'));
    const request = { stage: 'single_pass', attempt: 1, provider: 'openai', model: 'gpt-5.6-sol',
        maxInputTokens: 1000, maxOutputTokens: 1000 };
    let ledger;
    try {
        ledger = await VideoExperimentLedger.open(dir, { budgetUsd: 0.05 });
        const hooks = ledger.hooks('case');
        await hooks.beforeRequest(request);
        await hooks.onUsage({ ...request, inputTokens: 1000, outputTokens: 1000 });
        await hooks.beforeRequest({ ...request, attempt: 2 });
        await assert.rejects(hooks.beforeRequest(request), /Spend cap/);
        assert.equal(ledgerTotals(ledger.state).unresolved, 1);
        await ledger.close(); ledger = null;
        ledger = await VideoExperimentLedger.open(dir, { budgetUsd: 0.05 });
        assert.equal(ledgerTotals(ledger.state).unresolved, 1);
        await assert.rejects(ledger.hooks('next').beforeRequest(request), /Spend cap/);
    } finally { if (ledger) await ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('checkpoint identity changes with image bytes and code; a second process cannot own the ledger', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-ledger-'));
    let ledger;
    try {
        const asset = join(dir, 'frame.bin');
        await writeFile(asset, Buffer.from([0xff]));
        const before = await executionFingerprint([asset]);
        await writeFile(asset, Buffer.from([0xfe]));
        assert.notEqual(await executionFingerprint([asset]), before);
        ledger = await VideoExperimentLedger.open(dir);
        await assert.rejects(VideoExperimentLedger.open(dir), /live process/);
        let count = 0;
        await ledger.checkpoint({ code: before }, async () => ++count);
        const reused = await ledger.checkpoint({ code: before }, async () => ++count);
        assert.equal(reused.reused, true);
        assert.equal(count, 1);
        assert.equal(JSON.parse(await readFile(join(dir, 'ledger.json'))).schema_version, 1);
    } finally { if (ledger) await ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('malformed paid model output retains usage before the caller parses it', async () => {
    const oldFetch = globalThis.fetch;
    const events = [];
    try {
        globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'completed',
            model: 'gpt-6-astra', output_text: '{broken', usage: { input_tokens: 100, output_tokens: 10 } }) });
        const result = await requestPlannerResponse({ model: 'gpt-6-astra', max_output_tokens: 100,
            input: 'test' }, new AbortController().signal, 'test', { onUsage: value => events.push(value) });
        assert.throws(() => JSON.parse(result.output_text));
        assert.equal(events.length, 1);
        assert.equal(events[0].outputTokens, 10);
        assert.equal(events[0].rawUsage.input_tokens, 100);
    } finally { globalThis.fetch = oldFetch; }
});

test('judges see screenplay content with model and latency metadata removed', () => {
    assert.deepEqual(blindedPlan({ intent: 'A duck becomes mayor', planner_metrics: { single_pass_seconds: 17 },
        _planner_model: 'gpt-6-astra', segments: [{ title: 'Election', _private: true }] }),
    { intent: 'A duck becomes mayor', segments: [{ title: 'Election' }] });
    assert.equal(bootstrapMeanInterval([1]), null);
    assert.deepEqual(bootstrapMeanInterval([0, 0, 0]), [0, 0]);
});

test('holdout selection needs both judges, complete billing, repeats and quality evidence', () => {
    const corpus = Array.from({ length: 20 }, (_, i) => ({ id: `case-${i}`, split: 'holdout', command: 'minimax' }));
    const calls = [];
    for (const [i, testCase] of corpus.entries()) for (const repeat of i < 4 ? [0, 1] : [0]) {
        for (const candidate of ['sol-low', 'flash-low']) calls.push({ kind: 'planner', command: 'minimax', split: 'holdout',
            case_id: testCase.id, candidate, repeat, ok: true, accounting_complete: true,
            cost_usd: candidate === 'sol-low' ? 1 : 0.5, duration_seconds: 10 });
        for (const judge of ['gpt-5.6-sol', 'gemini-3.8-flash']) calls.push({ kind: 'judge', case_id: testCase.id,
            candidate: 'flash-low', judge, repeat, ok: true, accounting_complete: true,
            value: { control: { overall: 8, adherence: 8 }, candidate: { overall: 8, adherence: 8, material_failures: [] } } });
    }
    const result = values => summarizeOptimization(values, corpus, 'holdout').find(row => row.candidate === 'flash-low');
    assert.equal(result(calls).qualifies, true);
    assert.equal(result(calls.filter(call => call.repeat === 0)).qualifies, false);
    const incomplete = structuredClone(calls); incomplete[1].accounting_complete = false;
    assert.equal(result(incomplete).qualifies, false);
    const oneJudge = calls.filter(call => call.judge !== 'gemini-3.8-flash');
    assert.equal(result(oneJudge).qualifies, false);
    const failure = structuredClone(calls); failure.find(call => call.kind === 'judge').value.candidate.material_failures.push('Missing the requested character');
    assert.equal(result(failure).qualifies, false);
});

test('FastH3 comparison fixes duration and refuses mismatched contracts', () => {
    const args = rendererArguments(['gpuq', 'prompt'], { renderer_profile: 'fasth3-fixed-duration', seed: 1, aspect: '1:1' }, 'contract.json');
    assert.ok(args.includes('--fast'));
    assert.ok(args.includes('--no-fast-duration-aware'));
    assert.ok(!args.includes('--resume'));
    const base = { seed: 1, prompt: 'Test', command: 'oalgo', contract_path: 'same.json' };
    const manifest = { renders: [{ ...base, id: 'a', renderer_profile: 'h3-base' }, { ...base, id: 'b', renderer_profile: 'fasth3-fixed-duration' }],
        pairs: [{ id: 'ab', command: 'oalgo', control: 'a', candidate: 'b', component: 'renderer' }] };
    validateRenderManifest(manifest);
    manifest.pairs[0].command = 'minimax';
    assert.throws(() => validateRenderManifest(manifest), /paired prompt\/seed\/command/);
    manifest.pairs[0].command = 'oalgo';
    manifest.renders[1].contract_path = 'different.json';
    assert.throws(() => validateRenderManifest(manifest), /identical contract/);
});

test('render evidence binds policy and frozen input bytes before human labels can be reused', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'video-render-evidence-'));
    const digest = value => createHash('sha256').update(value).digest('hex');
    try {
        const generator = join(directory, 'video_gen.py'), plan = join(directory, 'plan.json'), contract = join(directory, 'contract.json');
        await writeFile(generator, 'generator'); await writeFile(plan, 'plan');
        await writeFile(contract, JSON.stringify({ inputs: { generator_sha256: digest('generator'), plan_sha256: digest('plan'),
            image_sha256: null, segment_image_sha256: {}, template_sha256: {} } }));
        const spec = { id: 'test', plan_path: plan, contract_path: contract, cloud_policy: { reviewer: 'sol-low' } };
        const original = await renderInputFingerprint(spec, generator);
        const changed = await renderInputFingerprint({ ...spec, cloud_policy: { reviewer: 'flash-low' } }, generator);
        assert.notEqual(original.fingerprint, changed.fingerprint);
        await writeFile(plan, 'revised plan');
        await assert.rejects(renderInputFingerprint(spec, generator), /Changed frozen inputs/);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unlabeled frames never become human ground truth', () => {
    const evidence = reviewerEvidence([], { cases: Array.from({ length: 24 }, (_, i) => ({ case_id: String(i), human_acceptable: null })) });
    assert.ok(evidence.every(row => !row.human_labels_complete && row.false_accepts === null && !row.accounting_complete));
});

test('canaries stay off without evidence and require distinct reviewed deliveries to expand', () => {
    const release = { schema_version: 1, experiment_id: 'measured-v1', commands: { oalgo: {
        percentage: 10, planner: { model: 'gemini-3.8-flash', effort: 'low' },
        evidence: { decision: 'qualified', report_sha256: 'a'.repeat(64), accounting_complete: true,
            human_video_review_complete: true, planner_holdout_passed: true }, delivery_reviews: [],
    } } };
    const selected = Array.from({ length: 1000 }, (_, i) => selectVideoOptimization(release, 'oalgo', String(i)));
    assert.ok(selected.filter(Boolean).length > 60 && selected.filter(Boolean).length < 140);
    assert.deepEqual(selected, Array.from({ length: 1000 }, (_, i) => selectVideoOptimization(release, 'oalgo', String(i))));
    const arm = release.commands.oalgo;
    arm.percentage = 50;
    assert.equal(selectVideoOptimization(release, 'oalgo', '0'), null);
    arm.delivery_reviews = Array.from({ length: 30 }, (_, i) => ({ job_id: String(i), review_complete: true, delivered: true, material_failure: false }));
    arm.percentage = 100;
    assert.equal(selectVideoOptimization(release, 'oalgo', '0').options.plannerModel, 'gemini-3.8-flash');
    arm.delivery_reviews[0].material_failure = true;
    assert.equal(selectVideoOptimization(release, 'oalgo', '0'), null);
    arm.delivery_reviews[0].material_failure = false;
    arm.evidence.human_video_review_complete = false;
    assert.equal(selectVideoOptimization(release, 'oalgo', '0'), null);
});

test('duration directives are enforced as timing while visible counts and quotes remain binding', () => {
    const prompt = 'A duck waves. Make it 12 seconds.';
    assert.equal(requestedVideoDurationSeconds(prompt), 12);
    assert.equal(requestedVideoDurationSeconds('A sign reads "Make it 12 seconds".'), null);
    assert.deepEqual(videoPromptContentNumbers('Show 12 ducks. Make it 12 seconds.'), ['12']);
    const plan = { intent: 'A duck waves.', continuity_bible: 'The same duck remains visible.',
        keyframe: { recommended: true, reason: 'Show the duck.', prompt: 'A duck.', motion_contract: {
            subject_orientation: 'Faces camera', gaze_direction: 'At camera', travel_direction: 'Still',
            camera_relation: 'Medium shot', first_second_action: 'Waves' } },
        segments: [{ title: 'Wave', transition: 'start', target_seconds: 12, output_seconds: 12, music: 'N/A', shots: [{
            duration_seconds: 12, visual: 'A duck waves.', camera: 'Static medium shot', audio: 'Quiet room tone', dialogue: [] }] }] };
    assert.doesNotThrow(() => validateFrontierVideoPlanForKeyframe(plan, 'minimax', prompt));
    assert.throws(() => validateFrontierVideoPlanForKeyframe(plan, 'minimax', 'Show 12 ducks. Make it 12 seconds.'), /omitted explicit numbers/);
    assert.throws(() => validateFrontierVideoPlanForKeyframe(plan, 'minimax', 'A sign reads "12". Make it 12 seconds.'), /quoted wording/);
    plan.segments[0].output_seconds = 10;
    assert.throws(() => validateFrontierVideoPlanForKeyframe(plan, 'minimax', prompt), /duration contract/);
});

test('renderer wins require completed human ratings and equal output duration', () => {
    const manifest = { pairs: [0, 1].map(i => ({ id: `pair-${i}`, command: 'oalgo', component: 'renderer', control: `a${i}`, candidate: `b${i}` })) };
    const state = { renders: Object.fromEntries([0, 1].flatMap(i => [
        [`a${i}`, { service_seconds: 100, generation_manifest: { validation: { duration_seconds: 8 } } }],
        [`b${i}`, { service_seconds: 50, generation_manifest: { validation: { duration_seconds: 8 } } }],
    ])) };
    const packet = { pairs: manifest.pairs.map(pair => ({ pair_id: pair.id, overall: { A: 8, B: 8 }, material_failure: { A: false, B: false }, preferred: 'tie' })) };
    const key = { pairs: manifest.pairs.map(pair => ({ pair_id: pair.id, labels: { A: 'control', B: 'candidate' } })) };
    const assess = () => assessVideoComponent(manifest, state, packet, key, 'oalgo', 'renderer');
    assert.equal(assess().passed, true);
    packet.pairs[0].overall.B = null;
    assert.equal(assess().passed, false);
    packet.pairs[0].overall.B = 8;
    state.renders.b0.generation_manifest.validation.duration_seconds = 5;
    assert.equal(assess().passed, false);
});
