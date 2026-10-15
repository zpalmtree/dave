import assert from 'node:assert/strict';
import test from 'node:test';
import sqlite3 from 'sqlite3';
import { MessageFlags } from 'discord.js';
import { createTablesIfNeeded, executeQuery, selectQuery } from '../dist/Database.js';
import { config } from '../dist/Config.js';
import { initPrivacy, isPrivacyOptedOut } from '../dist/Privacy.js';
import { handlePrivacyInteraction, handlePrivacyMessage, privacyPanel } from '../dist/PrivacyCommand.js';
import { initPrivacyRequests, latestDeletionRequest, pendingDeletionRequests, requestDataDeletion } from '../dist/PrivacyRequests.js';
import { minimizeCommandLogs } from '../dist/PrivacyRetention.js';
import { dispatchPrefixedCommand } from '../dist/CommandDispatcher.js';
import { Commands } from '../dist/CommandDeclarations.js';
import { Args } from '../dist/Types.js';

async function database(t) {
    const db = new sqlite3.Database(':memory:');
    await createTablesIfNeeded(db);
    await initPrivacy(db);
    await initPrivacyRequests(db);
    t.after(async () => {
        await executeQuery('DELETE FROM privacy_preferences', db);
        await initPrivacy(db);
        await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    });
    return db;
}

function interaction(action, userId = 'requester') {
    return {
        isButton: () => true,
        customId: `privacy:${action}`,
        user: { id: userId },
        replies: [],
        deferReply: async function(options) { this.deferred = options; },
        editReply: async function(payload) { this.replies.push(payload); },
    };
}

function message(content, userId = 'requester') {
    return {
        content, author: { id: userId },
        channel: { id: 'privacy-test' }, guild: null,
        replies: [], reply: async function(payload) { this.replies.push(payload); },
    };
}

function buttons(payload) {
    return payload.components.flatMap(row => row.toJSON().components);
}

test('privacy panel provides discoverable controls and keeps the review queue operator-only', async t => {
    const db = await database(t);
    const payload = await privacyPanel(db, 'member', 'discord');
    assert.deepEqual(buttons(payload).map(b => b.custom_id || b.url), [
        'privacy:status', 'privacy:optout', 'privacy:optin', 'privacy:delete',
        'https://github.com/zpalmtree/dave/blob/master/PRIVACY.md',
    ]);
    const ownerPanel = await privacyPanel(db, config.god, 'discord');
    assert.ok(buttons(ownerPanel).some(b => b.custom_id === 'privacy:requests:0'));
    assert.equal((await privacyPanel(db, 'member', 'uproar')).components.length, 0);
});

test('button actions act on the clicking user and reply privately', async t => {
    const db = await database(t);
    const click = interaction('optout', 'clicker');
    click.message = { author: { id: 'panel-owner' } };
    assert.equal(await handlePrivacyInteraction(click, db), true);
    assert.deepEqual(click.deferred, { flags: MessageFlags.Ephemeral });
    assert.equal(isPrivacyOptedOut('clicker'), true);
    assert.equal(isPrivacyOptedOut('panel-owner'), false);
    assert.match(click.replies[0].content, /You are opted out/);
    await handlePrivacyInteraction(interaction('optin', 'clicker'), db);
    assert.equal(isPrivacyOptedOut('clicker'), false);
});

test('deletion button needs confirmation; repeat confirmations return the same pending request', async t => {
    const db = await database(t);
    const open = interaction('delete');
    await handlePrivacyInteraction(open, db);
    assert.match(open.replies[0].content, /does not claim everything is already deleted/);
    assert.equal((await pendingDeletionRequests(db)).length, 0);
    assert.equal(isPrivacyOptedOut('requester'), false);
    const confirm = interaction('delete-confirm');
    await handlePrivacyInteraction(confirm, db);
    const first = await latestDeletionRequest(db, 'requester', 'discord');
    assert.equal(first.status, 'pending');
    assert.equal(isPrivacyOptedOut('requester'), true);
    assert.match(confirm.replies[0].content, /deletion is not yet complete/);
    const repeat = await requestDataDeletion(db, 'requester', 'discord');
    assert.equal(first.id, repeat.id);
    assert.equal((await pendingDeletionRequests(db)).length, 1);
    await initPrivacyRequests(db); // Migration/restart preserves requests.
    assert.equal((await latestDeletionRequest(db, 'requester', 'discord')).id, first.id);
    const other = await requestDataDeletion(db, 'requester', 'uproar');
    assert.notEqual(other.id, first.id);
});

test('operator review requires the configured operator and records completion only after confirmation', async t => {
    const db = await database(t);
    const request = await requestDataDeletion(db, 'requester', 'discord');
    for (const action of ['requests:0', `review:${request.id}`, `complete:${request.id}`]) {
        const stranger = interaction(action, 'stranger');
        await handlePrivacyInteraction(stranger, db);
        assert.match(stranger.replies[0].content, /Only the bot operator/);
        assert.doesNotMatch(stranger.replies[0].content, /requester/);
    }
    const review = interaction(`review:${request.id}`, config.god);
    await handlePrivacyInteraction(review, db);
    assert.match(review.replies[0].content, /does not perform deletion/);
    assert.equal((await latestDeletionRequest(db, 'requester', 'discord')).status, 'pending');
    await handlePrivacyInteraction(interaction(`complete:${request.id}`, config.god), db);
    const completed = await latestDeletionRequest(db, 'requester', 'discord');
    assert.equal(completed.status, 'completed');
    assert.ok(completed.completed_at);
    assert.equal(isPrivacyOptedOut('requester'), true);
    const renewed = await requestDataDeletion(db, 'requester', 'discord');
    assert.notEqual(renewed.id, request.id);
});

test('queue pagination stays within Discord component limits', async t => {
    const db = await database(t);
    for (let i = 0; i < 6; i++) await requestDataDeletion(db, `user-${i}`, 'discord');
    const first = interaction('requests:0', config.god);
    await handlePrivacyInteraction(first, db);
    assert.equal(first.replies[0].components.length, 5);
    assert.ok(buttons(first.replies[0]).some(b => b.custom_id === 'privacy:requests:1'));
    const next = interaction('requests:1', config.god);
    await handlePrivacyInteraction(next, db);
    assert.equal(next.replies[0].components.length, 3);
    assert.ok(buttons(next.replies[0]).some(b => b.custom_id === 'privacy:requests:0'));
});

test('text fallback submits requests without logging their content and status is scoped to the requester', async t => {
    const db = await database(t);
    const msg = message(`${config.prefix}privacy delete`);
    await dispatchPrefixedCommand(msg, db);
    assert.equal((await pendingDeletionRequests(db)).length, 0);
    msg.content = `${config.prefix}privacy delete confirm`;
    await dispatchPrefixedCommand(msg, db);
    assert.equal((await pendingDeletionRequests(db)).length, 1);
    assert.deepEqual(await selectQuery('SELECT * FROM logs', db), []);
    const other = await privacyPanel(db, 'someone-else', 'discord');
    assert.doesNotMatch(other.content, /Latest deletion request/);
    msg.content = `${config.prefix}privacy status`;
    await handlePrivacyMessage(msg, db);
    assert.match(msg.replies.at(-1).content, /Pending operator review/);
});

test('failed request storage never returns a successful deletion receipt', async t => {
    const db = await database(t);
    await executeQuery(`CREATE TRIGGER reject_request BEFORE INSERT ON privacy_deletion_requests
        BEGIN SELECT RAISE(ABORT, 'test storage failure'); END`, db);
    const click = interaction('delete-confirm');
    await handlePrivacyInteraction(click, db);
    assert.match(click.replies[0].content, /Could not complete/);
    assert.doesNotMatch(click.replies[0].content, /Deletion request received/);
    assert.equal(isPrivacyOptedOut('requester'), true);
    assert.equal((await pendingDeletionRequests(db)).length, 0);
});

test('log minimization clears only argument text and preserves saved features and usage counts', async t => {
    const db = await database(t);
    await executeQuery(`INSERT INTO logs(user_id, channel_id, command, args, timestamp)
        VALUES ('person', 'channel', 'quote', 'private text', CURRENT_TIMESTAMP)`, db);
    await executeQuery("INSERT INTO quote(quote, channel_id) VALUES ('saved quote', 'channel')", db);
    await executeQuery(`INSERT INTO timer(user_id, channel_id, message, expire_time)
        VALUES ('person', 'channel', 'saved reminder', CURRENT_TIMESTAMP)`, db);
    await minimizeCommandLogs(db);
    await minimizeCommandLogs(db);
    assert.deepEqual(await selectQuery('SELECT command, args FROM logs', db), [{ command: 'quote', args: null }]);
    assert.equal((await selectQuery('SELECT quote FROM quote', db))[0].quote, 'saved quote');
    assert.equal((await selectQuery('SELECT message FROM timer', db))[0].message, 'saved reminder');
    assert.equal((await selectQuery('PRAGMA secure_delete', db))[0].secure_delete, 1);
});

test('new command usage logs omit arguments without changing the command input', async t => {
    const db = await database(t);
    const oldDevEnv = config.devEnv;
    config.devEnv = false;
    let input;
    const command = {
        aliases: ['privacy-log-test'],
        primaryCommand: { argsFormat: Args.Combined, description: 'test', implementation: (_msg, args) => { input = args; } },
    };
    Commands.push(command);
    t.after(() => { config.devEnv = oldDevEnv; Commands.splice(Commands.indexOf(command), 1); });
    await dispatchPrefixedCommand(message(`${config.prefix}privacy-log-test private words`), db);
    assert.equal(input, 'private words');
    assert.deepEqual(await selectQuery('SELECT args FROM logs', db), [{ args: null }]);
});
