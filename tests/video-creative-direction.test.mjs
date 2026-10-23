import test from 'node:test';
import assert from 'node:assert/strict';
import { VIDEO_SINGLE_PASS_INSTRUCTIONS, VIDEO_PLANNER_INSTRUCTIONS, VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, videoPlannerSystemInstructions, videoPlannerFingerprint, configuredVideoPlannerPromptVariant } from '../dist/VideoFrontierPlanner.js';

test('experimental direction replaces conflicting defaults while preserving binding contracts', () => {
    const base=videoPlannerSystemInstructions(VIDEO_SINGLE_PASS_INSTRUCTIONS,'opus-tuned');
    const candidate=videoPlannerSystemInstructions(VIDEO_SINGLE_PASS_INSTRUCTIONS,'opus-experience');
    assert.match(candidate,/amusement, beauty, curiosity/);
    assert.match(candidate,/a pun is optional/);
    assert.match(candidate,/compact, distinct description for each recurring participant/);
    assert.match(candidate,/not precisely timed cues/);
    assert.doesNotMatch(candidate,/prefer mode generated and let the screenplay|each later beat must make it bigger/);
    for(const prefix of ['Treat every content-bearing word','Treat prompt_analysis.coverage_contract','Treat prompt_analysis.visible_text_contract','For a seamless loop','Treat explicit speaking intent']) {
        const paragraph=VIDEO_PLANNER_INSTRUCTIONS.split('\n\n').find(p=>p.startsWith(prefix));
        assert.ok(paragraph,prefix);assert.ok(candidate.includes(paragraph),prefix);
    }
    assert.match(base,/each later beat must make it bigger/);
    assert.equal(configuredVideoPlannerPromptVariant('claude-opus-5-5'),'opus-tuned');
});
test('analysis-only, screenplay-only and combined calls receive compatible direction and distinct fingerprints',()=>{
    assert.match(videoPlannerSystemInstructions(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS,'opus-experience'),/does not by itself require speech/);
    assert.match(videoPlannerSystemInstructions(VIDEO_PLANNER_INSTRUCTIONS,'opus-experience'),/State that intention/);
    const fp=v=>videoPlannerFingerprint('claude-opus-5-5','medium','medium','','hybrid-single-pass',v);
    assert.notEqual(fp('opus-tuned'),fp('opus-experience'));
});

test('specificity candidate preserves the winning instructions and adds only scene logic and theme checks',()=>{
    const base=videoPlannerSystemInstructions(VIDEO_SINGLE_PASS_INSTRUCTIONS,'opus-tuned');
    const candidate=videoPlannerSystemInstructions(VIDEO_SINGLE_PASS_INSTRUCTIONS,'opus-specificity');
    assert.ok(candidate.startsWith(base));
    assert.match(candidate,/what they can see, know, hold/);
    assert.match(candidate,/themed surface must still be shown clearly/);
    assert.match(candidate,/do not add sarcasm merely to excuse/);
    assert.doesNotMatch(candidate.slice(base.length),/music=|sound_mix/);
    const fp=v=>videoPlannerFingerprint('claude-opus-5-5','medium','medium','','hybrid-single-pass',v);
    assert.notEqual(fp('opus-tuned'),fp('opus-specificity'));
    assert.equal(configuredVideoPlannerPromptVariant('claude-opus-5-5'),'opus-tuned');
});
