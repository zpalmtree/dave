import assert from 'node:assert/strict';
import test from 'node:test';
import sqlite3 from 'sqlite3';
import {
    canProcessMessage, fetchProcessableMessage, initPrivacy, isPrivacyOptedOut,
    PrivacyAwareHistoryCache, runWithPrivacyContext, setPrivacyOptOut,
} from '../dist/Privacy.js';
import { handlePrivacyMessage, privacyCommandArgs } from '../dist/PrivacyCommand.js';
import { dispatchPrefixedCommand } from '../dist/CommandDispatcher.js';
import { createTablesIfNeeded, executeQuery, selectQuery } from '../dist/Database.js';
import { config } from '../dist/Config.js';
import {
    cacheMessageForSummarization, fetchRecentMessagesForSummarization,
    summarizeMessages, SUMMARY_WINDOW_MS,
} from '../dist/Summarize.js';
import { getImageURLsFromMessage } from '../dist/Utilities.js';

async function database(t) {
    const db = new sqlite3.Database(':memory:');
    await createTablesIfNeeded(db);
    await initPrivacy(db);
    t.after(async () => {
        await executeQuery('DELETE FROM privacy_preferences', db);
        await initPrivacy(db);
        await new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
    });
    return db;
}

function message(content, userId = 'privacy-user') {
    const replies = [];
    return {
        id: 'message', content, replies,
        author: { id: userId },
        client: { user: { id: 'privacy-bot' } },
        channel: { id: 'privacy-channel', messages: { cache: new Map() } },
        guild: null, attachments: new Map(), embeds: [], reference: null,
        createdTimestamp: 2 * SUMMARY_WINDOW_MS,
        reply: async payload => { replies.push(payload); return { id: 'reply' }; },
    };
}

test('privacy controls persist, bypass normal channel/role gates, and do not log arguments', async t => {
    const db = await database(t);
    const originalIgnored = config.ignoredChannels;
    config.ignoredChannels = [...originalIgnored, 'privacy-channel'];
    t.after(() => { config.ignoredChannels = originalIgnored; });
    const msg = message(`${config.prefix}privacy optout`);
    await dispatchPrefixedCommand(msg, db);
    assert.equal(isPrivacyOptedOut(msg.author.id), true);
    assert.match(msg.replies[0].content, /You are opted out/);
    assert.equal(canProcessMessage(msg), false);
    assert.deepEqual(await selectQuery('SELECT * FROM logs', db), []);
    await initPrivacy(db); // Rebuild memory from SQLite as at process startup.
    assert.equal(isPrivacyOptedOut(msg.author.id), true);
    msg.content = `${config.prefix}privacy optin`;
    await dispatchPrefixedCommand(msg, db);
    assert.equal(canProcessMessage(msg), true);
    assert.match(msg.replies.at(-1).content, /You are opted in/);
    assert.deepEqual(await selectQuery('SELECT * FROM privacy_preferences', db), []);
});

test('mentions allow privacy controls without message-content access; another bot mention does not', async t => {
    const db = await database(t);
    const msg = message('<@privacy-bot> privacy optout');
    // Discord snowflakes are numeric.
    msg.client.user.id = '123456';
    msg.content = '<@!123456> PRIVACY OPTOUT';
    assert.equal(privacyCommandArgs(msg), 'optout');
    assert.equal(await handlePrivacyMessage(msg, db), true);
    assert.equal(isPrivacyOptedOut(msg.author.id), true);
    msg.content = '<@654321> privacy optin';
    assert.equal(await handlePrivacyMessage(msg, db), false);
    msg.content = `${config.prefix}privacy optout someone-else`;
    await handlePrivacyMessage(msg, db);
    assert.match(msg.replies.at(-1), /Use/);
    assert.equal(isPrivacyOptedOut('someone-else'), false);
});

test('opt-out blocks ordinary command execution and logging, but not privacy status', async t => {
    const db = await database(t);
    const msg = message(`${config.prefix}timer 10m secret reminder`);
    await setPrivacyOptOut(db, msg.author.id, 'discord', true);
    await dispatchPrefixedCommand(msg, db);
    assert.deepEqual(msg.replies, []);
    assert.deepEqual(await selectQuery('SELECT * FROM logs', db), []);
    assert.deepEqual(await selectQuery('SELECT * FROM timer', db), []);
    msg.content = `${config.prefix}privacy status`;
    await dispatchPrefixedCommand(msg, db);
    assert.match(msg.replies[0].content, /You are opted out/);
});

test('preferences are platform-scoped and rapid writes preserve their order', async t => {
    const db = await database(t);
    await Promise.all([
        setPrivacyOptOut(db, 'person', 'discord', true),
        setPrivacyOptOut(db, 'person', 'discord', false),
        setPrivacyOptOut(db, 'person', 'uproar', true),
    ]);
    assert.equal(isPrivacyOptedOut('person'), false);
    assert.equal(canProcessMessage({ author: { id: 'person' }, platform: 'uproar' }), false);
    await initPrivacy(db);
    assert.equal(isPrivacyOptedOut('person'), false);
    assert.equal(isPrivacyOptedOut('person', 'uproar'), true);
});

test('database errors do not falsely confirm an opt-out or change the in-memory preference', async t => {
    const db = await database(t);
    await executeQuery(`CREATE TRIGGER reject_privacy BEFORE INSERT ON privacy_preferences
        BEGIN SELECT RAISE(ABORT, 'test storage failure'); END`, db);
    const msg = message(`${config.prefix}privacy optout`);
    await assert.rejects(handlePrivacyMessage(msg, db), /test storage failure/);
    assert.equal(isPrivacyOptedOut(msg.author.id), false);
    assert.deepEqual(msg.replies, []);
    await executeQuery('DROP TRIGGER reject_privacy', db);
    await handlePrivacyMessage(msg, db);
    assert.equal(isPrivacyOptedOut(msg.author.id), true);
});

test('referenced messages and images from opted-out authors are excluded', async t => {
    const db = await database(t);
    const referenced = message('private content', 'excluded-author');
    referenced.attachments.set('image', { name: 'private.png', url: 'https://example.com/private.png' });
    const msg = message('request');
    msg.channel.messages.fetch = async () => referenced;
    msg.channel.messages.cache.set('reference', referenced);
    await setPrivacyOptOut(db, referenced.author.id, 'discord', true);
    await assert.rejects(fetchProcessableMessage(msg, 'reference'), /opted out/);
    assert.equal(msg.channel.messages.cache.has('reference'), false);
    assert.deepEqual(getImageURLsFromMessage(msg, referenced), []);
    await setPrivacyOptOut(db, referenced.author.id, 'discord', false);
    assert.equal(await fetchProcessableMessage(msg, 'reference'), referenced);
});

test('summary REST history excludes opted-out authors and opt-out clears cached fallback history', async t => {
    const db = await database(t);
    const excluded = message('private discussion', 'excluded-author');
    const included = message('public discussion', 'included-author');
    const msg = message(`${config.prefix}summary`, 'requester');
    msg.channel.messages.fetch = async () => new Map([['private', excluded], ['public', included]]);
    await cacheMessageForSummarization(excluded);
    await setPrivacyOptOut(db, excluded.author.id, 'discord', true);
    const history = await fetchRecentMessagesForSummarization(msg, 0);
    assert.deepEqual(history.map(item => item.author), ['included-author']);
    await cacheMessageForSummarization(excluded); // Must not repopulate fallback cache.
    msg.channel.messages.fetch = async () => { throw new Error('history unavailable'); };
    const result = await summarizeMessages(msg, msg.channel.id, null, msg.author.id);
    assert.equal(result.error, 'No recent messages could be loaded for this channel.');
});

test('opt-out invalidates derived history and prevents an older request from repopulating it', async t => {
    const db = await database(t);
    const cache = new PrivacyAwareHistoryCache();
    cache.set('old', ['private discussion']);
    await runWithPrivacyContext(async () => {
        await setPrivacyOptOut(db, 'person', 'discord', true);
        assert.equal(cache.size, 0);
        cache.set('late-result', ['private discussion']);
        assert.equal(cache.size, 0);
    });
    runWithPrivacyContext(() => cache.set('fresh-result', ['allowed discussion']));
    assert.equal(cache.has('fresh-result'), true);
});
