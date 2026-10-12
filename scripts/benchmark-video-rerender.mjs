#!/usr/bin/env node

// Re-render delivered minimax/oalgo jobs under alternative planners or character
// guidance. Each case keeps its source image and one seed across every arm; a
// `stored_plan` arm re-renders the exact plan production used, so the seed
// noise between the delivered video and this experiment is held out.
//
// <run-dir>/cases.json: { cases: [{ id, source_job_id, command, prompt,
//     source_image, stored_plan, requested_duration_seconds? }] }
// <run-dir>/arms.json:  { arms: { <name>: { stored_plan: true } | { model,
//     strategy, effort, promptVariant, guidance_replacements?: [{ find, replace }] } } }

import { execFile } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { createFrontierVideoPlan } from '../dist/VideoFrontierPlanner.js';
import { videoCharacterForCommand, videoCharacterPlannerGuidance } from '../dist/VideoCharacters.js';
import { requestedVideoDurationSeconds } from '../dist/VideoProtocol.js';
import { videoUsageCost } from '../dist/VideoUsage.js';
import { buildGpuqRenderArguments, saveJsonAtomic, stableHash, stableShuffle } from './video-cost-ab-lib.mjs';

const execFileAsync = promisify(execFile);
const PYTHON_WINDOWS = 'D:\\AI\\ComfyUI_windows_portable\\python_embeded\\python.exe';
const GENERATOR_WINDOWS = 'D:\\AI\\ComfyUI_windows_portable\\video_gen\\video_gen.py';

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
    catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

async function windowsPath(path) {
    const { stdout } = await execFileAsync('wslpath', ['-w', resolve(path)]);
    return stdout.trim();
}

async function linuxPath(path) {
    const { stdout } = await execFileAsync('wslpath', ['-u', path]);
    return stdout.trim();
}

/** Production guidance for the case's character with the arm's sentence swaps applied. */
function armGuidance(command, replacements = []) {
    const character = videoCharacterForCommand(command);
    if (!character) {
        if (replacements.length) throw new Error(`No character guidance to revise for ${command}.`);
        return undefined;
    }
    let guidance = videoCharacterPlannerGuidance(character);
    for (const { find, replace } of replacements) {
        const pattern = find.replaceAll('{name}', character.name);
        if (guidance.split(pattern).length !== 2) {
            throw new Error(`Guidance replacement must match exactly once: ${pattern.slice(0, 60)}`);
        }
        guidance = guidance.replace(pattern, () => replace.replaceAll('{name}', character.name));
    }
    return guidance;
}

async function main() {
    const phase = argument('phase', 'plan');
    if (!['plan', 'render', 'report'].includes(phase)) throw new Error(`Unknown phase: ${phase}`);
    const runDir = resolve(argument('run-dir', 'artifacts/video-rerender'));
    const statePath = resolve(runDir, 'state.json');
    const cases = (await loadJson(resolve(runDir, 'cases.json')))?.cases;
    const allArms = (await loadJson(resolve(runDir, 'arms.json')))?.arms;
    if (!Array.isArray(cases) || !cases.length) throw new Error('cases.json must list at least one case.');
    if (!allArms || !Object.keys(allArms).length) throw new Error('arms.json must define at least one arm.');
    const selected = argument('arms', '')?.split(',').filter(Boolean);
    const arms = Object.fromEntries(Object.entries(allArms)
        .filter(([name]) => !selected.length || selected.includes(name)));
    for (const name of selected) if (!allArms[name]) throw new Error(`Unknown arm: ${name}`);
    for (const item of cases) {
        if (!item.id || !item.source_job_id || !item.command || !item.prompt) {
            throw new Error(`Incomplete case: ${item?.id || 'unknown'}`);
        }
        if (item.source_image) await existing(resolve(item.source_image));
        if (Object.values(arms).some(arm => arm.stored_plan)) await existing(resolve(runDir, item.stored_plan));
    }
    const state = await loadJson(statePath, {
        schema_version: 1, created_at: new Date().toISOString(), plans: {}, renders: {},
    });
    const budgetUsd = Number(argument('budget-usd', '15'));
    const spent = () => Object.values(state.plans).reduce((sum, value) => sum + Number(value.cost_usd || 0), 0);
    // A plan run and a render run may overlap; keep entries the other process wrote.
    const ownPlans = phase === 'plan';
    const staleRenders = new Set();
    const save = async () => {
        const disk = await loadJson(statePath, {});
        if (ownPlans) {
            state.renders = { ...state.renders, ...disk.renders };
            for (const key of staleRenders) delete state.renders[key];
        } else state.plans = { ...disk.plans, ...state.plans };
        state.updated_at = new Date().toISOString();
        await saveJsonAtomic(statePath, state);
    };

    if (phase === 'plan') {
        for (const item of cases) for (const [arm, configuration] of Object.entries(arms)) {
            const key = `${item.id}:${arm}`;
            if (configuration.stored_plan) {
                state.plans[key] = { ok: true, plan_path: resolve(runDir, item.stored_plan), stored: true, cost_usd: 0 };
                continue;
            }
            const plannerGuidance = armGuidance(item.command, configuration.guidance_replacements);
            const inputFingerprint = stableHash(JSON.stringify({ item, configuration, plannerGuidance }), 64);
            if (state.plans[key]?.ok && state.plans[key].input_fingerprint === inputFingerprint) continue;
            if (spent() >= budgetUsd) throw new Error(`Planner spend cap reached: $${spent().toFixed(2)}.`);
            const sourceBytes = item.source_image ? await readFile(resolve(item.source_image)) : null;
            const sourceImage = sourceBytes ? { data: sourceBytes, mimeType: 'image/png' } : undefined;
            const usage = [], attempts = [];
            const started = performance.now();
            const cost = () => usage.reduce((sum, event) => sum + videoUsageCost(event), 0);
            try {
                const plan = await createFrontierVideoPlan(item.prompt, 'minimax', `rerender-${item.id}-${arm}`,
                    sourceImage, {
                        plannerModel: configuration.model,
                        plannerStrategy: configuration.strategy,
                        analysisReasoningEffort: configuration.effort,
                        screenplayReasoningEffort: configuration.effort,
                        plannerPromptVariant: configuration.promptVariant,
                        plannerGuidance,
                        requestedDurationSeconds: item.requested_duration_seconds
                            ?? requestedVideoDurationSeconds(item.prompt) ?? undefined,
                        maxRequestAttempts: 1,
                        onUsage: event => usage.push(event),
                        onAttempt: event => attempts.push(event),
                    });
                const planPath = resolve(runDir, 'plans', `${item.id}-${arm}.json`);
                await saveJsonAtomic(planPath, plan);
                state.plans[key] = { ok: true, plan_path: planPath, planner_model: plan._planner_model,
                    input_fingerprint: inputFingerprint, strategy: plan._planner_configuration?.strategy,
                    cost_usd: cost(), duration_seconds: (performance.now() - started) / 1000, usage, attempts };
                staleRenders.add(key);
                process.stdout.write(`Planned ${key}: $${state.plans[key].cost_usd.toFixed(3)}\n`);
            } catch (error) {
                state.plans[key] = { ok: false, error: error.message, input_fingerprint: inputFingerprint,
                    cost_usd: cost(), duration_seconds: (performance.now() - started) / 1000, usage, attempts };
                process.stderr.write(`Planning failed ${key}: ${error.message}\n`);
            }
            await save();
        }
        await save();
        process.stdout.write(`Planner spend: $${spent().toFixed(3)}.\n`);
    }

    if (phase === 'render') {
        await execFileAsync('gpuq', ['status']);
        const dryRun = process.argv.includes('--dry-run');
        for (const item of cases) {
            const seed = Number.parseInt(stableHash(item.source_job_id, 8), 16);
            const fixedDuration = item.requested_duration_seconds ?? requestedVideoDurationSeconds(item.prompt);
            for (const arm of Object.keys(arms)) {
                const key = `${item.id}:${arm}`;
                const planPath = state.plans[key]?.ok && state.plans[key].plan_path;
                if (!planPath) {
                    process.stderr.write(`Skipping ${key}: no successful plan.\n`);
                    continue;
                }
                await existing(planPath);
                if (state.renders[key]?.video_path) {
                    try { await existing(state.renders[key].video_path); continue; }
                    catch { /* Reproduce a missing render with its recorded seed. */ }
                }
                const args = buildGpuqRenderArguments({
                    pythonPath: PYTHON_WINDOWS, generatorPath: GENERATOR_WINDOWS,
                    prompt: item.prompt, planPath: await windowsPath(planPath),
                    imagePath: item.source_image ? await windowsPath(item.source_image) : null,
                    seed, benchmarkLabel: `video-rerender-${item.id}-${arm}`,
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
                try {
                    const { stdout, stderr } = await execFileAsync('gpuq', args, { maxBuffer: 64 * 1024 * 1024 });
                    const completed = [...`${stdout}\n${stderr}`.matchAll(/Completed H3:\s+([^\r\n]+\.mp4)/g)]
                        .at(-1)?.[1]?.trim();
                    if (!completed) throw new Error('No completed H3 MP4 found.');
                    const videoPath = await linuxPath(completed);
                    await existing(videoPath);
                    state.renders[key] = { video_path: videoPath, seed,
                        duration_seconds: (performance.now() - started) / 1000,
                        completed_at: new Date().toISOString() };
                    process.stdout.write(`Rendered ${key}: ${videoPath}\n`);
                } catch (error) {
                    // One failed render should not strand the rest of an overnight queue.
                    state.renders[key] = { error: String(error.stderr || error.message).slice(-2000), seed };
                    process.stderr.write(`Render failed ${key}: ${error.message.slice(0, 300)}\n`);
                }
                await save();
            }
        }
    }

    if (phase === 'report' || phase === 'render') {
        const blind = [], key = [];
        for (const item of cases) {
            const values = stableShuffle(Object.keys(allArms), `video-rerender:${item.source_job_id}`);
            const options = values.map((arm, index) => ({
                label: String.fromCharCode(65 + index),
                video_path: state.renders[`${item.id}:${arm}`]?.video_path || null,
            }));
            blind.push({ case_id: item.id, command: item.command, prompt: item.prompt,
                delivered_video: item.delivered_video || null, options,
                preferred: null, material_failures: [], notes: '' });
            key.push({ case_id: item.id, labels: Object.fromEntries(values.map((arm, index) =>
                [String.fromCharCode(65 + index), arm])) });
        }
        await saveJsonAtomic(resolve(runDir, 'blind-review.json'), { schema_version: 1, cases: blind });
        await saveJsonAtomic(resolve(runDir, 'review-key.json'), { schema_version: 1, cases: key });
        const rendered = Object.values(state.renders).filter(value => value.video_path).length;
        process.stdout.write(`Planner spend: $${spent().toFixed(3)}; completed videos: ${rendered}.\n`);
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
