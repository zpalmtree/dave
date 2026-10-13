import assert from 'node:assert/strict';
import test from 'node:test';
import { validateVideoEditReference } from '../dist/VideoEditReference.js';

test('replacement caption rejects missing, name-only and unbounded output', () => {
    for (const value of [null, {}, { description: 42 }, { description: 'Meximutt' },
        { description: ' '.repeat(30) }, { description: 'x'.repeat(1001) }]) {
        assert.throws(() => validateVideoEditReference(value), /describe the replacement/);
    }
    assert.equal(validateVideoEditReference({ description: '  a broad-faced man in a green shirt  ' }),
        'a broad-faced man in a green shirt');
});
