import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeVideoAudioContinuity } from '../dist/VideoAudioContinuity.js';
import { VIDEO_PLAN_SCHEMA, VIDEO_PLANNER_INSTRUCTIONS } from '../dist/VideoFrontierPlanner.js';

const segment = (speaker, delivery, text = 'Hello.') => ({
    transition: 'cut', shots: [{ dialogue: [{ speaker_id: speaker, delivery, text }] }],
});

test('legacy voices stay anchored to their first turn without rewriting later performances', () => {
    const plan = { segments: [segment('A', 'low and resonant'), segment('B', 'light and airy'), segment('a', 'shouting')] };
    normalizeVideoAudioContinuity(plan);
    assert.deepEqual(plan.speaker_profiles, [
        { speaker_id: 'A', voice_description: 'low and resonant' },
        { speaker_id: 'B', voice_description: 'light and airy' },
    ]);
    assert.equal(plan.segments[2].shots[0].dialogue[0].delivery, 'shouting');
    assert.equal(plan.segments[2].shots[0].dialogue[0].text, 'Hello.');
    assert.equal(plan.segments[2].audio_transition, 'auto');
    const before = structuredClone(plan);
    normalizeVideoAudioContinuity(plan);
    assert.deepEqual(plan, before);
});

test('explicit voice identity and independent audio cuts survive normalization', () => {
    const plan = {
        speaker_profiles: [{ speaker_id: 'A', voice_description: 'warm alto with a Scottish accent' }],
        segments: [{ ...segment('A', 'whispering'), transition: 'dissolve', audio_transition: 'cut' }],
    };
    normalizeVideoAudioContinuity(plan);
    assert.equal(plan.speaker_profiles[0].voice_description, 'warm alto with a Scottish accent');
    assert.equal(plan.segments[0].audio_transition, 'cut');
    assert.equal(plan.segments[0].transition, 'dissolve');
});

test('silent legacy plans have no invented speakers', () => {
    const plan = { segments: [{ shots: [{ dialogue: [] }] }] };
    normalizeVideoAudioContinuity(plan);
    assert.deepEqual(plan.speaker_profiles, []);
});

test('ambiguous profiles and unsupported audio edits fail validation', () => {
    assert.throws(() => normalizeVideoAudioContinuity({ speaker_profiles: [
        { speaker_id: 'A', voice_description: 'alto' },
        { speaker_id: 'a', voice_description: 'tenor' },
    ] }), /unique/);
    assert.throws(() => normalizeVideoAudioContinuity({ segments: [{ audio_transition: 'overlap-speech' }] }), /Invalid audio/);
});

test('both planner fields are required in newly generated plans', () => {
    assert.ok(VIDEO_PLAN_SCHEMA.required.includes('speaker_profiles'));
    assert.ok(VIDEO_PLAN_SCHEMA.properties.segments.items.required.includes('audio_transition'));
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /habitual pitch range/);
});
