import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateVideoEditDecision, sampleVideoEditFrames, videoEditSampleTimes } from '../dist/VideoEditIntent.js';
import { resolveVideoEditRequest } from '../dist/VideoGeneration.js';

const clip = { clip_url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4', name: 'clip.mp4' };
const image = { url: 'https://cdn.discordapp.com/attachments/1/2/image.png', name: 'image.png' };
const message = { attachments: new Map() };
const sources = async (_command, _reply, edit) => edit ? { image, clip } : { image: clip, clip: null };

test('conversational requests keep source target, replacement, image and reply context separate', async () => {
    const result = await resolveVideoEditRequest('make him a robot lol', message, null, 'earlier: the dancer', false,
        async input => {
            assert.equal(input.request, 'make him a robot lol');
            assert.equal(input.context, 'earlier: the dancer');
            assert.equal(input.hasReplacementImage, true);
            assert.equal(input.hasPreset, false);
            return { action: 'replace', target: 'the dancer', replacement: 'a robot', clarification: '' };
        }, sources);
    assert.deepEqual(result, { replacement: { target: 'the dancer', prompt: 'a robot', mode: 'replace' }, sources: { image, clip } });
});

test('additions keep the source clip and name the anchor subject they join', async () => {
    const result = await resolveVideoEditRequest('needs more squid girls', message, null, 'reply: Splatoon Tahoe', false,
        async () => ({ action: 'add', target: 'the purple truck', replacement: 'more Splatoon squid girls', clarification: '' }),
        sources);
    assert.deepEqual(result, { replacement: { target: 'the purple truck', prompt: 'more Splatoon squid girls', mode: 'add' },
        sources: { image, clip } });
});

test('explicit replacement syntax bypasses intent classification, still retaining clip for visual grounding', async () => {
    const result = await resolveVideoEditRequest('replace Captain with slugs', message, null, '', true,
        async () => { throw new Error('should not classify'); }, sources);
    assert.equal(result.replacement.target, 'Captain');
    assert.equal(result.sources.clip, clip);
});

test('bare oalgo clips expose their preset to interpretation', async () => {
    const result = await resolveVideoEditRequest('', message, null, '', true, async input => {
        assert.equal(input.hasPreset, true);
        assert.equal(input.hasReplacementImage, false);
        return { action: 'replace', target: 'main subject', replacement: 'Meximutt', clarification: '' };
    }, async () => ({ image: null, clip }));
    assert.equal(result.replacement.prompt, 'Meximutt');
});

test('new-video requests retain clip-frame behavior rather than becoming edits', async () => {
    const result = await resolveVideoEditRequest('react to this', message, null, '', true,
        async () => ({ action: 'generate', target: '', replacement: '', clarification: '' }), sources);
    assert.equal(result.replacement, null);
    assert.equal(result.sources.clip, null);
    assert.equal(result.sources.image, clip);
});

test('generation routing preserves command-link precedence over a replied attachment', async () => {
    const calls = [];
    const commandClip = { ...clip, clip_url: 'https://video.twimg.com/command.mp4' };
    const result = await resolveVideoEditRequest('continue this', message, message, '', false,
        async () => ({ action: 'generate', target: '', replacement: '', clarification: '' }),
        async (_command, _reply, edit) => {
            calls.push(edit);
            return edit ? { image: null, clip: commandClip } : { image: commandClip, clip: null };
        });
    assert.deepEqual(calls, [true, false]);
    assert.equal(result.sources.image, commandClip);
});

test('clarification and provider errors cannot silently become a different generation', async () => {
    await assert.rejects(resolveVideoEditRequest('change it', message, null, '', false,
        async () => ({ action: 'clarify', target: '', replacement: '', clarification: 'Replace it with what?' }), sources),
    /Replace it with what/);
    await assert.rejects(resolveVideoEditRequest('change it', message, null, '', false,
        async () => { throw new Error('unavailable'); }, sources), /unavailable/);
});

test('non-video requests never invoke the video edit interpreter', async () => {
    const result = await resolveVideoEditRequest('a robot', message, null, '', false,
        async () => { throw new Error('should not classify'); }, async () => ({ image: null, clip: null }));
    assert.equal(result.replacement, null);
});

test('structured decisions reject empty or invalid grounding instead of using the original name', () => {
    for (const value of [null, {}, { action: 'replace', target: '', clarification: '' },
        { action: 'replace', target: 'x'.repeat(121), clarification: '' },
        { action: 'generate', target: 'person', clarification: '' },
        { action: 'clarify', target: '', clarification: '' }]) {
        assert.throws(() => validateVideoEditDecision(value, false), /interpret/);
    }
    assert.deepEqual(validateVideoEditDecision({ action: 'replace', target: ' red car ', clarification: '' }, false),
        { action: 'replace', target: 'red car', effects: '', subjects: 'primary', clarification: '' });
    assert.deepEqual(validateVideoEditDecision({ action: 'replace', target: 'bull-headed man',
        effects: ' two light beams from its eyes ', clarification: '' }, false),
        { action: 'replace', target: 'bull-headed man', effects: 'two light beams from its eyes', subjects: 'primary',
            clarification: '' });
    assert.deepEqual(validateVideoEditDecision({ action: 'replace', target: 'the dancers', effects: '', subjects: 'group',
        clarification: '' }, false), { action: 'replace', target: 'the dancers', effects: '', subjects: 'group', clarification: '' });
    assert.deepEqual(validateVideoEditDecision({ action: 'clarify', target: '', effects: 'beams', subjects: 'group',
        clarification: 'Which person?' }, false),
        { action: 'clarify', target: '', effects: '', subjects: 'primary', clarification: 'Which person?' });
    assert.throws(() => validateVideoEditDecision({ action: 'replace', target: 'man', effects: 'x'.repeat(161),
        clarification: '' }, false), /interpret/);
    assert.throws(() => validateVideoEditDecision({ action: 'replace', target: 'man', effects: '', subjects: 'everyone',
        clarification: '' }, false), /interpret/);
    for (const value of [{ action: 'add', target: '', replacement: 'a hat', clarification: '' },
        { action: 'add', target: 'the man', replacement: '', clarification: '' }]) {
        assert.throws(() => validateVideoEditDecision(value, true), /interpret/);
    }
    assert.throws(() => validateVideoEditDecision({ action: 'add', target: 'the man', clarification: '' }, false), /interpret/);
    assert.deepEqual(validateVideoEditDecision({ action: 'add', target: ' the man ', replacement: ' a hat ', clarification: '' }, true),
        { action: 'add', target: 'the man', replacement: 'a hat', clarification: '' });
});

test('samples contain actual source frames across the timeline, including short clips', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'video-edit-frames-'));
    try {
        const path = join(directory, 'clip.mp4');
        execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=24:duration=0.5',
            '-c:v', 'libx264', path]);
        const frames = await sampleVideoEditFrames({ path, duration: 0.5, bytes: 100 });
        assert.deepEqual(frames.map(f => f.seconds), [0, 0.1, 0.2, 0.3, 0.4]);
        assert.ok(frames.every(f => f.data[0] === 0xff && f.data[1] === 0xd8));
        assert.notDeepEqual(frames[0].data, frames[4].data);
        assert.deepEqual(videoEditSampleTimes(120), [0, 24, 48, 72, 96]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
