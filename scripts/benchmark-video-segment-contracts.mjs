#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import sqlite3 from 'sqlite3';

import { AI_MODELS } from '../dist/AIModels.js';
import { config } from '../dist/Config.js';
import {
    VIDEO_KEYFRAME_MODEL,
    VIDEO_KEYFRAME_REVIEW_MODEL,
    generateFrontierVideoKeyframeCandidate,
} from '../dist/VideoKeyframeProvider.js';
import { mapWithConcurrency } from './video-planner-benchmark-lib.mjs';

const MOTION_FIELDS = [
    'subject_orientation',
    'gaze_direction',
    'travel_direction',
    'camera_relation',
    'first_second_action',
];

function args() {
    const value = name => process.argv.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3);
    const dbPath = value('db');
    const jobId = value('job');
    const referencePath = value('reference');
    const outputPath = value('output');
    const contractsPath = value('contracts');
    const contractPlanner = value('contract-planner') || 'sol';
    const segments = String(value('segments') || '')
        .split(',')
        .map(item => Number(item.trim()))
        .filter(item => Number.isInteger(item) && item > 0);
    const concurrency = Number(value('concurrency'));
    const replicates = Number(value('replicates'));
    if (!dbPath || !jobId || !referencePath) {
        throw new Error('Usage: --db=<queue.sqlite3> --job=<id> --reference=<opening image> [--output=<dir>]');
    }
    return {
        dbPath: resolve(dbPath),
        jobId,
        referencePath: resolve(referencePath),
        outputPath: outputPath ? resolve(outputPath) : null,
        contractsPath: contractsPath ? resolve(contractsPath) : null,
        contractPlanner,
        segments,
        concurrency: Number.isInteger(concurrency) && concurrency > 0 ? Math.min(2, concurrency) : 2,
        replicates: Number.isInteger(replicates) && replicates > 0 ? Math.min(3, replicates) : 1,
    };
}

function outputText(response) {
    if (typeof response?.output_text === 'string' && response.output_text.trim()) return response.output_text.trim();
    for (const item of response?.output || []) {
        for (const content of item?.content || []) {
            if (content?.type === 'output_text' && typeof content.text === 'string') return content.text.trim();
        }
    }
    throw new Error(response?.error?.message || 'Model returned no text.');
}

function getRow(dbPath, sql, parameters) {
    return new Promise((resolveRow, reject) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, error => {
            if (error) reject(error);
        });
        db.get(sql, parameters, (error, row) => {
            db.close();
            if (error) reject(error);
            else resolveRow(row);
        });
    });
}

function imageExtension(mimeType) {
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/webp') return 'webp';
    return 'png';
}

function derivedPlan(plan, segmentIndex, contract = null) {
    const segment = plan.segments[segmentIndex - 1];
    const shot = segment.shots[0];
    const title = String(segment.title || `Segment ${segmentIndex}`).trim();
    const visual = String(shot.visual || '').trim();
    const camera = String(shot.camera || '').trim();
    return {
        intent: String(plan.intent || visual),
        continuity_bible: String(plan.continuity_bible || ''),
        keyframe: contract ? {
            recommended: true,
            reason: `Preserve recurring identity across the ${segment.transition} into ${title}.`,
            prompt: contract.prompt,
            reference_requirements: [],
            motion_contract: contract.motion_contract,
        } : {
            recommended: true,
            reason: `Preserve the recurring cast across the ${segment.transition} into ${title}.`,
            prompt: [
                `Opening still for segment ${segmentIndex}, ${title}: ${visual}`,
                `Camera and framing: ${camera}.`,
                'Use the supplied identity reference to depict the same recognizable recurring person or people in this new shot composition.',
                'Preserve their facial identity, body proportions, hair, skin tone, and defining appearance while placing them in the pose, wardrobe, environment, lighting, and action required by this segment.',
                'Show one frozen, motion-ready instant at 0.00 seconds of this segment.',
            ].join(' '),
            reference_requirements: [],
            motion_contract: {
                subject_orientation: 'Orient each recurring subject for the opening action described by this segment.',
                gaze_direction: 'Direct each subject gaze toward the focus of the opening action.',
                travel_direction: 'Show the travel vector implied by the opening action and composition.',
                camera_relation: camera,
                first_second_action: `Continue directly into this action: ${visual}`,
            },
        },
        segments: [segment],
    };
}

async function planContracts(job, plan, targets, contractPlanner) {
    const contractSchema = {
        type: 'object',
        additionalProperties: false,
        required: ['contracts'],
        properties: {
            contracts: {
                type: 'array',
                minItems: targets.length,
                maxItems: targets.length,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['segment_index', 'prompt', 'motion_contract'],
                    properties: {
                        segment_index: { type: 'integer', enum: targets },
                        prompt: { type: 'string' },
                        motion_contract: {
                            type: 'object',
                            additionalProperties: false,
                            required: MOTION_FIELDS,
                            properties: Object.fromEntries(MOTION_FIELDS.map(field => [field, { type: 'string' }])),
                        },
                    },
                },
            },
        },
    };
    const segmentContext = targets.map(segmentIndex => ({
        segment_index: segmentIndex,
        previous_segment: plan.segments[segmentIndex - 2] || null,
        target_segment: plan.segments[segmentIndex - 1],
    }));
    const started = performance.now();
    const instructions = [
        'You write exact frame-zero contracts for hard-cut image-to-video segments.',
        'Do not rewrite the screenplay. For each target, prompt describes only the frozen visible state at precisely 0.00 seconds, never a sequence or completed beat.',
        'Move all change after frame zero into first_second_action. If the shot says approach, board, insert, ignite, land, step, reveal, open, or transform, stage the instant immediately before or at the onset so H3 can visibly perform it.',
        'Make subject orientation, gaze, physical front or vehicle nose, travel vector, visible path ahead, lead room, camera side, and vanishing direction mutually consistent.',
        'Preserve recurring identity, closed cast/count, wardrobe, props, scale, location, and the distinctive user premise. Use positive-only visual wording.',
        'Return one contract for every requested segment index.',
    ].join('\n');
    const inputText = [
        `Original request: ${job.prompt}`,
        `Intent: ${plan.intent}`,
        `Continuity bible: ${plan.continuity_bible}`,
        `Targets: ${JSON.stringify(segmentContext)}`,
    ].join('\n');
    if (contractPlanner === 'gemini-flash') {
        const client = new GoogleGenAI({ apiKey: config.geminiApiKey, apiVersion: 'v1alpha' });
        const compatible = JSON.parse(JSON.stringify(contractSchema));
        const stripUnsupported = value => {
            if (Array.isArray(value)) return value.map(stripUnsupported);
            if (!value || typeof value !== 'object') return value;
            return Object.fromEntries(Object.entries(value)
                .filter(([key]) => !['additionalProperties', 'minItems', 'maxItems'].includes(key))
                .map(([key, nested]) => [key, stripUnsupported(nested)]));
        };
        const response = await client.models.generateContent({
            model: AI_MODELS.geminiChat,
            contents: [{ role: 'user', parts: [{ text: inputText }] }],
            config: {
                systemInstruction: instructions,
                responseMimeType: 'application/json',
                responseJsonSchema: stripUnsupported(compatible),
                maxOutputTokens: 8_000,
                thinkingConfig: { thinkingLevel: 'LOW' },
            },
        });
        const parsed = JSON.parse(String(response.text || ''));
        const contracts = new Map(parsed.contracts.map(contract => [Number(contract.segment_index), contract]));
        if (contracts.size !== targets.length || targets.some(segmentIndex => !contracts.has(segmentIndex))) {
            throw new Error('Gemini contract planner omitted or duplicated a target segment.');
        }
        return {
            contracts,
            report: {
                duration_seconds: (performance.now() - started) / 1000,
                model: response.modelVersion || AI_MODELS.geminiChat,
                usage: response.usageMetadata || null,
            },
        };
    }
    const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${config.openaiApiKey}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: VIDEO_KEYFRAME_REVIEW_MODEL,
            reasoning: { effort: 'high' },
            instructions,
            input: [{
                role: 'user',
                content: [{
                    type: 'input_text',
                    text: inputText,
                }],
            }],
            text: {
                verbosity: 'low',
                format: { type: 'json_schema', name: 'segment_frame_zero_contracts', strict: true, schema: contractSchema },
            },
            max_output_tokens: 12_000,
            store: false,
        }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message || `Contract planner returned HTTP ${response.status}.`);
    const parsed = JSON.parse(outputText(body));
    const contracts = new Map(parsed.contracts.map(contract => [Number(contract.segment_index), contract]));
    if (contracts.size !== targets.length || targets.some(segmentIndex => !contracts.has(segmentIndex))) {
        throw new Error('Contract planner omitted or duplicated a target segment.');
    }
    return {
        contracts,
        report: {
            duration_seconds: (performance.now() - started) / 1000,
            model: VIDEO_KEYFRAME_REVIEW_MODEL,
            usage: body.usage || null,
        },
    };
}

async function generateImage(testCase, candidate, replicate, references, directory) {
    const usage = [];
    const attempts = [];
    const started = performance.now();
    try {
        const image = await generateFrontierVideoKeyframeCandidate(candidate.plan, references, {
            geminiModel: VIDEO_KEYFRAME_MODEL,
            imageSize: '2K',
            aspectRatio: '16:9',
            onUsage: event => usage.push(event),
            onAttempt: event => attempts.push(event),
        });
        const imagePath = resolve(
            directory,
            `segment-${testCase.segmentIndex}-${candidate.id}-r${replicate}.${imageExtension(image.mimeType)}`,
        );
        await writeFile(imagePath, image.bytes, { flag: 'wx' });
        return {
            ...candidate,
            replicate,
            image,
            report: {
                candidate: candidate.id,
                replicate,
                ok: true,
                duration_seconds: (performance.now() - started) / 1000,
                image_path: imagePath,
                model: image.model,
                mime_type: image.mimeType,
                bytes: image.bytes.length,
                usage,
                attempts,
            },
        };
    } catch (error) {
        return {
            ...candidate,
            replicate,
            report: {
                candidate: candidate.id,
                replicate,
                ok: false,
                duration_seconds: (performance.now() - started) / 1000,
                error: error instanceof Error ? error.message : String(error),
                usage,
                attempts,
            },
        };
    }
}

async function judgePair(job, plan, testCase, pair, references, reverse) {
    const successful = pair.filter(value => value.image);
    if (successful.length !== 2) return null;
    const ordered = reverse ? [...successful].reverse() : successful;
    const labels = ordered.map((value, index) => ({ ...value, label: index === 0 ? 'A' : 'B' }));
    const schema = {
        type: 'object',
        additionalProperties: false,
        required: ['ratings', 'winner', 'explanation'],
        properties: {
            ratings: {
                type: 'array', minItems: 2, maxItems: 2,
                items: {
                    type: 'object', additionalProperties: false,
                    required: ['label', 'prompt_fidelity', 'identity_continuity', 'frame_zero_readiness', 'motion_geometry', 'visual_coherence', 'overall', 'acceptable', 'critical_failures'],
                    properties: {
                        label: { type: 'string', enum: ['A', 'B'] },
                        prompt_fidelity: { type: 'number', minimum: 1, maximum: 10 },
                        identity_continuity: { type: 'number', minimum: 1, maximum: 10 },
                        frame_zero_readiness: { type: 'number', minimum: 1, maximum: 10 },
                        motion_geometry: { type: 'number', minimum: 1, maximum: 10 },
                        visual_coherence: { type: 'number', minimum: 1, maximum: 10 },
                        overall: { type: 'number', minimum: 1, maximum: 10 },
                        acceptable: { type: 'boolean' },
                        critical_failures: { type: 'array', maxItems: 8, items: { type: 'string' } },
                    },
                },
            },
            winner: { type: 'string', enum: ['A', 'B', 'none'] },
            explanation: { type: 'string' },
        },
    };
    const previous = plan.segments[testCase.segmentIndex - 2] || null;
    const target = plan.segments[testCase.segmentIndex - 1];
    const content = [{
        type: 'input_text',
        text: [
            `Original request: ${job.prompt}`,
            `Intent: ${plan.intent}`,
            `Continuity bible: ${plan.continuity_bible}`,
            `Previous segment context: ${JSON.stringify(previous)}`,
            `Target segment that begins at this hard cut: ${JSON.stringify(target)}`,
            'Judge the visible candidates against this common screenplay, not against any hidden generation prompt.',
            'Frame 0 must contain the setup from which the target first shot can visibly unfold. Penalize a completed action, wrong cast/count/identity/wardrobe/prop/location, contradictory orientation or travel geometry, insufficient lead room, or a composition needing an immediate turn, reversal, teleport, axis crossing, or reframe.',
        ].join('\n'),
    }];
    references.forEach((reference, index) => {
        content.push({ type: 'input_text', text: `IDENTITY REFERENCE ${index + 1} (not a candidate): ${reference.visualFactsToPreserve}` });
        content.push({
            type: 'input_image',
            image_url: `data:${reference.mimeType};base64,${reference.bytes.toString('base64')}`,
            detail: 'high',
        });
    });
    labels.forEach(value => {
        content.push({ type: 'input_text', text: `CANDIDATE ${value.label}:` });
        content.push({
            type: 'input_image',
            image_url: `data:${value.image.mimeType};base64,${value.image.bytes.toString('base64')}`,
            detail: 'high',
        });
    });
    const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${config.openaiApiKey}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: VIDEO_KEYFRAME_REVIEW_MODEL,
            reasoning: { effort: 'high' },
            instructions: 'You are a blinded visual evaluator for expensive MiniMax H3 image-to-video renders. Provider and prompt variant are undisclosed. Judge only visible evidence and physical frame-zero continuity. A candidate is acceptable only if it can be sent to H3 without correction.',
            input: [{ role: 'user', content }],
            text: { verbosity: 'low', format: { type: 'json_schema', name: 'segment_contract_ab', strict: true, schema } },
            max_output_tokens: 12_000,
            store: false,
        }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message || `Judge returned HTTP ${response.status}.`);
    const judgment = JSON.parse(outputText(body));
    return {
        reverse,
        ...judgment,
        winner_candidate: labels.find(value => value.label === judgment.winner)?.id || judgment.winner,
        ratings: judgment.ratings.map(rating => ({
            ...rating,
            candidate: labels.find(value => value.label === rating.label)?.id,
        })),
        usage: body.usage || null,
    };
}

function summarize(cases, contractPlanning) {
    const candidates = ['baseline-derived', 'explicit-frame-zero'];
    return {
        contract_planning_seconds: contractPlanning.duration_seconds,
        contract_planning_usage: contractPlanning.usage,
        candidates: candidates.map(candidate => {
            const generated = cases.flatMap(testCase => testCase.generated)
                .filter(value => value.candidate === candidate);
            const ratings = cases.flatMap(testCase => testCase.judgments)
                .flatMap(judgment => judgment?.ratings || [])
                .filter(rating => rating.candidate === candidate);
            const overall = ratings.map(rating => Number(rating.overall)).filter(Number.isFinite);
            return {
                candidate,
                generated: generated.length,
                successful: generated.filter(value => value.ok).length,
                mean_generation_seconds: generated.filter(value => value.ok)
                    .reduce((sum, value, _index, values) => sum + value.duration_seconds / values.length, 0),
                judgments: ratings.length,
                acceptable: ratings.filter(rating => rating.acceptable).length,
                mean_overall: overall.reduce((sum, value) => sum + value, 0) / Math.max(1, overall.length),
                critical_failures: ratings.reduce((sum, rating) => sum + rating.critical_failures.length, 0),
                wins: cases.flatMap(testCase => testCase.judgments)
                    .filter(judgment => judgment?.winner_candidate === candidate).length,
            };
        }),
    };
}

async function main() {
    const options = args();
    const job = await getRow(
        options.dbPath,
        'SELECT public_id, prompt, planner_json, keyframe_mime FROM video_jobs WHERE public_id = ?',
        [options.jobId],
    );
    if (!job?.planner_json) throw new Error(`No stored screenplay for ${options.jobId}.`);
    const plan = JSON.parse(job.planner_json);
    let targets = plan.segments
        .map((segment, index) => ({ segment, segmentIndex: index + 1 }))
        .filter(value => value.segmentIndex >= 2 && ['cut', 'dissolve'].includes(value.segment.transition))
        .map(value => value.segmentIndex);
    if (options.segments.length) {
        const requested = new Set(options.segments);
        targets = targets.filter(segmentIndex => requested.has(segmentIndex));
    }
    if (!targets.length) throw new Error('The stored screenplay has no hard-cut segments.');
    const referenceBytes = await readFile(options.referencePath);
    const references = [{
        label: 'Recurring cast identity from frame zero',
        kind: 'identity',
        visualFactsToPreserve: 'Preserve recognizable facial identity, body proportions, hair, skin tone, wardrobe palette, and defining appearance of each recurring person shown.',
        bytes: referenceBytes,
        mimeType: String(job.keyframe_mime || '').includes('png') ? 'image/png' : 'image/jpeg',
        sourceUrl: 'historical-generated-frame-zero',
        contextUrl: 'historical-generated-frame-zero',
    }];
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const directory = options.outputPath || resolve('artifacts/video-segment-contract-benchmarks', `${options.jobId}-${stamp}`);
    const imageDirectory = resolve(directory, 'images');
    await mkdir(imageDirectory, { recursive: true });
    const planned = options.contractsPath
        ? {
            contracts: new Map(
                JSON.parse(await readFile(options.contractsPath, 'utf8'))
                    .filter(contract => targets.includes(Number(contract.segment_index)))
                    .map(contract => [Number(contract.segment_index), contract]),
            ),
            report: { duration_seconds: 0, model: VIDEO_KEYFRAME_REVIEW_MODEL, usage: null, reused: true },
        }
        : await planContracts(job, plan, targets, options.contractPlanner);
    if (planned.contracts.size !== targets.length) {
        throw new Error('Saved contracts do not cover every selected segment.');
    }
    await writeFile(resolve(directory, 'contracts.json'), `${JSON.stringify([...planned.contracts.values()], null, 2)}\n`, { flag: 'wx' });

    const cases = await mapWithConcurrency(targets, options.concurrency, async segmentIndex => {
        process.stdout.write(`Segment ${segmentIndex}: ${plan.segments[segmentIndex - 1].title}\n`);
        const testCase = { segmentIndex };
        const variants = [
            { id: 'baseline-derived', plan: derivedPlan(plan, segmentIndex) },
            { id: 'explicit-frame-zero', plan: derivedPlan(plan, segmentIndex, planned.contracts.get(segmentIndex)) },
        ];
        const generatedFull = [];
        const judgments = [];
        for (let replicate = 1; replicate <= options.replicates; replicate += 1) {
            const pair = await Promise.all(variants.map(candidate =>
                generateImage(testCase, candidate, replicate, references, imageDirectory)));
            generatedFull.push(...pair);
            judgments.push(await judgePair(job, plan, testCase, pair, references, false));
            judgments.push(await judgePair(job, plan, testCase, pair, references, true));
        }
        return {
            segment_index: segmentIndex,
            title: plan.segments[segmentIndex - 1].title,
            transition: plan.segments[segmentIndex - 1].transition,
            contract: planned.contracts.get(segmentIndex),
            generated: generatedFull.map(value => value.report),
            judgments,
        };
    });
    const report = {
        created_at: new Date().toISOString(),
        job_id: options.jobId,
        prompt: job.prompt,
        model: VIDEO_KEYFRAME_MODEL,
        image_size: '2K',
        replicates: options.replicates,
        contract_planning: planned.report,
        cases,
        summary: summarize(cases, planned.report),
    };
    const reportPath = resolve(directory, 'report.json');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\nReport: ${reportPath}\n`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
