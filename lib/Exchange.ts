import fetch from 'node-fetch';

interface Rates {
    [index: string]: number;
}

export class Exchange {
    public constructor() {
        this.fetchRates();
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
        };
    }

    private rates: Rates = {};
    private initialized: boolean = false;

    private async fetchRates() {
        try {
            const response = await fetch('https://api.exchangeratesapi.io/latest?base=USD');
            const data = await response.json();

            /* Check it looks good */
            if (data.base && data.date && data.rates) {
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
