import assert from 'node:assert/strict';
import test from 'node:test';

import {
    compactTeacherPlan,
    mapWithConcurrency,
    reportCandidate,
    selectTeacherExamples,
    summarizeBenchmarkCases,
    teacherExamplesFromReport,
} from '../scripts/video-planner-benchmark-lib.mjs';

function plan(label) {
    return {
        intent: label,
        continuity_bible: `${label} remains consistent.`,
        keyframe: {
            prompt: `${label} at the beginning.`,
            motion_contract: { first_second_action: `${label} begins moving.` },
            reference_requirements: [{ label: 'unused in compact example' }],
        },
        segments: [{
            title: 'Beat', transition: 'start', target_seconds: 5, music: 'N/A',
            shots: [{ visual: `${label} acts.`, camera: 'Wide.', audio: 'Room tone.', dialogue: [] }],
        }],
        prompt_analysis: { large: 'unused' },
        planner_metrics: { screenplay_seconds: 80 },
        _planner_model: 'teacher',
    };
}

const report = {
    cases: [{
        prompt: '  A DUCK   becomes mayor. ',
        generated: [{ candidate: 'sol-high-high', ok: true, plan: plan('duck') }],
        judgment: {
            ratings: [{ candidate: 'sol-high-high', overall: 9.4, critical_failures: [] }],
        },
    }, {
        prompt: 'A weak example.',
        generated: [{ candidate: 'sol-high-high', ok: true, plan: plan('weak') }],
        judgment: {
            ratings: [{ candidate: 'sol-high-high', overall: 8.9, critical_failures: [] }],
        },
    }],
};

test('benchmark finds reusable successful candidates by normalized prompt', () => {
    assert.equal(reportCandidate(report, 'a duck becomes mayor.', 'sol-high-high').plan.intent, 'duck');
    assert.equal(reportCandidate(report, 'missing', 'sol-high-high'), null);
});

test('benchmark infers teacher examples from strong baseline ratings', () => {
    assert.deepEqual(teacherExamplesFromReport(report).map(value => value.plan.intent), ['duck']);
    assert.deepEqual(selectTeacherExamples(report, 'A duck becomes mayor.'), []);
    assert.equal(selectTeacherExamples(report, 'A different prompt.')[0].plan.intent, 'duck');
});

test('benchmark compacts teacher plans to relevant directing demonstrations', () => {
    const compact = compactTeacherPlan(plan('duck'));
    assert.equal(compact.opening.prompt, 'duck at the beginning.');
    assert.equal(compact.beats[0].shots[0].visual, 'duck acts.');
    assert.equal('prompt_analysis' in compact, false);
    assert.equal('audio' in compact.beats[0].shots[0], false);
});

test('benchmark prompt concurrency is bounded and preserves order', async () => {
    let active = 0;
    let maximum = 0;
    const values = await mapWithConcurrency([3, 1, 2, 0], 2, async value => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, value * 2));
        active -= 1;
        return value * 10;
    });
    assert.deepEqual(values, [30, 10, 20, 0]);
    assert.equal(maximum, 2);
});

test('benchmark summaries separate cached baselines from live latency', () => {
    const cases = [{
        generated: [
            { candidate: 'teacher', ok: true, reused: true, duration_seconds: 80, attempts: [] },
            { candidate: 'student', ok: true, duration_seconds: 12, attempts: [{ stage: 'screenplay_repair' }] },
        ],
        judgment: {
            winner_candidate: 'student',
            ratings: [
                { candidate: 'teacher', overall: 9.2, critical_failures: [] },
                { candidate: 'student', overall: 9, acceptable: true, critical_failures: ['one'] },
            ],
        },
    }];
    assert.deepEqual(summarizeBenchmarkCases(cases), [{
        candidate: 'teacher', samples: 1, successful: 1, reused: 1,
        mean_generation_seconds: null, mean_overall: 9.2, minimum_overall: 9.2,
        acceptable: null, critical_failures: 0, wins: 0, repairs: 0,
    }, {
        candidate: 'student', samples: 1, successful: 1, reused: 0,
        mean_generation_seconds: 12, mean_overall: 9, minimum_overall: 9,
        acceptable: 1, critical_failures: 1, wins: 1, repairs: 1,
    }]);
});
