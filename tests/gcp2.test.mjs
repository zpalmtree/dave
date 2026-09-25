import assert from 'node:assert/strict';
import test from 'node:test';
import { Response } from 'node-fetch';
import { createGcp2Client as createClient, Gcp2RateLimitError } from '../dist/Gcp2.js';

function fakeClock() {
    let now = 1_800_000_000_000;
    const waits = [];
    return { now: () => now, advance: ms => { now += ms; }, waits,
        sleep: async ms => { waits.push(ms); now += ms; } };
}
const createGcp2Client = request => createClient(request, fakeClock());

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
    const expected = { currentNetvar: current, netvarAggregate24H: history, fetchedAt: 1_800_000_000_000, stale: false };
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
        assert.deepEqual(await client(), { currentNetvar: current, netvarAggregate24H: history, fetchedAt: 1_800_000_000_000, stale: false });
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
    assert.deepEqual(await client(), { currentNetvar: current, netvarAggregate24H: history, fetchedAt: 1_800_000_000_000, stale: false });
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

test('shares slow in-flight requests and caches for a minute after completion', async () => {
    const clock = fakeClock();
    let reads = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const client = createClient(async url => {
        reads++;
        if (url.endsWith('.js')) return script();
        await gate;
        return data(url);
    }, clock);
    const first = client();
    clock.advance(70000);
    const second = client();
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.strictEqual(a, b);
    assert.equal(reads, 3);
    clock.advance(59999);
    assert.strictEqual(await client(), a);
    assert.equal(reads, 3);
    clock.advance(1);
    assert.equal((await client()).stale, false);
    assert.equal(reads, 5);
});

for (const [header, expectedWait] of [['14', 15000], ['invalid', 31000], [null, 31000], ['0', 1000]]) {
    test(`retries a cold rate limit once using Retry-After ${header}`, async () => {
        const clock = fakeClock();
        let reads = 0;
        const client = createClient(async url => {
            if (url.endsWith('.js')) return script();
            if (++reads <= 2) return new Response('', {
                status: 429, headers: header === null ? {} : { 'retry-after': header },
            });
            return data(url);
        }, clock);
        const result = await client();
        assert.equal(result.stale, false);
        assert.deepEqual(result.netvarAggregate24H, history);
        assert.deepEqual(clock.waits, [expectedWait]);
        assert.equal(reads, 4);
    });
}

test('honors HTTP-date Retry-After and the later deadline from either endpoint', async () => {
    const clock = fakeClock();
    let reads = 0;
    const client = createClient(async url => {
        if (url.endsWith('.js')) return script();
        if (++reads <= 2) return new Response('', { status: 429, headers: {
            'retry-after': new Date(clock.now() + reads * 10000).toUTCString(),
        } });
        return data(url);
    }, clock);
    await client();
    assert.deepEqual(clock.waits, [21000]);
});

test('serves labeled recent data during cooldown, then refreshes', async () => {
    const clock = fakeClock();
    let limited = false;
    let reads = 0;
    const client = createClient(async url => {
        reads++;
        if (url.endsWith('.js')) return script();
        return limited ? new Response('', { status: 429, headers: { 'retry-after': '30' } }) : data(url);
    }, clock);
    const fresh = await client();
    clock.advance(60000);
    limited = true;
    assert.deepEqual(await client(), { ...fresh, stale: true });
    assert.equal(reads, 5);
    assert.deepEqual(await client(), { ...fresh, stale: true });
    assert.equal(reads, 5);
    assert.deepEqual(clock.waits, []);
    clock.advance(31000);
    limited = false;
    assert.equal((await client()).stale, false);
    assert.equal(reads, 7);
});

test('does not serve data older than fifteen minutes', async () => {
    const clock = fakeClock();
    let limited = false;
    const client = createClient(async url => {
        if (url.endsWith('.js')) return script();
        return limited ? new Response('', { status: 429, headers: { 'retry-after': '120' } }) : data(url);
    }, clock);
    await client();
    clock.advance(15 * 60000 + 1);
    limited = true;
    await assert.rejects(client(), Gcp2RateLimitError);
    assert.deepEqual(clock.waits, []);
});

test('bounds repeated rate limits and suppresses requests until cooldown expires', async () => {
    const clock = fakeClock();
    let reads = 0;
    const client = createClient(async url => {
        reads++;
        if (url.endsWith('.js')) return script();
        return new Response('', { status: 429, headers: { 'retry-after': '10' } });
    }, clock);
    await assert.rejects(client(), Gcp2RateLimitError);
    assert.equal(reads, 5);
    assert.deepEqual(clock.waits, [11000]);
    await assert.rejects(client(), Gcp2RateLimitError);
    assert.equal(reads, 5);
});

test('rate-limited token script respects cooldown without requesting API data', async () => {
    const clock = fakeClock();
    let reads = 0;
    const client = createClient(async url => {
        reads++;
        assert.ok(url.endsWith('.js'));
        return new Response('', { status: 429, headers: { 'retry-after': '120' } });
    }, clock);
    await assert.rejects(client(), Gcp2RateLimitError);
    await assert.rejects(client(), Gcp2RateLimitError);
    assert.equal(reads, 1);
    assert.deepEqual(clock.waits, []);
});
