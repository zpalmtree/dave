#!/usr/bin/env node
// Opt-in provider check. Generates synthetic screenshots and plans, never video jobs.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCanvas } from 'canvas';
import { createFrontierVideoPlan } from '../dist/VideoFrontierPlanner.js';
import { VIDEO_IMAGE_ONLY_AUTO_PROMPT } from '../dist/VideoProtocol.js';

const args = process.argv.slice(2);
const replay = args.includes('--replay');
if (args.includes('--live') === replay || !args.includes('--out') || !args[args.indexOf('--out') + 1]
    || args[args.indexOf('--out') + 1].startsWith('--')) {
    throw new Error('Usage: node scripts/check-video-image-only-planning.mjs (--live|--replay) --out DIRECTORY [--two-pass] [--case ID]. Live mode makes paid planner calls; replay checks saved plans. Neither renders or sends messages.');
}
const out = resolve(args[args.indexOf('--out') + 1]);
const caseId = args.includes('--case') ? args[args.indexOf('--case') + 1] : undefined;
const cases = JSON.parse(await readFile(new URL('../tests/fixtures/video-image-only-cases.json', import.meta.url)));
assert.ok(!caseId || cases.some(item => item.id === caseId), 'Unknown case ID');
await mkdir(out, { recursive: true });

function screenshot(posts) {
    const canvas = createCanvas(720, 1000);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#080808';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    let y = 44;
    for (const [index, post] of posts.entries()) {
        ctx.fillStyle = '#999999';
        ctx.font = '20px sans-serif';
        ctx.fillText(`Example post ${index + 1} · translated · 2h`, 30, y);
        y += 42;
        ctx.font = '27px sans-serif';
        ctx.fillStyle = '#eeeeee';
        for (const paragraph of post.split('\n')) {
            let line = '';
            for (const word of paragraph.split(/\s+/)) {
                const next = line ? `${line} ${word}` : word;
                if (ctx.measureText(next).width > 650 && line) {
                    ctx.fillText(line, 30, y);
                    y += 37;
                    line = word;
                } else line = next;
            }
            ctx.fillText(line, 30, y);
            y += 37;
        }
        ctx.fillStyle = '#777777';
        ctx.font = '18px sans-serif';
        ctx.fillText('12 replies       38 reposts       241 likes', 30, y + 15);
        y += 52;
        ctx.fillStyle = '#333333';
        ctx.fillRect(0, y, 720, 1);
        y += 44;
    }
    assert.ok(y < canvas.height, 'Fixture text exceeds screenshot height');
    return canvas.toBuffer('image/png');
}

const results = [];
for (const fixture of cases.filter(item => !caseId || item.id === caseId)) {
    const data = screenshot(fixture.posts);
    await writeFile(resolve(out, `${fixture.id}.png`), data);
    const usage = [];
    const started = Date.now();
    try {
        const plan = replay
            ? JSON.parse(await readFile(resolve(out, `${fixture.id}.plan.json`)))
            : await createFrontierVideoPlan(
            fixture.prompt || VIDEO_IMAGE_ONLY_AUTO_PROMPT, 'minimax', 'image-only-regression',
            { data, mimeType: 'image/png' }, {
                plannerStrategy: args.includes('--two-pass') ? 'two-pass' : 'single-pass',
                analysisReasoningEffort: 'low', screenplayReasoningEffort: 'low',
                maxRequestAttempts: 1,
                onUsage: entry => { usage.push(entry); },
            },
        );
        await writeFile(resolve(out, `${fixture.id}.plan.json`), JSON.stringify(plan, null, 2));
        const analysis = plan.prompt_analysis;
        assert.ok(fixture.strategies.includes(analysis.source_image_strategy), analysis.source_image_strategy);
        assert.equal(plan.keyframe.recommended, false);
        assert.deepEqual(plan.keyframe.reference_requirements, []);
        const adapted = plan.segments.slice(1);
        const visuals = adapted.flatMap(segment => segment.shots.map(shot => shot.visual)).join('\n').toLowerCase();
        if (analysis.source_image_strategy === 'narrative_adaptation') {
            assert.ok(analysis.source_narrative_beats.length > 0, 'Missing grounded narrative beats');
            assert.ok(adapted.some(segment => segment.transition === 'cut'), 'Missing cut from source into story');
            for (const term of fixture.visual_terms || []) assert.ok(visuals.includes(term.toLowerCase()), `Missing visual ${term}`);
            const words = new Set(visuals.match(/[\p{L}\p{N}_]+/gu));
            for (const term of fixture.excluded_visual_terms || []) assert.ok(!words.has(term.toLowerCase()), `Unrelated visual ${term}`);
        }
        if (fixture.no_dialogue) {
            assert.ok(plan.segments.every(segment => segment.shots.every(shot => shot.dialogue.length === 0)));
        }
        results.push({ id: fixture.id, passed: true, strategy: analysis.source_image_strategy, review: fixture.review });
    } catch (error) {
        results.push({ id: fixture.id, passed: false, error: error.message, review: fixture.review });
        process.exitCode = 1;
    } finally {
        if (!replay) await writeFile(resolve(out, `${fixture.id}.usage.json`), JSON.stringify({ seconds: (Date.now() - started) / 1000, usage }, null, 2));
    }
    console.log(JSON.stringify(results.at(-1)));
    await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2));
}
