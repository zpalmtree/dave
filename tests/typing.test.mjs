import assert from 'node:assert/strict';
import test from 'node:test';

import { withTyping } from '../dist/Typing.js';

test('continues the wrapped request when Discord rejects the typing indicator', async () => {
    const channel = {
        send() {},
        async sendTyping() {
            throw new Error('Internal Server Error');
        },
    };
    const originalWarn = console.warn;
    let warning = '';
    let called = false;

    console.warn = (...args) => {
        warning = args.join(' ');
    };

    try {
        const result = await withTyping(channel, async () => {
            called = true;
            return 'completed';
        });

        assert.equal(result, 'completed');
        assert.equal(called, true);
        assert.match(warning, /Failed to send typing indicator: Error: Internal Server Error/);
    } finally {
        console.warn = originalWarn;
    }
});
