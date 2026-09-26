import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeVideoAudioContinuity } from '../dist/VideoAudioContinuity.js';
import { stageFrontierDialogueVisually, VIDEO_PLAN_SCHEMA, VIDEO_PLANNER_INSTRUCTIONS } from '../dist/VideoFrontierPlanner.js';

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

test('off-screen commentator keeps one identity across scenes and repairs legacy visible staging', () => {
    // Regression for 2ec4df6f: the pictured woman was silent, but the compiler
    // forced the off-screen male commentator into visible lip-sync in every scene.
    const plan = {
        speaker_profiles: [{ speaker_id: 'comentarista', voice_description: 'Off-screen adult male Colombian Spanish commentator, mid-low pitch, gravelly radio resonance, distinct from the on-screen woman' }],
        segments: [segment('comentarista', 'dry'), segment('COMENTARISTA', 'indignant')],
    };
    for (const scene of plan.segments) scene.shots[0].visual = 'The woman reacts with her lips closed. '
        + 'Visible dialogue staging: comentarista remains visible and delivers the assigned line with synchronized mouth movement.';
    const profiles = structuredClone(plan.speaker_profiles);
    const dialogue = plan.segments.map(scene => structuredClone(scene.shots[0].dialogue));
    normalizeVideoAudioContinuity(plan);
    assert.equal(stageFrontierDialogueVisually(plan), 2);
    for (const scene of plan.segments) {
        assert.match(scene.shots[0].visual, /^The woman reacts with her lips closed\./);
        assert.match(scene.shots[0].visual, /assigned off-screen lines with the established voice identity/);
        assert.match(scene.shots[0].visual, /visible characters do not lip-sync those words/);
        assert.doesNotMatch(scene.shots[0].visual, /remains visible|synchronized mouth movement/);
    }
    assert.deepEqual(plan.speaker_profiles, profiles);
    assert.deepEqual(plan.segments.map(scene => scene.shots[0].dialogue), dialogue);
    assert.equal(stageFrontierDialogueVisually(plan), 0);
});

test('mixed narration and character dialogue stage each speaker independently', () => {
    const plan = {
        speaker_profiles: [
            { speaker_id: 'commentator', voice_description: 'Off-screen low male voice' },
            { speaker_id: 'Maya', voice_description: 'Warm female alto' },
        ],
        segments: [{ shots: [{ visual: 'Maya answers the unseen commentator.', dialogue: [
            { speaker_id: 'commentator', text: 'Ready?' },
            { speaker_id: 'Maya', text: 'Yes.' },
        ] }] }],
    };
    stageFrontierDialogueVisually(plan);
    const visual = plan.segments[0].shots[0].visual;
    assert.match(visual, /Maya remains visible.*synchronized mouth movement/);
    assert.match(visual, /commentator delivers the assigned off-screen lines/);
    assert.doesNotMatch(visual, /commentator remains visible|commentator and Maya/);
});

test('per-turn placement can change without changing the speaker voice profile', () => {
    const plan = {
        speaker_profiles: [{ speaker_id: 'Alex', voice_description: 'Off-screen warm tenor' }],
        segments: [segment('alex', 'On-screen, whispering'), segment('Alex', 'off screen, shouting')],
    };
    stageFrontierDialogueVisually(plan);
    assert.match(plan.segments[0].shots[0].visual, /alex remains visible/);
    assert.match(plan.segments[1].shots[0].visual, /Alex delivers the assigned off-screen lines/);
    assert.equal(plan.speaker_profiles[0].voice_description, 'Off-screen warm tenor');
});

test('legacy delivery can specify voice-over without globally hiding other speakers', () => {
    for (const delivery of ['voice-over, softly', 'voiceover, softly', 'off-screen, softly']) {
        const plan = { segments: [segment('Guide', delivery)] };
        stageFrontierDialogueVisually(plan);
        assert.match(plan.segments[0].shots[0].visual, /Guide delivers the assigned off-screen lines/);
        assert.doesNotMatch(plan.segments[0].shots[0].visual, /synchronized mouth movement/);
    }
    const plan = { segments: [segment('Guide', 'on-screen, not voice-over')] };
    stageFrontierDialogueVisually(plan);
    assert.match(plan.segments[0].shots[0].visual, /Guide remains visible/);
});

test('restaging a now-silent shot removes obsolete generated speaking instructions', () => {
    const plan = { segments: [segment('Guide', 'calm')] };
    plan.segments[0].shots[0].visual = 'The guide waits.';
    stageFrontierDialogueVisually(plan);
    plan.segments[0].shots[0].dialogue = [];
    assert.equal(stageFrontierDialogueVisually(plan), 1);
    assert.equal(plan.segments[0].shots[0].visual, 'The guide waits.');
    assert.equal(stageFrontierDialogueVisually(plan), 0);
});

test('restaging preserves contract directions appended after legacy and current staging', () => {
    const plan = {
        speaker_profiles: [{ speaker_id: 'Guide', voice_description: 'Off-screen low tenor' }],
        segments: [segment('Guide', 'calm')],
    };
    const shot = plan.segments[0].shots[0];
    shot.visual = 'A woman waits. Visible dialogue staging: Guide remains visible and delivers the assigned line '
        + 'with synchronized mouth movement. Keep the red door open.';
    stageFrontierDialogueVisually(plan);
    assert.match(shot.visual, /^A woman waits\. Keep the red door open\./);
    assert.doesNotMatch(shot.visual, /remains visible|synchronized mouth movement/);
    shot.visual += ' Preserve the blue lantern.';
    stageFrontierDialogueVisually(plan);
    assert.match(shot.visual, /Keep the red door open\. Preserve the blue lantern\./);
    assert.equal(stageFrontierDialogueVisually(plan), 0);
});
