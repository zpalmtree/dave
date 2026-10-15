import assert from 'node:assert/strict';
import test from 'node:test';

import { getDiscordLoginRetryDelay } from '../dist/DiscordRetry.js';

test('backs off Discord login retries and caps them at one minute', () => {
    assert.deepEqual(
        [0, 1, 2, 3, 4, 10].map(getDiscordLoginRetryDelay),
        [5_000, 10_000, 20_000, 40_000, 60_000, 60_000],
    );
});

test('only revoked-intent errors enable limited login mode', async () => {
    const { isDisallowedIntentsError } = await import('../dist/DiscordRetry.js');
    assert.equal(isDisallowedIntentsError(new Error('Used disallowed intents')), true);
    assert.equal(isDisallowedIntentsError(Object.assign(new Error('gateway closed'), { code: 4014 })), true);
    assert.equal(isDisallowedIntentsError(new Error('Invalid token')), false);
    assert.equal(isDisallowedIntentsError(new Error('Network timeout')), false);
});
