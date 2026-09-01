import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { videoUsageCost } from '../dist/VideoUsage.js';

export const COST_AB_SCHEMA_VERSION = 1;

export class BenchmarkBudgetExceededError extends Error {
    constructor(spend, budget, reserve) {
        super(`Benchmark budget exhausted: $${spend.toFixed(4)} spent with $${reserve.toFixed(4)} reserved against a $${budget.toFixed(2)} cap.`);
        this.name = 'BenchmarkBudgetExceededError';
        this.spend = spend;
        this.budget = budget;
        this.reserve = reserve;
    }
}

export function finite(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function mean(values) {
    const numbers = values
        .filter(value => value !== null && value !== undefined && value !== '')
        .map(Number).filter(Number.isFinite);
    return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

export function percentile(values, fraction) {
    const numbers = values
        .filter(value => value !== null && value !== undefined && value !== '')
        .map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!numbers.length) return null;
    const index = Math.max(0, Math.min(numbers.length - 1, Math.ceil(numbers.length * fraction) - 1));
    return numbers[index];
}

export function sampleStandardDeviation(values) {
    const numbers = values
        .filter(value => value !== null && value !== undefined && value !== '')
        .map(Number).filter(Number.isFinite);
    if (numbers.length < 2) return 0;
    const average = mean(numbers);
    return Math.sqrt(numbers.reduce((sum, value) => sum + (value - average) ** 2, 0) / (numbers.length - 1));
}

export function lowerConfidenceBound(values, z = 1.96) {
    const numbers = values
        .filter(value => value !== null && value !== undefined && value !== '')
        .map(Number).filter(Number.isFinite);
    if (!numbers.length) return null;
    return mean(numbers) - z * sampleStandardDeviation(numbers) / Math.sqrt(numbers.length);
}

export function stableHash(value, length = 16) {
    return createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function seededUnit(seed) {
    return Number.parseInt(stableHash(seed, 12), 16) / 0xffffffffffff;
}

export function stableShuffle(values, seed) {
    return values
        .map((value, index) => ({ value, key: seededUnit(`${seed}:${index}:${JSON.stringify(value)}`) }))
        .sort((a, b) => a.key - b.key)
        .map(entry => entry.value);
}

export function callKey(kind, caseId, configuration, run = 1) {
    return [kind, caseId, stableHash(JSON.stringify(configuration), 20), run].join(':');
}

export function normalizeOpenAIUsage(body, attributes = {}) {
    const usage = body?.usage || {};
    const details = usage.input_tokens_details || {};
    const cached = Math.max(0, finite(details.cached_tokens));
    const totalInput = Math.max(0, finite(usage.input_tokens));
    return {
        stage: attributes.stage || 'benchmark',
        attempt: attributes.attempt || 1,
        outcome: attributes.outcome || (body?.status === 'completed' ? 'success' : 'error'),
        provider: 'openai',
        model: String(body?.model || attributes.model || 'unknown'),
        serviceTier: String(body?.service_tier || attributes.serviceTier || 'default'),
        inputTokens: Math.max(0, totalInput - cached),
        outputTokens: Math.max(0, finite(usage.output_tokens)),
        cacheReadTokens: cached,
        cacheWriteTokens: Math.max(0, finite(details.cache_write_tokens)),
    };
}

export function eventCost(event) {
    return videoUsageCost(event);
}

export function totalUsageCost(events) {
    return (events || []).reduce((sum, event) => sum + eventCost(event), 0);
}

export function runSpend(state) {
    return Object.values(state?.calls || {}).reduce((sum, call) => sum + finite(call?.cost_usd), 0);
}

export async function saveJsonAtomic(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
}

export async function loadOrCreateRun(path, options = {}) {
    try {
        const state = JSON.parse(await readFile(path, 'utf8'));
        if (state.schema_version !== COST_AB_SCHEMA_VERSION || !state.calls) {
            throw new Error(`Unsupported benchmark state schema in ${path}.`);
        }
        return state;
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        const state = {
            schema_version: COST_AB_SCHEMA_VERSION,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            budget_usd: finite(options.budgetUsd, 35),
            dry_run: Boolean(options.dryRun),
            calls: {},
        };
        await saveJsonAtomic(path, state);
        return state;
    }
}

export async function checkpointedCall({
    state,
    statePath,
    key,
    metadata,
    reserveUsd,
    execute,
}) {
    if (state.calls[key]) {
        const existing = state.calls[key];
        if (metadata?.experiment && !(existing.experiments || [existing.experiment]).includes(metadata.experiment)) {
            existing.experiments = [...new Set([
                ...(existing.experiments || [existing.experiment]).filter(Boolean),
                metadata.experiment,
            ])];
            state.updated_at = new Date().toISOString();
            await saveJsonAtomic(statePath, state);
        }
        return { ...existing, reused: true };
    }
    const spend = runSpend(state);
    const reserve = Math.max(0, finite(reserveUsd));
    if (spend + reserve > finite(state.budget_usd, 35) + 1e-9) {
        throw new BenchmarkBudgetExceededError(spend, finite(state.budget_usd, 35), reserve);
    }
    const started = performance.now();
    let payload;
    try {
        payload = await execute();
    } catch (error) {
        payload = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            usage: error?.usage || [],
            attempts: error?.attempts || [],
        };
    }
    const record = {
        ...metadata,
        ...(metadata?.experiment ? { experiments: [metadata.experiment] } : {}),
        ...payload,
        duration_seconds: finite(payload?.duration_seconds, (performance.now() - started) / 1000),
        cost_usd: totalUsageCost(payload?.usage),
        completed_at: new Date().toISOString(),
    };
    state.calls[key] = record;
    state.updated_at = new Date().toISOString();
    await saveJsonAtomic(statePath, state);
    return record;
}

export function groupCalls(state, kind) {
    return Object.values(state?.calls || {}).filter(call => !kind || call.kind === kind);
}

export function summarizeTierCalls(calls) {
    const arms = [...new Set(calls.map(call => call.arm))];
    return arms.map(arm => {
        const selected = calls.filter(call => call.arm === arm);
        const successful = selected.filter(call => call.ok);
        return {
            arm,
            samples: selected.length,
            successful: successful.length,
            errors: selected.length - successful.length,
            error_rate: selected.length ? (selected.length - successful.length) / selected.length : null,
            mean_seconds: mean(successful.map(call => call.duration_seconds)),
            p50_seconds: percentile(successful.map(call => call.duration_seconds), 0.5),
            p95_seconds: percentile(successful.map(call => call.duration_seconds), 0.95),
            total_cost_usd: selected.reduce((sum, call) => sum + finite(call.cost_usd), 0),
            mean_cost_usd: mean(selected.map(call => call.cost_usd)),
        };
    });
}

export function reviewerSummary(calls, arm, humanLabels = {}) {
    const selected = calls.filter(call => call.arm === arm);
    const successful = selected.filter(call => call.ok && typeof call.actual === 'boolean');
    const scored = successful.map(call => ({
        ...call,
        gold: typeof humanLabels[call.case_id] === 'boolean'
            ? humanLabels[call.case_id]
            : call.expected,
    })).filter(call => typeof call.gold === 'boolean');
    const falseAccepts = scored.filter(call => !call.gold && call.actual).length;
    const falseRejects = scored.filter(call => call.gold && !call.actual).length;
    const accepts = scored.filter(call => call.gold).length;
    return {
        arm,
        samples: selected.length,
        successful: successful.length,
        errors: selected.length - successful.length,
        scored: scored.length,
        agreement: scored.length ? scored.filter(call => call.actual === call.gold).length / scored.length : null,
        false_accepts: falseAccepts,
        false_accept_rate: scored.filter(call => !call.gold).length
            ? falseAccepts / scored.filter(call => !call.gold).length : null,
        false_rejects: falseRejects,
        false_reject_rate: accepts ? falseRejects / accepts : 0,
        rescue_rate: selected.length ? selected.filter(call => call.rescued).length / selected.length : null,
        mean_seconds: mean(successful.map(call => call.duration_seconds)),
        p95_seconds: percentile(successful.map(call => call.duration_seconds), 0.95),
        total_cost_usd: selected.reduce((sum, call) => sum + finite(call.cost_usd), 0),
        mean_cost_usd: mean(selected.map(call => call.cost_usd)),
    };
}

export function reviewerGate(summary, control) {
    const costReduction = control?.mean_cost_usd > 0 && summary?.mean_cost_usd !== null
        ? 1 - summary.mean_cost_usd / control.mean_cost_usd : null;
    const falseRejectIncrease = summary?.false_reject_rate !== null && control?.false_reject_rate !== null
        ? summary.false_reject_rate - control.false_reject_rate : null;
    const reasons = [];
    if (summary.scored < 100) reasons.push('needs_100_scored_cases');
    if (summary.false_accepts !== 0) reasons.push('material_false_accept');
    if (!(summary.agreement >= 0.95)) reasons.push('agreement_below_95_percent');
    if (!(falseRejectIncrease !== null && falseRejectIncrease <= 0.05)) reasons.push('false_reject_increase_above_5_points');
    if (!(summary.rescue_rate !== null && summary.rescue_rate <= 0.02)) reasons.push('rescue_rate_above_2_percent');
    if (!(costReduction !== null && costReduction >= 0.30)) reasons.push('cost_reduction_below_30_percent');
    if (!(summary.p95_seconds !== null && control?.p95_seconds !== null
        && summary.p95_seconds <= control.p95_seconds + 5)) reasons.push('p95_latency_regression');
    return { qualifies: reasons.length === 0, reasons, cost_reduction: costReduction, false_reject_increase: falseRejectIncrease };
}

function averageRating(testCase, candidate, field) {
    const ratings = (testCase.judgments || []).flatMap(judgment => judgment?.ratings || [])
        .filter(rating => rating.candidate === candidate)
        .map(rating => finite(rating[field], Number.NaN))
        .filter(Number.isFinite);
    return mean(ratings);
}

export function plannerSummary(cases, candidate) {
    const generated = cases.map(testCase => ({
        testCase,
        result: (testCase.generated || []).find(value => value.candidate === candidate),
    })).filter(value => value.result);
    const successful = generated.filter(value => value.result.ok);
    const metric = field => mean(successful.map(({ testCase }) => averageRating(testCase, candidate, field)));
    const criticalFailures = successful.reduce((sum, { testCase }) => sum + (testCase.judgments || [])
        .flatMap(judgment => judgment?.ratings || [])
        .filter(rating => rating.candidate === candidate)
        .reduce((count, rating) => count + (rating.critical_failures || []).length, 0), 0);
    return {
        candidate,
        samples: generated.length,
        successful: successful.length,
        success_rate: generated.length ? successful.length / generated.length : null,
        overall: metric('overall'),
        prompt_fidelity: metric('prompt_fidelity'),
        continuity: metric('continuity'),
        audio_dialogue: metric('audio_dialogue'),
        critical_failures: criticalFailures,
        p95_seconds: percentile(successful.map(value => value.result.duration_seconds), 0.95),
        total_cost_usd: generated.reduce((sum, value) => sum + finite(value.result.cost_usd), 0),
        mean_cost_usd: mean(generated.map(value => value.result.cost_usd)),
    };
}

export function plannerGate(
    cases,
    candidate,
    controlCandidate,
    humanAdjudications = null,
    { requireHumanAdjudication = false } = {},
) {
    const summary = plannerSummary(cases, candidate);
    const control = plannerSummary(cases, controlCandidate);
    const differences = cases.flatMap(testCase => {
        const candidateOverall = averageRating(testCase, candidate, 'overall');
        const controlOverall = averageRating(testCase, controlCandidate, 'overall');
        return candidateOverall === null || controlOverall === null ? [] : [candidateOverall - controlOverall];
    });
    const metricDelta = field => {
        const candidateValue = summary[field];
        const controlValue = control[field];
        return candidateValue === null || controlValue === null ? null : candidateValue - controlValue;
    };
    const costReduction = control.mean_cost_usd > 0 && summary.mean_cost_usd !== null
        ? 1 - summary.mean_cost_usd / control.mean_cost_usd : null;
    const reasons = [];
    if (summary.samples < 60) reasons.push('needs_60_prompts');
    if (!(lowerConfidenceBound(differences) !== null && lowerConfidenceBound(differences) > -0.5)) reasons.push('overall_noninferiority_failed');
    for (const field of ['prompt_fidelity', 'continuity', 'audio_dialogue']) {
        if (!(metricDelta(field) !== null && metricDelta(field) >= -0.5)) reasons.push(`${field}_regression`);
    }
    const relevantHuman = humanAdjudications
        ? Object.values(humanAdjudications).filter(value => value.candidates?.includes(candidate))
        : [];
    const pendingHuman = relevantHuman.filter(value => !value.completed).length;
    const candidateMaterialFailures = relevantHuman.filter(value => value.material_failures?.includes(candidate)).length;
    const controlMaterialFailures = relevantHuman.filter(value => value.material_failures?.includes(controlCandidate)).length;
    if (requireHumanAdjudication && pendingHuman) reasons.push('pending_human_adjudication');
    if (humanAdjudications) {
        if (candidateMaterialFailures > controlMaterialFailures + 1) reasons.push('additional_human_confirmed_critical_failures');
    } else if (summary.critical_failures > control.critical_failures + 1) {
        reasons.push('additional_critical_failures');
    }
    if (!(summary.success_rate !== null && summary.success_rate >= 0.98)) reasons.push('validation_rate_below_98_percent');
    if (!(costReduction !== null && costReduction >= 0.25)) reasons.push('cost_reduction_below_25_percent');
    if (!(summary.p95_seconds !== null && control.p95_seconds !== null
        && summary.p95_seconds <= control.p95_seconds + 10)) reasons.push('p95_latency_regression');
    return {
        qualifies: reasons.length === 0,
        reasons,
        summary,
        control,
        overall_lower_confidence_bound: lowerConfidenceBound(differences),
        cost_reduction: costReduction,
        pending_human_reviews: pendingHuman,
        human_review_required: requireHumanAdjudication,
        human_confirmed_material_failures: candidateMaterialFailures,
    };
}

export function buildReviewerHumanPacket(calls, seed = 'reviewer-human-v1', auditFraction = 0.1) {
    const byCase = Map.groupBy(calls.filter(call => call.ok && typeof call.actual === 'boolean'), call => call.case_id);
    const selected = [];
    for (const [caseId, values] of byCase) {
        const decisions = [...new Set(values.map(value => value.actual))];
        const disagreement = decisions.length > 1;
        const audit = !disagreement && seededUnit(`${seed}:${caseId}`) < auditFraction;
        if (!disagreement && !audit) continue;
        const ordered = stableShuffle(values, `${seed}:${caseId}`);
        selected.push({
            case_id: caseId,
            reason: disagreement ? 'reviewer_disagreement' : 'agreement_audit',
            prompt: ordered[0].prompt,
            plan_path: ordered[0].plan_path,
            image_path: ordered[0].image_path,
            options: ordered.map((value, index) => ({
                label: String.fromCharCode(65 + index),
                acceptable: value.actual,
                issues: value.issues || [],
            })),
            human_acceptable: null,
            material_failure: null,
            notes: '',
        });
    }
    return { schema_version: 1, blinded: true, cases: selected };
}

export function buildReviewerHumanKey(packet, calls, seed = 'reviewer-human-v1') {
    return {
        schema_version: 1,
        cases: packet.cases.map(entry => {
            const values = calls.filter(call => call.case_id === entry.case_id && call.ok);
            const ordered = stableShuffle(values, `${seed}:${entry.case_id}`);
            return {
                case_id: entry.case_id,
                labels: Object.fromEntries(ordered.map((value, index) => [String.fromCharCode(65 + index), value.arm])),
            };
        }),
    };
}

export function reviewerHumanLabels(packet) {
    return Object.fromEntries((packet?.cases || [])
        .filter(entry => typeof entry.human_acceptable === 'boolean')
        .map(entry => [entry.case_id, entry.human_acceptable]));
}

export function buildPlannerHumanPacket(cases, controlCandidate, seed = 'planner-human-v1') {
    const packet = [];
    const key = [];
    for (const testCase of cases) {
        const control = (testCase.generated || []).find(value => value.candidate === controlCandidate && value.ok);
        if (!control) continue;
        for (const candidate of (testCase.generated || []).filter(value => value.ok && value.candidate !== controlCandidate)) {
            const judgments = (testCase.judgments || []).filter(value => value.pair_candidate === candidate.candidate);
            const winners = [...new Set(judgments.map(value => value.winner_candidate))];
            const ratings = judgments.flatMap(value => value.ratings || []);
            const critical = ratings.some(value => (value.critical_failures || []).length);
            const gaps = judgments.flatMap(judgment => {
                const candidateRating = (judgment.ratings || []).find(value => value.candidate === candidate.candidate);
                const controlRating = (judgment.ratings || []).find(value => value.candidate === controlCandidate);
                return candidateRating && controlRating ? [Math.abs(candidateRating.overall - controlRating.overall)] : [];
            });
            const close = gaps.some(value => value < 0.5);
            if (winners.length <= 1 && !critical && !close) continue;
            const ordered = stableShuffle([
                { candidate: controlCandidate, plan: control.plan },
                { candidate: candidate.candidate, plan: candidate.plan },
            ], `${seed}:${testCase.case_id}:${candidate.candidate}`);
            const reviewId = `${testCase.case_id}:${candidate.candidate}`;
            packet.push({
                review_id: reviewId,
                reason: winners.length > 1 ? 'judge_disagreement' : critical ? 'critical_failure' : 'close_score',
                prompt: testCase.prompt,
                options: ordered.map((value, index) => ({ label: String.fromCharCode(65 + index), plan: value.plan })),
                human_winner: null,
                material_failures: [],
                review_complete: false,
                notes: '',
            });
            key.push({
                review_id: reviewId,
                labels: Object.fromEntries(ordered.map((value, index) => [String.fromCharCode(65 + index), value.candidate])),
            });
        }
    }
    return {
        packet: { schema_version: 1, blinded: true, cases: packet },
        key: { schema_version: 1, cases: key },
    };
}

export function plannerHumanAdjudications(packet, key) {
    const keys = new Map((key?.cases || []).map(value => [value.review_id, value.labels || {}]));
    return Object.fromEntries((packet?.cases || []).map(entry => {
        const labels = keys.get(entry.review_id) || {};
        const winner = entry.human_winner === 'tie'
            ? 'tie'
            : labels[entry.human_winner] || null;
        const failures = (entry.material_failures || []).map(label => labels[label]).filter(Boolean);
        return [entry.review_id, {
            completed: entry.review_complete === true && Boolean(winner),
            winner,
            material_failures: failures,
            candidates: [...new Set(Object.values(labels).filter(Boolean))],
        }];
    }));
}

export function finalVideoGate(packet, key) {
    const keys = new Map((key?.pairs || []).map(value => [value.pair_id, value.labels || {}]));
    const rows = (packet?.pairs || []).map(pair => {
        const labels = keys.get(pair.pair_id) || {};
        const complete = ['A', 'B'].every(label => Number.isFinite(Number(pair.overall?.[label])))
            && ['A', 'B', 'tie'].includes(pair.preferred);
        const candidateLabel = Object.entries(labels).find(([_label, value]) => value === 'candidate')?.[0];
        const controlLabel = Object.entries(labels).find(([_label, value]) => value === 'control')?.[0];
        return {
            complete,
            preferred: pair.preferred === 'tie' ? 'tie' : labels[pair.preferred],
            overall_delta: complete && candidateLabel && controlLabel
                ? Number(pair.overall[candidateLabel]) - Number(pair.overall[controlLabel]) : null,
            candidate_material_failure: Boolean(candidateLabel && pair.material_failure?.[candidateLabel]),
        };
    });
    const complete = rows.filter(value => value.complete);
    const preferredOrTied = complete.filter(value => ['candidate', 'tie'].includes(value.preferred)).length;
    const overallDelta = mean(complete.map(value => value.overall_delta));
    const reasons = [];
    const candidateMaterialFailure = complete.some(value => value.candidate_material_failure);
    const strongEarlyThreshold = Math.ceil(complete.length * 0.8);
    const earlyPass = complete.length >= 6 && complete.length < 10
        && preferredOrTied >= strongEarlyThreshold
        && overallDelta !== null && overallDelta >= -0.5
        && !candidateMaterialFailure;
    const fullPass = complete.length >= 10
        && preferredOrTied >= 7
        && overallDelta !== null && overallDelta >= -0.5
        && !candidateMaterialFailure;
    if (candidateMaterialFailure) reasons.push('candidate_material_failure');
    if (!candidateMaterialFailure && complete.length < 6) reasons.push('needs_6_completed_pairs');
    if (!candidateMaterialFailure && complete.length >= 6 && complete.length < 10 && !earlyPass) {
        reasons.push('needs_more_pairs_up_to_10');
    }
    if (!candidateMaterialFailure && complete.length >= 10 && preferredOrTied < 7) {
        reasons.push('candidate_preferred_or_tied_below_7');
    }
    if (!candidateMaterialFailure && complete.length >= 10
        && !(overallDelta !== null && overallDelta >= -0.5)) reasons.push('overall_quality_regression');
    const qualifies = earlyPass || fullPass;
    return {
        qualifies,
        reasons,
        decision: qualifies ? 'pass' : candidateMaterialFailure || complete.length >= 10 ? 'fail' : complete.length >= 6 ? 'expand' : 'incomplete',
        completed_pairs: complete.length,
        preferred_or_tied: preferredOrTied,
        early_pass_threshold: complete.length >= 6 && complete.length < 10 ? strongEarlyThreshold : null,
        mean_overall_delta: overallDelta,
    };
}

export function replayQueue(history, measured) {
    const jobs = Array.isArray(history) ? history : [];
    const plannerDelta = finite(measured?.planner_p95_delta_seconds);
    const reviewDelta = finite(measured?.review_p95_delta_seconds);
    const rows = jobs.map(job => {
        const reviews = Math.max(0, finite(job.review_count));
        const added = Math.max(0, plannerDelta + reviews * reviewDelta);
        const slack = Math.max(0, finite(job.gpu_start_at) - finite(job.preparation_ready_at));
        return { added_seconds: added, delayed_gpu: added > slack, end_to_end_seconds: finite(job.end_to_end_seconds), slack_seconds: slack };
    });
    const originalMedian = percentile(rows.map(row => row.end_to_end_seconds), 0.5);
    const projectedMedian = percentile(rows.map(row => row.end_to_end_seconds + row.added_seconds), 0.5);
    return {
        jobs: rows.length,
        gpu_delay_rate: rows.length ? rows.filter(row => row.delayed_gpu).length / rows.length : null,
        median_end_to_end_increase: originalMedian && projectedMedian !== null
            ? (projectedMedian - originalMedian) / originalMedian : null,
        p95_added_seconds: percentile(rows.map(row => row.added_seconds), 0.95),
    };
}

export function buildGpuqRenderArguments({
    pythonPath,
    generatorPath,
    prompt,
    planPath,
    imagePath,
    seed,
    benchmarkLabel,
}) {
    if (!pythonPath || !generatorPath || !prompt || !planPath || !benchmarkLabel) {
        throw new Error('GPU render arguments require Python, generator, prompt, plan, and benchmark label.');
    }
    return [
        'run',
        '--profile', 'video-h3-isolated',
        '--priority', 'normal',
        '--when-gaming', 'hold',
        '--on-preempt', 'fail',
        '--evict-cache-before-run',
        '--expected-duration-low-seconds', '180',
        '--expected-duration-high-seconds', '1800',
        '--',
        pythonPath,
        '-s', generatorPath,
        '--model', 'h3',
        '--quality', 'final',
        '--frontier-plan', planPath,
        '--seed', String(seed),
        '--benchmark-label', benchmarkLabel,
        '--stop-server',
        ...(imagePath ? ['--image', imagePath, '--keyframe', 'never'] : ['--keyframe', 'never']),
        prompt,
    ];
}
