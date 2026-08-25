#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { config } from '../dist/Config.js';
import {
    VIDEO_PLANNER_FAST_MODEL,
    VIDEO_PLANNER_MODEL,
    createFrontierVideoPlan,
} from '../dist/VideoFrontierPlanner.js';
import {
    mapWithConcurrency,
    reportCandidate,
    selectTeacherExamples,
    summarizeBenchmarkCases,
    teacherExamplesFromReport,
} from './video-planner-benchmark-lib.mjs';

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

const FOCUSED_FLASH_GUIDANCE = 'Preserve state transitions: when the request describes a change, frame zero must show the relevant state before that change, not the achieved result. Preserve temporal facts exactly; for example, overdue means already late. Make required abstract facts visually verifiable. Keep each short shot physically achievable, including a visible route for tiny subjects. Give each dialogue turn one visible speaker and stage its delivery in the same shot.';

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
    {
        id: 'gemini-flash-low-medium-focused',
        experimental: true,
        plannerModel: VIDEO_PLANNER_FAST_MODEL,
        analysisReasoningEffort: 'low',
        screenplayReasoningEffort: 'medium',
        plannerGuidance: FOCUSED_FLASH_GUIDANCE,
    },
];

function args() {
    const values = new Set(process.argv.slice(2));
    const limitArgument = process.argv.find(value => value.startsWith('--limit='));
    const examplesArgument = process.argv.find(value => value.startsWith('--examples='));
    const baselineArgument = process.argv.find(value => value.startsWith('--baseline='));
    const candidatesArgument = process.argv.find(value => value.startsWith('--candidates='));
    const concurrencyArgument = process.argv.find(value => value.startsWith('--concurrency='));
    const limit = limitArgument ? Number(limitArgument.split('=')[1]) : undefined;
    const concurrency = concurrencyArgument ? Number(concurrencyArgument.split('=')[1]) : 1;
    const candidateIds = candidatesArgument
        ? candidatesArgument.slice('--candidates='.length).split(',').map(value => value.trim()).filter(Boolean)
        : CANDIDATES.filter(candidate => !candidate.experimental).map(candidate => candidate.id);
    const unknownCandidates = candidateIds.filter(id => !CANDIDATES.some(candidate => candidate.id === id));
    if (unknownCandidates.length) {
        throw new Error(`Unknown candidates: ${unknownCandidates.join(', ')}.`);
    }
    return {
        full: values.has('--full'),
        noJudge: values.has('--no-judge'),
        limit: Number.isInteger(limit) && limit > 0 ? limit : undefined,
        concurrency: Number.isInteger(concurrency) && concurrency > 0 ? Math.min(concurrency, 4) : 1,
        candidateIds,
        examplesPath: examplesArgument ? examplesArgument.slice('--examples='.length) : undefined,
        baselinePath: baselineArgument ? baselineArgument.slice('--baseline='.length) : undefined,
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
            plannerGuidance: candidate.plannerGuidance,
            plannerExamples: candidate.plannerModel === VIDEO_PLANNER_FAST_MODEL
                ? plannerExamples.filter(example => example.prompt.trim().toLocaleLowerCase()
                    !== prompt.trim().toLocaleLowerCase()).slice(0, 3)
                : undefined,
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
    const activeCandidates = CANDIDATES.filter(candidate => options.candidateIds.includes(candidate.id));
    let examplesReport = null;
    if (options.examplesPath) {
        examplesReport = JSON.parse(await readFile(resolve(options.examplesPath), 'utf8'));
        process.stdout.write(`Loaded ${teacherExamplesFromReport(examplesReport).length} teacher examples.\n`);
    }
    let baselineReport = null;
    const baselinePath = options.baselinePath ? resolve(options.baselinePath) : null;
    if (baselinePath) {
        baselineReport = JSON.parse(await readFile(baselinePath, 'utf8'));
    }
    const cases = await mapWithConcurrency(prompts, options.concurrency, async prompt => {
        process.stdout.write(`Planning: ${prompt}\n`);
        const plannerExamples = examplesReport ? selectTeacherExamples(examplesReport, prompt) : [];
        const generated = await Promise.all(activeCandidates.map(async candidate => {
            const reusable = candidate.id === 'sol-high-high'
                ? reportCandidate(baselineReport, prompt, candidate.id)
                : null;
            if (!reusable) return generateCandidate(prompt, candidate, plannerExamples);
            process.stdout.write(`Reused ${candidate.id}: ${prompt}\n`);
            return {
                ...structuredClone(reusable),
                reused: true,
                source_report: baselinePath,
            };
        }));
        const judgment = options.noJudge ? null : await judgeCandidates(prompt, generated);
        return { prompt, generated, judgment };
    });
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
    const teacherExamples = teacherExamplesFromReport({ cases });
    const report = {
        created_at: new Date().toISOString(),
        mode: options.full ? 'full' : 'quick',
        benchmark_options: {
            prompt_concurrency: options.concurrency,
            baseline_report: baselinePath,
            examples_report: options.examplesPath ? resolve(options.examplesPath) : null,
        },
        candidates: activeCandidates,
        cases,
        summary: summarizeBenchmarkCases(cases),
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
