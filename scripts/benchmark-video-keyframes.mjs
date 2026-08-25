#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { config } from '../dist/Config.js';
import {
    VIDEO_KEYFRAME_FAST_LITE_MODEL,
    VIDEO_KEYFRAME_FAST_MODEL,
    VIDEO_KEYFRAME_MODEL,
    VIDEO_KEYFRAME_REVIEW_MODEL,
    buildVideoKeyframeReviewPrompt,
    generateFrontierVideoKeyframeCandidate,
} from '../dist/VideoKeyframeProvider.js';
import { mapWithConcurrency, summarizeBenchmarkCases } from './video-planner-benchmark-lib.mjs';

const CANDIDATES = [
    { id: 'gemini-pro-2k', geminiModel: VIDEO_KEYFRAME_MODEL, imageSize: '2K' },
    { id: 'gemini-flash-2k', geminiModel: VIDEO_KEYFRAME_FAST_MODEL, imageSize: '2K' },
    { id: 'gemini-flash-lite-1k', geminiModel: VIDEO_KEYFRAME_FAST_LITE_MODEL, imageSize: '1K' },
];

function args() {
    const values = new Set(process.argv.slice(2));
    const plansArgument = process.argv.find(value => value.startsWith('--plans='));
    const limitArgument = process.argv.find(value => value.startsWith('--limit='));
    const concurrencyArgument = process.argv.find(value => value.startsWith('--concurrency='));
    const resumeArgument = process.argv.find(value => value.startsWith('--resume='));
    const limit = Number(limitArgument?.slice('--limit='.length));
    const concurrency = Number(concurrencyArgument?.slice('--concurrency='.length));
    if (!plansArgument) throw new Error('Pass a planner benchmark report with --plans=<report.json>.');
    return {
        plansPath: resolve(plansArgument.slice('--plans='.length)),
        limit: Number.isInteger(limit) && limit > 0 ? limit : undefined,
        concurrency: Number.isInteger(concurrency) && concurrency > 0 ? Math.min(concurrency, 2) : 1,
        resumePath: resumeArgument ? resolve(resumeArgument.slice('--resume='.length)) : undefined,
        noJudge: values.has('--no-judge'),
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
    throw new Error(response?.error?.message || 'Keyframe judge returned no rating.');
}

function extension(mimeType) {
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/webp') return 'webp';
    return 'png';
}

function solPlans(report) {
    return (report?.cases || []).flatMap(testCase => {
        const generated = (testCase.generated || [])
            .find(candidate => candidate.candidate === 'sol-high-high' && candidate.ok);
        return generated?.plan?.keyframe?.recommended === true
            ? [{ prompt: testCase.prompt, plan: generated.plan }]
            : [];
    });
}

async function generateCandidate(testCase, candidate, caseIndex, directory) {
    const usage = [];
    const attempts = [];
    const started = performance.now();
    try {
        for (const candidateExtension of ['png', 'jpg', 'webp']) {
            const cachedPath = resolve(directory, `case-${caseIndex + 1}-${candidate.id}.${candidateExtension}`);
            try {
                const bytes = await readFile(cachedPath);
                const mimeType = candidateExtension === 'jpg'
                    ? 'image/jpeg'
                    : `image/${candidateExtension}`;
                return {
                    candidate: candidate.id,
                    ok: true,
                    image: { bytes, mimeType, provider: 'google', model: candidate.geminiModel },
                    report: {
                        candidate: candidate.id,
                        duration_seconds: 0,
                        ok: true,
                        reused: true,
                        provider: 'google',
                        model: candidate.geminiModel,
                        mime_type: mimeType,
                        bytes: bytes.length,
                        image_path: cachedPath,
                        usage,
                        attempts,
                    },
                };
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
        }
        const image = await generateFrontierVideoKeyframeCandidate(testCase.plan, [], {
            geminiModel: candidate.geminiModel,
            imageSize: candidate.imageSize,
            aspectRatio: '16:9',
            onUsage: event => usage.push(event),
            onAttempt: event => attempts.push(event),
        });
        const durationSeconds = (performance.now() - started) / 1000;
        const imagePath = resolve(directory, `case-${caseIndex + 1}-${candidate.id}.${extension(image.mimeType)}`);
        await writeFile(imagePath, image.bytes, { flag: 'wx' });
        return {
            candidate: candidate.id,
            ok: true,
            image,
            report: {
                candidate: candidate.id,
                duration_seconds: durationSeconds,
                ok: true,
                provider: image.provider,
                model: image.model,
                mime_type: image.mimeType,
                bytes: image.bytes.length,
                image_path: imagePath,
                usage,
                attempts,
            },
        };
    } catch (error) {
        return {
            candidate: candidate.id,
            ok: false,
            report: {
                candidate: candidate.id,
                duration_seconds: (performance.now() - started) / 1000,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                usage,
                attempts,
            },
        };
    }
}

async function judgeCandidates(testCase, generated, caseIndex) {
    const successful = generated.filter(value => value.ok);
    if (!successful.length) return null;
    const offset = caseIndex % successful.length;
    const ordered = [...successful.slice(offset), ...successful.slice(0, offset)];
    const labels = ordered.map((value, index) => ({
        label: String.fromCharCode(65 + index),
        candidate: value.candidate,
        image: value.image,
    }));
    const labelValues = labels.map(value => value.label);
    const schema = {
        type: 'object', additionalProperties: false,
        required: ['ratings', 'winner', 'explanation'],
        properties: {
            ratings: {
                type: 'array', minItems: labels.length, maxItems: labels.length,
                items: {
                    type: 'object', additionalProperties: false,
                    required: ['label', 'prompt_fidelity', 'frame_zero_continuity', 'composition', 'visual_coherence', 'overall', 'acceptable', 'critical_failures'],
                    properties: {
                        label: { type: 'string', enum: labelValues },
                        prompt_fidelity: { type: 'number', minimum: 1, maximum: 10 },
                        frame_zero_continuity: { type: 'number', minimum: 1, maximum: 10 },
                        composition: { type: 'number', minimum: 1, maximum: 10 },
                        visual_coherence: { type: 'number', minimum: 1, maximum: 10 },
                        overall: { type: 'number', minimum: 1, maximum: 10 },
                        acceptable: { type: 'boolean' },
                        critical_failures: { type: 'array', maxItems: 8, items: { type: 'string' } },
                    },
                },
            },
            winner: { type: 'string', enum: [...labelValues, 'none'] },
            explanation: { type: 'string' },
        },
    };
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const response = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${config.openaiApiKey}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: VIDEO_KEYFRAME_REVIEW_MODEL,
                reasoning: { effort: 'high' },
                instructions: 'You are a blinded visual evaluator for expensive MiniMax H3 image-to-video renders. Judge only visible evidence and physical frame-zero continuity. Provider and resolution are undisclosed. A candidate is acceptable only if it could be sent to H3 without correction.',
                input: [{
                    role: 'user',
                    content: [
                        { type: 'input_text', text: buildVideoKeyframeReviewPrompt(testCase.plan, []) },
                        { type: 'input_text', text: 'Compare every candidate independently. Penalize text artifacts, malformed anatomy or geometry, wrong counts, already-completed transformations, missing visual evidence, and motion that cannot continue from this exact frame.' },
                        ...labels.flatMap(value => ([
                            { type: 'input_text', text: `CANDIDATE ${value.label}:` },
                            { type: 'input_image', image_url: `data:${value.image.mimeType};base64,${value.image.bytes.toString('base64')}`, detail: 'high' },
                        ])),
                    ],
                }],
                text: {
                    verbosity: 'low',
                    format: { type: 'json_schema', name: 'video_keyframe_benchmark', strict: true, schema },
                },
                max_output_tokens: attempt === 1 ? 12_000 : 24_000,
                prompt_cache_key: 'video-keyframe-benchmark-teacher-v1',
                store: false,
            }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error?.message || `Keyframe judge returned HTTP ${response.status}.`);
        try {
            if (body?.status && body.status !== 'completed') {
                throw new Error(`Keyframe judge response was ${body.status}.`);
            }
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
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error('Keyframe judge returned invalid JSON.');
}

async function main() {
    const options = args();
    const sourceReport = JSON.parse(await readFile(options.plansPath, 'utf8'));
    const cases = solPlans(sourceReport).slice(0, options.limit || Number.POSITIVE_INFINITY);
    if (!cases.length) throw new Error('The supplied report contains no reusable Sol keyframe plans.');
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const directory = options.resumePath || resolve('artifacts/video-keyframe-benchmarks', stamp);
    await mkdir(resolve(directory, 'images'), { recursive: true });
    const results = await mapWithConcurrency(cases, options.concurrency, async (testCase, caseIndex) => {
        process.stdout.write(`Keyframes: ${testCase.prompt}\n`);
        const planPath = resolve(directory, `case-${caseIndex + 1}-plan.json`);
        try {
            await writeFile(planPath, `${JSON.stringify(testCase.plan, null, 2)}\n`, { flag: 'wx' });
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
        }
        const generated = await Promise.all(CANDIDATES.map(candidate =>
            generateCandidate(testCase, candidate, caseIndex, resolve(directory, 'images'))));
        const judgment = options.noJudge ? null : await judgeCandidates(testCase, generated, caseIndex);
        return {
            prompt: testCase.prompt,
            planner_fingerprint: testCase.plan._planner_fingerprint || null,
            plan_path: planPath,
            generated: generated.map(value => value.report),
            judgment,
        };
    });
    const report = {
        created_at: new Date().toISOString(),
        source_plans: options.plansPath,
        source_report: basename(options.plansPath),
        prompt_concurrency: options.concurrency,
        candidates: CANDIDATES,
        cases: results,
        summary: summarizeBenchmarkCases(results),
    };
    let reportPath = resolve(directory, 'report.json');
    try {
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        reportPath = resolve(directory, `report-${stamp}.json`);
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    }
    process.stdout.write(`Report: ${reportPath}\n`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
