import assert from 'node:assert/strict';
import test from 'node:test';

import sqlite3 from 'sqlite3';

import { config } from '../dist/Config.js';
import {
    dispatchPrefixedCommand,
    isMessageAllowed,
} from '../dist/CommandDispatcher.js';
import {
    createTablesIfNeeded,
    executeQuery,
    selectQuery,
} from '../dist/Database.js';
import {
    getActiveTimersForPlatform,
    getMessagePlatform,
} from '../dist/Timer.js';
import {
    UproarChannel,
    UproarSentMessage,
} from '../dist/Uproar.js';
import { Commands } from '../dist/CommandDeclarations.js';
import { Args } from '../dist/Types.js';
import {
    initTokenSpend,
    recordTokenSpend,
} from '../dist/TokenSpend.js';

function closeDatabase(db) {
    return new Promise((resolve, reject) => {
        db.close((err) => err ? reject(err) : resolve());
    });
}

test('Uproar message edits upload files and preserve attachment clearing', async () => {
    const executions = [];
    const uploads = [];
    const bot = {
        uploadFiles: async (channelId, files) => {
            uploads.push({ channelId, files });
            return [{ url: '/uploads/result.png' }];
        },
        exec: async (body) => {
            executions.push(body);
            return {};
        },
    };

    const message = new UproarSentMessage(bot, 'message-1', 'channel-1');
    const file = Buffer.from('image');

    await message.edit({ content: 'done', files: [file], attachments: [] });
    await message.edit({ content: 'cleared', attachments: [] });

    assert.deepEqual(uploads, [{ channelId: 'channel-1', files: [file] }]);
    assert.deepEqual(executions, [
        {
            action: 'edit',
            message_id: 'message-1',
            content: 'done',
            attachments: [{ url: '/uploads/result.png' }],
        },
        {
            action: 'edit',
            message_id: 'message-1',
            content: 'cleared',
            attachments: [],
        },
    ]);
});

test('Uproar channel exposes the permission preflight used by GIF commands', () => {
    const channel = new UproarChannel({}, 'channel-1');
    assert.equal(channel.permissionsFor(null).has(), true);
});

test('shared message policy applies development and user restrictions', () => {
    const originalDevEnv = config.devEnv;
    const originalDevChannels = config.devChannels;

    try {
        config.devEnv = true;
        config.devChannels = ['allowed-channel'];

        const baseMessage = {
            author: { id: 'ordinary-user' },
            channel: { id: 'blocked-channel' },
            guild: { id: 'guild-1' },
        };

        assert.equal(isMessageAllowed(baseMessage), false);
        assert.equal(isMessageAllowed({
            ...baseMessage,
            channel: { id: 'allowed-channel' },
        }), true);

        config.devEnv = false;
        assert.equal(isMessageAllowed({
            ...baseMessage,
            author: { id: '1307359331724824744' },
        }), false);
    } finally {
        config.devEnv = originalDevEnv;
        config.devChannels = originalDevChannels;
    }
});

test('shared dispatch records command logs and token-spend context', async () => {
    const db = new sqlite3.Database(':memory:');
    const originalPrefix = config.prefix;
    const originalDevEnv = config.devEnv;
    let commandAdded = false;
    const testCommand = {
        aliases: ['uproar-context-test'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: () => {
                recordTokenSpend({
                    model: 'test-model',
                    inputTokens: 12,
                    outputTokens: 3,
                });
            },
            description: 'test command',
        },
    };

    try {
        await createTablesIfNeeded(db);
        initTokenSpend(db);
        config.prefix = '$';
        config.devEnv = false;
        Commands.push(testCommand);
        commandAdded = true;

        await dispatchPrefixedCommand({
            content: '$uproar-context-test',
            author: { id: 'uproar-user' },
            channel: { id: 'uproar-channel' },
            guild: { id: 'uproar-server' },
        }, db);

        const logs = await selectQuery(
            `SELECT user_id, channel_id, guild_id, command FROM logs`,
            db,
        );
        const usage = await selectQuery(
            `SELECT user_id, channel_id, guild_id, command, input_tokens, output_tokens
             FROM token_usage`,
            db,
        );

        assert.deepEqual(logs, [{
            user_id: 'uproar-user',
            channel_id: 'uproar-channel',
            guild_id: 'uproar-server',
            command: 'uproar-context-test',
        }]);
        assert.deepEqual(usage, [{
            user_id: 'uproar-user',
            channel_id: 'uproar-channel',
            guild_id: 'uproar-server',
            command: 'uproar-context-test',
            input_tokens: 12,
            output_tokens: 3,
        }]);
    } finally {
        if (commandAdded) {
            Commands.splice(Commands.indexOf(testCommand), 1);
        }
        config.prefix = originalPrefix;
        config.devEnv = originalDevEnv;
        await closeDatabase(db);
    }
});

test('timer migration and queries keep Discord and Uproar channels separate', async () => {
    const db = new sqlite3.Database(':memory:');

    try {
        await executeQuery(
            `CREATE TABLE timer (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id VARCHAR(255) NOT NULL,
                channel_id VARCHAR(255) NOT NULL,
                message VARCHAR(2000),
                expire_time TIMESTAMP
            )`,
            db,
        );
        await createTablesIfNeeded(db);

        const columns = await selectQuery(`PRAGMA table_info(timer)`, db);
        assert.ok(columns.some(({ name }) => name === 'platform'));

        await executeQuery(
            `INSERT INTO timer
                (user_id, channel_id, message, expire_time)
             VALUES
                ('discord-user', 'shared-channel', 'discord timer',
                 STRFTIME('%Y-%m-%d %H:%M:%S', 'NOW', '+1 day'))`,
            db,
        );
        await executeQuery(
            `INSERT INTO timer
                (user_id, channel_id, platform, message, expire_time)
             VALUES
                ('uproar-user', 'shared-channel', 'uproar', 'uproar timer',
                 STRFTIME('%Y-%m-%d %H:%M:%S', 'NOW', '+1 day'))`,
            db,
        );

        const discordTimers = await getActiveTimersForPlatform(db, 'discord');
        const uproarTimers = await getActiveTimersForPlatform(db, 'uproar');

        assert.deepEqual(discordTimers.map(({ user_id }) => user_id), ['discord-user']);
        assert.deepEqual(uproarTimers.map(({ user_id }) => user_id), ['uproar-user']);
        assert.equal(getMessagePlatform({}), 'discord');
        assert.equal(getMessagePlatform({ platform: 'uproar' }), 'uproar');
    } finally {
        await closeDatabase(db);
    }
});
