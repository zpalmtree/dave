import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { videoPromptContentNumbers } from '../dist/VideoProtocol.js';
import { approvedLocalRecoveryContract, requireRecoveryPlanningPolicy } from '../dist/VideoRecovery.js';

for (const fixture of JSON.parse(readFileSync(new URL('./fixtures/video-planning-numbers.json', import.meta.url)))) {
    test(`instruction numbers versus content: ${fixture.prompt}`, () => {
        assert.deepEqual(videoPromptContentNumbers(fixture.prompt), fixture.numbers);
    });
}

test('recovery preserves six scenes at thirty seconds and refuses extensions or omissions', () => {
    const plan = { segments: Array.from({ length: 6 }, () => ({ target_seconds: 5, shots: [{}] })) };
    assert.doesNotThrow(() => requireRecoveryPlanningPolicy(plan, 30));
    assert.doesNotThrow(() => approvedLocalRecoveryContract(plan, 'Make it 30 seconds.', 'other'));
    plan.segments[5].target_seconds = 8;
    assert.throws(() => requireRecoveryPlanningPolicy(plan, 30), /Duration conflict.*33.00s.*30s/);
    assert.throws(() => approvedLocalRecoveryContract(plan, 'Make it 30 seconds.', 'other'), /Duration conflict/);
    plan.segments[5].output_seconds = 5;
    assert.doesNotThrow(() => requireRecoveryPlanningPolicy(plan, 30));
    plan.best_effort_truncated = true;
    assert.throws(() => requireRecoveryPlanningPolicy(plan, 30), /truncated/);
});

test('legacy local quality rejection carries the specific reason and screenplay count', () => {
    const plan = { segments: [{ shots: [{}] }], quality_gate_bypassed: true,
        quality_gate_issues: ['The final garden scene is missing'], planner: { screenplay_attempts: 3 } };
    assert.throws(() => approvedLocalRecoveryContract(plan, 'A garden story', 'other'),
        /after 3 screenplay attempts: The final garden scene is missing.*No video was rendered/);
});
