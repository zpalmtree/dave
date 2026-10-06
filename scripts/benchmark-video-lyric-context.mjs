#!/usr/bin/env node
// Live planning only: never enqueue a render. Review rubrics are not model input.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareRecoveryPlan } from '../dist/VideoRecoveryService.js';
import { videoSourceAudioPlannerGuidance } from '../dist/VideoSourceAudio.js';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
    if (!['--source', '--job', '--output', '--cases'].includes(process.argv[i]) || !process.argv[i + 1]) {
        throw Error('Usage: --source cutout.png --output directory [--job exported-job.json] [--cases id,id]');
    }
    args.set(process.argv[i], process.argv[i + 1]);
}
assert.ok(args.get('--source') && args.get('--output'), 'Provide a PNG cutout and output directory.');
const source = { mimeType: 'image/png', data: await readFile(resolve(args.get('--source'))) };
const output = resolve(args.get('--output'));
await mkdir(output, { recursive: true });
const job = args.has('--job') ? JSON.parse(await readFile(resolve(args.get('--job')))) : null;
const config = job?.plan?._planner_configuration;
const fixtures = JSON.parse(await readFile(new URL('../tests/fixtures/video-lyric-context.json', import.meta.url)));
const cases = fixtures.map(fixture => {
    const lines = fixture.lines.map((text, i) => ({ text, start: i * 4, end: (i + 1) * 4 }));
    const words = lines.flatMap(line => line.text.split(/\s+/).map((text, i, all) => ({
        text, start: line.start + i * 4 / all.length, end: line.start + (i + 1) * 4 / all.length,
    })));
    return { ...fixture, prompt: 'Make this subject sing the supplied song.', seconds: lines.length * 4, lyrics: { lines, words } };
});
if (job) {
    const seconds = job.source_audio_seconds ?? job.plan?.source_audio?.duration_seconds;
    assert.ok(Number.isFinite(seconds) && seconds > 0 && job.lyrics?.lines?.length, 'Job must contain song duration and lyric timing.');
    const song = job.recovery?.song;
    const recording = song ? { title: song.recording?.title || song.source?.title, artist: song.recording?.artist } : undefined;
    cases.unshift({ id: 'original_request', prompt: job.prompt, seconds, lyrics: job.lyrics, recording,
        review: 'Read the actual passage in context. No manually supplied scenery, lighting, or mood. Inspect whether inferred scenery fits the setting and speaker attitude rather than one isolated word.' });
    cases.push({ id: 'explicit_override', prompt: job.prompt + '. Keep the background plain blue throughout.',
        seconds, lyrics: job.lyrics, recording, review: 'Explicit plain blue background overrides inferred song scenery.' });
}
const selected = args.has('--cases') ? args.get('--cases').split(',') : cases.map(c => c.id);
assert.ok(selected.every(id => cases.some(c => c.id === id)), 'Unknown case ID.');
const results = await Promise.allSettled(cases.filter(c => selected.includes(c.id)).map(async item => {
    const usage = [];
    console.log(`Planning ${item.id}`);
    const prepared = await prepareRecoveryPlan({ prompt: item.prompt, model: 'minimax',
        requester: 'lyric-context-benchmark', sources: [source], sourceAudioSeconds: item.seconds,
        sourceAudioLyrics: item.lyrics, options: {
            ...(config ? { plannerModel: config.model, plannerStrategy: config.strategy,
                plannerPromptVariant: config.prompt_variant, analysisReasoningEffort: config.analysis_effort,
                screenplayReasoningEffort: config.screenplay_effort } : {}),
            requestedDurationSeconds: item.seconds,
            plannerGuidance: videoSourceAudioPlannerGuidance(item.lyrics, item.seconds, 'recording', item.recording),
            maxRequestAttempts: 1, onUsage: entry => usage.push(entry),
        } });
    await writeFile(resolve(output, `${item.id}.json`), JSON.stringify({ input: item, prepared, usage }, null, 2));
    assert.equal(prepared.prompt, item.prompt);
    assert.equal(prepared.plan.keyframe.recommended, false);
    assert.equal(prepared.plan.segments.reduce((n, s) => n + s.source_audio_frames, 0), Math.ceil(item.seconds * 24 - 1e-6));
    assert.ok(prepared.plan.segments.every(s => s.shots.every(shot => shot.dialogue.length === 0)));
    console.log(`Saved ${item.id}; semantic review required.`);
    return item.id;
}));
for (const result of results) if (result.status === 'rejected') console.error(result.reason);
if (results.some(result => result.status === 'rejected')) process.exitCode = 1;
