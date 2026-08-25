#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { config } from '../dist/Config.js';
import {
    VIDEO_PLANNER_FAST_MODEL,
    VIDEO_PLANNER_MODEL,
    createFrontierVideoPlan,
} from '../dist/VideoFrontierPlanner.js';

const QUICK_PROMPTS = [
    'A duck becomes mayor.',
    'Make something fun about Monday morning.',
    'Exactly three arcade racers speed toward a neon finish line while one says "Not today!"',
    'A tiny knight tries to return an overdue library book during a dragon attack.',
];

const FULL_PROMPTS = [
    ...QUICK_PROMPTS,
    'A luxury perfume commercial for a bottle that smells like fresh-cut grass.',
    'Two rival chefs discover they are both cooking for the same very judgmental cat.',
    'A realistic wildlife documentary about office workers migrating to the break room.',
    'Show five dogs marching together, stopping in formation, and saluting one at a time.',
    'An astronaut finds a handwritten note on Mars that says "back in five minutes".',
    'A cozy stop-motion sequence about a sock escaping from a laundry basket.',
    'A tense black-and-white detective scene where the only witness is a goldfish.',
    'A cheerful local-news segment about a pothole that residents have turned into a tiny beach.',
];

const CANDIDATES = [
    {
        id: 'sol-high-high',
        plannerModel: VIDEO_PLANNER_MODEL,
        analysisReasoningEffort: 'high',
        screenplayReasoningEffort: 'high',
    },
    {
        id: 'gemini-flash-medium-medium',
        plannerModel: VIDEO_PLANNER_FAST_MODEL,
        analysisReasoningEffort: 'medium',
        screenplayReasoningEffort: 'medium',
    },
    {
        id: 'gemini-flash-low-medium',
        plannerModel: VIDEO_PLANNER_FAST_MODEL,
        analysisReasoningEffort: 'low',
        screenplayReasoningEffort: 'medium',
    },
];

function args() {
    const values = new Set(process.argv.slice(2));
    const limitArgument = process.argv.find(value => value.startsWith('--limit='));
    const examplesArgument = process.argv.find(value => value.startsWith('--examples='));
    const limit = limitArgument ? Number(limitArgument.split('=')[1]) : undefined;
    return {
        full: values.has('--full'),
        noJudge: values.has('--no-judge'),
        limit: Number.isInteger(limit) && limit > 0 ? limit : undefined,
        examplesPath: examplesArgument ? examplesArgument.slice('--examples='.length) : undefined,
    };
}

function outputText(response) {
    if (typeof response?.output_text === 'string' && response.output_text.trim()) {
        return response.output_text.trim();
    }
    for (const item of response?.output || []) {
        for (const content of item?.content || []) {
            if (content?.type === 'output_text' && typeof content.text === 'string') return content.text;
        }
    }
    throw new Error(response?.error?.message || 'Teacher returned no rating.');
}

async function generateCandidate(prompt, candidate, plannerExamples) {
    const usage = [];
    const attempts = [];
    const started = performance.now();
    try {
        const plan = await createFrontierVideoPlan(prompt, 'minimax', `benchmark-${candidate.id}`, undefined, {
            plannerModel: candidate.plannerModel,
            analysisReasoningEffort: candidate.analysisReasoningEffort,
            screenplayReasoningEffort: candidate.screenplayReasoningEffort,
            plannerExamples: candidate.plannerModel === VIDEO_PLANNER_FAST_MODEL ? plannerExamples : undefined,
            onUsage: event => usage.push(event),
            onAttempt: event => attempts.push(event),
        });
        return {
            candidate: candidate.id,
            duration_seconds: (performance.now() - started) / 1000,
            ok: true,
            plan,
            usage,
            attempts,
        };
    } catch (error) {
        return {
            candidate: candidate.id,
            duration_seconds: (performance.now() - started) / 1000,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            usage,
            attempts,
        };
    }
}

async function judgeCandidates(prompt, generated) {
    const successful = generated.filter(result => result.ok);
    if (!successful.length) return null;
    const labels = successful.map((result, index) => ({
        label: String.fromCharCode(65 + index),
        candidate: result.candidate,
        plan: result.plan,
    }));
    const schema = {
        type: 'object',
        additionalProperties: false,
        required: ['ratings', 'winner', 'explanation'],
        properties: {
            ratings: {
                type: 'array',
                minItems: labels.length,
                maxItems: labels.length,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['label', 'prompt_fidelity', 'creative_expansion', 'specificity', 'continuity', 'audio_dialogue', 'overall', 'critical_failures'],
                    properties: {
                        label: { type: 'string', enum: labels.map(value => value.label) },
                        prompt_fidelity: { type: 'number', minimum: 1, maximum: 10 },
                        creative_expansion: { type: 'number', minimum: 1, maximum: 10 },
                        specificity: { type: 'number', minimum: 1, maximum: 10 },
                        continuity: { type: 'number', minimum: 1, maximum: 10 },
                        audio_dialogue: { type: 'number', minimum: 1, maximum: 10 },
                        overall: { type: 'number', minimum: 1, maximum: 10 },
                        critical_failures: { type: 'array', maxItems: 8, items: { type: 'string' } },
                    },
                },
            },
            winner: { type: 'string', enum: [...labels.map(value => value.label), 'tie'] },
            explanation: { type: 'string' },
        },
    };
    const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${config.openaiApiKey}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: VIDEO_PLANNER_MODEL,
            reasoning: { effort: 'high' },
            instructions: 'You are a blinded video-directing evaluator. Score plans only on the supplied request and their concrete feasibility for MiniMax H3. Reward inventive development of vague prompts, but penalize generic spectacle, prompt mirroring, missing literal constraints, impossible timing, broken shot continuity, and unwanted dialogue. Do not infer provider identity from style.',
            input: [{
                role: 'user',
                content: [{
                    type: 'input_text',
                    text: [
                        `USER REQUEST:\n${prompt}`,
                        ...labels.map(value => `CANDIDATE ${value.label}:\n${JSON.stringify(value.plan)}`),
                    ].join('\n\n'),
                }],
            }],
            text: {
                verbosity: 'low',
                format: { type: 'json_schema', name: 'video_plan_comparison', strict: true, schema },
            },
            max_output_tokens: 5000,
            prompt_cache_key: 'video-plan-benchmark-teacher-v1',
            store: false,
        }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message || `Teacher returned HTTP ${response.status}.`);
    const judgment = JSON.parse(outputText(body));
    return {
        ...judgment,
        ratings: judgment.ratings.map(rating => ({
            ...rating,
            candidate: labels.find(value => value.label === rating.label)?.candidate,
        })),
        winner_candidate: labels.find(value => value.label === judgment.winner)?.candidate || judgment.winner,
        usage: body.usage,
    };
}

async function main() {
    const options = args();
    const source = options.full ? FULL_PROMPTS : QUICK_PROMPTS;
    const prompts = source.slice(0, options.limit || source.length);
    let plannerExamples = [];
    if (options.examplesPath) {
        const previous = JSON.parse(await readFile(resolve(options.examplesPath), 'utf8'));
        const storedExamples = Array.isArray(previous.teacher_examples) && previous.teacher_examples.length
            ? previous.teacher_examples
            : (previous.cases || []).flatMap(testCase => {
                const rating = (testCase.judgment?.ratings || [])
                    .find(candidate => candidate.candidate === 'sol-high-high');
                const result = (testCase.generated || [])
                    .find(candidate => candidate.candidate === 'sol-high-high');
                return rating?.overall >= 9 && !rating.critical_failures.length && result?.ok
                    ? [{ prompt: testCase.prompt, plan: result.plan }]
                    : [];
            });
        plannerExamples = storedExamples
            .slice(0, 3)
            .map(example => ({ prompt: example.prompt, plan: example.plan }));
        process.stdout.write(`Loaded ${plannerExamples.length} teacher examples.\n`);
    }
    const cases = [];
    for (const prompt of prompts) {
        process.stdout.write(`Planning: ${prompt}\n`);
        const generated = await Promise.all(CANDIDATES.map(candidate =>
            generateCandidate(prompt, candidate, plannerExamples)));
        const judgment = options.noJudge ? null : await judgeCandidates(prompt, generated);
        cases.push({ prompt, generated, judgment });
    }
    const studentExamples = cases.flatMap(testCase => {
        const ratings = testCase.judgment?.ratings || [];
        return ratings
            .filter(rating => rating.candidate?.startsWith('gemini-flash')
                && rating.overall >= 8.5 && !rating.critical_failures.length)
            .map(rating => ({
                prompt: testCase.prompt,
                rating,
                plan: testCase.generated.find(result => result.candidate === rating.candidate)?.plan,
            }));
    });
    const teacherExamples = cases.flatMap(testCase => {
        const rating = (testCase.judgment?.ratings || [])
            .find(candidate => candidate.candidate === 'sol-high-high');
        const result = testCase.generated.find(candidate => candidate.candidate === 'sol-high-high');
        return rating?.overall >= 9 && !rating.critical_failures.length && result?.ok
            ? [{ prompt: testCase.prompt, rating, plan: result.plan }]
            : [];
    });
    const report = {
        created_at: new Date().toISOString(),
        mode: options.full ? 'full' : 'quick',
        candidates: CANDIDATES,
        cases,
        teacher_examples: teacherExamples,
        student_examples: studentExamples,
    };
    const directory = resolve('artifacts/video-planner-benchmarks');
    await mkdir(directory, { recursive: true });
    const path = resolve(directory, `${new Date().toISOString().replaceAll(':', '-')}.json`);
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`Report: ${path}\n`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
