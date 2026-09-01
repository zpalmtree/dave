#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { saveJsonAtomic, stableHash } from './video-cost-ab-lib.mjs';

const CONTROL = 'sol-medium-standard';
const CANDIDATE = 'sol-low-standard';
const CATEGORY_PRIORITY = [
    'exact_text',
    'dialogue_and_count',
    'multi_scene_transition',
    'narrative_continuity',
    'seamless_loop',
    'audio_and_silence',
    'visual_transformation',
];

function argument(name, fallback = null) {
    const prefix = `--${name}=`;
    const value = process.argv.find(candidate => candidate.startsWith(prefix));
    return value ? value.slice(prefix.length) : fallback;
}

function experimentIncludes(call, experiment) {
    return (call.experiments || [call.experiment]).includes(experiment);
}

function attributedJudgment(call) {
    const judgment = call.judgment || {};
    const run = Number(judgment.run || call.configuration?.run || 1);
    const pairCandidate = call.pair_candidate || call.configuration?.candidate;
    const ordered = run % 2 === 0 ? [pairCandidate, CONTROL] : [CONTROL, pairCandidate];
    const labels = { A: ordered[0], B: ordered[1] };
    return {
        winner: labels[judgment.winner] || judgment.winner_candidate,
        ratings: (judgment.ratings || []).map(rating => ({ ...rating, candidate: labels[rating.label] })),
    };
}

function risk(call, judgeCalls) {
    const judgments = judgeCalls.map(attributedJudgment);
    const ratings = judgments.flatMap(value => value.ratings);
    const criticalFailures = ratings.reduce((sum, rating) => sum + (rating.critical_failures || []).length, 0);
    const winners = new Set(judgments.map(value => value.winner));
    const gaps = judgments.flatMap(judgment => {
        const control = judgment.ratings.find(value => value.candidate === CONTROL);
        const candidate = judgment.ratings.find(value => value.candidate === CANDIDATE);
        return control && candidate ? [Math.abs(Number(candidate.overall) - Number(control.overall))] : [];
    });
    return {
        critical_failures: criticalFailures,
        judge_disagreement: winners.size > 1,
        closest_overall_gap: gaps.length ? Math.min(...gaps) : null,
        rank: criticalFailures * 100 + (winners.size > 1 ? 10 : 0) + (gaps.length ? 1 - Math.min(1, Math.min(...gaps)) : 0),
    };
}

export function selectRenderPairs(state, corpus, count = 6) {
    const categories = new Map(corpus.map(value => [value.prompt, value.category]));
    const plannerCalls = Object.values(state.calls || {}).filter(call => call.kind === 'planner'
        && experimentIncludes(call, 'planner-quality'));
    const judges = Object.values(state.calls || {}).filter(call => call.kind === 'planner-judge'
        && call.ok && call.configuration?.candidate === CANDIDATE);
    const byCase = Map.groupBy(plannerCalls, call => call.case_id);
    const eligible = [...byCase.entries()].flatMap(([caseId, calls]) => {
        const control = calls.find(call => call.arm === CONTROL && call.ok && call.plan);
        const candidate = calls.find(call => call.arm === CANDIDATE && call.ok && call.plan);
        if (!control || !candidate) return [];
        const caseJudges = judges.filter(call => call.case_id === caseId);
        const score = risk(candidate, caseJudges);
        return [{
            case_id: caseId,
            prompt: candidate.prompt,
            category: categories.get(candidate.prompt) || 'uncategorized',
            control_plan: control.plan,
            candidate_plan: candidate.plan,
            risk: score,
        }];
    });
    const ordered = eligible.sort((a, b) => b.risk.rank - a.risk.rank
        || stableHash(a.case_id).localeCompare(stableHash(b.case_id)));
    const selected = [];
    for (const category of CATEGORY_PRIORITY) {
        const entry = ordered.find(value => value.category === category && !selected.includes(value));
        if (entry) selected.push(entry);
        if (selected.length >= count) break;
    }
    for (const entry of ordered) {
        if (selected.length >= count) break;
        if (!selected.includes(entry)) selected.push(entry);
    }
    if (selected.length !== count) throw new Error(`Only ${selected.length} successful pairs were available; ${count} required.`);
    return selected;
}

async function main() {
    const statePath = resolve(argument('state'));
    const corpusPath = resolve(argument('corpus', 'benchmarks/video-cost-ab-planner-corpus.json'));
    const outputPath = resolve(argument('output', resolve(statePath, '..', 'render-inputs.json')));
    const count = Math.max(6, Math.min(10, Number(argument('count', '6')) || 6));
    const [state, corpus] = await Promise.all([
        readFile(statePath, 'utf8').then(JSON.parse),
        readFile(corpusPath, 'utf8').then(JSON.parse),
    ]);
    const selected = selectRenderPairs(state, corpus, count);
    const planDirectory = resolve(outputPath, '..', 'render-plans');
    const pairs = [];
    for (const [index, entry] of selected.entries()) {
        const pairId = `risk-${String(index + 1).padStart(2, '0')}-${entry.category.replaceAll('_', '-')}`;
        const controlPath = resolve(planDirectory, `${pairId}-control.json`);
        const candidatePath = resolve(planDirectory, `${pairId}-candidate.json`);
        await Promise.all([
            saveJsonAtomic(controlPath, entry.control_plan),
            saveJsonAtomic(candidatePath, entry.candidate_plan),
        ]);
        pairs.push({
            pair_id: pairId,
            source_case_id: entry.case_id,
            category: entry.category,
            selection_risk: entry.risk,
            prompt: entry.prompt,
            seed: Number.parseInt(stableHash(entry.case_id, 8), 16),
            control: { plan_path: controlPath },
            candidate: { plan_path: candidatePath },
        });
    }
    await saveJsonAtomic(outputPath, { schema_version: 1, adaptive_initial_pairs: count, pairs });
    process.stdout.write(`Prepared ${pairs.length} risk-stratified render pairs at ${outputPath}.\n`);
    for (const pair of pairs) process.stdout.write(`- ${pair.pair_id}: ${pair.category} (${pair.source_case_id})\n`);
}

if (process.argv[1]?.endsWith('prepare-video-cost-ab-renders.mjs')) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
