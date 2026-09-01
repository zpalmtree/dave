import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
    configuredVideoOpenAIServiceTier,
    requestedOpenAIServiceTier,
    resolvedOpenAIServiceTier,
    videoUsageCost,
} from '../dist/VideoUsage.js';
import {
    buildGpuqRenderArguments,
    buildPlannerHumanPacket,
    buildReviewerHumanPacket,
    callKey,
    checkpointedCall,
    finalVideoGate,
    loadOrCreateRun,
    plannerGate,
    plannerHumanAdjudications,
    replayQueue,
    reviewerGate,
    saveJsonAtomic,
    stableShuffle,
} from '../scripts/video-cost-ab-lib.mjs';
import {
    applyPlannerRatings,
    applyReviewerRatings,
    reviewProgress,
    reviewerImagePath,
    sanitizePlannerPacket,
    sanitizeReviewerPacket,
} from '../scripts/video-cost-ab-review.mjs';
import {
    applyFinalVideoRatings,
    finalVideoPath,
    finalVideoProgress,
    sanitizeFinalVideoPacket,
} from '../scripts/video-cost-ab-final-review.mjs';
import { selectRenderPairs } from '../scripts/prepare-video-cost-ab-renders.mjs';

test('prices GPT-5.6 family cache and service tiers at current rates', () => {
    const usage = {
        stage: 'test', attempt: 1, outcome: 'success', provider: 'openai',
        model: 'gpt-5.6-sol', inputTokens: 1_000_000, outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000,
    };
    assert.equal(videoUsageCost({ ...usage, serviceTier: 'default' }), 29.4);
    assert.equal(videoUsageCost({ ...usage, serviceTier: 'priority' }), 58.8);
    assert.equal(videoUsageCost({ ...usage, serviceTier: 'flex' }), 14.7);
    assert.equal(videoUsageCost({ ...usage, model: 'gpt-5.6-terra' }), 16.7);
    assert.equal(videoUsageCost({ ...usage, model: 'gpt-5.6-luna' }), 1.67);
});

test('maps requested and resolved OpenAI service tiers without treating default as Fast', () => {
    assert.equal(configuredVideoOpenAIServiceTier({}), 'default');
    assert.equal(configuredVideoOpenAIServiceTier({ VIDEO_OPENAI_SERVICE_TIER: 'fast' }), 'fast');
    assert.equal(configuredVideoOpenAIServiceTier({ VIDEO_OPENAI_SERVICE_TIER: 'flex' }), 'flex');
    assert.equal(configuredVideoOpenAIServiceTier({ VIDEO_OPENAI_SERVICE_TIER: 'priority' }), 'default');
    assert.equal(requestedOpenAIServiceTier('default'), undefined);
    assert.equal(requestedOpenAIServiceTier('fast'), 'priority');
    assert.equal(requestedOpenAIServiceTier('flex'), 'flex');
    assert.equal(resolvedOpenAIServiceTier({}, 'default'), 'default');
    assert.equal(resolvedOpenAIServiceTier({}, 'fast'), 'priority');
    assert.equal(resolvedOpenAIServiceTier({}, 'flex'), 'flex');
    assert.equal(resolvedOpenAIServiceTier({ service_tier: 'default' }, 'fast'), 'default');
});

test('stable blinding order is reproducible and seed-specific', () => {
    const values = ['control', 'terra', 'luna', 'sol-low'];
    assert.deepEqual(stableShuffle(values, 'one'), stableShuffle(values, 'one'));
    assert.notDeepEqual(stableShuffle(values, 'one'), stableShuffle(values, 'two'));
    assert.deepEqual([...stableShuffle(values, 'one')].sort(), [...values].sort());
});

test('checkpointed calls resume without rebilling and persist experiment reuse', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'video-cost-ab-'));
    const statePath = resolve(directory, 'state.json');
    try {
        const state = await loadOrCreateRun(statePath, { budgetUsd: 1 });
        let executions = 0;
        const key = callKey('planner', 'case', { model: 'gpt-5.6-sol' });
        const first = await checkpointedCall({
            state, statePath, key, reserveUsd: 0.1,
            metadata: { kind: 'planner', experiment: 'tier-planner', case_id: 'case' },
            execute: async () => {
                executions += 1;
                return { ok: true, usage: [], value: 42 };
            },
        });
        const second = await checkpointedCall({
            state, statePath, key, reserveUsd: 0.1,
            metadata: { kind: 'planner', experiment: 'planner-quality', case_id: 'case' },
            execute: async () => {
                executions += 1;
                return { ok: true, usage: [], value: 99 };
            },
        });
        assert.equal(first.value, 42);
        assert.equal(second.value, 42);
        assert.equal(second.reused, true);
        assert.equal(executions, 1);
        const stored = JSON.parse(await readFile(statePath, 'utf8'));
        assert.deepEqual(stored.calls[key].experiments, ['tier-planner', 'planner-quality']);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('reviewer gate enforces the agreed safety, cost, and latency thresholds', () => {
    const control = {
        mean_cost_usd: 0.1, false_reject_rate: 0.02, p95_seconds: 10,
    };
    const passing = {
        scored: 100, false_accepts: 0, agreement: 0.97, false_reject_rate: 0.05,
        rescue_rate: 0.01, mean_cost_usd: 0.06, p95_seconds: 14,
    };
    assert.equal(reviewerGate(passing, control).qualifies, true);
    assert.deepEqual(reviewerGate({ ...passing, false_accepts: 1 }, control).reasons, ['material_false_accept']);
});

function plannerCase(index, candidateOverall = 8.8, critical = []) {
    return {
        case_id: `case-${index}`,
        generated: [
            { candidate: 'control', ok: true, duration_seconds: 20, cost_usd: 0.1 },
            { candidate: 'candidate', ok: true, duration_seconds: 22, cost_usd: 0.06 },
        ],
        judgments: [{
            pair_candidate: 'candidate',
            winner_candidate: candidateOverall >= 9 ? 'candidate' : 'tie',
            ratings: [
                { candidate: 'control', prompt_fidelity: 9, continuity: 9, audio_dialogue: 9, overall: 9, critical_failures: [] },
                { candidate: 'candidate', prompt_fidelity: 8.8, continuity: 8.8, audio_dialogue: 8.8, overall: candidateOverall, critical_failures: critical },
            ],
        }],
    };
}

test('planner gate accepts a lower-cost noninferior 60-prompt finalist', () => {
    const gate = plannerGate(Array.from({ length: 60 }, (_value, index) => plannerCase(index)), 'candidate', 'control');
    assert.equal(gate.qualifies, true);
    assert.ok(gate.cost_reduction >= 0.39);
});

test('planner gate waits for required human adjudication and uses confirmed failures', () => {
    const cases = Array.from({ length: 60 }, (_value, index) => plannerCase(index));
    const adjudications = {
        one: { completed: false, candidates: ['control', 'candidate'], material_failures: [] },
    };
    assert.equal(plannerGate(cases, 'candidate', 'control', adjudications).qualifies, true);
    assert.ok(plannerGate(cases, 'candidate', 'control', adjudications, {
        requireHumanAdjudication: true,
    }).reasons.includes('pending_human_adjudication'));
    adjudications.one = { completed: true, candidates: ['control', 'candidate'], material_failures: ['candidate'] };
    assert.equal(plannerGate(cases, 'candidate', 'control', adjudications).pending_human_reviews, 0);
});

test('human packets include reviewer disagreements and uncertain planner pairs only', () => {
    const reviewer = buildReviewerHumanPacket([
        { case_id: 'one', arm: 'control', ok: true, actual: true, prompt: 'p', plan_path: 'p.json', image_path: 'i.png' },
        { case_id: 'one', arm: 'candidate', ok: true, actual: false, prompt: 'p', plan_path: 'p.json', image_path: 'i.png' },
        { case_id: 'two', arm: 'control', ok: true, actual: true, prompt: 'q', plan_path: 'q.json', image_path: 'j.png' },
        { case_id: 'two', arm: 'candidate', ok: true, actual: true, prompt: 'q', plan_path: 'q.json', image_path: 'j.png' },
    ], 'seed', 0);
    assert.deepEqual(reviewer.cases.map(value => value.case_id), ['one']);

    const cases = [plannerCase(1, 8.8, ['missed text'])];
    cases[0].prompt = 'prompt';
    const planner = buildPlannerHumanPacket(cases, 'control');
    assert.equal(planner.packet.cases.length, 1);
    assert.equal(planner.key.cases.length, 1);
    assert.equal('candidate' in planner.packet.cases[0], false);
});

test('queue replay reports GPU delays and median end-to-end change', () => {
    const replay = replayQueue([
        { review_count: 2, preparation_ready_at: 10, gpu_start_at: 30, end_to_end_seconds: 500 },
        { review_count: 1, preparation_ready_at: 10, gpu_start_at: 12, end_to_end_seconds: 600 },
    ], { planner_p95_delta_seconds: 5, review_p95_delta_seconds: 2 });
    assert.equal(replay.jobs, 2);
    assert.equal(replay.gpu_delay_rate, 0.5);
    assert.ok(replay.median_end_to_end_increase > 0);
});

test('final render commands are GPUq admitted, Gaming-Mode safe, and never use FastH3', () => {
    const args = buildGpuqRenderArguments({
        pythonPath: 'python.exe', generatorPath: 'video_gen.py', prompt: 'A duck.',
        planPath: 'plan.json', imagePath: 'frame.png', seed: 123, benchmarkLabel: 'cost-ab',
    });
    assert.deepEqual(args.slice(0, 9), [
        'run', '--profile', 'video-h3-isolated', '--priority', 'normal',
        '--when-gaming', 'hold', '--on-preempt', 'fail',
    ]);
    assert.equal(args.includes('--fast'), false);
    assert.ok(args.includes('--evict-cache-before-run'));
    assert.ok(args.includes('--stop-server'));
    assert.ok(args.includes('--frontier-plan'));
    assert.ok(args.includes('--image'));
});

test('final video gate passes six strong pairs, expands ambiguity, and rejects a candidate failure', () => {
    const packet = { pairs: Array.from({ length: 10 }, (_value, index) => ({
        pair_id: `p${index}`,
        preferred: index < 7 ? 'B' : 'A',
        overall: { A: 8.5, B: 8.4 },
        material_failure: { A: false, B: false },
    })) };
    const key = { pairs: packet.pairs.map(value => ({ pair_id: value.pair_id, labels: { A: 'control', B: 'candidate' } })) };
    assert.equal(finalVideoGate(packet, key).qualifies, true);
    assert.equal(finalVideoGate({ pairs: packet.pairs.slice(0, 6) }, { pairs: key.pairs.slice(0, 6) }).qualifies, true);
    const ambiguous = { pairs: packet.pairs.slice(0, 6).map((pair, index) => ({
        ...pair,
        preferred: index < 4 ? 'B' : 'A',
    })) };
    assert.equal(finalVideoGate(ambiguous, { pairs: key.pairs.slice(0, 6) }).decision, 'expand');
    packet.pairs[0].material_failure.B = true;
    assert.ok(finalVideoGate(packet, key).reasons.includes('candidate_material_failure'));
});

test('render selector chooses six successful category-stratified pairs deterministically', () => {
    const categories = ['exact_text', 'dialogue_and_count', 'multi_scene_transition', 'narrative_continuity', 'seamless_loop', 'audio_and_silence'];
    const calls = {};
    const corpus = categories.map((category, index) => ({ category, prompt: `prompt ${index}` }));
    for (const [index, entry] of corpus.entries()) {
        const caseId = `case-${index}`;
        for (const arm of ['sol-medium-standard', 'sol-low-standard']) {
            calls[`${caseId}:${arm}`] = {
                kind: 'planner', experiment: 'planner-quality', case_id: caseId,
                arm, ok: true, prompt: entry.prompt, plan: { intent: `${arm}-${index}` },
            };
        }
    }
    const selected = selectRenderPairs({ calls }, corpus, 6);
    assert.deepEqual(new Set(selected.map(value => value.category)), new Set(categories));
    assert.deepEqual(selectRenderPairs({ calls }, corpus, 6).map(value => value.case_id), selected.map(value => value.case_id));
});

test('planner human labels remain blinded until joined with the separate key', () => {
    const adjudications = plannerHumanAdjudications({ cases: [{
        review_id: 'r', human_winner: 'A', material_failures: ['B'], review_complete: true,
    }] }, { cases: [{ review_id: 'r', labels: { A: 'candidate', B: 'control' } }] });
    assert.deepEqual(adjudications.r, {
        completed: true,
        winner: 'candidate',
        material_failures: ['control'],
        candidates: ['candidate', 'control'],
    });
});

test('atomic JSON writer emits parseable private state', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'video-cost-ab-json-'));
    const path = resolve(directory, 'nested', 'state.json');
    try {
        await saveJsonAtomic(path, { ok: true });
        assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { ok: true });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('review UI payloads retain blinding and omit internal identifiers, paths, and model votes', () => {
    const reviewerPacket = {
        schema_version: 1,
        blinded: true,
        cases: [{
            case_id: 'secret-case', prompt: 'A duck.', image_path: '/tmp/private-frame.png',
            plan_path: '/tmp/private-plan.json', options: [{ label: 'A', model: 'secret-model' }],
            human_acceptable: null, material_failure: null, notes: '',
        }],
    };
    const reviewer = sanitizeReviewerPacket(reviewerPacket);
    const serializedReviewer = JSON.stringify(reviewer);
    assert.equal(serializedReviewer.includes('secret-case'), false);
    assert.equal(serializedReviewer.includes('private-frame'), false);
    assert.equal(serializedReviewer.includes('secret-model'), false);
    assert.equal(reviewerImagePath(reviewerPacket, 'r-1'), '/tmp/private-frame.png');

    const plannerPacket = {
        schema_version: 1,
        blinded: true,
        cases: [{
            review_id: 'planner-case:secret-arm', prompt: 'A duck.',
            options: [{ label: 'A', plan: { intent: 'one' } }, { label: 'B', plan: { intent: 'two' } }],
            human_winner: null, material_failures: [], review_complete: false, notes: '',
        }],
    };
    const planner = sanitizePlannerPacket(plannerPacket);
    assert.equal(JSON.stringify(planner).includes('secret-arm'), false);
    assert.deepEqual(planner.cases[0].options.map(option => option.label), ['A', 'B']);
});

test('review UI updates only valid human fields and requires complete decisions', () => {
    const reviewerPacket = {
        schema_version: 1,
        blinded: true,
        cases: [{
            case_id: 'one', prompt: 'p', image_path: '/tmp/i.png', options: [],
            human_acceptable: null, material_failure: null, notes: '', protected: 'keep',
        }],
    };
    const publicReviewer = sanitizeReviewerPacket(reviewerPacket);
    const ratedReviewer = applyReviewerRatings(reviewerPacket, {
        fingerprint: publicReviewer.fingerprint,
        cases: [{ public_id: 'r-1', human_acceptable: false, material_failure: true, notes: 'broken' }],
    });
    assert.deepEqual(reviewProgress(ratedReviewer, 'reviewer'), { complete: 1, total: 1 });
    assert.equal(ratedReviewer.cases[0].protected, 'keep');
    assert.throws(() => applyReviewerRatings(reviewerPacket, {
        fingerprint: publicReviewer.fingerprint,
        cases: [{ public_id: 'r-1', human_acceptable: true, material_failure: null, notes: '' }],
    }), /both decisions/);

    const plannerPacket = {
        schema_version: 1,
        blinded: true,
        cases: [{
            review_id: 'one:arm', prompt: 'p',
            options: [{ label: 'A', plan: {} }, { label: 'B', plan: {} }],
            human_winner: null, material_failures: [], review_complete: false, notes: '', protected: 'keep',
        }],
    };
    const publicPlanner = sanitizePlannerPacket(plannerPacket);
    const ratedPlanner = applyPlannerRatings(plannerPacket, {
        fingerprint: publicPlanner.fingerprint,
        cases: [{ public_id: 'p-1', human_winner: 'tie', material_failures: ['B'], review_complete: true, notes: '' }],
    });
    assert.deepEqual(reviewProgress(ratedPlanner, 'planner'), { complete: 1, total: 1 });
    assert.equal(ratedPlanner.cases[0].protected, 'keep');
    assert.throws(() => applyPlannerRatings(plannerPacket, {
        fingerprint: publicPlanner.fingerprint,
        cases: [{ public_id: 'p-1', human_winner: null, material_failures: [], review_complete: true, notes: '' }],
    }), /needs a winner/);
});

test('final-video UI stays blinded and validates the small review payload', () => {
    const packet = {
        schema_version: 1,
        blinded: true,
        pairs: [{
            pair_id: 'secret-pair', prompt: 'A duck.',
            videos: [
                { label: 'A', video_path: '/tmp/control.mp4' },
                { label: 'B', video_path: '/tmp/candidate.mp4' },
            ],
            preferred: null, overall: { A: null, B: null },
            material_failure: { A: false, B: false }, notes: '', protected: 'keep',
        }],
    };
    const publicPacket = sanitizeFinalVideoPacket(packet);
    assert.deepEqual(publicPacket.pairs[0].overall, { A: null, B: null });
    assert.equal(JSON.stringify(publicPacket).includes('secret-pair'), false);
    assert.equal(JSON.stringify(publicPacket).includes('candidate.mp4'), false);
    assert.equal(finalVideoPath(packet, 'v-1', 'B'), '/tmp/candidate.mp4');
    const rated = applyFinalVideoRatings(packet, {
        fingerprint: publicPacket.fingerprint,
        pairs: [{
            public_id: 'v-1', preferred: 'tie', overall: { A: 8.5, B: 8.5 },
            material_failure: { A: false, B: false }, notes: 'close',
        }],
    });
    assert.deepEqual(finalVideoProgress(rated), { complete: 1, total: 1 });
    assert.equal(rated.pairs[0].protected, 'keep');
    assert.throws(() => applyFinalVideoRatings(packet, {
        fingerprint: publicPacket.fingerprint,
        pairs: [{
            public_id: 'v-1', preferred: 'A', overall: { A: 11, B: 8 },
            material_failure: { A: false, B: false }, notes: '',
        }],
    }), /1 to 10/);
});

test('final-video UI can save one rated pair while later pairs remain unanswered', () => {
    const pair = index => ({
        pair_id: `pair-${index}`,
        prompt: `Prompt ${index}`,
        videos: [
            { label: 'A', video_path: `/tmp/${index}-a.mp4` },
            { label: 'B', video_path: `/tmp/${index}-b.mp4` },
        ],
        preferred: null,
        overall: { A: null, B: null },
        material_failure: { A: false, B: false },
        notes: '',
    });
    const packet = { schema_version: 1, blinded: true, pairs: [pair(1), pair(2)] };
    const publicPacket = sanitizeFinalVideoPacket(packet);
    const saved = applyFinalVideoRatings(packet, {
        fingerprint: publicPacket.fingerprint,
        pairs: [
            {
                ...publicPacket.pairs[0],
                preferred: 'B',
                overall: { A: 5, B: 7 },
            },
            publicPacket.pairs[1],
        ],
    });
    assert.deepEqual(saved.pairs[0].overall, { A: 5, B: 7 });
    assert.deepEqual(saved.pairs[1].overall, { A: null, B: null });
    assert.deepEqual(finalVideoProgress(saved), { complete: 1, total: 2 });
});
