export function normalizedPrompt(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function reportCandidate(report, prompt, candidateId) {
    const wanted = normalizedPrompt(prompt);
    const testCase = (report?.cases || []).find(value => normalizedPrompt(value?.prompt) === wanted);
    return testCase?.generated?.find(value => value?.candidate === candidateId && value?.ok) || null;
}

export function teacherExamplesFromReport(report, teacherCandidate = 'sol-high-high') {
    const stored = Array.isArray(report?.teacher_examples) ? report.teacher_examples : [];
    const inferred = (report?.cases || []).flatMap(testCase => {
        const rating = (testCase?.judgment?.ratings || [])
            .find(value => value?.candidate === teacherCandidate);
        const result = (testCase?.generated || [])
            .find(value => value?.candidate === teacherCandidate);
        return rating?.overall >= 9 && !(rating.critical_failures || []).length && result?.ok
            ? [{ prompt: testCase.prompt, rating, plan: result.plan }]
            : [];
    });
    const unique = new Map();
    for (const example of [...stored, ...inferred]) {
        if (!example?.plan || !normalizedPrompt(example.prompt)) continue;
        unique.set(normalizedPrompt(example.prompt), example);
    }
    return [...unique.values()];
}

export function compactTeacherPlan(plan) {
    return {
        intent: plan?.intent,
        continuity_bible: plan?.continuity_bible,
        opening: {
            prompt: plan?.keyframe?.prompt,
            motion_contract: plan?.keyframe?.motion_contract,
        },
        beats: (plan?.segments || []).map(segment => ({
            title: segment?.title,
            transition: segment?.transition,
            target_seconds: segment?.target_seconds,
            shots: (segment?.shots || []).map(shot => ({
                visual: shot?.visual,
                camera: shot?.camera,
                dialogue: shot?.dialogue,
            })),
        })),
    };
}

export function selectTeacherExamples(report, prompt, limit = 3) {
    const excluded = normalizedPrompt(prompt);
    return teacherExamplesFromReport(report)
        .filter(example => normalizedPrompt(example.prompt) !== excluded)
        .slice(0, Math.max(0, limit))
        .map(example => ({
            prompt: example.prompt,
            plan: compactTeacherPlan(example.plan),
        }));
}

export async function mapWithConcurrency(values, concurrency, worker) {
    const results = new Array(values.length);
    let nextIndex = 0;
    const count = Math.max(1, Math.min(values.length || 1, Number(concurrency) || 1));
    await Promise.all(Array.from({ length: count }, async () => {
        while (nextIndex < values.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await worker(values[index], index);
        }
    }));
    return results;
}

export function summarizeBenchmarkCases(cases) {
    const candidateIds = [...new Set((cases || []).flatMap(testCase =>
        (testCase?.generated || []).map(value => value?.candidate).filter(Boolean)))];
    return candidateIds.map(candidate => {
        const generated = cases.map(testCase =>
            (testCase?.generated || []).find(value => value?.candidate === candidate)).filter(Boolean);
        const liveDurations = generated
            .filter(value => value.ok && !value.reused && Number.isFinite(value.duration_seconds))
            .map(value => Number(value.duration_seconds));
        const ratings = cases.flatMap(testCase => {
            const judgments = Array.isArray(testCase?.judgments) && testCase.judgments.length
                ? testCase.judgments
                : testCase?.judgment ? [testCase.judgment] : [];
            return judgments.flatMap(judgment =>
                (judgment?.ratings || []).filter(value => value?.candidate === candidate));
        });
        const overall = ratings.map(value => Number(value.overall)).filter(Number.isFinite);
        const acceptanceRatings = ratings.filter(value => typeof value.acceptable === 'boolean');
        return {
            candidate,
            samples: generated.length,
            successful: generated.filter(value => value.ok).length,
            reused: generated.filter(value => value.reused).length,
            mean_generation_seconds: liveDurations.length
                ? liveDurations.reduce((sum, value) => sum + value, 0) / liveDurations.length
                : null,
            mean_overall: overall.length
                ? overall.reduce((sum, value) => sum + value, 0) / overall.length
                : null,
            minimum_overall: overall.length ? Math.min(...overall) : null,
            acceptable: acceptanceRatings.length
                ? acceptanceRatings.filter(value => value.acceptable).length
                : null,
            critical_failures: ratings.reduce(
                (sum, value) => sum + (Array.isArray(value.critical_failures) ? value.critical_failures.length : 0),
                0,
            ),
            wins: cases.reduce((sum, testCase) => {
                const judgments = Array.isArray(testCase?.judgments) && testCase.judgments.length
                    ? testCase.judgments
                    : testCase?.judgment ? [testCase.judgment] : [];
                return sum + judgments.filter(judgment => judgment?.winner_candidate === candidate).length;
            }, 0),
            repairs: generated.reduce(
                (sum, value) => sum + (value.attempts || []).filter(attempt => attempt.stage === 'screenplay_repair').length,
                0,
            ),
            single_pass_fallbacks: generated.reduce(
                (sum, value) => sum + (value.attempts || [])
                    .filter(attempt => attempt.stage === 'single_pass_fallback').length,
                0,
            ),
        };
    });
}
