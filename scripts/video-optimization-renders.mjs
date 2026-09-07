#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { promisify } from 'node:util';
import { buildGpuqRenderArguments, saveJsonAtomic, stableHash } from './video-cost-ab-lib.mjs';

const exec = promisify(execFile);
const GENERATOR = '/mnt/d/AI/ComfyUI_windows_portable/video_gen/video_gen.py';
const PYTHON = 'D:\\AI\\ComfyUI_windows_portable\\python_embeded\\python.exe';
const argument = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const hashFile = async path => stableHash(await readFile(path), 64);
const windowsPath = async path => (await exec('wslpath', ['-w', resolve(path)])).stdout.trim();

export function rendererArguments(base, spec, contractPath) {
    if (!['h3-base', 'fasth3-fixed-duration'].includes(spec.renderer_profile)) throw new Error('Unknown renderer profile.');
    if (!contractPath || !Number.isInteger(spec.seed)) throw new Error('Frozen contract and seed required.');
    const flags = ['--experiment-contract', contractPath, '--aspect', spec.aspect];
    if (spec.requested_duration != null) flags.push('--duration', String(spec.requested_duration));
    if (spec.renderer_profile === 'fasth3-fixed-duration') flags.push('--fast', '--no-fast-duration-aware');
    return [...base.slice(0, -1), ...flags, base.at(-1)];
}

export function validateRenderManifest(manifest) {
    if (!Array.isArray(manifest.renders) || !manifest.renders.length || manifest.renders.length > 14
        || !Array.isArray(manifest.pairs) || !manifest.pairs.length || manifest.pairs.length > 10) throw new Error('Campaign permits at most 14 unique videos and 10 pairs.');
    const ids = new Set(manifest.renders.map(item => item.id));
    if (ids.size !== manifest.renders.length || ids.has(undefined)) throw new Error('Duplicate/missing render IDs.');
    for (const pair of manifest.pairs) {
        const control = manifest.renders.find(item => item.id === pair.control);
        const candidate = manifest.renders.find(item => item.id === pair.candidate);
        if (!control || !candidate || control.id === candidate.id || control.seed !== candidate.seed
            || control.prompt !== candidate.prompt || control.command !== candidate.command
            || pair.command !== control.command || !['minimax', 'oalgo'].includes(pair.command)) throw new Error('Invalid paired prompt/seed/command.');
        if (pair.component === 'renderer' && (control.contract_path !== candidate.contract_path
            || control.renderer_profile !== 'h3-base' || candidate.renderer_profile !== 'fasth3-fixed-duration')) throw new Error('Renderer comparisons require one identical contract and base/FastH3 profiles.');
        if (pair.component === 'cloud' && (control.renderer_profile !== 'h3-base' || candidate.renderer_profile !== 'h3-base')) throw new Error('Cloud comparisons require base H3 for both plans.');
        if (!['renderer', 'cloud', 'combined'].includes(pair.component)) throw new Error('Unknown comparison component.');
    }
}

export async function renderInputFingerprint(spec, generator = GENERATOR) {
    const contract = JSON.parse(await readFile(spec.contract_path, 'utf8'));
    const hashes = { generator: await hashFile(generator), plan: await hashFile(spec.plan_path),
        image: spec.keyframe_path ? await hashFile(spec.keyframe_path) : null,
        contract: await hashFile(spec.contract_path), segment_images: {} };
    for (const [name, hash] of Object.entries(contract.inputs.template_sha256 || {})) {
        if (await hashFile(resolve(dirname(generator), 'templates', name)) !== hash) throw new Error('H3 workflow template changed.');
    }
    for (const [index, image] of Object.entries(spec.segment_keyframes || {})) hashes.segment_images[index] = await hashFile(image);
    if (hashes.generator !== contract.inputs.generator_sha256 || hashes.plan !== contract.inputs.plan_sha256
        || hashes.image !== contract.inputs.image_sha256
        || JSON.stringify(hashes.segment_images) !== JSON.stringify(contract.inputs.segment_image_sha256)) throw new Error(`Changed frozen inputs: ${spec.id}`);
    return { contract, fingerprint: stableHash(JSON.stringify({ spec, hashes }), 64) };
}

async function main() {
    const path = resolve(argument('manifest', ''));
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    validateRenderManifest(manifest);
    const output = resolve(dirname(path), 'optimization-render-state.json');
    let state;
    try { state = JSON.parse(await readFile(output, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = { schema_version: 1, renders: {} }; }
    const dry = process.argv.includes('--dry-run');
    if (!dry) await exec('gpuq', ['status']);
    for (const spec of manifest.renders) {
        // Combined comparisons are allowed only after recorded component approval.
        if (manifest.pairs.some(pair => pair.component === 'combined' && pair.candidate === spec.id)
            && manifest.component_review_passed !== true) continue;
        const { contract, fingerprint } = await renderInputFingerprint(spec);
        const saved = state.renders[spec.id];
        if (!dry && saved?.fingerprint === fingerprint && saved.video_path
            && await hashFile(saved.video_path).catch(() => null) === saved.video_sha256) {
            console.log(`Reusing verified render ${spec.id}`); continue;
        }
        let args = rendererArguments(buildGpuqRenderArguments({ pythonPath: PYTHON,
            generatorPath: await windowsPath(GENERATOR), prompt: spec.prompt, planPath: await windowsPath(spec.plan_path),
            imagePath: spec.keyframe_path ? await windowsPath(spec.keyframe_path) : null,
            seed: spec.seed, benchmarkLabel: `optimization-${spec.id}` }), spec, await windowsPath(spec.contract_path));
        for (const [index, image] of Object.entries(spec.segment_keyframes || {})) args.splice(-1, 0, '--segment-keyframe', `${index}=${await windowsPath(image)}`);
        if (dry) { console.log(`Validated ${spec.id}: ${spec.renderer_profile}, ${contract.compiled_h3.length} scenes`); continue; }
        console.log(`Rendering ${spec.id} through GPUq`);
        const startedAt = Date.now();
        const { stdout, stderr } = await exec('gpuq', args, { maxBuffer: 64 * 1024 * 1024 });
        const log = `${stdout}\n${stderr}`;
        const completed = [...log.matchAll(/Completed H3:\s+([^\r\n]+\.mp4)/g)].at(-1)?.[1]?.trim();
        if (!completed) throw new Error(`Missing completed output for ${spec.id}`);
        const video = (await exec('wslpath', ['-u', completed])).stdout.trim();
        if ((await stat(video)).mtimeMs < startedAt - 2000) throw new Error('Renderer returned an old video.');
        const manifestPath = video.replace(/\.mp4$/, '.generation.json');
        const generation = JSON.parse(await readFile(manifestPath, 'utf8'));
        const segmentManifests = generation.timing ? [generation] : await Promise.all(Object.values(generation.segments).map(async segment => {
            const path = (await exec('wslpath', ['-u', segment.manifest])).stdout.trim();
            return JSON.parse(await readFile(path, 'utf8'));
        }));
        const serviceSeconds = segmentManifests.reduce((sum, segment) => sum + segment.timing.total_seconds - segment.timing.queue_wait_seconds, 0);
        if (!Number.isFinite(serviceSeconds) || serviceSeconds <= 0) throw new Error('Missing renderer service timing.');
        state.renders[spec.id] = { id: spec.id, command: spec.command, profile: spec.renderer_profile,
            fingerprint, video_path: video, video_sha256: await hashFile(video),
            service_seconds: serviceSeconds, generation_manifest: generation, segment_manifests: segmentManifests,
            queue_inclusive_seconds: (Date.now() - startedAt) / 1000, log,
            completed_at: new Date().toISOString() };
        await saveJsonAtomic(output, state);
    }
    const pairs = manifest.pairs.flatMap(pair => {
        const a = state.renders[pair.control], b = state.renders[pair.candidate];
        return a?.video_path && b?.video_path ? [{ pair_id: pair.id, command: pair.command, component: pair.component,
            prompt: manifest.renders.find(render => render.id === pair.control).prompt,
            control_video: a.video_path, candidate_video: b.video_path }] : [];
    });
    if (!dry) await saveJsonAtomic(resolve(dirname(path), 'render-pairs.json'), pairs);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
