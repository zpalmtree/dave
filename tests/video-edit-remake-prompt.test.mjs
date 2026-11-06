import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleRemakePrompt, writeRemakePrompt, REMAKE_PROMPT_SECTIONS } from '../dist/VideoEditRemakePrompt.js';

const sections = {
    subject_definitions: '<Video 1> is the source video for the editing task: a cartoon duck. <Picture 1> is a frame of the target video, from [Shot 1]. <Subject 1> is Meximutt in <Picture 1>.',
    summary: '[video editing + character replacement] The target video is an edited version of <Video 1>.',
    retention_analysis: '<Video 1> (source video editing): fully_preserved - the shot.',
    detailed_description: 'A photographic portrait.\n[Shot 1] At 00:00.000 <Subject 1> smirks — at about 00:01.200 he shuts his eyes, matching <Picture 1> at about 00:01.833.',
    overall_soundscape: 'Silence.',
    non_diegetic_music: 'N/A',
};

test('a Remake prompt is six labelled sections of plain ASCII in the trained order', () => {
    const prompt = assembleRemakePrompt(sections, 1, 90);
    assert.deepEqual(prompt.split('\n\n').map(part => part.split(':\n')[0]), [...REMAKE_PROMPT_SECTIONS]);
    assert.match(prompt, /smirks - at about/);
    assert.doesNotMatch(prompt, /[^\x20-\x7e\n]/);
});

test('a Remake prompt fails closed on missing labels, unknown pictures and timestamps past the window', () => {
    assert.throws(() => assembleRemakePrompt({ ...sections, summary: '' }, 1, 90), /no summary/);
    assert.throws(() => assembleRemakePrompt(sections, 2, 90), /never places <Picture 2>/);
    assert.throws(() => assembleRemakePrompt({ ...sections, retention_analysis: '<Picture 3> is extra.' }, 1, 90), /<Picture 3>/);
    assert.throws(() => assembleRemakePrompt({ ...sections, detailed_description:
        '[Shot 1] <Subject 1> waves at 00:04.500, matching <Picture 1>.' }, 1, 90), /past the 00:03.750 window/);
    assert.throws(() => assembleRemakePrompt({ ...sections, subject_definitions: sections.subject_definitions.replace(', from [Shot 1]', ''),
        detailed_description: 'No shot label, <Picture 1>.' }, 1, 90), /\[Shot 1\]/);
});

test('the prompt writer sends the window clip and pinned still to Gemini and validates the reply', async t => {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        assert.match(String(input), /generativelanguage.googleapis.com/);
        requests.push(JSON.parse(init.body));
        return new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify(sections) }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const usage = [];
    const prompt = await writeRemakePrompt({
        clip: { bytes: Buffer.from('clip'), mimeType: 'video/mp4' }, frames: 90, sourceFrames: 72,
        pictures: [{ image: { bytes: Buffer.from('still'), mimeType: 'image/png' }, frame: 44 }],
        target: 'the yellow cartoon duck', request: 'meximutt', replacementDescription: 'a heavy-set man',
    }, { onUsage: event => usage.push(event) });
    assert.match(prompt, /^subject_definitions:\n/);
    const parts = requests[0].contents[0].parts;
    const video = parts.find(part => part.inlineData?.mimeType === 'video/mp4');
    assert.ok(video);
    // Gemini's default of one frame a second misses a blink or a tongue flick.
    assert.equal(video.videoMetadata?.fps, 8);
    assert.ok(parts.some(part => /pinned at output frame 44 \(00:01.833\)/.test(part.text || '')));
    assert.ok(parts.some(part => /holds its last frame/.test(part.text || '')));
    assert.equal(usage[0].stage, 'video_edit_remake_prompt');
    await writeRemakePrompt({
        clip: { bytes: Buffer.from('clip'), mimeType: 'video/mp4' }, frames: 90, sourceFrames: 38, padding: 'boomerang',
        pictures: [{ image: { bytes: Buffer.from('still'), mimeType: 'image/png' }, frame: 20 }],
        target: 'Mario', request: 'meximutt', replacementDescription: 'a heavy-set man',
    });
    assert.ok(requests[1].contents[0].parts.some(part => /backwards and forwards/.test(part.text || '')));
    await assert.rejects(writeRemakePrompt({
        clip: { bytes: Buffer.from('clip'), mimeType: 'video/mp4' }, frames: 91, sourceFrames: 72,
        pictures: [{ image: { bytes: Buffer.from('still'), mimeType: 'image/png' }, frame: 44 }],
        target: 't', request: '', replacementDescription: '',
    }), /Invalid Remake prompt request/);
});
