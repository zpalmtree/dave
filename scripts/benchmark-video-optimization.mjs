#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { config } from '../dist/Config.js';
import { OALGO_VIDEO_PLANNER_GUIDANCE } from '../dist/VideoGeneration.js';
import { createFrontierVideoPlan, requestPlannerResponse } from '../dist/VideoFrontierPlanner.js';
import { requestedVideoDurationSeconds } from '../dist/VideoProtocol.js';
import { VideoExperimentLedger, ledgerTotals, executionFingerprint, ExperimentBudgetError } from './video-experiment-ledger.mjs';
import { saveJsonAtomic, stableHash, stableShuffle } from './video-cost-ab-lib.mjs';
import { CONTROL, PLANNER_CANDIDATES, blindedPlan, summarizeOptimization, chooseScreenFinalists } from './video-optimization-analysis.mjs';
import { mapWithConcurrency } from './video-planner-benchmark-lib.mjs';

const argument = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const runDirectory = resolve(argument('run-dir', 'artifacts/video-optimization/2026-09-07'));
const corpusPath = resolve(argument('corpus', 'benchmarks/video-optimization-corpus.json'));
const phase = argument('phase', 'dry-run');
let screeningSelection = null;
const CAPS = { screen: 15, images: 25, holdout: 40, renders: 50, report: 50 };
const generationPaths = ['dist/VideoFrontierPlanner.js', 'dist/VideoProtocol.js', 'dist/VideoUsage.js', 'dist/VideoModelCapabilities.js',
    'dist/VideoGeneration.js',
    'scripts/video-experiment-ledger.mjs', 'scripts/video-planner-benchmark-lib.mjs', 'scripts/video-cost-ab-lib.mjs', 'package.json', corpusPath];
export const campaignFingerprint = async () => stableHash(JSON.stringify({
    files: await executionFingerprint(generationPaths), generate: callPlanner.toString(), candidates: PLANNER_CANDIDATES,
}), 64);
export const judgeFingerprint = () => stableHash(JSON.stringify({ judge: judgePair.toString(), blind: blindedPlan.toString(), schema: judgeSchema }), 64);
const ratingSchema = {
    type: 'object', additionalProperties: false,
    required: ['overall', 'adherence', 'feasibility', 'identity_dialogue', 'material_failures'],
    properties: {
        overall: { type: 'number', minimum: 0, maximum: 10 },
        adherence: { type: 'number', minimum: 0, maximum: 10 },
        feasibility: { type: 'number', minimum: 0, maximum: 10 },
        identity_dialogue: { type: 'number', minimum: 0, maximum: 10 },
        material_failures: { type: 'array', items: { type: 'string' } },
    },
};
const judgeSchema = { type: 'object', additionalProperties: false, required: ['A', 'B'], properties: { A: ratingSchema, B: ratingSchema } };

async function preflightModels() {
    const result = {};
    for (const model of [...new Set(Object.values(PLANNER_CANDIDATES).map(value => value.model))]) {
        try {
            if (model.startsWith('gemini-')) {
                const client = new GoogleGenAI({ apiKey: config.geminiApiKey, apiVersion: 'v1alpha' });
                const response = await client.models.get({ model });
                result[model] = { available: true, resolved: response.name, checked_at: new Date().toISOString() };
            } else {
                const response = await fetch(`https://api.openai.com/v1/models/${model}`, {
                    headers: { authorization: `Bearer ${config.openaiApiKey}` }, signal: AbortSignal.timeout(30_000),
                });
                const body = await response.json();
                result[model] = { available: response.ok, resolved: body.id, status: response.status, checked_at: new Date().toISOString() };
            }
        } catch (error) { result[model] = { available: false, error: error.name || 'model lookup failed' }; }
    }
    await saveJsonAtomic(resolve(runDirectory, 'model-availability.json'), result);
    return result;
}

async function callPlanner(ledger, testCase, candidate, fingerprint, repeat = 0) {
    const model = PLANNER_CANDIDATES[candidate];
    const bytes = testCase.source_image ? await readFile(resolve(testCase.source_image)) : null;
    return ledger.checkpoint({ kind: 'planner', command: testCase.command, split: testCase.split,
        case_id: testCase.id, candidate, configuration: model, repeat, fingerprint,
        source_hash: bytes ? stableHash(bytes, 64) : null,
    }, hooks => createFrontierVideoPlan(testCase.prompt, 'minimax', `experiment-${testCase.id}`,
        bytes ? { data: bytes, mimeType: 'image/png' } : undefined, {
            ...hooks, plannerModel: model.model, plannerStrategy: 'single-pass',
            analysisReasoningEffort: model.effort, screenplayReasoningEffort: model.effort,
            serviceTier: 'default', plannerGuidance: testCase.command === 'oalgo' ? OALGO_VIDEO_PLANNER_GUIDANCE : undefined,
            requestedDurationSeconds: requestedVideoDurationSeconds(testCase.prompt) ?? undefined,
        }));
}

async function judgePair(ledger, testCase, candidate, control, treatment, fingerprint, repeat = 0) {
    if (!control.ok || !treatment.ok || !control.accounting_complete || !treatment.accounting_complete) return;
    for (const [index, judge] of ['gpt-5.6-sol', 'gemini-3.8-flash'].entries()) {
        const reversed = (Number.parseInt(stableHash(`${testCase.id}:${repeat}`, 2), 16) + index) % 2;
        const labels = reversed ? { A: treatment.value, B: control.value } : { A: control.value, B: treatment.value };
        const input = { command: testCase.command, request: testCase.prompt,
            requested_duration_seconds: requestedVideoDurationSeconds(testCase.prompt),
            guidance: testCase.command === 'oalgo' ? OALGO_VIDEO_PLANNER_GUIDANCE : '',
            plans: Object.fromEntries(Object.entries(labels).map(([key, plan]) => [key, blindedPlan(plan)])) };
        await ledger.checkpoint({ kind: 'judge', command: testCase.command, split: testCase.split,
            case_id: testCase.id, candidate, judge, repeat, fingerprint, judge_fingerprint: judgeFingerprint(), input_hash: stableHash(JSON.stringify(input), 64),
        }, async hooks => {
            const response = await requestPlannerResponse({ model: judge, reasoning: { effort: 'medium' },
                instructions: 'Compare these blinded screenplays for a local MiniMax H3 video. Score concrete adherence, feasible timing, complete requested actions, exact quoted words and visible text, closed cast/count, identity, speech assignment, continuity and creative execution. A null requested_duration_seconds means automatic duration: the planner is required to choose a feasible runtime, and choosing a concrete duration is allowed. A numeric requested_duration_seconds is a binding finished-duration requirement. Do not invent extra duration or voice requirements beyond the request and supplied guidance. Penalize lost actions, unsupported dialogue, stacked impossible action, needless padding and destructive compression. Do not reward length or infer model identity. Character delivery must be planned but its audible quality cannot be proven from JSON. A material failure must identify a specific binding requirement from the request or guidance that the plan omits or contradicts; ordinary choices left to the planner are not failures. Scores are 0 to 10. Return exactly the schema.',
                input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(input) }] }],
                text: { format: { type: 'json_schema', name: 'paired_plan_ratings', strict: true, schema: judgeSchema } },
                max_output_tokens: 3000, store: false,
            }, AbortSignal.timeout(120_000), 'experiment_judge', { ...hooks, maxRequestAttempts: 1 });
            const text = response.output_text || response.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text;
            const ratings = JSON.parse(text);
            for (const label of ['A', 'B']) {
                if (!Array.isArray(ratings[label]?.material_failures)
                    || ['overall', 'adherence', 'feasibility', 'identity_dialogue'].some(field =>
                        typeof ratings[label]?.[field] !== 'number' || ratings[label][field] < 0 || ratings[label][field] > 10)) {
                    throw new Error('Invalid judge ratings.');
                }
            }
            return { control: ratings[reversed ? 'B' : 'A'], candidate: ratings[reversed ? 'A' : 'B'] };
        });
    }
}

export async function writeOptimizationReport(directory, state, corpus, fingerprint) {
    const calls = Object.values(state.calls).filter(call => call.fingerprint === fingerprint
        && (call.kind !== 'judge' || call.judge_fingerprint === judgeFingerprint()));
    const screen = screeningSelection?.screen || summarizeOptimization(calls, corpus, 'screen');
    const holdout = summarizeOptimization(calls, corpus, 'holdout');
    const finalists = chooseScreenFinalists(screen);
    const report = { schema_version: 1, created_at: new Date().toISOString(), fingerprint,
        corpus_sha256: stableHash(JSON.stringify(corpus), 64),
        screening_fingerprint: screeningSelection?.fingerprint || fingerprint,
        screening_contract_changed: Boolean(screeningSelection && screeningSelection.fingerprint !== fingerprint),
        budget_blocks: (state.budget_blocks || []).filter(value => value.fingerprint === fingerprint),
        accounting: ledgerTotals(state), budget_usd: state.budget_usd, screen, holdout, finalists,
        execution: { screening_case_concurrency: 1, holdout_case_concurrency: 2, maximum_concurrent_holdout_calls: 4 },
        production_changes: false, final_video_review: 'pending',
        conclusion: 'No automatic promotion. Model scores are screening evidence; human frame/video review and monitored canaries remain required.' };
    await saveJsonAtomic(resolve(directory, 'report.json'), report);
    const rows = [...screen.map(value => ({ ...value, split: 'screen' })), ...holdout.map(value => ({ ...value, split: 'holdout' }))];
    const lines = ['# MiniMax and OALGO optimization evidence', '',
        `Recorded charges: $${report.accounting.charged_usd.toFixed(4)}; unresolved reservations: $${report.accounting.reserved_usd.toFixed(4)}; API cap: $${state.budget_usd}.`, '',
        '| Command | Phase | Candidate | Valid / expected | Judged cases | Mean cost | p95 seconds | Quality delta | Material flags |',
        '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
        ...rows.map(row => `| ${row.command} | ${row.split} | ${row.candidate} | ${row.successful}/${row.expected} | ${row.judged_cases} | ${row.cost_usd?.toFixed(4) ?? 'n/a'} | ${row.p95_seconds?.toFixed(1) ?? 'n/a'} | ${row.overall_delta?.toFixed(2) ?? 'n/a'} | ${row.material_flags.length} |`),
        '', report.conclusion, '', 'Historical application spend is an estimate, not a reconciled bill. No monthly savings are inferred from missing measurements.', ''];
    await writeFile(resolve(directory, 'report.md'), lines.join('\n'));
    return report;
}

async function main() {
    let stopRequested = false;
    const stop = () => { stopRequested = true; console.log('Stop requested; saving active calls before exiting.'); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    const corpus = JSON.parse(await readFile(corpusPath, 'utf8')).cases;
    if (new Set(corpus.map(value => value.id)).size !== corpus.length) throw new Error('Duplicate corpus IDs.');
    await mkdir(runDirectory, { recursive: true });
    if (['holdout', 'report'].includes(phase)) {
        const selectionPath = argument('selection-report', resolve(runDirectory, 'screen-selection.json'));
        try {
            screeningSelection = JSON.parse(await readFile(selectionPath, 'utf8'));
            if (screeningSelection.corpus_sha256 !== stableHash(JSON.stringify(corpus), 64)
                || !Array.isArray(screeningSelection.screen)) throw new Error('Screening selection must match the current corpus.');
            if (argument('selection-report')) await saveJsonAtomic(resolve(runDirectory, 'screen-selection.json'), screeningSelection);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const fingerprint = await campaignFingerprint();
    if (phase === 'preflight') {
        console.log(JSON.stringify(await preflightModels(), null, 2));
        return;
    }
    if (phase === 'dry-run') {
        await saveJsonAtomic(resolve(runDirectory, 'campaign-manifest.json'), {
            schema_version: 1, fingerprint, corpus, candidates: PLANNER_CANDIDATES, cumulative_caps_usd: CAPS,
            budget_usd: 50, optimization_scope: 'cloud-only-standard-h3', renderer_profiles: ['h3-base'], maximum_video_pairs: 10,
            maximum_unique_videos: 14, human_labels_required: true, paid_calls: 0,
        });
        console.log(`Validated campaign manifest: ${runDirectory}`);
        return;
    }
    if (!['screen', 'holdout', 'report'].includes(phase)) throw new Error('Use --phase=dry-run|screen|holdout|report.');
    const ledger = await VideoExperimentLedger.open(runDirectory, { phaseCapUsd: CAPS[phase] });
    try {
        if (phase !== 'report') {
            const availability = await preflightModels();
            if (!availability['gpt-5.6-sol']?.available) throw new Error('Current control model is unavailable; no valid comparison is possible.');
            const existing = await writeOptimizationReport(runDirectory, ledger.state, corpus, fingerprint);
            const cases = corpus.filter(value => value.split === phase);
            // Fixed repeat set, declared before results. Do not treat repeats as independent prompts.
            const work = cases.map(testCase => ({ testCase, repeat: 0 }));
            if (phase === 'holdout') for (const command of ['minimax', 'oalgo']) {
                for (const testCase of cases.filter(value => value.command === command).slice(0, 4)) work.push({ testCase, repeat: 1 });
            }
            let reporting = Promise.resolve();
            await mapWithConcurrency(work, phase === 'holdout' ? 2 : 1, async ({ testCase, repeat }) => {
                if (stopRequested) return;
                const candidates = phase === 'screen' ? Object.keys(PLANNER_CANDIDATES)
                    : [CONTROL, existing.finalists[testCase.command]].filter(Boolean);
                if (phase === 'holdout' && candidates.length !== 2) return;
                const generated = new Map();
                await mapWithConcurrency(stableShuffle(candidates, testCase.id).filter(candidate =>
                    availability[PLANNER_CANDIDATES[candidate].model]?.available), 2, async candidate => {
                    const blocked = ledger.state.budget_blocks || [];
                    if (blocked.some(value => value.kind === 'planner' && value.case_id === testCase.id && value.candidate === candidate && value.repeat === repeat && value.fingerprint === fingerprint)) return;
                    try {
                        const result = await callPlanner(ledger, testCase, candidate, fingerprint, repeat);
                        generated.set(candidate, result);
                        console.log(`${testCase.id} ${candidate}: ${result.ok ? 'valid' : 'failed'}; $${ledgerTotals(ledger.state).charged_usd.toFixed(4)} total`);
                    } catch (error) {
                        if (!(error instanceof ExperimentBudgetError)) throw error;
                        ledger.state.budget_blocks = [...(ledger.state.budget_blocks || []), { kind: 'planner', case_id: testCase.id, candidate, repeat, fingerprint, reason: error.message }];
                        await ledger.save();
                        console.log(`${testCase.id} ${candidate}: not completed within the spend cap; continuing only calls that fit.`);
                    }
                });
                if (!stopRequested) await mapWithConcurrency([...generated].filter(([candidate]) => candidate !== CONTROL), 2,
                    async ([candidate, result]) => {
                        if (!stopRequested && generated.has(CONTROL)) {
                            try { await judgePair(ledger, testCase, candidate, generated.get(CONTROL), result, fingerprint, repeat); }
                            catch (error) {
                                if (!(error instanceof ExperimentBudgetError)) throw error;
                                ledger.state.budget_blocks = [...(ledger.state.budget_blocks || []), { kind: 'judge', case_id: testCase.id, candidate, repeat, fingerprint, reason: error.message }];
                                await ledger.save();
                            }
                        }
                    });
                // Reports share an atomic-save path; serialize their writes while
                // independent prompt pairs overlap. The ledger serializes billing.
                reporting = reporting.then(() => writeOptimizationReport(runDirectory, ledger.state, corpus, fingerprint));
                await reporting;
            });
        }
    } catch (error) {
        ledger.state.status = error instanceof ExperimentBudgetError ? 'budget_exhausted' : 'incomplete';
        ledger.state.stop_reason = String(error.message).slice(0, 1000);
        await ledger.save();
        throw error;
    } finally {
        await writeOptimizationReport(runDirectory, ledger.state, corpus, fingerprint);
        await ledger.close();
    }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
