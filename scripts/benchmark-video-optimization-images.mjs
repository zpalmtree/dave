#!/usr/bin/env node
import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { oalgoSourceImageCompositePlan, derivedSegmentKeyframePlan } from '../dist/VideoBroker.js';
import { generateFrontierVideoKeyframeCandidate, reviewVideoKeyframe, buildVideoKeyframeReviewPrompt } from '../dist/VideoKeyframeProvider.js';
import { VideoExperimentLedger, executionFingerprint, ledgerTotals } from './video-experiment-ledger.mjs';
import { saveJsonAtomic, stableHash, stableShuffle, mean, percentile } from './video-cost-ab-lib.mjs';
import { mapWithConcurrency } from './video-planner-benchmark-lib.mjs';

const argument = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const directory = resolve(argument('run-dir', 'artifacts/video-optimization/2026-09-07'));
const phase = argument('phase', 'prepare');
const oldDirectory = resolve(argument('retained-frames', 'artifacts/video-keyframe-benchmarks/2026-08-25T11-16-53.002Z'));
const REVIEWERS = { 'sol-high': { model: 'gpt-5.6-sol', effort: 'high' }, 'sol-low': { model: 'gpt-5.6-sol', effort: 'low' }, 'flash-low': { model: 'gemini-3.8-flash', effort: 'low' } };
const IMAGE_MODELS = { pro: { geminiModel: 'gemini-3-pro-image', imageSize: '2K' }, flash: { geminiModel: 'gemini-3.1-flash-image', imageSize: '1K' } };
const paths = ['dist/VideoKeyframeProvider.js', 'dist/VideoBroker.js', 'dist/VideoFrontierPlanner.js',
    'dist/VideoUsage.js', 'scripts/benchmark-video-optimization-images.mjs', 'scripts/video-experiment-ledger.mjs'];
const imageReference = (path, label, facts, kind = 'identity') => ({ image_path: path, label, kind,
    visualFactsToPreserve: facts, mimeType: path.endsWith('.png') ? 'image/png' : 'image/jpeg' });
const referenceBytes = async references => Promise.all(references.map(async reference => ({ ...reference,
    bytes: await readFile(reference.image_path), sourceUrl: 'experiment-reference', contextUrl: 'experiment-reference' })));

async function buildManifest() {
    const report = JSON.parse(await readFile(resolve(oldDirectory, 'report-2026-08-25T23-56-44.407Z.json'), 'utf8'));
    const retained = [], generate = [];
    for (const [index, testCase] of report.cases.entries()) {
        const planPath = resolve(oldDirectory, `case-${index + 1}-plan.json`);
        const plan = JSON.parse(await readFile(planPath, 'utf8'));
        for (const image of testCase.generated.filter(image => image.ok)) retained.push({
            id: `retained-${index + 1}-${image.candidate}`, group: `retained-${index + 1}`, kind: 'retained',
            prompt: testCase.prompt, plan, image_path: image.image_path, mimeType: image.mime_type, references: [],
            provenance: 'Retained generated frame; old model labels are deliberately excluded.',
        });
        const attachment = resolve(oldDirectory, 'images', `case-${index + 1}-gemini-pro-2k.jpg`);
        const prompt = `OALGO reacts with annoyance to the main subject from the attached image. Preserve both references in one coherent scene.`;
        const references = [imageReference(resolve('images/oalgo.png'), 'OALGO identity reference',
            'Recognizable face, body, Mexican flag clothing and emblem, actual background, photographic style and palette.', 'style'),
        imageReference(attachment, 'Attached subject reference', 'Recognizable appearance of the salient subject, integrated naturally into the same scene.', 'object')];
        for (const candidate of ['pro', 'flash']) generate.push({ id: `composite-${index + 1}-${candidate}`,
            group: `composite-${index + 1}`, kind: 'composite', candidate, prompt,
            plan: oalgoSourceImageCompositePlan(prompt), references, aspectRatio: '1:1' });
        // Reuse a real later-cut contract and the same frame-zero identity reference.
        for (const [segmentIndex, segment] of plan.segments.entries()) {
            if (!segmentIndex || !['cut', 'dissolve'].includes(segment.transition)) continue;
            const segmentPlan = derivedSegmentKeyframePlan(plan, segmentIndex + 1);
            if (!segmentPlan) throw new Error('Invalid retained later-cut contract.');
            generate.push({ id: `later-cut-${index + 1}-${segmentIndex + 1}`, group: `retained-${index + 1}`, kind: 'later_cut', candidate: 'pro',
                prompt: testCase.prompt, plan: segmentPlan, references: [imageReference(attachment, 'Frame-zero identity reference',
                    'Keep the same recognizable recurring subject identity in this new shot.')], aspectRatio: '16:9' });
        }
    }
    if (retained.length !== 12 || generate.length !== 12) throw new Error('Expected 12 retained plus 12 new frames.');
    for (const image of retained) await access(image.image_path);
    const manifest = { schema_version: 1, retained, generate };
    await saveJsonAtomic(resolve(directory, 'image-manifest.json'), manifest);
    return manifest;
}

async function writePacket(cases) {
    const path = resolve(directory, 'human-review/reviewer.json');
    let existing;
    try { existing = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const ordered = [...cases].sort((a, b) => a.id.localeCompare(b.id));
    const packet = { schema_version: 1, blinded: true, cases: stableShuffle(ordered, 'optimization-frames-v1').map(entry => {
        const prompt = `${entry.prompt}\n\n${buildVideoKeyframeReviewPrompt(entry.plan, entry.references)}`;
        const previous = existing?.cases.find(value => value.case_id === entry.id && value.asset_hash === entry.asset_hash
            && value.context_hash === entry.context_hash && value.prompt === prompt);
        return { case_id: entry.id, image_path: entry.image_path, asset_hash: entry.asset_hash, prompt,
            references: entry.references, context_hash: entry.context_hash, human_acceptable: previous?.human_acceptable ?? null,
            material_failure: previous?.material_failure ?? null, notes: previous?.notes || '' };
    }) };
    await saveJsonAtomic(path, packet);
    const plannerPath = resolve(directory, 'human-review/planner.json');
    try { await access(plannerPath); } catch { await saveJsonAtomic(plannerPath, { schema_version: 1, blinded: true, cases: [] }); }
    return packet;
}

export function reviewerEvidence(calls, packet) {
    const complete = packet.cases.length === 24 && packet.cases.every(entry => typeof entry.human_acceptable === 'boolean' && typeof entry.material_failure === 'boolean');
    return Object.keys(REVIEWERS).map(candidate => {
        const own = calls.filter(call => call.kind === 'frame_reviewer' && call.candidate === candidate);
        let falseAccepts = 0, falseRejects = 0;
        for (const call of own) {
            const gold = packet.cases.find(entry => entry.case_id === call.case_id);
            if (!call.ok || typeof gold?.human_acceptable !== 'boolean') continue;
            if (!gold.human_acceptable && call.value.acceptable) falseAccepts++;
            if (gold.human_acceptable && !call.value.acceptable) falseRejects++;
        }
        return { candidate, samples: own.length, valid: own.filter(call => call.ok).length,
            human_labels_complete: complete, accounting_complete: own.length === 24 && own.every(call => call.accounting_complete),
            false_accepts: complete ? falseAccepts : null, false_rejects: complete ? falseRejects : null,
            mean_cost_usd: mean(own.map(call => call.cost_usd)), p95_seconds: percentile(own.map(call => call.duration_seconds), 0.95) };
    });
}

export function imageComponentEvidence(calls, packet) {
    const reviewers = reviewerEvidence(calls, packet);
    const control = reviewers.find(row => row.candidate === 'sol-high');
    for (const row of reviewers) {
        const costRatio = control.mean_cost_usd > 0 ? row.mean_cost_usd / control.mean_cost_usd : null;
        const timeRatio = control.p95_seconds > 0 ? row.p95_seconds / control.p95_seconds : null;
        row.eligible_for_video_review = row.candidate !== 'sol-high' && row.human_labels_complete
            && row.accounting_complete && control.accounting_complete && row.valid === 24 && control.valid === 24
            && row.false_accepts <= control.false_accepts && row.false_rejects <= control.false_rejects
            && costRatio !== null && timeRatio !== null
            && ((costRatio <= .85 && timeRatio <= 1.05) || (timeRatio <= .85 && costRatio <= 1.05));
    }
    const composites = ['pro', 'flash'].map(candidate => {
        const own = calls.filter(call => call.kind === 'frame_generation' && call.case_id.startsWith('composite-') && call.candidate === candidate);
        const labels = own.map(call => packet.cases.find(entry => entry.case_id === call.case_id));
        const complete = own.length === 4 && own.every(call => call.ok && call.accounting_complete)
            && labels.every(label => typeof label?.human_acceptable === 'boolean' && typeof label?.material_failure === 'boolean');
        return { candidate, complete, samples: own.length,
            accepted: complete ? labels.filter(label => label.human_acceptable).length : null,
            material_failures: complete ? labels.filter(label => label.material_failure).length : null,
            mean_cost_usd: mean(own.map(call => call.cost_usd)), p95_seconds: percentile(own.map(call => call.duration_seconds), .95) };
    });
    const [pro, flash] = composites;
    flash.eligible_for_video_review = pro.complete && flash.complete && flash.accepted >= pro.accepted
        && flash.material_failures === 0 && ((flash.mean_cost_usd <= pro.mean_cost_usd * .85 && flash.p95_seconds <= pro.p95_seconds * 1.05)
            || (flash.p95_seconds <= pro.p95_seconds * .85 && flash.mean_cost_usd <= pro.mean_cost_usd * 1.05));
    return { reviewers, composites };
}

async function main() {
    if (phase === 'prepare') { await buildManifest(); console.log('Prepared 24-frame design; no API calls.'); return; }
    if (!['run', 'report'].includes(phase)) throw new Error('Use --phase=prepare|run|report.');
    const manifestPath = resolve(directory, 'image-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const fingerprint = await executionFingerprint([...paths, manifestPath]);
    const ledger = await VideoExperimentLedger.open(directory, { phaseCapUsd: 25 });
    const cases = [...manifest.retained];
    let packet;
    try {
        if (phase === 'run') await mapWithConcurrency(stableShuffle(manifest.generate, 'images-v1'), 2, async entry => {
            const references = await referenceBytes(entry.references);
            const identity = { kind: 'frame_generation', case_id: entry.id, candidate: entry.candidate, fingerprint,
                references: references.map(reference => stableHash(reference.bytes, 64)) };
            const result = await ledger.checkpoint(identity, async hooks => {
                const image = await generateFrontierVideoKeyframeCandidate(entry.plan, references,
                    { ...hooks, ...IMAGE_MODELS[entry.candidate], aspectRatio: entry.aspectRatio, serviceTier: 'default' });
                const path = resolve(directory, 'frames', `${entry.id}.${image.mimeType.split('/')[1]}`);
                await import('node:fs/promises').then(fs => fs.mkdir(dirname(path), { recursive: true }));
                await writeFile(path, image.bytes);
                return { image_path: path, mimeType: image.mimeType, asset_hash: stableHash(image.bytes, 64) };
            });
            if (result.ok) cases.push({ ...entry, ...result.value });
            console.log(`${entry.id}: ${result.ok ? 'generated' : 'failed'}, $${ledgerTotals(ledger.state).charged_usd.toFixed(4)} cumulative`);
        });
        else for (const entry of manifest.generate) {
            const result = Object.values(ledger.state.calls).find(call => call.kind === 'frame_generation' && call.case_id === entry.id && call.fingerprint === fingerprint && call.ok);
            if (result) cases.push({ ...entry, ...result.value });
        }
        cases.sort((a, b) => a.id.localeCompare(b.id));
        for (const entry of cases) {
            const actual = stableHash(await readFile(entry.image_path), 64);
            if (entry.asset_hash && entry.asset_hash !== actual) throw new Error('Checkpoint frame bytes changed.');
            entry.asset_hash = actual;
            entry.context_hash = stableHash(JSON.stringify({ plan: entry.plan, references: await Promise.all(entry.references.map(async reference =>
                stableHash(await readFile(reference.image_path), 64))) }), 64);
        }
        packet = await writePacket(cases);
        if (phase === 'run') for (const entry of stableShuffle(cases, 'reviewer-order-v1')) {
            const references = await referenceBytes(entry.references);
            for (const candidate of stableShuffle(Object.keys(REVIEWERS), entry.id)) {
                const choice = REVIEWERS[candidate];
                await ledger.checkpoint({ kind: 'frame_reviewer', case_id: entry.id, candidate, fingerprint,
                    asset_hash: entry.asset_hash, reference_hashes: references.map(reference => stableHash(reference.bytes, 64)) },
                async hooks => reviewVideoKeyframe(entry.plan, { bytes: await readFile(entry.image_path),
                    mimeType: entry.mimeType, provider: 'blinded', model: 'blinded' }, references,
                { ...hooks, reviewModel: choice.model, reviewReasoningEffort: choice.effort,
                    serviceTier: 'default', reviewTimeoutMs: 120_000 }));
            }
        }
    } finally {
        try {
            if (!packet) packet = await writePacket(cases);
            else packet = JSON.parse(await readFile(resolve(directory, 'human-review/reviewer.json'), 'utf8'));
            const calls = Object.values(ledger.state.calls).filter(call => call.fingerprint === fingerprint);
            await saveJsonAtomic(resolve(directory, 'image-report.json'), { schema_version: 1, fingerprint, accounting: ledgerTotals(ledger.state),
                ...imageComponentEvidence(calls, packet),
                conclusion: 'Human labels, paired composite inspection and final videos are required. No automatic promotion. Frames share prompt families; 24 frames are not 24 independent prompts.' });
        } finally { await ledger.close(); }
    }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
