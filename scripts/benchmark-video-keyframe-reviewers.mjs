#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { GoogleGenAI } from '@google/genai';

import { config } from '../dist/Config.js';
import { buildVideoKeyframeReviewPrompt } from '../dist/VideoKeyframeProvider.js';

const REVIEW_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['acceptable', 'issues', 'correction_prompt'],
    properties: {
        acceptable: { type: 'boolean' },
        issues: {
            type: 'array',
            maxItems: 8,
            items: { type: 'string' },
        },
        correction_prompt: { type: 'string' },
    },
};

const CANDIDATES = {
    'sol-low': { provider: 'openai', model: 'gpt-5.6-sol', reasoning: 'low', imageDetail: 'high' },
    'sol-medium': { provider: 'openai', model: 'gpt-5.6-sol', reasoning: 'medium', imageDetail: 'high' },
    'sol-high-low-detail': { provider: 'openai', model: 'gpt-5.6-sol', reasoning: 'high', imageDetail: 'low' },
    'gemini-flash-low': { provider: 'google', model: 'gemini-3.7-flash', reasoning: 'low' },
};

function parseArgs() {
    const report = process.argv.find(value => value.startsWith('--report='))?.slice('--report='.length);
    const candidates = process.argv.find(value => value.startsWith('--candidates='))
        ?.slice('--candidates='.length).split(',').filter(Boolean) || ['sol-low', 'gemini-flash-low'];
    const output = process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length);
    const limitValue = Number(process.argv.find(value => value.startsWith('--limit='))?.slice('--limit='.length));
    if (!report) throw new Error('Pass --report=<keyframe benchmark report.json>.');
    for (const candidate of candidates) {
        if (!CANDIDATES[candidate]) throw new Error(`Unknown candidate: ${candidate}`);
    }
    return {
        report: resolve(report),
        candidates,
        output: output ? resolve(output) : undefined,
        limit: Number.isInteger(limitValue) && limitValue > 0 ? limitValue : undefined,
        stopOnFalseAccept: process.argv.includes('--stop-on-false-accept'),
    };
}

function outputText(response) {
    if (typeof response?.output_text === 'string' && response.output_text.trim()) {
        return response.output_text.trim();
    }
    for (const item of response?.output || []) {
        for (const content of item?.content || []) {
            if (content?.type === 'output_text' && typeof content.text === 'string') return content.text.trim();
        }
    }
    throw new Error(response?.error?.message || 'Reviewer returned no output text.');
}

function percentile(values, fraction) {
    if (!values.length) return null;
    const ordered = [...values].sort((a, b) => a - b);
    return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}

function loadCases(report, limit) {
    const cases = report.cases.flatMap((testCase, caseIndex) => {
        const ratings = testCase?.judgment?.ratings || [];
        const generated = new Map((testCase.generated || []).map(candidate => [candidate.candidate, candidate]));
        return ratings.flatMap(rating => {
            const candidate = generated.get(rating.candidate);
            if (!candidate?.ok || !candidate?.image_path || typeof rating.acceptable !== 'boolean') return [];
            return [{
                id: `case-${caseIndex + 1}-${rating.candidate}`,
                prompt: testCase.prompt,
                planPath: resolve(
                    testCase.plan_path
                    || resolve(candidate.image_path, '..', '..', `case-${caseIndex + 1}-plan.json`),
                ),
                imagePath: resolve(candidate.image_path),
                mimeType: candidate.mime_type,
                expected: rating.acceptable,
            }];
        });
    });
    return cases.slice(0, limit || Number.POSITIVE_INFINITY);
}

async function reviewOpenAI(candidate, prompt, image, mimeType) {
    const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${config.openaiApiKey}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: candidate.model,
            service_tier: 'priority',
            reasoning: { effort: candidate.reasoning },
            instructions: 'You are the final visual quality gate for an expensive image-to-video render. Judge only visible evidence and physical continuity. Output the required JSON.',
            input: [{
                role: 'user',
                content: [
                    { type: 'input_text', text: prompt },
                    { type: 'input_text', text: 'CANDIDATE FRAME ZERO:' },
                    {
                        type: 'input_image',
                        image_url: `data:${mimeType};base64,${image.toString('base64')}`,
                        detail: candidate.imageDetail,
                    },
                ],
            }],
            text: {
                verbosity: 'low',
                format: {
                    type: 'json_schema',
                    name: 'video_keyframe_review',
                    strict: true,
                    schema: REVIEW_SCHEMA,
                },
            },
            max_output_tokens: 4000,
            store: false,
        }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message || `OpenAI returned HTTP ${response.status}.`);
    return {
        review: JSON.parse(outputText(body)),
        model: body.model || candidate.model,
        usage: body.usage,
    };
}

async function reviewGemini(candidate, prompt, image, mimeType) {
    const client = new GoogleGenAI({ apiKey: config.geminiApiKey, apiVersion: 'v1alpha' });
    const response = await client.models.generateContent({
        model: candidate.model,
        contents: [{
            role: 'user',
            parts: [
                { text: prompt },
                { text: 'CANDIDATE FRAME ZERO:' },
                { inlineData: { mimeType, data: image.toString('base64') } },
            ],
        }],
        config: {
            systemInstruction: 'You are the final visual quality gate for an expensive image-to-video render. Judge only visible evidence and physical continuity. Output the required JSON.',
            responseMimeType: 'application/json',
            responseJsonSchema: {
                ...REVIEW_SCHEMA,
                properties: {
                    ...REVIEW_SCHEMA.properties,
                    issues: { type: 'array', items: { type: 'string' } },
                },
            },
            maxOutputTokens: 4000,
            thinkingConfig: { thinkingLevel: candidate.reasoning.toUpperCase() },
        },
    });
    if (!response.text?.trim()) throw new Error('Gemini returned no output text.');
    return {
        review: JSON.parse(response.text),
        model: response.modelVersion || candidate.model,
        usage: response.usageMetadata,
    };
}

async function reviewCase(candidateId, testCase) {
    const candidate = CANDIDATES[candidateId];
    const [planText, image] = await Promise.all([
        readFile(testCase.planPath, 'utf8'),
        readFile(testCase.imagePath),
    ]);
    const prompt = buildVideoKeyframeReviewPrompt(JSON.parse(planText), []);
    const started = performance.now();
    try {
        const result = candidate.provider === 'openai'
            ? await reviewOpenAI(candidate, prompt, image, testCase.mimeType)
            : await reviewGemini(candidate, prompt, image, testCase.mimeType);
        const actual = result.review.acceptable;
        if (typeof actual !== 'boolean') throw new Error('Reviewer returned invalid acceptable field.');
        return {
            ...testCase,
            candidate: candidateId,
            ok: true,
            actual,
            agrees: actual === testCase.expected,
            falseAccept: !testCase.expected && actual,
            falseReject: testCase.expected && !actual,
            durationSeconds: (performance.now() - started) / 1000,
            model: result.model,
            issues: result.review.issues,
            usage: result.usage,
        };
    } catch (error) {
        return {
            ...testCase,
            candidate: candidateId,
            ok: false,
            durationSeconds: (performance.now() - started) / 1000,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function summarize(candidate, results) {
    const successful = results.filter(result => result.ok);
    const durations = successful.map(result => result.durationSeconds);
    return {
        candidate,
        samples: results.length,
        successful: successful.length,
        errors: results.length - successful.length,
        agreement: successful.filter(result => result.agrees).length,
        falseAccepts: successful.filter(result => result.falseAccept).length,
        falseRejects: successful.filter(result => result.falseReject).length,
        meanSeconds: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
        p50Seconds: percentile(durations, 0.5),
        p95Seconds: percentile(durations, 0.95),
    };
}

async function main() {
    const options = parseArgs();
    const teacherReport = JSON.parse(await readFile(options.report, 'utf8'));
    const cases = loadCases(teacherReport, options.limit);
    if (!cases.length) throw new Error('No judged keyframe cases found.');
    const results = [];
    for (const candidate of options.candidates) {
        for (const testCase of cases) {
            process.stderr.write(`${candidate}: ${testCase.id}\n`);
            const result = await reviewCase(candidate, testCase);
            results.push(result);
            if (options.stopOnFalseAccept && result.falseAccept) break;
        }
    }
    const report = {
        createdAt: new Date().toISOString(),
        teacherReport: options.report,
        cases: cases.length,
        expectedAccepts: cases.filter(testCase => testCase.expected).length,
        expectedRejects: cases.filter(testCase => !testCase.expected).length,
        summaries: options.candidates.map(candidate => summarize(
            candidate,
            results.filter(result => result.candidate === candidate),
        )),
        results,
    };
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) {
        await mkdir(dirname(options.output), { recursive: true });
        await writeFile(options.output, output);
    }
    process.stdout.write(output);
}

await main();
