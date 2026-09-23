#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { createFrontierVideoPlan } from '../dist/VideoFrontierPlanner.js';
import { OALGO_VIDEO_PLANNER_GUIDANCE } from '../dist/VideoGeneration.js';
import { requestedVideoDurationSeconds } from '../dist/VideoProtocol.js';
import { videoUsageCost } from '../dist/VideoUsage.js';
import { buildGpuqRenderArguments, saveJsonAtomic, stableHash, stableShuffle } from './video-cost-ab-lib.mjs';

const execFileAsync = promisify(execFile);
const PYTHON_WINDOWS = 'D:\\AI\\ComfyUI_windows_portable\\python_embeded\\python.exe';
const GENERATOR_WINDOWS = 'D:\\AI\\ComfyUI_windows_portable\\video_gen\\video_gen.py';
const ARMS = {
    'sol-production': { model: 'gpt-5.6-sol', strategy: 'single-pass', effort: 'low', promptVariant: 'baseline' },
    'opus-baseline': { model: 'claude-opus-5-5', strategy: 'two-pass', effort: 'medium', promptVariant: 'baseline' },
    'opus-tuned': { model: 'claude-opus-5-5', strategy: 'two-pass', effort: 'medium', promptVariant: 'opus-tuned' },
};

function argument(name, fallback) {
    const value = process.argv.find(item => item.startsWith(`--${name}=`));
    return value ? value.slice(name.length + 3) : fallback;
}

async function existing(path) {
    await access(path);
    return path;
}

async function loadJson(path, fallback) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function windowsPath(path) {
    const { stdout } = await execFileAsync('wslpath', ['-w', resolve(path)]);
    return stdout.trim();
}

async function linuxPath(path) {
    const { stdout } = await execFileAsync('wslpath', ['-u', path]);
    return stdout.trim();
}

async function main() {
    const phase = argument('phase', 'plan');
    if (!['plan', 'render', 'report'].includes(phase)) throw new Error(`Unknown phase: ${phase}`);
    const runDir = resolve(argument('run-dir', 'artifacts/video-opus-ab'));
    const casesPath = resolve(argument('cases', `${runDir}/historical-cases.json`));
    const statePath = resolve(runDir, 'state.json');
    const source = await loadJson(casesPath);
    const cases = source?.cases;
    if (!Array.isArray(cases) || cases.length < 1 || cases.length > 4) {
        throw new Error('Historical case file must contain one to four cases.');
    }
    for (const item of cases) {
        if (!item.id || !item.source_job_id || !['minimax', 'oalgo'].includes(item.command)
            || !item.prompt || (item.command === 'oalgo' && !item.source_image)) {
            throw new Error(`Incomplete historical case: ${item?.id || 'unknown'}`);
        }
        if (item.source_image) await existing(resolve(item.source_image));
    }
    const state = await loadJson(statePath, {
        schema_version: 1, created_at: new Date().toISOString(), cases_path: casesPath,
        arms: ARMS, plans: {}, renders: {},
    });
    if (stableHash(JSON.stringify(state.arms)) !== stableHash(JSON.stringify(ARMS))
        || state.cases_path !== casesPath) throw new Error('Experiment configuration changed; use a new run directory.');
    const budgetUsd = Number(argument('budget-usd', '10'));
    const spent = () => Object.values(state.plans).reduce((sum, value) => sum + Number(value.cost_usd || 0), 0);

    if (phase === 'plan') {
        for (const item of cases) for (const [arm, configuration] of Object.entries(ARMS)) {
            const key = `${item.id}:${arm}`;
            const inputFingerprint = stableHash(JSON.stringify({ item, configuration }), 64);
            if (state.plans[key]?.ok && state.plans[key].input_fingerprint === inputFingerprint) continue;
            if (spent() >= budgetUsd) throw new Error(`Planner spend cap reached: $${spent().toFixed(2)}.`);
            const sourceBytes = item.source_image ? await readFile(resolve(item.source_image)) : null;
            const sourceImage = sourceBytes ? { data: sourceBytes, mimeType: 'image/png' } : undefined;
            const usage = [], attempts = [];
            const started = performance.now();
            try {
                const plan = await createFrontierVideoPlan(item.prompt, 'minimax', `opus-ab-${item.id}`,
                    sourceImage, {
                        plannerModel: configuration.model,
                        plannerStrategy: configuration.strategy,
                        analysisReasoningEffort: configuration.effort,
                        screenplayReasoningEffort: configuration.effort,
                        plannerPromptVariant: configuration.promptVariant,
                        plannerGuidance: item.command === 'oalgo' ? OALGO_VIDEO_PLANNER_GUIDANCE : undefined,
                        requestedDurationSeconds: item.experiment_duration_seconds
                            ?? item.requested_duration_seconds
                            ?? requestedVideoDurationSeconds(item.prompt) ?? undefined,
                        maxRequestAttempts: 1,
                        onUsage: event => usage.push(event),
                        onAttempt: event => attempts.push(event),
                    });
                const planPath = resolve(runDir, 'plans', `${key.replace(':', '-')}.json`);
                await saveJsonAtomic(planPath, plan);
                state.plans[key] = { ok: true, plan_path: planPath, planner_model: plan._planner_model,
                    input_fingerprint: inputFingerprint,
                    fingerprint: plan._planner_fingerprint, strategy: plan._planner_configuration?.strategy,
                    cost_usd: usage.reduce((sum, event) => sum + videoUsageCost(event), 0),
                    duration_seconds: (performance.now() - started) / 1000, usage, attempts };
                process.stdout.write(`Planned ${key}: $${state.plans[key].cost_usd.toFixed(3)}\n`);
            } catch (error) {
                state.plans[key] = { ok: false, error: error.message,
                    input_fingerprint: inputFingerprint,
                    cost_usd: usage.reduce((sum, event) => sum + videoUsageCost(event), 0),
                    duration_seconds: (performance.now() - started) / 1000, usage, attempts };
                process.stderr.write(`Planning failed ${key}: ${error.message}\n`);
            }
            state.updated_at = new Date().toISOString();
            await saveJsonAtomic(statePath, state);
        }
    }

    if (phase === 'render') {
        await execFileAsync('gpuq', ['status']);
        const dryRun = process.argv.includes('--dry-run');
        for (const item of cases) {
            const seed = Number.parseInt(stableHash(item.source_job_id, 8), 16);
            const fixedDuration = item.experiment_duration_seconds
                ?? item.requested_duration_seconds ?? requestedVideoDurationSeconds(item.prompt);
            for (const arm of Object.keys(ARMS)) {
                const key = `${item.id}:${arm}`;
                const planPath = state.plans[key]?.plan_path;
                if (!planPath) throw new Error(`Missing successful plan: ${key}`);
                await existing(planPath);
                if (state.renders[key]?.video_path) {
                    try { await existing(state.renders[key].video_path); continue; }
                    catch { /* Reproduce a missing render with its recorded seed. */ }
                }
                const args = buildGpuqRenderArguments({
                    pythonPath: PYTHON_WINDOWS, generatorPath: GENERATOR_WINDOWS,
                    prompt: item.prompt, planPath: await windowsPath(planPath),
                    imagePath: item.source_image ? await windowsPath(item.source_image) : null,
                    seed, benchmarkLabel: `video-opus-ab-${item.id}-${arm}`,
                });
                if (fixedDuration !== null && fixedDuration !== undefined) {
                    args.splice(-1, 0, '--duration', String(fixedDuration));
                }
                if (dryRun) {
                    process.stdout.write(`Ready ${key}: seed=${seed}, source=${item.source_image || 'text'}\n`);
                    continue;
                }
                process.stdout.write(`Rendering ${key} through GPUq...\n`);
                const started = performance.now();
                const { stdout, stderr } = await execFileAsync('gpuq', args, { maxBuffer: 64 * 1024 * 1024 });
                const completed = [...`${stdout}\n${stderr}`.matchAll(/Completed H3:\s+([^\r\n]+\.mp4)/g)].at(-1)?.[1]?.trim();
                if (!completed) throw new Error(`No completed H3 MP4 found for ${key}.`);
                const videoPath = await linuxPath(completed);
                await existing(videoPath);
                state.renders[key] = { video_path: videoPath, seed,
                    duration_seconds: (performance.now() - started) / 1000,
                    completed_at: new Date().toISOString() };
                state.updated_at = new Date().toISOString();
                await saveJsonAtomic(statePath, state);
                process.stdout.write(`Rendered ${key}: ${videoPath}\n`);
            }
        }
    }

    if (phase === 'report' || phase === 'render') {
        const blind = [], key = [];
        for (const item of cases) {
            const values = stableShuffle(Object.keys(ARMS), `video-opus-ab:${item.source_job_id}`);
            const options = values.map((arm, index) => ({
                label: String.fromCharCode(65 + index),
                video_path: state.renders[`${item.id}:${arm}`]?.video_path || null,
            }));
            blind.push({ case_id: item.id, command: item.command, prompt: item.prompt, options,
                preferred: null, material_failures: [], notes: '' });
            key.push({ case_id: item.id, labels: Object.fromEntries(values.map((arm, index) =>
                [String.fromCharCode(65 + index), arm])) });
        }
        await saveJsonAtomic(resolve(runDir, 'blind-review.json'), { schema_version: 1, cases: blind });
        await saveJsonAtomic(resolve(runDir, 'review-key.json'), { schema_version: 1, cases: key });
        process.stdout.write(`Planner spend: $${spent().toFixed(3)}; completed videos: ${Object.keys(state.renders).length}.\n`);
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
