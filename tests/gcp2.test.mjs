import assert from 'node:assert/strict';
import test from 'node:test';
import { Response } from 'node-fetch';
import { createGcp2Client } from '../dist/Gcp2.js';

const current = { netvar: [{ netvar: '39.0636' }] };
const history = { aggregates: [{ end_epoch: 1788757019, netvar_aggregate: '39.0636' }] };
const script = () => new Response('const bearer = "Bearer public-test-token";');
const data = url => new Response(JSON.stringify(url.endsWith('getcurrentnetvar') ? current : history));

test('combines official endpoints, caches the public token and bounds requests', async () => {
    let tokenReads = 0;
    const client = createGcp2Client(async (url, options) => {
        assert.ok(url.startsWith('https://gcp2.net/'));
        assert.equal(options.redirect, 'manual');
        assert.equal(options.timeout, 15000);
        assert.ok(options.size > 0);
        if (url.endsWith('.js')) { tokenReads++; return script(); }
        assert.equal(options.headers.authorization, 'Bearer public-test-token');
        return data(url);
    });
    const expected = { currentNetvar: current, netvarAggregate24H: history };
    assert.deepEqual(await client(), expected);
    assert.deepEqual(await client(), expected);
    assert.equal(tokenReads, 1);
});

for (const status of [401, 403, 302]) {
    test(`refreshes token once after authorization failure ${status}`, async () => {
        let tokenReads = 0;
        const client = createGcp2Client(async url => {
            if (url.endsWith('.js')) { tokenReads++; return script(); }
            if (tokenReads === 1) return new Response('', {
                status, headers: { location: 'https://gcp2.net/session/expired' },
            });
            return data(url);
        });
        assert.deepEqual(await client(), { currentNetvar: current, netvarAggregate24H: history });
        assert.equal(tokenReads, 2);
    });
}

test('stops retrying persistent authorization failure', async () => {
    let tokenReads = 0;
    const client = createGcp2Client(async url => {
        if (url.endsWith('.js')) { tokenReads++; return script(); }
        return new Response('', { status: 401 });
    });
    await assert.rejects(client(), /authorization expired/);
    assert.equal(tokenReads, 2);
});

test('failed token retrieval can recover on the next call', async () => {
    let tokenReads = 0;
    const client = createGcp2Client(async url => {
        if (url.endsWith('.js')) return ++tokenReads === 1 ? new Response('unavailable') : script();
        return data(url);
    });
    await assert.rejects(client(), /token was not found/);
    assert.deepEqual(await client(), { currentNetvar: current, netvarAggregate24H: history });
});

test('does not retry a provider outage', async () => {
    let tokenReads = 0;
    const client = createGcp2Client(async url => {
        if (url.endsWith('.js')) { tokenReads++; return script(); }
        return new Response('Application not found', { status: 404, statusText: 'Not Found' });
    });
    await assert.rejects(client(), /404 Not Found/);
    assert.equal(tokenReads, 1);
});

for (const body of ['<html>session expired</html>', 'null', '[]']) {
    test(`rejects invalid data: ${body}`, async () => {
        const client = createGcp2Client(async url => url.endsWith('.js') ? script() : new Response(body));
        await assert.rejects(client(), /invalid JSON/);
    });
}

test('propagates network timeouts', async () => {
    const client = createGcp2Client(async url => {
        if (url.endsWith('.js')) return script();
        throw new Error('network timeout');
    });
    await assert.rejects(client(), /network timeout/);
});
