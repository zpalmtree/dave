import assert from 'node:assert/strict';
import test from 'node:test';
import moment from 'moment';
import sqlite3 from 'sqlite3';

import { parseTimerInput } from '../dist/TimerInput.js';
import { handleTimer, deleteTimer } from '../dist/Timer.js';
import { executeQuery, selectQuery } from '../dist/Database.js';

const now = moment.utc('2026-01-31T12:00:00Z');

test('calendar dates default to UTC and preserve reminder text', () => {
    for (const [input, expected, description] of [
        ['2026-12-25 Christmas', '2026-12-25T00:00:00.000Z', 'Christmas'],
        ['2026-12-25 09:30 open presents', '2026-12-25T09:30:00.000Z', 'open presents'],
        ['2026-12-25T09:30:15Z', '2026-12-25T09:30:15.000Z', undefined],
        ['2026-12-25 09:30-05:00 breakfast', '2026-12-25T14:30:00.000Z', 'breakfast'],
        ['2026-12-25T00:30+0530', '2026-12-24T19:00:00.000Z', undefined],
        ['2028-02-29 leap day', '2028-02-29T00:00:00.000Z', 'leap day'],
    ]) {
        const parsed = parseTimerInput(input, now);
        assert.equal(parsed.error, undefined, input);
        assert.equal(parsed.time.toISOString(), expected, input);
        assert.equal(parsed.description, description, input);
    }
});

test('M means calendar months, mm remains compatible, and m means minutes', () => {
    for (const suffix of ['M', 'mm']) {
        const parsed = parseTimerInput(`1${suffix} renew subscription`, now);
        assert.equal(parsed.time.toISOString(), '2026-02-28T12:00:00.000Z');
        assert.equal(parsed.description, 'renew subscription');
    }
    assert.equal(parseTimerInput('1m', now).time.toISOString(), '2026-01-31T12:01:00.000Z');
    assert.equal(parseTimerInput('1M2w3d4h5m6s', now).time.toISOString(), '2026-03-17T16:05:06.000Z');
    assert.equal(parseTimerInput('1y2h5m', now).time.toISOString(), '2027-01-31T14:05:00.000Z');
    assert.equal(parseTimerInput('.5h', now).time.toISOString(), '2026-01-31T12:30:00.000Z');
    assert.equal(now.toISOString(), '2026-01-31T12:00:00.000Z');
});

test('invalid dates, clocks, durations, past dates, and excessive delays are rejected', () => {
    for (const input of [
        '', 'coffee', '0m', '-1h', '1..2h', '.s', '101y', '9'.repeat(400) + 's',
        '2026-02-29', '2026-04-31', '2026-13-01', '2026-12-25T24:00',
        '2026-12-25 25:00', '2026-12-25 09:60', '2026-12-25 9:00',
        '2026-12-25T09:00+05:60', '2026-12-25T09:00-25:00',
        '2026-12-25T09:00oops', '2026-01-31', '2026-01-31T12:00Z', '2127-01-01',
    ]) {
        assert.equal(typeof parseTimerInput(input, now).error, 'string', input);
    }
});

test('absolute reminders persist in UTC, confirm the instant, and remain cancellable on both platforms', async () => {
    const db = new sqlite3.Database(':memory:');
    await executeQuery(`CREATE TABLE timer (
        id INTEGER PRIMARY KEY, user_id TEXT, channel_id TEXT,
        platform TEXT, message TEXT, expire_time TEXT
    )`, db);
    try {
        for (const platform of ['discord', 'uproar']) {
            const replies = [];
            const msg = {
                platform,
                author: { id: 'user' },
                channel: { id: 'channel', send: () => assert.fail('Future timer fired early') },
                reply: async (text) => replies.push(text),
            };
            await handleTimer(msg, ['2030-12-25', '09:00-05:00', 'open', 'presents'], db);
            const [row] = await selectQuery('SELECT * FROM timer', db);
            try {
                assert.equal(row.expire_time, '2030-12-25 14:00:00');
                assert.equal(row.message, 'open presents');
                assert.equal(row.platform, platform);
                const timestamp = moment.utc('2030-12-25T14:00:00Z').unix();
                assert.ok(replies[0].includes(`<t:${timestamp}:`));
            } finally {
                if (row) await deleteTimer(msg, [String(row.id)], db);
            }
            assert.match(replies.at(-1), /Successfully deleted timer/);
            assert.deepEqual(await selectQuery('SELECT * FROM timer', db), []);
            await handleTimer(msg, ['2030-02-30'], db);
            assert.match(replies.at(-1), /Invalid calendar date/);
            assert.deepEqual(await selectQuery('SELECT * FROM timer', db), []);
        }
    } finally {
        await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
    }
});
