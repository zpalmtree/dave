import assert from 'node:assert/strict';
import test from 'node:test';

import { getPriceCoins, PUMP_FUN_COIN } from '../dist/PriceCoins.js';

test('adds Pump.fun to the configured price coins', () => {
    const configuredCoins = [{ id: 'solana', label: 'Solana' }];

    assert.deepEqual(getPriceCoins(configuredCoins), [
        ...configuredCoins,
        PUMP_FUN_COIN,
    ]);
});

test('does not duplicate an existing Pump.fun price coin', () => {
    const configuredCoins = [
        { id: 'solana', label: 'Solana' },
        { id: 'pump-fun', label: 'PUMP' },
    ];

    assert.deepEqual(getPriceCoins(configuredCoins), configuredCoins);
});
