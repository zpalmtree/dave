#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

import { config } from '../dist/Config.js';
import {
    VIDEO_KEYFRAME_REVIEW_MODEL,
    buildVideoKeyframeReviewPrompt,
} from '../dist/VideoKeyframeProvider.js';

function argument(name, fallback) {
    const prefix = `--${name}=`;
    const value = process.argv.find(candidate => candidate.startsWith(prefix));
    return value ? value.slice(prefix.length) : fallback;
}

function outputText(response) {
    if (typeof response?.output_text === 'string' && response.output_text.trim()) {
        return response.output_text.trim();
    }
    for (const item of response?.output || []) {
        for (const content of item?.content || []) {
            if (content?.type === 'output_text' && typeof content.text === 'string') {
                return content.text.trim();
            }
        }
    }
    throw new Error(response?.error?.message || 'Keyframe judge returned no output text.');
}

function mimeType(path) {
    const extension = extname(path).toLowerCase();
    if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
    if (extension === '.webp') return 'image/webp';
    return 'image/png';
}

function schema(labels) {
    return {
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
                    required: [
                        'label', 'prompt_fidelity', 'frame_zero_continuity', 'composition',
                        'visual_coherence', 'detail_quality', 'overall', 'acceptable',
                        'critical_failures',
                    ],
                    properties: {
                        label: { type: 'string', enum: labels },
                        prompt_fidelity: { type: 'number', minimum: 1, maximum: 10 },
                        frame_zero_continuity: { type: 'number', minimum: 1, maximum: 10 },
                        composition: { type: 'number', minimum: 1, maximum: 10 },
                        visual_coherence: { type: 'number', minimum: 1, maximum: 10 },
                        detail_quality: { type: 'number', minimum: 1, maximum: 10 },
                        overall: { type: 'number', minimum: 1, maximum: 10 },
                        acceptable: { type: 'boolean' },
                        critical_failures: {
                            type: 'array',
                            maxItems: 8,
                            items: { type: 'string' },
                        },
                    },
                },
            },
            winner: { type: 'string', enum: [...labels, 'none'] },
            explanation: { type: 'string' },
        },
    };
}

async function judge(plan, candidates, runIndex) {
    const ordered = runIndex % 2 === 0 ? candidates : [...candidates].reverse();
    const labelled = ordered.map((candidate, index) => ({
        ...candidate,
        label: String.fromCharCode(65 + index),
    }));
    const content = [
        { type: 'input_text', text: buildVideoKeyframeReviewPrompt(plan, []) },
        {
            type: 'input_text',
            text: [
                'Compare every candidate independently and only from visible evidence.',
                'Candidate provenance, sampling settings, speed, and ordering are undisclosed.',
                'Penalize malformed anatomy or geometry, wrong counts, text artifacts, missing requested evidence, already-completed action, and a pose or camera axis that cannot naturally continue into the planned first second.',
                'A candidate is acceptable only if it can be sent to MiniMax H3 without correction.',
            ].join(' '),
        },
    ];
    for (const candidate of labelled) {
        const bytes = await readFile(candidate.image_path);
        content.push({ type: 'input_text', text: `CANDIDATE ${candidate.label}:` });
        content.push({
            type: 'input_image',
            image_url: `data:${mimeType(candidate.image_path)};base64,${bytes.toString('base64')}`,
            detail: 'high',
        });
    }

    const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${config.openaiApiKey}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: VIDEO_KEYFRAME_REVIEW_MODEL,
            service_tier: 'priority',
            reasoning: { effort: 'high' },
            instructions: 'You are a strict blinded senior visual evaluator for expensive MiniMax H3 image-to-video renders. A more realistic or detailed look is not automatically better; reward faithful, coherent, motion-ready execution of the exact screenplay.',
            input: [{ role: 'user', content }],
            text: {
                verbosity: 'low',
                format: {
                    type: 'json_schema',
                    name: 'video_keyframe_comparison',
                    strict: true,
                    schema: schema(labelled.map(candidate => candidate.label)),
                },
            },
            max_output_tokens: 12_000,
            prompt_cache_key: 'video-keyframe-comparison-v1',
            store: false,
        }),
    });
    const body = await response.json();
    if (!response.ok) {
        throw new Error(body?.error?.message || `Keyframe judge returned HTTP ${response.status}.`);
    }
    if (body?.status && body.status !== 'completed') {
        throw new Error(`Keyframe judge response was ${body.status}.`);
    }
    const judgment = JSON.parse(outputText(body));
    return {
        ...judgment,
        run: runIndex + 1,
        ratings: judgment.ratings.map(rating => ({
            ...rating,
            candidate: labelled.find(candidate => candidate.label === rating.label)?.id,
        })),
        winner_candidate: labelled.find(candidate => candidate.label === judgment.winner)?.id
            || judgment.winner,
        usage: body.usage,
    };
}

function aggregate(candidates, judgments) {
    const metrics = [
        'prompt_fidelity', 'frame_zero_continuity', 'composition', 'visual_coherence',
        'detail_quality', 'overall',
    ];
    return candidates.map(candidate => {
        const ratings = judgments.flatMap(judgment => judgment.ratings)
            .filter(rating => rating.candidate === candidate.id);
        return {
            candidate: candidate.id,
            render_seconds: candidate.render_seconds,
            averages: Object.fromEntries(metrics.map(metric => [
                metric,
                Number((ratings.reduce((sum, rating) => sum + rating[metric], 0)
                    / ratings.length).toFixed(3)),
            ])),
            acceptable_votes: ratings.filter(rating => rating.acceptable).length,
            total_votes: ratings.length,
            winner_votes: judgments.filter(
                judgment => judgment.winner_candidate === candidate.id,
            ).length,
            critical_failures: [...new Set(ratings.flatMap(rating => rating.critical_failures))],
        };
    });
}

async function main() {
    const specArgument = argument('spec');
    if (!specArgument) throw new Error('Pass --spec=<keyframe-comparison.json>.');
    const specPath = resolve(specArgument);
    const spec = JSON.parse(await readFile(specPath, 'utf8'));
    if (!Array.isArray(spec.cases) || !spec.cases.length) {
        throw new Error('Spec requires a non-empty cases array.');
    }
    const judgeRuns = Math.max(1, Math.min(4, Number(argument('judge-runs', '2')) || 2));
    const results = [];
    for (const testCase of spec.cases) {
        if (!testCase.plan_path || !Array.isArray(testCase.candidates)
            || testCase.candidates.length < 2) {
            throw new Error(`Case ${testCase.id || '[unknown]'} requires a plan and two candidates.`);
        }
        process.stdout.write(`Comparing ${testCase.id}...\n`);
        const document = JSON.parse(await readFile(resolve(testCase.plan_path), 'utf8'));
        const plan = document.plan || document;
        const candidates = testCase.candidates.map(candidate => ({
            ...candidate,
            image_path: resolve(candidate.image_path),
        }));
        const judgments = [];
        for (let runIndex = 0; runIndex < judgeRuns; runIndex += 1) {
            process.stdout.write(`  Blinded judge ${runIndex + 1}/${judgeRuns}...\n`);
            judgments.push(await judge(plan, candidates, runIndex));
        }
        results.push({
            id: testCase.id,
            prompt: testCase.prompt,
            plan_path: resolve(testCase.plan_path),
            candidates,
            judgments,
            aggregate: aggregate(candidates, judgments),
        });
    }
    const report = {
        created_at: new Date().toISOString(),
        spec_path: specPath,
        judge_model: VIDEO_KEYFRAME_REVIEW_MODEL,
        judge_runs: judgeRuns,
        cases: results,
    };
    const outputPath = resolve(argument('output', resolve(specPath, '..', 'report.json')));
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`Saved ${outputPath}\n`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
