#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';

import { AI_MODELS } from '../dist/AIModels.js';
import { config } from '../dist/Config.js';
import { evaluateDialogueContract } from './video-render-dialogue-contract.mjs';

const execFileAsync = promisify(execFile);

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
            if (content?.type === 'output_text' && typeof content.text === 'string') return content.text;
        }
    }
    throw new Error(response?.error?.message || 'Render judge returned no rating.');
}

async function run(command, args) {
    try {
        return await execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024 });
    } catch (error) {
        const detail = [error?.stdout, error?.stderr].filter(Boolean).join('\n').trim();
        throw new Error(`${command} failed${detail ? `: ${detail}` : ''}`, { cause: error });
    }
}

async function probeVideo(videoPath) {
    const { stdout } = await run('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,nb_frames',
        '-of', 'json',
        videoPath,
    ]);
    return JSON.parse(stdout);
}

async function extractVisualEvidence(candidate, outputDirectory) {
    const candidateDirectory = resolve(outputDirectory, candidate.id);
    await mkdir(candidateDirectory, { recursive: true });
    const frameZeroPath = resolve(candidateDirectory, 'frame-zero.jpg');
    const timelinePath = resolve(candidateDirectory, 'timeline-2fps.jpg');
    const audioPath = resolve(candidateDirectory, 'audio.wav');
    await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', candidate.video_path,
        '-vf', 'select=eq(n\\,0)',
        '-frames:v', '1', '-q:v', '2', frameZeroPath,
    ]);
    await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', candidate.video_path,
        '-vf', 'fps=2,scale=448:256,tile=4x4',
        '-frames:v', '1', '-q:v', '2', timelinePath,
    ]);
    await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', candidate.video_path, '-vn', '-ac', '1', '-ar', '16000', audioPath,
    ]);
    return { frameZeroPath, timelinePath, audioPath };
}

function metricValue(text, pattern) {
    const match = text.match(pattern);
    return match ? Number(match[1]) : null;
}

async function frameZeroMetrics(keyframePath, frameZeroPath, width, height) {
    const filter = `[0:v]scale=-2:${height},crop=${width}:${height}[reference];[reference][1:v]ssim`;
    const { stderr } = await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'info',
        '-i', keyframePath, '-i', frameZeroPath,
        '-lavfi', filter, '-frames:v', '1', '-f', 'null', '-',
    ]);
    return {
        ssim: metricValue(stderr, /All:([0-9.]+)/),
    };
}

async function detectTimelineProblems(videoPath) {
    const { stderr } = await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'info', '-i', videoPath,
        '-vf', 'freezedetect=n=-50dB:d=0.75,blackdetect=d=0.25:pix_th=0.10',
        '-an', '-f', 'null', '-',
    ]);
    return {
        freeze_events: [...stderr.matchAll(/freeze_start: ([0-9.]+)/g)].map(match => Number(match[1])),
        black_events: [...stderr.matchAll(/black_start:([0-9.]+) black_end:([0-9.]+)/g)]
            .map(match => ({ start: Number(match[1]), end: Number(match[2]) })),
    };
}

async function transcribeGemini(gemini, audioPath, model) {
    const data = (await readFile(audioPath)).toString('base64');
    const result = await gemini.models.generateContent({
        model,
        contents: [{
            role: 'user',
            parts: [
                {
                    text: 'Transcribe every intelligible spoken human word in this audio exactly. Do not describe sounds. If there are no intelligible spoken words, reply exactly [NO SPEECH].',
                },
                { inlineData: { mimeType: 'audio/wav', data } },
            ],
        }],
        config: { temperature: 0 },
    });
    const text = String(result.text || '').trim();
    return {
        text: /^\[NO SPEECH\]$/i.test(text) ? '' : text,
        usage: result.usageMetadata || null,
    };
}

async function transcribeVideo(openai, gemini, videoPath, audioPath, dialogueContract) {
    const models = dialogueContract?.transcription_models?.length
        ? dialogueContract.transcription_models
        : [AI_MODELS.openAITranscription];
    const runsPerModel = dialogueContract
        ? Math.max(1, Math.min(4, Number(dialogueContract.transcription_runs_per_model) || 2))
        : 1;
    const observations = await Promise.all(models.flatMap(model =>
        Array.from({ length: runsPerModel }, async (_, index) => {
            const result = model.startsWith('gemini-')
                ? await transcribeGemini(gemini, audioPath, model)
                : await openai.audio.transcriptions.create({
                    file: createReadStream(videoPath),
                    model,
                });
            return {
                model,
                run: index + 1,
                text: result.text.trim(),
                usage: result.usage || null,
            };
        })));
    const distinctText = [...new Set(observations.map(observation => observation.text).filter(Boolean))];
    return {
        text: distinctText.join(' | '),
        observations,
    };
}

async function imageInput(path) {
    const bytes = await readFile(path);
    const extension = basename(path).split('.').pop()?.toLowerCase();
    const mimeType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
    return { type: 'input_image', image_url: `data:${mimeType};base64,${bytes.toString('base64')}`, detail: 'high' };
}

function judgeSchema(labels) {
    return {
        type: 'object', additionalProperties: false,
        required: ['ratings', 'winner', 'explanation'],
        properties: {
            ratings: {
                type: 'array', minItems: labels.length, maxItems: labels.length,
                items: {
                    type: 'object', additionalProperties: false,
                    required: [
                        'label', 'prompt_fidelity', 'visual_quality', 'temporal_coherence',
                        'frame_zero_continuity', 'creative_execution', 'audio_dialogue',
                        'overall', 'acceptable', 'critical_failures',
                    ],
                    properties: {
                        label: { type: 'string', enum: labels },
                        prompt_fidelity: { type: 'number', minimum: 1, maximum: 10 },
                        visual_quality: { type: 'number', minimum: 1, maximum: 10 },
                        temporal_coherence: { type: 'number', minimum: 1, maximum: 10 },
                        frame_zero_continuity: { type: 'number', minimum: 1, maximum: 10 },
                        creative_execution: { type: 'number', minimum: 1, maximum: 10 },
                        audio_dialogue: { type: 'number', minimum: 1, maximum: 10 },
                        overall: { type: 'number', minimum: 1, maximum: 10 },
                        acceptable: { type: 'boolean' },
                        critical_failures: { type: 'array', maxItems: 10, items: { type: 'string' } },
                    },
                },
            },
            winner: { type: 'string', enum: [...labels, 'none'] },
            explanation: { type: 'string' },
        },
    };
}

async function judge(openai, spec, evidence, runIndex) {
    const ordered = runIndex % 2 === 0 ? evidence : [...evidence].reverse();
    const labelled = ordered.map((candidate, index) => ({
        ...candidate,
        label: String.fromCharCode(65 + index),
    }));
    const content = [
        {
            type: 'input_text',
            text: [
                `USER REQUEST: ${spec.prompt}`,
                `PLANNED INTENT: ${spec.intent || 'Not supplied.'}`,
                `EXPECTED DIALOGUE OR AUDIO: ${spec.expected_dialogue || 'No explicit dialogue requirement supplied.'}`,
                '',
                'Each timeline sheet contains sixteen chronological samples at 0.5-second intervals, left-to-right then top-to-bottom.',
                'Judge only supplied evidence. Treat wrong counts, missing literal constraints, absent required dialogue, broken physical continuity, severe morphing, and failure to creatively develop a vague request as critical.',
                'A candidate is acceptable only if it could be delivered without correction. Do not infer provider, source resolution, or candidate identity.',
            ].join('\n'),
        },
    ];
    for (const candidate of labelled) {
        content.push({
            type: 'input_text',
            text: [
                `CANDIDATE ${candidate.label}`,
                `ASR OBSERVATIONS: ${candidate.transcript.observations
                    .map(observation => `${observation.model} run ${observation.run}: ${observation.text || '[no recognizable speech]'}`)
                    .join(' | ')}`,
                `DETERMINISTIC DIALOGUE CONTRACT: ${candidate.dialogue_verification
                    ? JSON.stringify(candidate.dialogue_verification)
                    : '[not configured]'}`,
                `FRAME-ZERO SSIM: ${candidate.frame_zero.ssim ?? 'unavailable'}`,
                `FREEZE EVENTS: ${JSON.stringify(candidate.timeline.freeze_events)}`,
                `BLACK EVENTS: ${JSON.stringify(candidate.timeline.black_events)}`,
                'SOURCE KEYFRAME:',
            ].join('\n'),
        });
        content.push(await imageInput(candidate.keyframe_path));
        content.push({ type: 'input_text', text: 'GENERATED FRAME ZERO:' });
        content.push(await imageInput(candidate.visuals.frameZeroPath));
        content.push({ type: 'input_text', text: 'GENERATED TIMELINE:' });
        content.push(await imageInput(candidate.visuals.timelinePath));
    }

    const response = await openai.responses.create({
        model: AI_MODELS.openAIChat,
        reasoning: { effort: 'high' },
        instructions: 'You are a strict blinded senior video director and visual-effects evaluator comparing expensive MiniMax H3 renders. A higher-resolution or more realistic look is not automatically better; score faithful, coherent, inventive execution of the request.',
        input: [{ role: 'user', content }],
        text: {
            verbosity: 'low',
            format: {
                type: 'json_schema',
                name: 'video_render_benchmark',
                strict: true,
                schema: judgeSchema(labelled.map(candidate => candidate.label)),
            },
        },
        max_output_tokens: 18_000,
        prompt_cache_key: 'video-render-benchmark-teacher-v1',
        store: false,
    });
    if (response.status !== 'completed') throw new Error(`Render judge response was ${response.status}.`);
    const judgment = JSON.parse(outputText(response));
    return {
        ...judgment,
        run: runIndex + 1,
        ratings: judgment.ratings.map(rating => ({
            ...rating,
            candidate: labelled.find(candidate => candidate.label === rating.label)?.id,
        })),
        winner_candidate: labelled.find(candidate => candidate.label === judgment.winner)?.id || judgment.winner,
        usage: response.usage,
    };
}

function aggregateJudgments(evidence, judgments) {
    const metrics = [
        'prompt_fidelity', 'visual_quality', 'temporal_coherence', 'frame_zero_continuity',
        'creative_execution', 'audio_dialogue', 'overall',
    ];
    const candidates = evidence.map(candidate => {
        const ratings = judgments.flatMap(judgment => judgment.ratings)
            .filter(rating => rating.candidate === candidate.id);
        return {
            candidate: candidate.id,
            averages: Object.fromEntries(metrics.map(metric => [
                metric,
                Number((ratings.reduce((sum, rating) => sum + rating[metric], 0) / ratings.length).toFixed(3)),
            ])),
            acceptable_votes: ratings.filter(rating => rating.acceptable).length,
            total_votes: ratings.length,
            critical_failures: [...new Set(ratings.flatMap(rating => rating.critical_failures))],
            winner_votes: judgments.filter(judgment => judgment.winner_candidate === candidate.id).length,
            dialogue_verification: candidate.dialogue_verification,
        };
    });
    const eligible = candidates
        .filter(candidate => candidate.acceptable_votes > candidate.total_votes / 2
            && (!candidate.dialogue_verification || candidate.dialogue_verification.status === 'passed'))
        .sort((left, right) => right.averages.overall - left.averages.overall);
    const dialogueBlocked = candidates.some(candidate => candidate.acceptable_votes > candidate.total_votes / 2
        && candidate.dialogue_verification && candidate.dialogue_verification.status !== 'passed');
    return {
        candidates,
        promotion: eligible[0]?.candidate || 'none',
        promotion_reason: eligible.length
            ? 'Candidate received a majority of acceptable votes; inspect critical failures before rollout.'
            : dialogueBlocked
                ? 'A visually acceptable candidate failed or could not conclusively pass the deterministic dialogue contract. Do not promote.'
            : 'No candidate received a majority of acceptable votes. Do not promote from this comparison.',
    };
}

async function main() {
    const specPath = argument('spec');
    if (!specPath) throw new Error('Pass --spec=<render-comparison.json>.');
    const resolvedSpecPath = resolve(specPath);
    const spec = JSON.parse(await readFile(resolvedSpecPath, 'utf8'));
    if (!spec.prompt || !Array.isArray(spec.candidates) || spec.candidates.length < 2) {
        throw new Error('Spec requires prompt and at least two candidates.');
    }
    const outputPath = resolve(argument('output', resolve(dirname(resolvedSpecPath), 'render-report.json')));
    const outputDirectory = resolve(dirname(outputPath), `${basename(outputPath, '.json')}-evidence`);
    const judgeRuns = Math.max(1, Math.min(4, Number(argument('judge-runs', '2')) || 2));
    await mkdir(outputDirectory, { recursive: true });
    const openai = new OpenAI({ apiKey: config.openaiApiKey });
    const gemini = new GoogleGenAI({ apiKey: config.geminiApiKey, apiVersion: 'v1alpha' });

    const evidence = [];
    for (const candidate of spec.candidates) {
        process.stdout.write(`Inspecting ${candidate.id}...\n`);
        const probe = await probeVideo(candidate.video_path);
        const videoStream = probe.streams.find(stream => stream.codec_type === 'video');
        if (!videoStream?.width || !videoStream?.height) throw new Error(`No video stream in ${candidate.video_path}.`);
        const visuals = await extractVisualEvidence(candidate, outputDirectory);
        const [frameZero, timeline, transcript] = await Promise.all([
            frameZeroMetrics(candidate.keyframe_path, visuals.frameZeroPath, videoStream.width, videoStream.height),
            detectTimelineProblems(candidate.video_path),
            transcribeVideo(
                openai,
                gemini,
                candidate.video_path,
                visuals.audioPath,
                spec.dialogue_contract,
            ),
        ]);
        const dialogueVerification = evaluateDialogueContract(
            spec.dialogue_contract,
            transcript.observations,
        );
        evidence.push({
            ...candidate,
            probe,
            visuals,
            frame_zero: frameZero,
            timeline,
            transcript,
            dialogue_verification: dialogueVerification,
        });
    }

    const judgments = [];
    for (let runIndex = 0; runIndex < judgeRuns; runIndex += 1) {
        process.stdout.write(`Blinded judge ${runIndex + 1}/${judgeRuns}...\n`);
        judgments.push(await judge(openai, spec, evidence, runIndex));
    }
    const report = {
        created_at: new Date().toISOString(),
        spec_path: resolvedSpecPath,
        prompt: spec.prompt,
        intent: spec.intent || null,
        expected_dialogue: spec.expected_dialogue || null,
        dialogue_contract: spec.dialogue_contract || null,
        judge_model: AI_MODELS.openAIChat,
        judge_runs: judgeRuns,
        evidence,
        judgments,
        aggregate: aggregateJudgments(evidence, judgments),
    };
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report.aggregate, null, 2)}\nSaved ${outputPath}\n`);
}

await main();
