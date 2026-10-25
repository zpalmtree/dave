import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas } from 'canvas';
import { recoveryKeyframeAspect } from '../dist/VideoCanvas.js';

test('recovery openings match source framing, including model-rounded dimensions', async () => {
    for (const [width, height, aspect] of [[832, 832, '1:1'], [736, 1120, '2:3'],
        [1344, 768, '16:9'], [768, 1344, '9:16'], [1120, 736, '3:2']]) {
        assert.equal(await recoveryKeyframeAspect(undefined, createCanvas(width, height).toBuffer('image/png')), aspect);
    }
    assert.equal(await recoveryKeyframeAspect(undefined), '16:9');
});

test('accepted opening aspect overrides the identity reference and rejects invalid requests', async () => {
    const portrait = createCanvas(512, 768).toBuffer('image/png');
    assert.equal(await recoveryKeyframeAspect('16:9', portrait), '16:9');
    assert.equal(await recoveryKeyframeAspect('1:1', portrait), '1:1');
    await assert.rejects(recoveryKeyframeAspect('sideways', portrait), /Invalid recovery canvas/);
});
