import assert from 'node:assert/strict';
import test from 'node:test';
import { validateEditReview } from '../dist/VideoEditReview.js';
test('subject edit review fails closed on missing, string-valued or malformed decisions', () => {
    for (const result of [undefined, {}, {accepted:'true',reason:'ok'}, {accepted:true,reason:''},
        {accepted:true,reason:'x'.repeat(801)}, {accepted:1,reason:'ok'}]) {
        assert.throws(() => validateEditReview(result));
    }
    assert.deepEqual(validateEditReview({accepted:false,reason:' Wrong performer. '}), {accepted:false,reason:'Wrong performer.'});
});
