import { mean, percentile, stableHash } from './video-cost-ab-lib.mjs';

export const CONTROL = 'sol-low';
export const PLANNER_CANDIDATES = {
    'sol-low': { model: 'gpt-5.6-sol', effort: 'low' },
    'sol-medium': { model: 'gpt-5.6-sol', effort: 'medium' },
    'astra-low': { model: 'gpt-6-astra', effort: 'low' },
    'astra-medium': { model: 'gpt-6-astra', effort: 'medium' },
    'terra-medium': { model: 'gpt-5.6-terra', effort: 'medium' },
    'luna-medium': { model: 'gpt-5.6-luna', effort: 'medium' },
    'flash-low': { model: 'gemini-3.8-flash', effort: 'low' },
    'flash-medium': { model: 'gemini-3.8-flash', effort: 'medium' },
};

export function blindedPlan(value) {
    if (Array.isArray(value)) return value.map(blindedPlan);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !key.startsWith('_') && !['planner', 'planner_model', 'planner_route', 'planner_metrics', 'generation_notice'].includes(key))
        .map(([key, nested]) => [key, blindedPlan(nested)]));
    return value;
}

export function bootstrapMeanInterval(values, seed = 'quality-v1') {
    const xs = values.filter(Number.isFinite);
    if (xs.length < 2) return null;
    let state = Number.parseInt(stableHash(seed, 8), 16);
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    const samples = Array.from({ length: 4000 }, () => mean(xs.map(() => xs[Math.floor(random() * xs.length)])));
    return [percentile(samples, 0.025), percentile(samples, 0.975)];
}

export function summarizeOptimization(calls, corpus, split) {
    const results = [];
    for (const command of ['minimax', 'oalgo']) {
        const cases = corpus.filter(value => value.command === command && value.split === split);
        const candidateIds = [...new Set(calls.filter(call => call.kind === 'planner' && call.command === command && call.split === split).map(call => call.candidate))];
        for (const candidate of candidateIds) {
            const own = calls.filter(call => call.kind === 'planner' && call.command === command && call.split === split && call.candidate === candidate && call.repeat === 0);
            const control = calls.filter(call => call.kind === 'planner' && call.command === command && call.split === split && call.candidate === CONTROL && call.repeat === 0);
            const deltas = [], absolute = [], adherence = [], material = [];
            let judgedCases = 0, disagreementCases = 0;
            for (const testCase of cases) {
                const judges = calls.filter(call => call.kind === 'judge' && call.case_id === testCase.id
                    && call.candidate === candidate && call.repeat === 0 && call.ok && call.accounting_complete);
                if (judges.length !== 2 || new Set(judges.map(call => call.judge)).size !== 2) continue;
                judgedCases++;
                const perCase = judges.map(call => call.value.candidate.overall - call.value.control.overall);
                deltas.push(mean(perCase));
                absolute.push(mean(judges.map(call => call.value.candidate.overall)));
                adherence.push(mean(judges.map(call => call.value.candidate.adherence - call.value.control.adherence)));
                if (Math.sign(perCase[0]) !== Math.sign(perCase[1])) disagreementCases++;
                if (judges.some(call => call.value.candidate.material_failures.length)) material.push(testCase.id);
            }
            const cost = mean(own.map(call => call.cost_usd));
            const baseCost = mean(control.map(call => call.cost_usd));
            const latency = percentile(own.filter(call => call.ok).map(call => call.duration_seconds), 0.95);
            const baseLatency = percentile(control.filter(call => call.ok).map(call => call.duration_seconds), 0.95);
            const interval = bootstrapMeanInterval(deltas, `${command}:${candidate}:${split}`);
            const allComplete = own.length === cases.length && control.length === cases.length
                && [...own, ...control].every(call => call.accounting_complete);
            const successRate = own.length ? own.filter(call => call.ok).length / own.length : null;
            const qualityFloor = allComplete && judgedCases === cases.length && successRate >= 0.98
                && interval?.[0] > -0.5 && mean(adherence) >= -0.5 && material.length === 0;
            const costRatio = cost !== null && baseCost > 0 ? cost / baseCost : null;
            const timeRatio = latency !== null && baseLatency > 0 ? latency / baseLatency : null;
            const measured = costRatio !== null && timeRatio !== null;
            const efficient = measured && qualityFloor && ((costRatio <= 0.85 && timeRatio <= 1.05) || (timeRatio <= 0.85 && costRatio <= 1.05));
            const qualityUpgrade = measured && qualityFloor && mean(deltas) >= 0.5 && interval?.[0] > 0 && costRatio <= 1.2 && timeRatio <= 1.1;
            const repeatCases = calls.filter(call => call.kind === 'planner' && call.command === command
                && call.split === split && call.candidate === candidate && call.repeat === 1);
            const repeatsPass = repeatCases.length === 4 && repeatCases.every(call => call.ok && call.accounting_complete
                && calls.some(base => base.kind === 'planner' && base.case_id === call.case_id && base.candidate === CONTROL
                    && base.repeat === 1 && base.ok && base.accounting_complete)
                && calls.filter(judge => judge.kind === 'judge' && judge.case_id === call.case_id && judge.candidate === candidate
                    && judge.repeat === 1 && judge.ok && judge.accounting_complete
                    && !judge.value.candidate.material_failures.length
                    && judge.value.candidate.overall - judge.value.control.overall > -0.5).length === 2);
            results.push({ command, candidate, samples: own.length, expected: cases.length, successful: own.filter(call => call.ok).length,
                success_rate: successRate, judged_cases: judgedCases, disagreement_cases: disagreementCases,
                cost_usd: cost, p95_seconds: latency, overall: mean(absolute), overall_delta: mean(deltas),
                overall_interval: interval, material_flags: material, cost_ratio: costRatio, time_ratio: timeRatio,
                accounting_complete: allComplete, quality_floor: Boolean(qualityFloor),
                repeated_cases: repeatCases.length, repeat_consistency: repeatsPass,
                qualifies: split === 'holdout' && repeatsPass && Boolean(efficient || qualityUpgrade),
                treatment: qualityUpgrade ? 'quality_upgrade' : efficient ? 'efficiency' : 'inconclusive',
            });
        }
    }
    return results;
}

export function chooseScreenFinalists(summaries) {
    return Object.fromEntries(['minimax', 'oalgo'].map(command => {
        const candidates = summaries.filter(row => row.command === command && row.candidate !== CONTROL
            && row.samples === row.expected && row.judged_cases === row.expected && row.accounting_complete
            && row.success_rate >= 0.98 && row.overall_delta >= -0.5 && row.material_flags.length === 0);
        candidates.sort((a, b) => a.cost_usd - b.cost_usd || a.p95_seconds - b.p95_seconds);
        return [command, candidates[0]?.candidate || null];
    }));
}
