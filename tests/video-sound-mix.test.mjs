import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVideoAudioContinuity } from '../dist/VideoAudioContinuity.js';
import { VIDEO_PLAN_SCHEMA } from '../dist/VideoFrontierPlanner.js';
const plan = () => ({ sound_mix: { music: 'instrumental', caption: 'Gentle brushed percussion and warm piano, one continuous understated arrangement.', reason: 'Support the reveal.', effects: 'soften_transients' },
    segments: [{ music: 'different scene music', shots: [{ dialogue: [] }] }, { music: 'another song', shots: [{ dialogue: [] }] }] });

test('one score replaces per-segment music directions, not dialogue or effects', () => {
    const value = plan(); value.segments[0].shots[0].dialogue = [{ speaker_id: 'Mia', text: 'Hello.', delivery: 'soft' }];
    normalizeVideoAudioContinuity(value);
    assert.equal(value.sound_mix.music, 'instrumental');
    assert.equal(value.sound_mix.effects, 'preserve');
    assert.deepEqual(value.segments.map(s => s.music), ['N/A', 'N/A']);
    assert.equal(value.segments[0].shots[0].dialogue[0].text, 'Hello.');
});
test('explicit no-music requests and supplied soundtracks take precedence', () => {
    for (const prompt of ['No music.', 'without background music', 'complete silence', 'only sound effects']) {
        const value = plan(); normalizeVideoAudioContinuity(value, prompt);
        assert.equal(value.sound_mix.music, 'none');
        assert.deepEqual(value.segments.map(s => s.music), ['N/A', 'N/A']);
    }
    const value = plan(); value.source_audio = { output_frames: 240 }; normalizeVideoAudioContinuity(value);
    assert.equal(value.sound_mix.music, 'none'); assert.equal(value.sound_mix.effects, 'preserve');
    const silentDialogue = plan(); normalizeVideoAudioContinuity(silentDialogue, 'No speech.');
    assert.equal(silentDialogue.sound_mix.music, 'instrumental');
});
test('legacy plans stay unchanged audibly and malformed mix instructions fail', () => {
    const legacy = { segments: [] }; normalizeVideoAudioContinuity(legacy);
    assert.equal(legacy.sound_mix.music, 'none'); assert.equal(legacy.sound_mix.effects, 'preserve');
    const value = plan(); value.sound_mix.caption = ''; assert.throws(() => normalizeVideoAudioContinuity(value), /sound_mix/);
    assert.ok(VIDEO_PLAN_SCHEMA.required.includes('sound_mix'));
});
