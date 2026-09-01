#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { config } from '../dist/Config.js';
import {
    VIDEO_PLANNER_MODEL,
    createFrontierVideoPlan,
} from '../dist/VideoFrontierPlanner.js';
import {
    buildVideoKeyframeReviewPrompt,
    reviewVideoKeyframe,
} from '../dist/VideoKeyframeProvider.js';
import {
    BenchmarkBudgetExceededError,
    buildPlannerHumanPacket,
    buildReviewerHumanKey,
    buildReviewerHumanPacket,
    callKey,
    checkpointedCall,
    eventCost,
    finalVideoGate,
    groupCalls,
    loadOrCreateRun,
    mean,
    normalizeOpenAIUsage,
    percentile,
    plannerGate,
    plannerHumanAdjudications,
    plannerSummary,
    replayQueue,
    reviewerGate,
    reviewerHumanLabels,
    reviewerSummary,
    runSpend,
    saveJsonAtomic,
    stableHash,
    stableShuffle,
    summarizeTierCalls,
} from './video-cost-ab-lib.mjs';

const DEFAULT_PROMPTS = [
    'A duck becomes mayor.',
    'Make something fun about Monday morning.',
    'Exactly three arcade racers speed toward a neon finish line while one says "Not today!"',
    'A tiny knight tries to return an overdue library book during a dragon attack.',
    'A luxury perfume commercial for a bottle that smells like fresh-cut grass.',
    'Two rival chefs discover they are both cooking for the same very judgmental cat.',
    'A realistic wildlife documentary about office workers migrating to the break room.',
    'Show five dogs marching together, stopping in formation, and saluting one at a time.',
    'An astronaut finds a handwritten note on Mars that says "back in five minutes".',
    'A cozy stop-motion sequence about a sock escaping from a laundry basket.',
    'A tense black-and-white detective scene where the only witness is a goldfish.',
    'A cheerful local-news segment about a pothole that residents have turned into a tiny beach.',
];

const TIER_PLANNER_ARMS = {
    'sol-medium-fast': plannerArm('gpt-5.6-sol', 'medium', 'fast'),
    'sol-medium-standard': plannerArm('gpt-5.6-sol', 'medium', 'default'),
    'sol-medium-flex': plannerArm('gpt-5.6-sol', 'medium', 'flex'),
};

const PLANNER_ARMS = {
    'sol-medium-standard': plannerArm('gpt-5.6-sol', 'medium', 'default'),
    'sol-low-standard': plannerArm('gpt-5.6-sol', 'low', 'default'),
    'terra-high-standard': plannerArm('gpt-5.6-terra', 'high', 'default'),
    'terra-medium-standard': plannerArm('gpt-5.6-terra', 'medium', 'default'),
    'luna-medium-standard': plannerArm('gpt-5.6-luna', 'medium', 'default'),
};

const TIER_REVIEWER_ARMS = {
    'sol-high-fast': reviewerArm('gpt-5.6-sol', 'high', 'high', 4000, 'fast'),
    'sol-high-standard': reviewerArm('gpt-5.6-sol', 'high', 'high', 4000, 'default'),
};

const REVIEWER_ARMS = {
    'sol-high-standard': reviewerArm('gpt-5.6-sol', 'high', 'high', 4000, 'default'),
    'sol-low-standard': reviewerArm('gpt-5.6-sol', 'low', 'high', 2000, 'default'),
    'terra-high-standard': reviewerArm('gpt-5.6-terra', 'high', 'high', 2000, 'default'),
    'terra-medium-standard': reviewerArm('gpt-5.6-terra', 'medium', 'high', 2000, 'default'),
    'luna-medium-standard': reviewerArm('gpt-5.6-luna', 'medium', 'high', 2000, 'default'),
};

function plannerArm(model, effort, serviceTier) {
    return {
        model,
        effort,
        serviceTier,
        strategy: 'single-pass',
    };
}

function reviewerArm(model, effort, imageDetail, maxOutputTokens, serviceTier) {
    return { model, effort, imageDetail, maxOutputTokens, serviceTier };
}

function argument(name, fallback) {
    const prefix = `--${name}=`;
    const value = process.argv.find(candidate => candidate.startsWith(prefix));
    return value ? value.slice(prefix.length) : fallback;
}

function integerArgument(name, fallback, maximum = Number.POSITIVE_INFINITY) {
    const value = Number(argument(name, fallback));
    return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function parseOptions() {
    const phase = argument('phase', 'dry-run');
    const supported = new Set(['dry-run', 'tier', 'reviewer', 'planner', 'packets', 'render-packet', 'report', 'all']);
    if (!supported.has(phase)) throw new Error(`Unknown phase ${phase}. Expected ${[...supported].join(', ')}.`);
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const runDirectory = resolve(argument('run-dir', `artifacts/video-cost-ab/${stamp}`));
    return {
        phase,
        dryRun: phase === 'dry-run' || process.argv.includes('--dry-run'),
        runDirectory,
        statePath: resolve(runDirectory, 'state.json'),
        promptsPath: argument('prompts'),
        reviewerReportPath: argument('reviewer-report'),
        reviewerHumanPath: argument('reviewer-human', resolve(runDirectory, 'human-review/reviewer.json')),
        renderManifestPath: argument('render-manifest'),
        queueHistoryPath: argument('queue-history'),
        candidates: argument('candidates')?.split(',').map(value => value.trim()).filter(Boolean),
        limit: integerArgument('limit', undefined, 100),
        judgeRuns: integerArgument('judge-runs', 2, 2),
        budgetUsd: Math.max(0.01, Number(argument('budget-usd', '35')) || 35),
    };
}

function configuredSecret(value) {
    const normalized = String(value || '').trim();
    return Boolean(normalized && !/enter |replace|example|your[_ -]?key/i.test(normalized));
}

function requireOpenAIKey() {
    if (!configuredSecret(config.openaiApiKey)) {
        throw new Error('No configured OpenAI API key. Populate the ignored lib/Config.ts or provide the project configuration before paid phases.');
    }
}

function responseOutputText(response) {
    if (typeof response?.output_text === 'string' && response.output_text.trim()) return response.output_text.trim();
    for (const item of response?.output || []) {
        for (const content of item?.content || []) {
            if (content?.type === 'output_text' && typeof content.text === 'string') return content.text.trim();
        }
    }
    throw new Error(response?.error?.message || `OpenAI response was ${response?.status || 'missing output'}.`);
}

async function loadPrompts(path, limit) {
    const source = path ? JSON.parse(await readFile(resolve(path), 'utf8')) : DEFAULT_PROMPTS;
    const values = Array.isArray(source) ? source : Array.isArray(source?.cases) ? source.cases : [];
    const prompts = values.map(value => typeof value === 'string' ? value : value?.prompt)
        .filter(value => typeof value === 'string' && value.trim())
        .map(value => value.trim());
    if (!prompts.length) throw new Error('Planner corpus must contain strings or objects with a prompt field.');
    return prompts.slice(0, limit || prompts.length).map(prompt => ({
        case_id: `planner-${stableHash(prompt)}`,
        prompt,
    }));
}

function inferredPlanPath(reportPath, testCase, candidate, caseIndex) {
    if (testCase.plan_path) return resolve(dirname(reportPath), testCase.plan_path);
    const imagePath = resolve(dirname(reportPath), candidate.image_path);
    return resolve(imagePath, '..', '..', `case-${caseIndex + 1}-plan.json`);
}

async function loadReviewerCases(reportPath, limit) {
    if (!reportPath) return [];
    const resolvedReport = resolve(reportPath);
    const report = JSON.parse(await readFile(resolvedReport, 'utf8'));
    const cases = (report.cases || []).flatMap((testCase, caseIndex) => {
        const generated = new Map((testCase.generated || []).map(candidate => [candidate.candidate, candidate]));
        return (testCase?.judgment?.ratings || []).flatMap(rating => {
            const candidate = generated.get(rating.candidate);
            if (!candidate?.ok || !candidate?.image_path || typeof rating.acceptable !== 'boolean') return [];
            const imagePath = resolve(dirname(resolvedReport), candidate.image_path);
            return [{
                case_id: `review-${stableHash(`${caseIndex}:${rating.candidate}:${testCase.prompt}`)}`,
                prompt: testCase.prompt,
                plan_path: inferredPlanPath(resolvedReport, testCase, candidate, caseIndex),
                image_path: imagePath,
                mime_type: candidate.mime_type || (imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg'),
                expected: rating.acceptable,
            }];
        });
    });
    return cases.slice(0, limit || cases.length);
}

function selectedArms(catalog, requested) {
    const ids = requested?.length ? requested : Object.keys(catalog);
    const unknown = ids.filter(id => !catalog[id]);
    if (unknown.length) throw new Error(`Unknown candidates for this phase: ${unknown.join(', ')}.`);
    return ids.map(id => ({ id, configuration: catalog[id] }));
}

async function executePlanner(testCase, configuration) {
    const usage = [];
    const attempts = [];
    const started = performance.now();
    try {
        const plan = await createFrontierVideoPlan(
            testCase.prompt,
            'minimax',
            `cost-ab-${testCase.case_id}`,
            undefined,
            {
                plannerModel: configuration.model,
                plannerStrategy: configuration.strategy,
                analysisReasoningEffort: configuration.effort,
                screenplayReasoningEffort: configuration.effort,
                serviceTier: configuration.serviceTier,
                onUsage: event => usage.push(event),
                onAttempt: event => attempts.push(event),
            },
        );
        return { ok: true, plan, usage, attempts, duration_seconds: (performance.now() - started) / 1000 };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            usage,
            attempts,
            duration_seconds: (performance.now() - started) / 1000,
        };
    }
}

function rescueableReviewFailure(error) {
    return /max[_ ]output|token|incomplete|no result|no output|invalid structured|json/i.test(
        error instanceof Error ? error.message : String(error),
    );
}

async function executeReviewer(testCase, configuration, allowRescue) {
    const [planText, imageBytes] = await Promise.all([
        readFile(testCase.plan_path, 'utf8'),
        readFile(testCase.image_path),
    ]);
    const plan = JSON.parse(planText);
    const image = {
        bytes: imageBytes,
        mimeType: testCase.mime_type,
        provider: 'corpus',
        model: 'retained-candidate',
    };
    const usage = [];
    const attempts = [];
    const started = performance.now();
    const run = candidate => reviewVideoKeyframe(plan, image, [], {
        serviceTier: candidate.serviceTier,
        reviewModel: candidate.model,
        reviewReasoningEffort: candidate.effort,
        reviewImageDetail: candidate.imageDetail,
        reviewMaxOutputTokens: candidate.maxOutputTokens,
        onUsage: event => usage.push(event),
        onAttempt: event => attempts.push(event),
    });
    try {
        const review = await run(configuration);
        return {
            ok: true,
            actual: review.acceptable,
            issues: review.issues,
            correction_prompt: review.correction_prompt,
            rescued: false,
            usage,
            attempts,
            duration_seconds: (performance.now() - started) / 1000,
        };
    } catch (error) {
        if (allowRescue && rescueableReviewFailure(error)) {
            const review = await run(REVIEWER_ARMS['sol-high-standard']);
            return {
                ok: true,
                actual: review.acceptable,
                issues: review.issues,
                correction_prompt: review.correction_prompt,
                rescued: true,
                rescue_reason: error instanceof Error ? error.message : String(error),
                usage,
                attempts,
                duration_seconds: (performance.now() - started) / 1000,
            };
        }
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            usage,
            attempts,
            duration_seconds: (performance.now() - started) / 1000,
        };
    }
}

const PLANNER_JUDGE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['ratings', 'winner', 'explanation'],
    properties: {
        ratings: {
            type: 'array', minItems: 2, maxItems: 2,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['label', 'prompt_fidelity', 'continuity', 'audio_dialogue', 'overall', 'critical_failures'],
                properties: {
                    label: { type: 'string', enum: ['A', 'B'] },
                    prompt_fidelity: { type: 'number', minimum: 1, maximum: 10 },
                    continuity: { type: 'number', minimum: 1, maximum: 10 },
                    audio_dialogue: { type: 'number', minimum: 1, maximum: 10 },
                    overall: { type: 'number', minimum: 1, maximum: 10 },
                    critical_failures: { type: 'array', maxItems: 8, items: { type: 'string' } },
                },
            },
        },
        winner: { type: 'string', enum: ['A', 'B', 'tie'] },
        explanation: { type: 'string' },
    },
};

async function judgePlannerPair(testCase, control, candidate, runIndex) {
    const ordered = runIndex % 2 ? [candidate, control] : [control, candidate];
    const labels = ordered.map((value, index) => ({
        label: String.fromCharCode(65 + index),
        candidate: value.candidate || value.arm,
        plan: value.plan,
    }));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4 * 60 * 1000);
    let response;
    try {
        response = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            signal: controller.signal,
            headers: {
                authorization: `Bearer ${config.openaiApiKey}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
            model: VIDEO_PLANNER_MODEL,
            reasoning: { effort: 'high' },
            instructions: 'You are a blinded video-directing evaluator for MiniMax H3. Penalize missing literal constraints, impossible timing, broken continuity, wrong visible text, and dialogue that cannot fit or is assigned to the wrong visible speaker. Do not infer model identity from style.',
            input: [{
                role: 'user',
                content: [{
                    type: 'input_text',
                    text: [
                        `USER REQUEST:\n${testCase.prompt}`,
                        ...labels.map(value => `CANDIDATE ${value.label}:\n${JSON.stringify(value.plan)}`),
                    ].join('\n\n'),
                }],
            }],
            text: {
                verbosity: 'low',
                format: { type: 'json_schema', name: 'video_cost_ab_plan_pair', strict: true, schema: PLANNER_JUDGE_SCHEMA },
            },
            max_output_tokens: 4000,
            prompt_cache_key: 'video-cost-ab-planner-judge-v1',
            store: false,
            }),
        });
    } finally {
        clearTimeout(timeout);
    }
    const body = await response.json();
    const usage = [normalizeOpenAIUsage(body, { stage: 'planner_judge', model: VIDEO_PLANNER_MODEL })];
    if (!response.ok) return { ok: false, error: body?.error?.message || `Judge returned HTTP ${response.status}.`, usage };
    const parsed = JSON.parse(responseOutputText(body));
    const judgment = {
        ...parsed,
        run: runIndex + 1,
        pair_candidate: candidate.candidate || candidate.arm,
        ratings: parsed.ratings.map(rating => ({
            ...rating,
            candidate: labels.find(value => value.label === rating.label)?.candidate,
        })),
        winner_candidate: labels.find(value => value.label === parsed.winner)?.candidate || parsed.winner,
    };
    return { ok: true, judgment, usage };
}

async function runPlannerCalls(options, state, statePath, catalog, kind, defaultLimit) {
    requireOpenAIKey();
    const prompts = await loadPrompts(options.promptsPath, options.limit || defaultLimit);
    const arms = selectedArms(catalog, options.candidates);
    for (const testCase of prompts) {
        for (const arm of stableShuffle(arms, `${kind}:${testCase.case_id}`)) {
            const key = callKey('planner', testCase.case_id, arm.configuration);
            process.stderr.write(`${kind} ${arm.id}: ${testCase.prompt}\n`);
            await checkpointedCall({
                state, statePath, key, reserveUsd: 0.75,
                metadata: {
                    kind: 'planner',
                    experiment: kind,
                    case_id: testCase.case_id,
                    prompt: testCase.prompt,
                    arm: arm.id,
                    configuration: arm.configuration,
                },
                execute: () => executePlanner(testCase, arm.configuration),
            });
        }
    }
}

async function runReviewerCalls(options, state, statePath, catalog, kind, defaultLimit) {
    requireOpenAIKey();
    if (!options.reviewerReportPath) throw new Error(`--reviewer-report=<report.json> is required for ${kind}.`);
    const cases = await loadReviewerCases(options.reviewerReportPath, options.limit || defaultLimit);
    if (!cases.length) throw new Error('The reviewer report contained no judged retained frames.');
    const arms = selectedArms(catalog, options.candidates);
    for (const testCase of cases) {
        for (const arm of stableShuffle(arms, `${kind}:${testCase.case_id}`)) {
            const key = callKey('reviewer', testCase.case_id, arm.configuration);
            process.stderr.write(`${kind} ${arm.id}: ${testCase.case_id}\n`);
            await checkpointedCall({
                state, statePath, key, reserveUsd: 0.25,
                metadata: {
                    kind: 'reviewer',
                    experiment: kind,
                    ...testCase,
                    arm: arm.id,
                    configuration: arm.configuration,
                },
                execute: () => executeReviewer(
                    testCase,
                    arm.configuration,
                    kind === 'reviewer-quality' && arm.id !== 'sol-high-standard',
                ),
            });
        }
    }
}

function plannerCases(state, experiment = 'planner-quality') {
    const generatedCalls = groupCalls(state, 'planner').filter(call => hasExperiment(call, experiment));
    const judgeCalls = groupCalls(state, 'planner-judge');
    const grouped = Map.groupBy(generatedCalls, call => call.case_id);
    return [...grouped.entries()].map(([caseId, calls]) => ({
        case_id: caseId,
        prompt: calls[0].prompt,
        generated: calls.map(call => ({
            candidate: call.arm,
            ok: call.ok,
            plan: call.plan,
            error: call.error,
            usage: call.usage,
            attempts: call.attempts,
            duration_seconds: call.duration_seconds,
            cost_usd: call.cost_usd,
        })),
        judgments: judgeCalls.filter(call => call.case_id === caseId && call.ok)
            .map(call => attributedPlannerJudgment(call, 'sol-medium-standard')),
    }));
}

function hasExperiment(call, experiment) {
    return (call.experiments || [call.experiment]).includes(experiment);
}

function attributedPlannerJudgment(call, controlCandidate) {
    const judgment = call.judgment || {};
    const pairCandidate = judgment.pair_candidate || call.pair_candidate || call.configuration?.candidate;
    const run = Number(judgment.run || call.configuration?.run || 1);
    const ordered = run % 2 === 0
        ? [pairCandidate, controlCandidate]
        : [controlCandidate, pairCandidate];
    const labels = { A: ordered[0], B: ordered[1] };
    return {
        ...judgment,
        pair_candidate: pairCandidate,
        ratings: (judgment.ratings || []).map(rating => ({
            ...rating,
            candidate: rating.candidate || labels[rating.label],
        })),
        winner_candidate: judgment.winner_candidate && !['A', 'B'].includes(judgment.winner_candidate)
            ? judgment.winner_candidate
            : labels[judgment.winner] || judgment.winner,
    };
}

async function runPlannerJudges(options, state, statePath) {
    const cases = plannerCases(state);
    for (const testCase of cases) {
        const control = testCase.generated.find(value => value.candidate === 'sol-medium-standard' && value.ok);
        if (!control) continue;
        for (const candidate of testCase.generated.filter(value => value.ok && value.candidate !== control.candidate)) {
            for (let run = 0; run < options.judgeRuns; run += 1) {
                const configuration = { control: control.candidate, candidate: candidate.candidate, run: run + 1 };
                const key = callKey('planner-judge', testCase.case_id, configuration, run + 1);
                await checkpointedCall({
                    state, statePath, key, reserveUsd: 0.5,
                    metadata: {
                        kind: 'planner-judge',
                        experiment: 'planner-quality',
                        case_id: testCase.case_id,
                        prompt: testCase.prompt,
                        arm: 'sol-high-blinded-judge',
                        pair_candidate: candidate.candidate,
                        configuration,
                    },
                    execute: () => judgePlannerPair(testCase, control, candidate, run),
                });
            }
        }
    }
}

async function writeHumanPackets(options, state) {
    const directory = resolve(options.runDirectory, 'human-review');
    const reviewerCalls = groupCalls(state, 'reviewer').filter(call => hasExperiment(call, 'reviewer-quality'));
    const reviewerPacket = await preserveHumanFields(
        resolve(directory, 'reviewer.json'),
        buildReviewerHumanPacket(reviewerCalls),
        'case_id',
        ['human_acceptable', 'material_failure', 'notes'],
    );
    const reviewerKey = buildReviewerHumanKey(reviewerPacket, reviewerCalls);
    await saveJsonAtomic(resolve(directory, 'reviewer.json'), reviewerPacket);
    await saveJsonAtomic(resolve(directory, 'reviewer-key.json'), reviewerKey);

    const cases = plannerCases(state);
    const planner = buildPlannerHumanPacket(cases, 'sol-medium-standard');
    planner.packet = await preserveHumanFields(
        resolve(directory, 'planner.json'),
        planner.packet,
        'review_id',
        ['human_winner', 'material_failures', 'review_complete', 'notes'],
    );
    await saveJsonAtomic(resolve(directory, 'planner.json'), planner.packet);
    await saveJsonAtomic(resolve(directory, 'planner-key.json'), planner.key);
    return { reviewer: reviewerPacket.cases.length, planner: planner.packet.cases.length };
}

async function optionalJson(path) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

async function preserveHumanFields(path, packet, idField, fields) {
    const previous = await optionalJson(path);
    const byId = new Map((previous?.cases || previous?.pairs || []).map(value => [value[idField], value]));
    const collection = packet.cases || packet.pairs || [];
    for (const entry of collection) {
        const stored = byId.get(entry[idField]);
        if (!stored) continue;
        for (const field of fields) {
            if (stored[field] !== undefined) entry[field] = stored[field];
        }
    }
    return packet;
}

async function writeRenderPacket(options) {
    const pairs = options.renderManifestPath
        ? JSON.parse(await readFile(resolve(options.renderManifestPath), 'utf8'))
        : Array.from({ length: 10 }, (_value, index) => ({ pair_id: `pair-${index + 1}`, prompt: '', control_video: '', candidate_video: '' }));
    if (!Array.isArray(pairs) || pairs.length < 1 || pairs.length > 10) {
        throw new Error('The progressive render manifest must contain between 1 and 10 completed pairs.');
    }
    const packet = { schema_version: 1, blinded: true, pairs: [] };
    const key = { schema_version: 1, pairs: [] };
    for (const pair of pairs) {
        const ordered = stableShuffle([
            { variant: 'control', video_path: pair.control_video },
            { variant: 'candidate', video_path: pair.candidate_video },
        ], `render:${pair.pair_id}`);
        packet.pairs.push({
            pair_id: pair.pair_id,
            prompt: pair.prompt,
            videos: ordered.map((value, index) => ({ label: String.fromCharCode(65 + index), video_path: value.video_path })),
            preferred: null,
            prompt_fidelity: { A: null, B: null },
            continuity: { A: null, B: null },
            dialogue_text: { A: null, B: null },
            artifacts: { A: null, B: null },
            overall: { A: null, B: null },
            material_failure: { A: false, B: false },
            notes: '',
        });
        key.pairs.push({
            pair_id: pair.pair_id,
            labels: Object.fromEntries(ordered.map((value, index) => [String.fromCharCode(65 + index), value.variant])),
        });
    }
    const packetPath = resolve(options.runDirectory, 'human-review/final-videos.json');
    const preservedPacket = await preserveHumanFields(
        packetPath,
        packet,
        'pair_id',
        ['preferred', 'prompt_fidelity', 'continuity', 'dialogue_text', 'artifacts', 'overall', 'material_failure', 'notes'],
    );
    await saveJsonAtomic(packetPath, preservedPacket);
    await saveJsonAtomic(resolve(options.runDirectory, 'human-review/final-videos-key.json'), key);
}

function formatMoney(value) {
    return value === null || value === undefined ? 'n/a' : `$${Number(value).toFixed(4)}`;
}

function formatSeconds(value) {
    return value === null || value === undefined ? 'n/a' : `${Number(value).toFixed(2)}s`;
}

function standardCounterfactualRatio(calls) {
    const selected = calls.filter(call => call.ok && call.cost_usd > 0);
    const actual = selected.reduce((sum, call) => sum + call.cost_usd, 0);
    const standard = selected.reduce((sum, call) => sum + (call.usage || []).reduce(
        (eventSum, event) => eventSum + eventCost({ ...event, serviceTier: 'default' }),
        0,
    ), 0);
    return actual > 0 ? standard / actual : 0.5;
}

function modelCostRatio(summary, control) {
    return summary?.mean_cost_usd >= 0 && control?.mean_cost_usd > 0
        ? summary.mean_cost_usd / control.mean_cost_usd
        : 1;
}

async function buildReport(options, state) {
    const humanPacket = await optionalJson(resolve(options.reviewerHumanPath));
    const humanLabels = reviewerHumanLabels(humanPacket);
    const tierPlanner = summarizeTierCalls(groupCalls(state, 'planner').filter(call => hasExperiment(call, 'tier-planner')));
    const tierReviewer = summarizeTierCalls(groupCalls(state, 'reviewer').filter(call => hasExperiment(call, 'tier-reviewer')));
    const reviewerCalls = groupCalls(state, 'reviewer').filter(call => hasExperiment(call, 'reviewer-quality'));
    const reviewerArms = [...new Set(reviewerCalls.map(call => call.arm))];
    const reviewerSummaries = reviewerArms.map(arm => reviewerSummary(reviewerCalls, arm, humanLabels));
    const reviewerControl = reviewerSummaries.find(value => value.arm === 'sol-high-standard');
    const reviewerGates = reviewerSummaries.filter(value => value.arm !== 'sol-high-standard')
        .map(summary => ({ arm: summary.arm, ...reviewerGate(summary, reviewerControl) }));
    const cases = plannerCases(state);
    const plannerHumanPacket = await optionalJson(resolve(options.runDirectory, 'human-review/planner.json'));
    const plannerHumanKey = await optionalJson(resolve(options.runDirectory, 'human-review/planner-key.json'));
    const generatedPlannerHuman = buildPlannerHumanPacket(cases, 'sol-medium-standard');
    const plannerAdjudications = plannerHumanAdjudications(
        plannerHumanPacket || generatedPlannerHuman.packet,
        plannerHumanKey || generatedPlannerHuman.key,
    );
    const plannerArms = [...new Set(cases.flatMap(testCase => testCase.generated.map(value => value.candidate)))];
    const plannerSummaries = plannerArms.map(arm => plannerSummary(cases, arm));
    const plannerGates = plannerArms.filter(arm => arm !== 'sol-medium-standard')
        .map(arm => ({ arm, ...plannerGate(cases, arm, 'sol-medium-standard', plannerAdjudications) }));

    const finalVideoPacket = await optionalJson(resolve(options.runDirectory, 'human-review/final-videos.json'));
    const finalVideoKey = await optionalJson(resolve(options.runDirectory, 'human-review/final-videos-key.json'));
    const finalGate = finalVideoGate(finalVideoPacket, finalVideoKey);

    const standardPlanner = tierPlanner.find(value => value.arm === 'sol-medium-standard');
    const fastPlanner = tierPlanner.find(value => value.arm === 'sol-medium-fast');
    const standardReviewer = tierReviewer.find(value => value.arm === 'sol-high-standard');
    const fastReviewer = tierReviewer.find(value => value.arm === 'sol-high-fast');
    const latency = {
        planner_p95_delta_seconds: standardPlanner?.p95_seconds !== null && fastPlanner?.p95_seconds !== null
            ? standardPlanner.p95_seconds - fastPlanner.p95_seconds : null,
        review_p95_delta_seconds: standardReviewer?.p95_seconds !== null && fastReviewer?.p95_seconds !== null
            ? standardReviewer.p95_seconds - fastReviewer.p95_seconds : null,
    };
    let queueReplay = null;
    if (options.queueHistoryPath) {
        queueReplay = replayQueue(JSON.parse(await readFile(resolve(options.queueHistoryPath), 'utf8')), latency);
    }

    const qualifiedReviewer = reviewerGates.filter(value => value.qualifies)
        .sort((a, b) => reviewerSummaries.find(value => value.arm === a.arm).mean_cost_usd
            - reviewerSummaries.find(value => value.arm === b.arm).mean_cost_usd)[0];
    const qualifiedPlanner = plannerGates.filter(value => value.qualifies)
        .sort((a, b) => a.summary.mean_cost_usd - b.summary.mean_cost_usd)[0];
    const selectedReviewerSummary = reviewerSummaries.find(value => value.arm === qualifiedReviewer?.arm) || reviewerControl;
    const selectedPlannerSummary = plannerSummaries.find(value => value.candidate === qualifiedPlanner?.arm);
    const planningTierRatio = standardCounterfactualRatio(
        groupCalls(state, 'planner').filter(call => call.experiment === 'tier-planner' && call.arm === 'sol-medium-fast'),
    );
    const reviewerTierRatio = standardCounterfactualRatio(
        groupCalls(state, 'reviewer').filter(call => call.experiment === 'tier-reviewer' && call.arm === 'sol-high-fast'),
    );
    const monthlyBaseline = { planning: 31, reviewer: 19.13, image_fallback: 7.10 };
    const monthlyProjection = {
        baseline_usd: Object.values(monthlyBaseline).reduce((sum, value) => sum + value, 0),
        planning_usd: monthlyBaseline.planning * planningTierRatio
            * modelCostRatio(selectedPlannerSummary, plannerSummaries.find(value => value.candidate === 'sol-medium-standard')),
        reviewer_usd: monthlyBaseline.reviewer * reviewerTierRatio
            * modelCostRatio(selectedReviewerSummary, reviewerControl),
        image_fallback_usd: monthlyBaseline.image_fallback,
        source: 'Observed non-translation MiniMax 30-day stage mix as of 2026-08-31; model ratios use this local benchmark.',
    };
    monthlyProjection.projected_usd = monthlyProjection.planning_usd
        + monthlyProjection.reviewer_usd + monthlyProjection.image_fallback_usd;
    monthlyProjection.savings_fraction = 1 - monthlyProjection.projected_usd / monthlyProjection.baseline_usd;
    const recommendation = {
        service_tier: 'default',
        fast_removed: true,
        reviewer: qualifiedReviewer?.arm || 'sol-high-standard',
        planner: qualifiedPlanner?.arm || 'sol-medium-standard',
        ready_for_final_video_gate: Boolean(reviewerControl && qualifiedPlanner),
        final_video_gate_passed: finalGate.qualifies,
        deploy_authorized: false,
        note: reviewerControl && qualifiedPlanner && finalGate.qualifies
            ? 'All local gates pass. A separate user decision and production-change plan are still required.'
            : reviewerControl && qualifiedPlanner
                ? 'Run the initial 12-video blinded gate; add up to 8 videos only if the first six pairs are ambiguous.'
            : 'Evidence gates are incomplete or failed; do not deploy model changes. Removing Fast remains the only unconditional recommendation.',
    };
    const report = {
        schema_version: 1,
        created_at: new Date().toISOString(),
        run_directory: options.runDirectory,
        dry_run: state.dry_run,
        benchmark_spend_usd: runSpend(state),
        budget_usd: state.budget_usd,
        tier: { planner: tierPlanner, reviewer: tierReviewer, latency, queue_replay: queueReplay },
        reviewer: { summaries: reviewerSummaries, gates: reviewerGates, human_labels_completed: Object.keys(humanLabels).length },
        planner: { summaries: plannerSummaries, gates: plannerGates },
        final_video_gate: finalGate,
        monthly_projection: monthlyProjection,
        recommendation,
    };
    await saveJsonAtomic(resolve(options.runDirectory, 'report.json'), report);

    const lines = [
        '# MiniMax cost/quality local A/B report',
        '',
        `- Generated: ${report.created_at}`,
        `- Dry run: ${report.dry_run ? 'yes' : 'no'}`,
        `- ${report.dry_run ? 'Simulated benchmark spend' : 'Paid API spend recorded'}: ${formatMoney(report.benchmark_spend_usd)} / ${formatMoney(report.budget_usd)}`,
        '- Production deployment: not authorized by this benchmark',
        '',
        '## Tier latency',
        '',
        '| Stage | Arm | Samples | Errors | Mean | p95 | Cost |',
        '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
        ...tierPlanner.map(value => `| Planner | ${value.arm} | ${value.samples} | ${value.errors} | ${formatSeconds(value.mean_seconds)} | ${formatSeconds(value.p95_seconds)} | ${formatMoney(value.total_cost_usd)} |`),
        ...tierReviewer.map(value => `| Reviewer | ${value.arm} | ${value.samples} | ${value.errors} | ${formatSeconds(value.mean_seconds)} | ${formatSeconds(value.p95_seconds)} | ${formatMoney(value.total_cost_usd)} |`),
        '',
        '## Reviewer quality',
        '',
        '| Arm | Samples | Agreement | False accepts | Rescue rate | Mean cost | Gate |',
        '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
        ...reviewerSummaries.map(value => {
            const gate = reviewerGates.find(candidate => candidate.arm === value.arm);
            return `| ${value.arm} | ${value.samples} | ${value.agreement === null ? 'n/a' : `${(100 * value.agreement).toFixed(1)}%`} | ${value.false_accepts} | ${value.rescue_rate === null ? 'n/a' : `${(100 * value.rescue_rate).toFixed(1)}%`} | ${formatMoney(value.mean_cost_usd)} | ${gate ? gate.qualifies ? 'pass' : gate.reasons.join(', ') : 'control'} |`;
        }),
        '',
        '## Planner quality',
        '',
        '| Arm | Samples | Success | Overall | Critical failures | Mean cost | Gate |',
        '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
        ...plannerSummaries.map(value => {
            const gate = plannerGates.find(candidate => candidate.arm === value.candidate);
            return `| ${value.candidate} | ${value.samples} | ${value.success_rate === null ? 'n/a' : `${(100 * value.success_rate).toFixed(1)}%`} | ${value.overall === null ? 'n/a' : value.overall.toFixed(2)} | ${value.critical_failures} | ${formatMoney(value.mean_cost_usd)} | ${gate ? gate.qualifies ? 'pass' : gate.reasons.join(', ') : 'control'} |`;
        }),
        '',
        '## Recommendation',
        '',
        `Use ${recommendation.service_tier}; Fast is excluded. Planner: ${recommendation.planner}. Reviewer: ${recommendation.reviewer}.`,
        '',
        `Projected non-translation MiniMax spend: ${formatMoney(monthlyProjection.projected_usd)} per 30 days versus ${formatMoney(monthlyProjection.baseline_usd)} (${(100 * monthlyProjection.savings_fraction).toFixed(1)}% lower).`,
        '',
        `Adaptive final-video gate: ${finalGate.qualifies ? 'pass' : finalGate.reasons.join(', ')}.`,
        '',
        recommendation.note,
        '',
    ];
    await saveJsonAtomic(resolve(options.runDirectory, 'report-data.json'), report);
    const markdownPath = resolve(options.runDirectory, 'report.md');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(markdownPath, `${lines.join('\n')}\n`, { mode: 0o600 }));
    return report;
}

async function seedDryRun(options, state) {
    const prompts = (await loadPrompts(options.promptsPath, 6));
    const plannerArms = selectedArms({ ...TIER_PLANNER_ARMS, ...PLANNER_ARMS });
    for (const testCase of prompts) {
        for (const arm of plannerArms) {
            const config = arm.configuration;
            const key = callKey('planner', testCase.case_id, config);
            if (state.calls[key]) continue;
            const modelFactor = config.model.includes('luna') ? 0.15 : config.model.includes('terra') ? 0.6 : 1;
            const tierFactor = config.serviceTier === 'fast' ? 2 : config.serviceTier === 'flex' ? 0.5 : 1;
            const experiments = [
                ...(Object.hasOwn(TIER_PLANNER_ARMS, arm.id) ? ['tier-planner'] : []),
                ...(Object.hasOwn(PLANNER_ARMS, arm.id) ? ['planner-quality'] : []),
            ];
            state.calls[key] = {
                kind: 'planner',
                experiment: experiments[0],
                experiments,
                case_id: testCase.case_id,
                prompt: testCase.prompt,
                arm: arm.id,
                configuration: config,
                ok: true,
                plan: { intent: testCase.prompt, keyframe: {}, segments: [] },
                usage: [],
                attempts: [],
                duration_seconds: config.serviceTier === 'fast' ? 12 : config.serviceTier === 'flex' ? 45 : 22,
                cost_usd: 0.12 * modelFactor * tierFactor,
                completed_at: new Date().toISOString(),
            };
        }
    }
    const reviewerCases = Array.from({ length: 12 }, (_value, index) => ({
        case_id: `review-dry-${index + 1}`,
        prompt: `Dry reviewer case ${index + 1}`,
        plan_path: '/local/dry-run/plan.json',
        image_path: `/local/dry-run/frame-${index + 1}.png`,
        expected: index % 2 === 0,
    }));
    const reviewerArms = selectedArms({ ...TIER_REVIEWER_ARMS, ...REVIEWER_ARMS });
    for (const testCase of reviewerCases) {
        for (const arm of reviewerArms) {
            const key = callKey('reviewer', testCase.case_id, arm.configuration);
            if (state.calls[key]) continue;
            const wrong = arm.id === 'luna-medium-standard' && testCase.case_id.endsWith('2');
            const experiments = [
                ...(Object.hasOwn(TIER_REVIEWER_ARMS, arm.id) ? ['tier-reviewer'] : []),
                ...(Object.hasOwn(REVIEWER_ARMS, arm.id) ? ['reviewer-quality'] : []),
            ];
            state.calls[key] = {
                kind: 'reviewer',
                experiment: experiments[0],
                experiments,
                ...testCase,
                arm: arm.id,
                configuration: arm.configuration,
                ok: true,
                actual: wrong ? !testCase.expected : testCase.expected,
                issues: [],
                rescued: false,
                usage: [],
                attempts: [],
                duration_seconds: arm.configuration.serviceTier === 'fast' ? 6 : 9,
                cost_usd: arm.id.includes('luna') ? 0.001 : arm.id.includes('terra') ? 0.015 : 0.03,
                completed_at: new Date().toISOString(),
            };
        }
    }
    state.updated_at = new Date().toISOString();
    await saveJsonAtomic(options.statePath, state);
}

async function main() {
    const options = parseOptions();
    const state = await loadOrCreateRun(options.statePath, options);
    if (state.dry_run !== options.dryRun) {
        throw new Error('Cannot mix dry-run and paid records. Select a new --run-dir.');
    }
    try {
        if (options.dryRun) {
            await seedDryRun(options, state);
            await writeHumanPackets(options, state);
            await writeRenderPacket(options);
            const report = await buildReport(options, state);
            process.stdout.write(`Dry-run report: ${resolve(options.runDirectory, 'report.md')}\n`);
            process.stdout.write(`${JSON.stringify(report.recommendation, null, 2)}\n`);
            return;
        }
        if (options.phase === 'tier' || options.phase === 'all') {
            await runPlannerCalls(options, state, options.statePath, TIER_PLANNER_ARMS, 'tier-planner', 20);
            if (options.reviewerReportPath) {
                await runReviewerCalls(options, state, options.statePath, TIER_REVIEWER_ARMS, 'tier-reviewer', 30);
            }
        }
        if (options.phase === 'reviewer' || options.phase === 'all') {
            await runReviewerCalls(options, state, options.statePath, REVIEWER_ARMS, 'reviewer-quality', 30);
        }
        if (options.phase === 'planner' || options.phase === 'all') {
            await runPlannerCalls(options, state, options.statePath, PLANNER_ARMS, 'planner-quality', 30);
            await runPlannerJudges(options, state, options.statePath);
        }
        if (options.phase === 'packets' || options.phase === 'all') {
            const counts = await writeHumanPackets(options, state);
            process.stdout.write(`Human review packets: ${counts.reviewer} reviewer, ${counts.planner} planner cases.\n`);
        }
        if (options.phase === 'render-packet' || options.phase === 'all') await writeRenderPacket(options);
        if (options.phase === 'report' || options.phase === 'all') {
            const report = await buildReport(options, state);
            process.stdout.write(`Report: ${resolve(options.runDirectory, 'report.md')}\n`);
            process.stdout.write(`${JSON.stringify(report.recommendation, null, 2)}\n`);
        }
    } catch (error) {
        if (error instanceof BenchmarkBudgetExceededError) {
            state.status = 'budget_exhausted';
            state.updated_at = new Date().toISOString();
            await saveJsonAtomic(options.statePath, state);
            await writeHumanPackets(options, state);
            await buildReport(options, state);
        }
        throw error;
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
