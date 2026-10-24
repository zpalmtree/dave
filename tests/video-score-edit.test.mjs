import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateEdit, bypassReason, requestEdit, planScoreEdit } from '../scripts/plan-video-score-edit.mjs';

const edit = () => ({ vocal_regions: [], music: 'edited', reason: 'Enter at the reveal and use the answering phrase.',
    scene_events: [{ time: 2, description: 'The door opens.' }],
    music_events: [{ time: 5, description: 'The melody answers.' }],
    cues: [{ start: 2, end: 5, source_start: 5, gain_db: 0, fade_in: .2, fade_out: .5, reason: 'Melody answers the door reveal.' }] });

test('separate video and score clocks, silence, and continuous music are supported', () => {
    assert.equal(validateEdit(edit(), 6, 10).cues[0].source_start, 5);
    assert.equal(validateEdit({ ...edit(), music: 'none', cues: [] }, 6, 10).music, 'none');
    const full = edit(); full.cues[0] = { ...full.cues[0], start: 0, end: 6, source_start: 0 };
    assert.equal(validateEdit(full, 6, 10).cues[0].end, 6);
});

test('invalid edits cannot become silent clipping, looping, boosting, or overlapping music', () => {
    for (const change of [{ end: 7 }, { source_start: 9 }, { start: NaN }, { gain_db: 1 },
        { fade_out: 4 }, { reason: '' }, { start: '2' }]) {
        const value = edit(); Object.assign(value.cues[0], change);
        assert.throws(() => validateEdit(value, 6, 10));
    }
    const overlap = edit(); overlap.cues.push({ ...overlap.cues[0] });
    assert.throws(() => validateEdit(overlap, 6, 10), /Overlapping/);
    assert.throws(() => validateEdit({ ...edit(), music: 'none' }, 6, 10), /Inconsistent/);
    assert.throws(() => validateEdit({ ...edit(), scene_events: [{ time: 7, description: 'Impossible' }] }, 6, 10));
});

test('only explicit constraints force bypass; comedy and speech do not', () => {
    for (const prompt of ['No background music', 'Only sound effects', 'complete silence']) assert.ok(bypassReason({ prompt }));
    assert.ok(bypassReason({ preserveSourceAudio: true }));
    assert.equal(bypassReason({ prompt: 'Awkward quiet comedy with two people talking' }), null);
});

test('one bounded repair preserves invalid output evidence; repeated invalid edits fail', async () => {
    let calls = 0;
    const client = { models: { generateContent: async () => ({ text: JSON.stringify(++calls === 1 ? { ...edit(), cues: [] } : edit()) }) } };
    const result = await requestEdit(client, { model: 'test', parts: [], videoSeconds: 6, scoreSeconds: 10 });
    assert.equal(calls, 2); assert.equal(result.attempts.length, 2);
    assert.match(result.attempts[0].validation_error, /Inconsistent/);
    calls = 0; client.models.generateContent = async () => { calls++; return { text: '{}' }; };
    await assert.rejects(requestEdit(client, { model: 'test', parts: [], videoSeconds: 6, scoreSeconds: 10 }), /after one repair/);
    assert.equal(calls, 2);
});

test('bypass performs no model call; receipts resist stale input reuse and concurrent writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'score-editor-'));
    try {
        const source = join(root, 'video.mp4'), score = join(root, 'score.flac'), directory = join(root, 'out');
        await writeFile(source, 'source'); await writeFile(score, 'score');
        const options = { client: { models: { generateContent: () => { throw Error('Must not be called'); } } },
            model: 'test', source, score, directory, prompt: 'no music' };
        const first = await planScoreEdit(options);
        assert.equal(first.status, 'bypassed'); assert.equal(first.edit.cues.length, 0);
        assert.deepEqual(await planScoreEdit(options), first);
        await writeFile(source, 'changed');
        await assert.rejects(planScoreEdit(options), /different inputs/);
        assert.equal(JSON.parse(await readFile(join(directory, 'edit.json'))).fingerprint, first.fingerprint);
        await writeFile(join(directory, 'editor.lock'), 'another owner');
        await assert.rejects(planScoreEdit(options), /EEXIST/);
        assert.equal(await readFile(join(directory, 'editor.lock'), 'utf8'), 'another owner');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('instrumental gate checks source clock, including a safety margin', () => {
    const value = edit(); value.vocal_regions = [{ start: 7.8, end: 8.5, description: 'Suspected shout' }];
    assert.throws(() => validateEdit(value, 6, 10), /vocal region/);
    value.cues[0].source_start = 0;
    assert.equal(validateEdit(value, 6, 10), value);
    delete value.vocal_regions;
    assert.throws(() => validateEdit(value, 6, 10), /Missing vocal/);
});
