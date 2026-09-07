#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { createFrontierVideoKeyframe, generateFrontierVideoKeyframeCandidate } from '../dist/VideoKeyframeProvider.js';
import { derivedSegmentKeyframePlan, oalgoSourceImageCompositePlan } from '../dist/VideoBroker.js';
import { createFrontierVideoPlan } from '../dist/VideoFrontierPlanner.js';
import { OALGO_VIDEO_PLANNER_GUIDANCE } from '../dist/VideoGeneration.js';
import { requestedVideoDurationSeconds } from '../dist/VideoProtocol.js';
import { VideoExperimentLedger, executionFingerprint } from './video-experiment-ledger.mjs';
import { campaignFingerprint } from './benchmark-video-optimization.mjs';
import { CONTROL, PLANNER_CANDIDATES } from './video-optimization-analysis.mjs';
import { saveJsonAtomic, stableHash } from './video-cost-ab-lib.mjs';

const exec = promisify(execFile);
const argument = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const directory = resolve(argument('run-dir', 'artifacts/video-optimization/2026-09-07'));
const ANCHORS = ['minimax-screen-racers', 'minimax-screen-note', 'oalgo-screen-refund', 'oalgo-screen-sign'];
let generatorPath;

async function frame(ledger, plan, references, id, aspectRatio, fingerprint, policy = {}) {
    const result = await ledger.checkpoint({ kind: 'render_frame', case_id: id, fingerprint,
        policy, plan_hash: stableHash(JSON.stringify(plan), 64), reference_hashes: references.map(reference => stableHash(reference.bytes, 64)) },
    async hooks => {
        const image = await createFrontierVideoKeyframe(plan, references, { ...hooks,
            strategy: 'fast-gated-v3', serviceTier: 'default', aspectRatio, ...policy });
        const path = resolve(directory, 'render-assets', `${id}.${image.mimeType.split('/')[1]}`);
        await mkdir(resolve(directory, 'render-assets'), { recursive: true });
        await writeFile(path, image.bytes);
        return { path, mimeType: image.mimeType, asset_hash: stableHash(image.bytes, 64), review_status: image.reviewStatus };
    });
    // A canceled image hedge may leave a fully reserved unknown bill. The saved
    // image can still support a paired renderer test; release gates require all
    // billing to be reconciled before any production promotion.
    if (!result.ok) throw new Error(`Failed render asset ${id}.`);
    if (stableHash(await readFile(result.value.path), 64) !== result.value.asset_hash) throw new Error(`Changed render asset ${id}.`);
    return result.value;
}

async function prepareVariant(ledger, testCase, plan, candidate, fingerprint, policy = {}) {
    const id = `${testCase.id}-${candidate}`;
    const target = resolve(directory, 'render-inputs', id);
    await mkdir(target, { recursive: true });
    let first = testCase.source_image ? { path: resolve(testCase.source_image), mimeType: 'image/png' } : null;
    if (testCase.id === 'oalgo-screen-sign') {
        const attachment = resolve('artifacts/video-keyframe-benchmarks/2026-08-25T11-16-53.002Z/images/case-1-gemini-pro-2k.jpg');
        const references = [{ bytes: await readFile(first.path), mimeType: 'image/png', kind: 'style', label: 'OALGO base image',
            visualFactsToPreserve: 'Preserve recognizable face, body, Mexican flag clothing and emblem, actual background, rendering style and palette.' },
        { bytes: await readFile(attachment), mimeType: 'image/jpeg', kind: 'object', label: 'User-attached image',
            visualFactsToPreserve: 'Preserve the salient attached subject and integrate it naturally into the OALGO scene.' }];
        const model = policy.composite ? 'gemini-3.1-flash-image' : 'gemini-3-pro-image';
        const composed = await ledger.checkpoint({ kind: 'render_composite', case_id: id, model, fingerprint,
            source_hashes: references.map(reference => stableHash(reference.bytes, 64)) }, async hooks => {
            const image = await generateFrontierVideoKeyframeCandidate(oalgoSourceImageCompositePlan(testCase.prompt), references,
                { ...hooks, geminiModel: model, imageSize: policy.composite ? '1K' : '2K', aspectRatio: '1:1' });
            const path = resolve(target, `composite.${image.mimeType.split('/')[1]}`);
            await writeFile(path, image.bytes);
            return { path, mimeType: image.mimeType, hash: stableHash(image.bytes, 64) };
        });
        if (!composed.ok || !composed.accounting_complete) throw new Error('Incomplete OALGO composite.');
        first = composed.value;
        const bytes = await readFile(first.path);
        if (stableHash(bytes, 64) !== first.hash) throw new Error('Changed OALGO composite.');
        const plannerChoice = PLANNER_CANDIDATES[policy.planner || CONTROL];
        const planned = await ledger.checkpoint({ kind: 'render_planner', case_id: id, configuration: plannerChoice, fingerprint,
            source_hash: first.hash }, hooks => createFrontierVideoPlan(testCase.prompt, 'minimax', 'experiment-render',
            { data: bytes, mimeType: first.mimeType }, { ...hooks, plannerModel: plannerChoice.model, plannerStrategy: 'single-pass',
                analysisReasoningEffort: plannerChoice.effort, screenplayReasoningEffort: plannerChoice.effort,
                serviceTier: 'default', plannerGuidance: OALGO_VIDEO_PLANNER_GUIDANCE,
                requestedDurationSeconds: requestedVideoDurationSeconds(testCase.prompt) ?? undefined }));
        if (!planned.ok || !planned.accounting_complete) throw new Error('Incomplete attached-image OALGO plan.');
        plan = planned.value;
    }
    const reviewer = policy.reviewer === 'flash-low' ? { reviewModel: 'gemini-3.8-flash', reviewReasoningEffort: 'low' }
        : policy.reviewer === 'sol-low' ? { reviewModel: 'gpt-5.6-sol', reviewReasoningEffort: 'low' } : {};
    if (!first && plan.keyframe?.recommended) first = await frame(ledger, plan, [], `${id}-first`, '16:9', fingerprint, reviewer);
    const segmentImages = {};
    if (first) for (const [index, segment] of plan.segments.entries()) {
        if (!index || !['cut', 'dissolve'].includes(segment.transition)) continue;
        const derived = derivedSegmentKeyframePlan(plan, index + 1);
        if (!derived) throw new Error(`Missing later-cut contract: ${id}/${index + 1}`);
        const source = await readFile(first.path);
        const image = await frame(ledger, derived, [{ bytes: source, mimeType: first.mimeType,
            label: 'Recurring cast identity from frame zero', kind: 'identity',
            visualFactsToPreserve: 'Preserve the recognizable recurring cast in this new shot.',
            sourceUrl: 'experiment-frame-zero', contextUrl: 'experiment-frame-zero' }],
        `${id}-segment-${index + 1}`, testCase.id === 'oalgo-screen-sign' ? '1:1' : testCase.source_image ? '2:3' : '16:9', fingerprint, reviewer);
        segmentImages[index + 1] = image.path;
    }
    const planPath = resolve(target, 'planner-output.json');
    await saveJsonAtomic(planPath, plan);
    const spec = { id, command: testCase.command, prompt: testCase.prompt, plan_path: planPath,
        keyframe_path: first?.path || null, segment_keyframes: segmentImages,
        requested_duration: requestedVideoDurationSeconds(testCase.prompt),
        seed: Number.parseInt(stableHash(testCase.id, 8), 16), aspect: first ? 'auto' : '16:9' };
    const path = resolve(target, 'spec.json');
    await saveJsonAtomic(path, spec);
    await exec('python3', ['scripts/prepare-video-render-contract.py', `--spec=${path}`, `--output=${target}`, `--generator=${generatorPath}`]);
    return JSON.parse(await readFile(resolve(target, 'render-spec.json'), 'utf8'));
}

async function main() {
    const previous = JSON.parse(await readFile(resolve(directory, 'render-manifest.json'), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return '{}'; throw error;
    }));
    generatorPath = resolve(argument('generator', previous.generator_path || '/mnt/d/AI/ComfyUI_windows_portable/video_gen/video_gen.py'));
    const corpus = JSON.parse(await readFile('benchmarks/video-optimization-corpus.json', 'utf8')).cases;
    const report = JSON.parse(await readFile(resolve(directory, 'report.json'), 'utf8'));
    const plannerFingerprint = await campaignFingerprint();
    if (report.fingerprint !== plannerFingerprint) throw new Error('Planner report is stale.');
    const fingerprint = await executionFingerprint(['dist/VideoKeyframeProvider.js', 'dist/VideoBroker.js',
        'dist/VideoUsage.js', 'scripts/prepare-video-optimization-renders.mjs']);
    const controlOnly = process.argv.includes('--control-only');
    const imageReport = JSON.parse(await readFile(resolve(directory, 'image-report.json'), 'utf8').catch(() => '{}'));
    const reviewer = (imageReport.reviewers || []).filter(row => row.eligible_for_video_review)
        .sort((a, b) => a.mean_cost_usd - b.mean_cost_usd)[0]?.candidate;
    const composite = Boolean(imageReport.composites?.find(row => row.candidate === 'flash')?.eligible_for_video_review);
    const ledger = await VideoExperimentLedger.open(directory, { phaseCapUsd: controlOnly ? 25 : 50 });
    const renders = [], pairs = [];
    try {
        const sourceFingerprint = report.screening_fingerprint || plannerFingerprint;
        const calls = Object.values(ledger.state.calls).filter(call => call.kind === 'planner' && call.fingerprint === sourceFingerprint);
        for (const id of ANCHORS) {
            const testCase = corpus.find(value => value.id === id);
            const control = calls.find(call => call.case_id === id && call.candidate === CONTROL && call.ok && call.accounting_complete);
            if (!control) throw new Error(`Missing valid control plan: ${id}`);
            const base = await prepareVariant(ledger, testCase, control.value, CONTROL, fingerprint);
            const baseId = `${id}-base`, fastId = `${id}-fast`;
            renders.push({ ...base, id: baseId, renderer_profile: 'h3-base' },
                { ...base, id: fastId, renderer_profile: 'fasth3-fixed-duration' });
            pairs.push({ id: `${id}-renderer`, command: testCase.command, component: 'renderer', control: baseId, candidate: fastId });
            const candidate = report.finalists[testCase.command];
            const qualified = !controlOnly && report.holdout.some(row => row.command === testCase.command && row.candidate === candidate && row.qualifies);
            const treatment = calls.find(call => call.case_id === id && call.candidate === candidate && call.ok && call.accounting_complete);
            const policy = { ...(qualified ? { planner: candidate } : {}),
                ...(!controlOnly && reviewer ? { reviewer } : {}), ...(!controlOnly && testCase.command === 'oalgo' && composite ? { composite: true } : {}) };
            if (Object.keys(policy).length) {
                const next = await prepareVariant(ledger, testCase, qualified && treatment ? treatment.value : control.value, 'cloud-policy', fingerprint, policy);
                const nextId = `${id}-cloud`;
                renders.push({ ...next, id: nextId, cloud_policy: policy, renderer_profile: 'h3-base' });
                pairs.push({ id: `${id}-cloud`, command: testCase.command, component: 'cloud', control: baseId, candidate: nextId });
            }
        }
        await saveJsonAtomic(resolve(directory, 'render-manifest.json'), { schema_version: 1, fingerprint,
            generator_path: generatorPath,
            planner_fingerprint: plannerFingerprint, screening_fingerprint: sourceFingerprint,
            component_review_passed: false, renders, pairs });
        console.log(`Prepared ${renders.length} unique videos and ${pairs.length} comparisons. Combined tests wait for component review.`);
    } finally { await ledger.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
