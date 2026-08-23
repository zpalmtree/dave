import { Coin } from './Types.js';

export const PUMP_FUN_COIN: Coin = {
    id: 'pump-fun',
    label: 'Pump.fun',
};

export function getPriceCoins(configuredCoins: readonly Coin[]): Coin[] {
    if (configuredCoins.some(({ id }) => id === PUMP_FUN_COIN.id)) {
        return [...configuredCoins];
    }

    return [...configuredCoins, PUMP_FUN_COIN];
}
