import fetch from 'node-fetch';

import { config } from './Config';

interface Rates {
    [index: string]: number;
}

export class Exchange {
    public constructor() {
        this.init();
    }

    public getCurrencies(): string[] {
        return Object.keys(this.rates);
    }

    public exchange(from: string, to: string, amount: number) {
        if (!this.initialized) {
            return {
                success: false,
                error: 'Currency object failed to initialize. Try again later.',
            };
        }

        if (!this.rates[from]) {
            return {
                success: false,
                error: `Unknown currency ${from}`,
            };
        }

        if (!this.rates[to]) {
            return {
                success: false,
                error: `Unknown currency ${to}`,
            };
        }

        /* prevent the scary explody */
        if (this.rates[from] == 0) {
            return {
                success: false,
                error: 'Divide by zero',
            };
        }

        const amountInUsd = amount / this.rates[from];

        const amountInTarget = amountInUsd * this.rates[to];

        return {
            success: true,
            amount: amountInTarget,
            amountInUsd,
            fromCurrency: this.mapping[from],
            toCurrency: this.mapping[to],
        };
    }

    private rates: Rates = {};
    private mapping: { [index: string]: string } = {};
    private initialized: boolean = false;

    private async init() {
        this.fetchCurrencyMapping();
        this.fetchRates();
    }

    private async fetchCurrencyMapping() {
        try {
            const response = await fetch(`https://openexchangerates.org/api/currencies.json`);
            const data = await response.json();
            this.mapping = data;
        } catch (err) {
            console.log('Failed to fetch currency mapping: ' + err.toString());

            /* Try again in 10 seconds */
            setTimeout(() => this.fetchCurrencyMapping(), 10 * 1000);
        }
    }

    private async fetchRates() {
        try {
            const response = await fetch(`https://openexchangerates.org/api/latest.json?base=USD&app_id=${config.exchangeRateApiKey}`);
            const data = await response.json();

            /* Check it looks good */
            if (data.base && data.rates) {
                this.rates = data.rates;
                this.initialized = true;

                /* 8 hours */
                setTimeout(() => this.fetchRates(), 8 * 60 * 60 * 1000);
            }
        } catch (err) {
            console.log('Failed to fetch exchange rates: ' + err.toString());

            /* Try again in 10 seconds */
            setTimeout(() => this.fetchRates(), 10 * 1000);
        }
    }
}

export const exchangeService = new Exchange();
