#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { saveJsonAtomic, stableHash, stableShuffle, mean } from './video-cost-ab-lib.mjs';
import { bootstrapMeanInterval, PLANNER_CANDIDATES } from './video-optimization-analysis.mjs';
import { ledgerTotals } from './video-experiment-ledger.mjs';
import { renderInputFingerprint, normalH3OptimizationManifest } from './video-optimization-renders.mjs';

const argument = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const readJson = async (path, fallback) => {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
};

export function assessVideoComponent(manifest, state, packet, key, command, component) {
    const pairs = manifest.pairs.filter(pair => pair.command === command && pair.component === component);
    const expected = component === 'combined' ? 1 : 2;
    const rows = pairs.map(pair => {
        const labels = key.pairs.find(entry => entry.pair_id === pair.id)?.labels || {};
        const review = packet.pairs.find(entry => entry.pair_id === pair.id);
        const controlLabel = Object.keys(labels).find(label => labels[label] === 'control');
        const candidateLabel = Object.keys(labels).find(label => labels[label] === 'candidate');
        const a = state.renders[pair.control], b = state.renders[pair.candidate];
        const complete = Boolean(a && b && review && controlLabel && candidateLabel
            && ['A', 'B'].every(label => typeof review.overall?.[label] === 'number'
                && Number.isFinite(review.overall[label]) && review.overall[label] >= 1 && review.overall[label] <= 10
                && typeof review.material_failure?.[label] === 'boolean')
            && ['A', 'B', 'tie'].includes(review.preferred));
        const duration = render => render?.generation_manifest?.validation?.duration_seconds;
        return { pair_id: pair.id, complete,
            delta: complete ? review.overall[candidateLabel] - review.overall[controlLabel] : null,
            material_failure: complete ? review.material_failure[candidateLabel] : null,
            service_ratio: a?.service_seconds > 0 && b?.service_seconds > 0 ? b.service_seconds / a.service_seconds : null,
            equal_duration: typeof duration(a) === 'number' && typeof duration(b) === 'number' && Math.abs(duration(a) - duration(b)) < .15 };
    });
    const complete = rows.length === expected && rows.every(row => row.complete);
    const interval = complete ? bootstrapMeanInterval(rows.map(row => row.delta), `${command}:${component}`) : null;
    const quality = complete && rows.every(row => !row.material_failure)
        && (component === 'combined' ? rows[0].delta > -.5 : interval?.[0] > -.5);
    const faster = complete && rows.every(row => row.equal_duration && row.service_ratio !== null)
        && mean(rows.map(row => row.service_ratio)) <= .8;
    return { command, component, expected_pairs: expected, reviewed_pairs: rows.filter(row => row.complete).length,
        complete, overall_delta: complete ? mean(rows.map(row => row.delta)) : null, overall_interval: interval,
        service_ratio: complete ? mean(rows.map(row => row.service_ratio)) : null,
        passed: Boolean(quality && (component === 'renderer' ? faster : true)), rows };
}

export function buildOptimizationRelease({ manifest, components, planners, images, accounting }) {
    const release = { schema_version: 1, experiment_id: 'video-optimization-2026-09-07', commands: {} };
    const scoped = normalH3OptimizationManifest(manifest);
    const framesComplete = images.reviewers?.length === 3 && images.reviewers.every(row => row.human_labels_complete && row.accounting_complete);
    if (accounting.unresolved || accounting.committed_usd > 50 || !framesComplete) return release;
    for (const command of ['minimax', 'oalgo']) {
        const policy = scoped.renders.find(render => render.command === command && render.cloud_policy)?.cloud_policy;
        const planner = policy?.planner && planners.holdout.find(row => row.command === command && row.candidate === policy.planner && row.qualifies);
        const cloud = components.find(row => row.command === command && row.component === 'cloud');
        const cloudPass = Boolean(policy && (policy.planner || policy.reviewer || policy.composite) && cloud?.passed
            && (!policy.planner || planner)
            && (!policy.reviewer || images.reviewers.some(row => row.candidate === policy.reviewer && row.eligible_for_video_review))
            && (!policy.composite || images.composites?.some(row => row.candidate === 'flash' && row.eligible_for_video_review)));
        if (!cloudPass) continue;
        release.commands[command] = { percentage: 10, delivery_reviews: [],
            ...(policy.planner ? { planner: PLANNER_CANDIDATES[policy.planner] } : {}),
            ...(policy.reviewer ? { reviewer: { model: policy.reviewer === 'flash-low' ? 'gemini-3.8-flash' : 'gpt-5.6-sol', effort: 'low' } } : {}),
            ...(policy.composite ? { composite: { model: 'gemini-3.1-flash-image', size: '1K' } } : {}),
            evidence: { decision: 'qualified', accounting_complete: true, human_video_review_complete: true,
                human_frame_review_complete: true, planner_holdout_passed: Boolean(planner),
                reviewer_passed: Boolean(policy.reviewer), composite_passed: Boolean(policy.composite),
                report_sha256: stableHash(JSON.stringify({ planners, images, manifest: scoped,
                    components: components.filter(row => row.component === 'cloud'), accounting }), 64) } };
    }
    return release;
}

async function main() {
    if (process.argv.includes('--prepare-combined')) throw new Error('FastH3 and combined renderer tests are outside this campaign; use cloud comparisons on standard H3.');
    const directory = resolve(argument('run-dir', 'artifacts/video-optimization/2026-09-07'));
    const manifest = normalH3OptimizationManifest(await readJson(resolve(directory, 'render-manifest.json')));
    const state = await readJson(resolve(directory, 'optimization-render-state.json'), { renders: {} });
    for (const spec of manifest.renders) {
        const saved = state.renders[spec.id];
        if (!saved) continue;
        const { fingerprint } = await renderInputFingerprint(spec, manifest.generator_path);
        if (saved.fingerprint !== fingerprint) throw new Error(`Stale rendered evidence for ${spec.id}; render the current inputs before reporting.`);
    }
    const path = resolve(directory, 'human-review/final-videos.json');
    const previous = await readJson(path, { pairs: [] });
    const packet = { schema_version: 1, blinded: true, pairs: [] }, key = { schema_version: 1, pairs: [] };
    for (const pair of manifest.pairs) {
        const control = state.renders[pair.control], candidate = state.renders[pair.candidate];
        if (!control?.video_path || !candidate?.video_path) continue;
        const options = stableShuffle([{ variant: 'control', value: control }, { variant: 'candidate', value: candidate }], pair.id);
        for (const option of options) if (stableHash(await readFile(option.value.video_path), 64) !== option.value.video_sha256) throw new Error('Rendered video changed after verification.');
        const videos = options.map((option, i) => ({ label: i ? 'B' : 'A', video_path: option.value.video_path, sha256: option.value.video_sha256 }));
        const original = previous.pairs.find(value => value.pair_id === pair.id && JSON.stringify(value.videos) === JSON.stringify(videos));
        packet.pairs.push({ pair_id: pair.id, prompt: manifest.renders.find(render => render.id === pair.control).prompt,
            videos, preferred: original?.preferred ?? null, overall: original?.overall || { A: null, B: null },
            material_failure: original?.material_failure || { A: null, B: null }, notes: original?.notes || '' });
        key.pairs.push({ pair_id: pair.id, command: pair.command, component: pair.component,
            labels: Object.fromEntries(options.map((option, i) => [i ? 'B' : 'A', option.variant])) });
    }
    await saveJsonAtomic(path, packet);
    await saveJsonAtomic(resolve(directory, 'human-review/final-videos-key.json'), key);
    const components = ['minimax', 'oalgo'].map(command =>
        assessVideoComponent(manifest, state, packet, key, command, 'cloud'));
    const planners = await readJson(resolve(directory, 'report.json'));
    const images = await readJson(resolve(directory, 'image-report.json'), {});
    const accounting = ledgerTotals(await readJson(resolve(directory, 'ledger.json')));
    const release = buildOptimizationRelease({ manifest, components, planners, images, accounting });
    const decision = { schema_version: 1, optimization_scope: 'cloud-only-standard-h3', accounting, components,
        excluded_components: ['renderer', 'combined'],
        status: Object.keys(release.commands).length ? 'eligible_for_canary' : 'inconclusive',
        production_changed: false, note: 'FastH3 remains exclusive to the fast command; archived renderer reviews are not required. Cloud candidates still require human frame/video review and complete billing. A generated release is inactive until VIDEO_OPTIMIZATION_RELEASE_FILE points to it.' };
    await saveJsonAtomic(resolve(directory, 'decision.json'), decision);
    const previousRelease = await readJson(resolve(directory, 'canary-release.json'), { commands: {} });
    for (const [command, arm] of Object.entries(release.commands)) {
        const previousArm = previousRelease.commands?.[command];
        if (previousArm?.evidence?.report_sha256 === arm.evidence.report_sha256) {
            arm.delivery_reviews = previousArm.delivery_reviews || [];
            arm.percentage = previousArm.percentage;
        }
    }
    await saveJsonAtomic(resolve(directory, 'canary-release.json'), release);
    console.log(JSON.stringify({ status: decision.status, completed_videos: Object.keys(state.renders).length, review_pairs: packet.pairs.length, accounting }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
