#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import {
    buildGpuqRenderArguments,
    saveJsonAtomic,
    stableHash,
} from './video-cost-ab-lib.mjs';

const execFileAsync = promisify(execFile);
const PYTHON_WINDOWS = 'D:\\AI\\ComfyUI_windows_portable\\python_embeded\\python.exe';
const GENERATOR_WINDOWS = 'D:\\AI\\ComfyUI_windows_portable\\video_gen\\video_gen.py';

function argument(name, fallback) {
    const prefix = `--${name}=`;
    const value = process.argv.find(candidate => candidate.startsWith(prefix));
    return value ? value.slice(prefix.length) : fallback;
}

async function existing(path, label) {
    try {
        await access(path);
    } catch {
        throw new Error(`${label} does not exist: ${path}`);
    }
}

async function windowsPath(path) {
    const { stdout } = await execFileAsync('wslpath', ['-w', resolve(path)]);
    return stdout.trim();
}

async function linuxPath(path) {
    const { stdout } = await execFileAsync('wslpath', ['-u', path]);
    return stdout.trim();
}

function parseCompletedVideo(stdout) {
    const matches = [...String(stdout).matchAll(/Completed H3:\s+([^\r\n]+\.mp4)/g)];
    return matches.at(-1)?.[1]?.trim() || null;
}

async function loadState(path) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        return { schema_version: 1, created_at: new Date().toISOString(), renders: {} };
    }
}

async function main() {
    const manifestArgument = argument('manifest');
    if (!manifestArgument) throw new Error('Pass --manifest=<ten-render-pairs.json>.');
    const manifestPath = resolve(manifestArgument);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const pairs = Array.isArray(manifest) ? manifest : manifest.pairs;
    if (!Array.isArray(pairs) || pairs.length < 6 || pairs.length > 10) {
        throw new Error('Render manifest must contain between six and ten prompt pairs.');
    }
    const outputPath = resolve(argument('output', resolve(manifestPath, '..', 'render-state.json')));
    const resultPath = resolve(argument('pairs-output', resolve(manifestPath, '..', 'render-pairs.json')));
    const limit = Math.max(1, Math.min(pairs.length, Number(argument('limit', String(pairs.length))) || pairs.length));
    const dryRun = process.argv.includes('--dry-run');
    const exportOnly = process.argv.includes('--export-only');
    const state = await loadState(outputPath);

    if (!dryRun && !exportOnly) {
        const { stdout } = await execFileAsync('gpuq', ['status', '--json']);
        const status = JSON.parse(stdout);
        if (status?.gamingMode || status?.mode === 'gaming') {
            process.stdout.write('GPUq Gaming Mode is active; submissions will remain held until the user resumes them.\n');
        }
    }

    for (const pair of exportOnly ? [] : pairs.slice(0, limit)) {
        if (!pair?.pair_id || !pair?.prompt || !pair?.control?.plan_path || !pair?.candidate?.plan_path) {
            throw new Error('Each pair requires pair_id, prompt, control.plan_path, and candidate.plan_path.');
        }
        const seed = Number.isInteger(pair.seed)
            ? pair.seed
            : Number.parseInt(stableHash(pair.pair_id, 8), 16);
        for (const variantName of ['control', 'candidate']) {
            const variant = pair[variantName];
            const recordKey = `${pair.pair_id}:${variantName}`;
            if (state.renders[recordKey]?.video_path) {
                try {
                    await access(state.renders[recordKey].video_path);
                    process.stdout.write(`Reused ${recordKey}: ${state.renders[recordKey].video_path}\n`);
                    continue;
                } catch {
                    // The checkpoint is stale; reproduce the seeded render.
                }
            }
            await existing(resolve(variant.plan_path), `${recordKey} plan`);
            if (variant.keyframe_path) await existing(resolve(variant.keyframe_path), `${recordKey} keyframe`);
            const args = buildGpuqRenderArguments({
                pythonPath: PYTHON_WINDOWS,
                generatorPath: GENERATOR_WINDOWS,
                prompt: pair.prompt,
                planPath: await windowsPath(variant.plan_path),
                imagePath: variant.keyframe_path ? await windowsPath(variant.keyframe_path) : null,
                seed,
                benchmarkLabel: `video-cost-ab-${pair.pair_id}-${variantName}`.replace(/[^a-zA-Z0-9_-]/g, '-'),
            });
            if (dryRun) {
                state.renders[recordKey] = {
                    pair_id: pair.pair_id,
                    variant: variantName,
                    seed,
                    dry_run: true,
                    gpuq_arguments: args.map((value, index) => index > args.indexOf('--') && value === pair.prompt ? '[PROMPT]' : value),
                };
            } else {
                process.stdout.write(`Rendering ${recordKey} through GPUq...\n`);
                const started = performance.now();
                const { stdout, stderr } = await execFileAsync('gpuq', args, { maxBuffer: 64 * 1024 * 1024 });
                const completed = parseCompletedVideo(`${stdout}\n${stderr}`);
                if (!completed) throw new Error(`Could not locate the generated H3 MP4 for ${recordKey}.`);
                const videoPath = await linuxPath(completed);
                await existing(videoPath, `${recordKey} output`);
                state.renders[recordKey] = {
                    pair_id: pair.pair_id,
                    variant: variantName,
                    seed,
                    video_path: videoPath,
                    duration_seconds: (performance.now() - started) / 1000,
                    completed_at: new Date().toISOString(),
                };
            }
            state.updated_at = new Date().toISOString();
            await saveJsonAtomic(outputPath, state);
        }
    }

    const completedPairs = pairs.flatMap(pair => {
        const control = state.renders[`${pair.pair_id}:control`];
        const candidate = state.renders[`${pair.pair_id}:candidate`];
        if (!control?.video_path || !candidate?.video_path) return [];
        return [{
            pair_id: pair.pair_id,
            prompt: pair.prompt,
            control_video: control.video_path,
            candidate_video: candidate.video_path,
        }];
    });
    await saveJsonAtomic(resultPath, completedPairs);
    process.stdout.write(`${dryRun ? 'Validated' : exportOnly ? 'Exported' : 'Completed'} ${Object.keys(state.renders).length} render entries.\n`);
    if (!dryRun) process.stdout.write(`Blinding manifest: ${resultPath}\n`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
