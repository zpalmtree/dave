import assert from 'node:assert/strict';
import test from 'node:test';

import { Commands } from '../dist/CommandDeclarations.js';
import { formatVideoJob } from '../dist/VideoGeneration.js';
import { parsePauseDuration } from '../dist/VideoProtocol.js';

test('video pause durations default to six hours and enforce safe limits', () => {
    assert.equal(parsePauseDuration(undefined), 6 * 60 * 60);
    assert.equal(parsePauseDuration('90m'), 90 * 60);
    assert.equal(parsePauseDuration('2d'), 2 * 24 * 60 * 60);
    assert.throws(() => parsePauseDuration('30s'), /look like/);
    assert.throws(() => parsePauseDuration('8d'), /between 1 minute and 7 days/);
});

test('local video commands are declared as Discord-only', () => {
    for (const name of ['ltx', 'minimax', 'videoqueue', 'videogen']) {
        const command = Commands.find(candidate => candidate.aliases.includes(name));
        assert.ok(command, `${name} command is present`);
        assert.equal(command.discordOnly, true);
    }
});

test('offline queue messages omit fake ETAs', () => {
    const text = formatVideoJob({
        id: '12345678-1234-1234-1234-123456789abc',
        model: 'minimax',
        prompt: 'test',
        requester_id: 'u',
        origin_bot_id: 'b',
        channel_id: 'c',
        guild_id: null,
        command_message_id: 'm',
        status_message_id: 's',
        status: 'queued',
        queue_position: 2,
        estimate_low_seconds: 10,
        estimate_high_seconds: 20,
        expected_start_at: null,
        expected_finish_at: null,
        stage: null,
        progress: null,
        error: null,
        result_path: null,
        result_bytes: null,
        created_at: 1,
        updated_at: 1,
        started_at: null,
        completed_at: null,
        delivered_at: null,
        worker_online: false,
        worker_busy: false,
        paused_until: null,
    });
    assert.match(text, /Queue position: \*\*2\*\*/);
    assert.match(text, /offline/);
    assert.doesNotMatch(text, /Expected (start|finish)/);
});
