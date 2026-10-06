import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import sqlite3 from 'sqlite3';

import { handleUsersTokens } from '../dist/StatsCommands.js';
import { createTablesIfNeeded, executeQuery } from '../dist/Database.js';

for (const [global, hasGlobalUsers] of [[true, true], [false, true], [true, false]]) {
    test(`${global ? 'global' : 'server'} token pages (global users: ${hasGlobalUsers}) reuse names and preserve spend ordering`, async (t) => {
        const db = new sqlite3.Database(':memory:');
        t.after(() => new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve())));
        await createTablesIfNeeded(db);
        for (let index = 0; index < 19; index++) {
            await executeQuery(`INSERT INTO token_usage
                (user_id, channel_id, guild_id, command, model, input_tokens, cost, timestamp)
                VALUES (?, 'channel', 'guild', 'claude', 'model', 100, ?, CURRENT_TIMESTAMP)`,
            db, [String(index), 19 - index]);
        }

        const memberLookups = [];
        const userLookups = [];
        const client = {
            users: {
                fetch: async (id) => {
                    userLookups.push(id);
                    if (id === '18') throw new Error('Unknown user');
                    return { displayName: `User ${id}` };
                },
            },
        };
        const guild = {
            id: 'guild', client,
            members: {
                cache: new Map([['0', { displayName: 'Cached nickname' }]]),
                fetch: async (id) => {
                    memberLookups.push(id);
                    if (id === '0') return { displayName: 'Cached nickname' };
                    if (id === '1') return { displayName: 'Uncached nickname' };
                    throw new Error('Unknown member');
                },
            },
        };
        if (!hasGlobalUsers) {
            delete client.users;
            delete guild.members.cache;
        }
        const expectedName = (id) => hasGlobalUsers ? `User ${id}` : `<@${id}>`;
        const collector = new EventEmitter();
        const edits = new EventEmitter();
        let initial;
        const message = {
            createReactionCollector: () => collector,
            react: async () => {},
            edit: async (payload) => edits.emit('edit', payload.embeds[0].toJSON()),
        };
        const source = {
            guild, client,
            channel: {
                send: async (payload) => {
                    initial = payload.embeds[0].toJSON();
                    return message;
                },
            },
        };
        const turnPage = (emoji) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Page edit timed out')), 2000);
            edits.once('edit', (embed) => {
                clearTimeout(timer);
                resolve(embed);
            });
            collector.emit('collect', {
                emoji: { name: emoji },
                users: { remove: async () => {} },
            }, { id: 'reader' });
        });

        await handleUsersTokens(source, db, global);
        assert.equal(initial.fields.length, 9);
        assert.equal(initial.fields[0].name, 'Cached nickname');
        assert.equal(initial.fields[1].name, global && hasGlobalUsers ? 'User 1' : 'Uncached nickname');
        assert.match(initial.fields[0].value, /\$19\.00/);
        assert.match(initial.description, /\$190\.00/);
        assert.equal(userLookups.includes('9'), false, 'only visible rows are fetched');

        const second = await turnPage('➡️');
        assert.equal(second.fields[0].name, expectedName('9'));
        assert.equal(second.footer.text, 'Page 2 of 3');
        const last = await turnPage('➡️');
        assert.equal(last.fields.length, 1);
        assert.equal(last.fields[0].name, '<@18>');
        assert.equal(last.footer.text, 'Page 3 of 3');
        const lookupsAfterFirstPass = [memberLookups.length, userLookups.length];
        await turnPage('⬅️');
        assert.deepEqual((await turnPage('⬅️')).fields, initial.fields);
        assert.equal((await turnPage('⬅️')).fields[0].name, '<@18>');
        assert.deepEqual([memberLookups.length, userLookups.length], lookupsAfterFirstPass,
            'revisiting pages, including unknown users, makes no more API requests');
        if (global && hasGlobalUsers) assert.deepEqual(memberLookups, [], 'global pages never probe guild membership');

        await handleUsersTokens(source, db, global);
        assert.ok(memberLookups.length + userLookups.length > lookupsAfterFirstPass[0] + lookupsAfterFirstPass[1],
            'new commands refresh the name snapshot');
    });
}
