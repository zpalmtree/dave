import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import sqlite3 from 'sqlite3';
import { ComponentType, MessageFlags } from 'discord.js';

import { VideoBroker } from '../dist/VideoBroker.js';
import {
    deliveryLinkFromStatus,
    deliveryMedia,
    filterGalleryEntries,
    galleryCustomId,
    galleryOrder,
    galleryPage,
    galleryPagePayload,
    galleryVariants,
    maxGalleryQueryLength,
    parseGalleryArgs,
    parseGalleryCustomId,
} from '../dist/VideoGallery.js';

const entry = (index, overrides = {}) => ({
    id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
    model: 'minimax', command_variant: 'oalgo', prompt: `Meximutt video ${index}`,
    planned_intent: null, prompt_tease: null, requester_id: '111111111111111111',
    channel_id: '222222222222222222', status_message_id: `9${index}`, delivery_message_id: `8${index}`,
    delivered_at: 1_790_000_000 + index, ...overrides,
});
const media = id => ({ url: `https://cdn.discordapp.com/attachments/2/3/${id}.mp4?ex=1`, name: `${id}.mp4`, size: 4_200_000, spoiler: false, deliveryUrl: 'https://discord.com/channels/1/2/3' });

test('gallery covers every Oalgo command variant', () => {
    assert.deepEqual(galleryVariants(), ['oalgo', 'meximutt', 'minimutt', 'oalgofast']);
});

test('gallery button IDs round-trip their whole browsing state within Discord’s limit', () => {
    const state = { seed: 0xdeadbeef, current: 'a1b2c3d4', userId: '123456789012345678', query: 'taco: night' };
    const id = galleryCustomId('next', state);
    assert.ok(id.length <= 100);
    assert.deepEqual(parseGalleryCustomId(id), { action: 'next', state });
    assert.equal(parseGalleryCustomId('video-workflows:abc'), null);
    assert.equal(parseGalleryCustomId('vgallery:x:1:::'), null);
    const longest = { ...state, query: 'q'.repeat(maxGalleryQueryLength(state.userId)) };
    assert.equal(galleryCustomId('shuffle', { ...longest, current: 'ffffffff', seed: 0xffffffff }).length, 100);
});

test('gallery arguments accept mine, a mention, and prompt words', () => {
    assert.deepEqual(parseGalleryArgs('', '42'), { userId: '', query: '' });
    assert.deepEqual(parseGalleryArgs('mine  tacos', '42'), { userId: '42', query: 'tacos' });
    assert.deepEqual(parseGalleryArgs('<@!123456789012345678> lucha libre', '42'), { userId: '123456789012345678', query: 'lucha libre' });
});

test('gallery order is a stable shuffle independent of the broker’s ordering', () => {
    const entries = Array.from({ length: 30 }, (_, index) => entry(index));
    const order = galleryOrder(entries, 7).map(item => item.id);
    assert.deepEqual(galleryOrder([...entries].reverse(), 7).map(item => item.id), order);
    assert.notDeepEqual(galleryOrder(entries, 8).map(item => item.id), order);
    assert.notDeepEqual(order, entries.map(item => item.id));
    assert.deepEqual([...order].sort(), entries.map(item => item.id));
});

test('gallery filters out opted-out requesters and matches every search word', () => {
    const entries = [entry(1, { prompt: 'Eats TACOS at night' }), entry(2, { prompt: 'tacos at noon', requester_id: '5' }),
        entry(3, { prompt: 'Image-only auto-direction: inspect the supplied image and create the most natural short motion continuation.', planned_intent: 'Dances with tacos at night' })];
    const ids = list => list.map(item => item.id.slice(0, 8));
    assert.deepEqual(ids(filterGalleryEntries(entries, { userId: '', query: 'tacos night' }, () => false)), ['00000001', '00000003']);
    assert.deepEqual(ids(filterGalleryEntries(entries, { userId: '5', query: '' }, () => false)), ['00000002']);
    assert.deepEqual(ids(filterGalleryEntries(entries, { userId: '', query: '' }, id => id === '5')), ['00000001', '00000003']);
});

test('older deliveries are found through the link their status message was edited to', () => {
    assert.deepEqual(deliveryLinkFromStatus('**Oalgo · abc**\nDelivered in https://discord.com/channels/579913226129637376/600/700.'),
        { channelId: '600', messageId: '700' });
    assert.deepEqual(deliveryLinkFromStatus('Your video: https://discordapp.com/channels/1/2/3'), { channelId: '2', messageId: '3' });
    assert.equal(deliveryLinkFromStatus('Rendering…'), null);
});

test('delivery media picks the video, not the workflow archive, and keeps spoilers', () => {
    const attachments = new Map([
        ['1', { url: 'https://cdn/x.zip', name: 'workflows.zip', contentType: 'application/zip', size: 10, spoiler: false }],
        ['2', { url: 'https://cdn/SPOILER_minimax-a.mp4', name: 'SPOILER_minimax-a.mp4', contentType: 'video/mp4', size: 99, spoiler: true }],
    ]);
    assert.deepEqual(deliveryMedia({ attachments, url: 'https://discord.com/channels/1/2/3' }),
        { url: 'https://cdn/SPOILER_minimax-a.mp4', name: 'SPOILER_minimax-a.mp4', size: 99, spoiler: true, deliveryUrl: 'https://discord.com/channels/1/2/3' });
    assert.equal(deliveryMedia({ attachments: new Map([['1', attachments.get('1')]]), url: '' }), null);
    const gif = new Map([['1', { url: 'https://cdn/a.gif', name: 'minimax-a.gif', contentType: 'image/gif', size: 5, spoiler: false }]]);
    assert.equal(deliveryMedia({ attachments: gif, url: '' }).url, 'https://cdn/a.gif');
});

test('gallery pages step through the shuffle, wrap around, and skip deleted deliveries', async () => {
    const entries = Array.from({ length: 5 }, (_, index) => entry(index));
    const deleted = new Set();
    const deps = { list: async () => entries, resolve: async item => deleted.has(item.id) ? null : media(item.id) };
    const opened = await galleryPage('g', 'open', { seed: 0, current: '', userId: '', query: '' }, deps, () => 0.5);
    const order = galleryOrder(entries, opened.state.seed);
    assert.equal(opened.position, 1);
    assert.equal(opened.total, 5);
    assert.equal(opened.entry.id, order[0].id);
    const back = await galleryPage('g', 'prev', opened.state, deps);
    assert.equal(back.position, 5);
    assert.equal(back.entry.id, order[4].id);
    deleted.add(order[1].id);
    const next = await galleryPage('g', 'next', opened.state, deps);
    assert.equal(next.entry.id, order[2].id);
    assert.equal(next.position, 3);
    // A video removed from the list since the button was drawn restarts at the front.
    const vanished = await galleryPage('g', 'next', { ...opened.state, current: 'ffffffff' }, deps);
    assert.equal(vanished.entry.id, order[0].id);
    for (const item of entries) deleted.add(item.id);
    assert.equal((await galleryPage('g', 'next', opened.state, deps)).unavailable, true);
    assert.equal((await galleryPage('g', 'open', { seed: 0, current: '', userId: '9', query: '' }, deps)).empty, true);
});

test('gallery page is a components-v2 card with playable media, navigation and download links', () => {
    const item = entry(1, { prompt: 'Line one\nLine two' });
    const payload = galleryPagePayload({ entry: item, media: { ...media(item.id), spoiler: true }, position: 2, total: 9,
        state: { seed: 3, current: '00000001', userId: '42', query: 'line' } }, 'Oalgo');
    assert.equal(payload.flags, MessageFlags.IsComponentsV2);
    assert.deepEqual(payload.allowedMentions.parse, []);
    const json = payload.components[0].toJSON();
    assert.equal(json.type, ComponentType.Container);
    const [header, prompt, gallery, nav, links] = json.components;
    assert.match(header.content, /^### Oalgo · 2 of 9\n-# by <@42> · matching “line”$/);
    assert.match(prompt.content, /^>>> Line one\nLine two\n-# <@111111111111111111> · <t:1790000001:D> · `00000001`$/);
    assert.equal(gallery.type, ComponentType.MediaGallery);
    assert.equal(gallery.items[0].media.url, media(item.id).url);
    assert.equal(gallery.items[0].spoiler, true);
    assert.deepEqual(nav.components.map(button => parseGalleryCustomId(button.custom_id).action), ['prev', 'shuffle', 'next']);
    assert.equal(links.components[0].url, media(item.id).url);
    assert.equal(links.components[0].label, 'Download (4.0 MB)');
    assert.equal(links.components[1].url, 'https://discord.com/channels/1/2/3');
});

test('broker gallery lists one server’s delivered videos for the requested variants', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-video-gallery-'));
    const dbPath = join(directory, 'queue.sqlite3');
    const broker = new VideoBroker({
        host: '127.0.0.1', port: 0, dbPath, resultsDir: join(directory, 'results'),
        botToken: 'bot-secret', workerToken: 'worker-secret', preplanQueuedJobs: false,
    });
    await broker.start();
    const db = new sqlite3.Database(dbPath);
    const run = (sql, params) => new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
    try {
        let id = 0;
        const insert = async (variant, status, guild, extra = {}) => {
            id++;
            await run(`INSERT INTO video_jobs (public_id, idempotency_key, model, prompt, requester_id, origin_bot_id, channel_id, guild_id,
                command_message_id, status_message_id, status, estimate_low_seconds, estimate_high_seconds, created_at, updated_at,
                command_variant, delivery_message_id, delivered_at, planner_json)
                VALUES (?, ?, 'minimax', ?, 'u', 'b', 'c', ?, ?, ?, ?, 1, 2, 1, 1, ?, ?, ?, ?)`,
            [`job-${id}`, `key-${id}`, `prompt ${id}`, guild, `cmd-${id}`, `status-${id}`, status, variant,
                extra.delivery ?? null, extra.deliveredAt ?? null, extra.planner ?? null]);
        };
        await insert('oalgo', 'delivered', 'g1', { delivery: '700', deliveredAt: 50, planner: JSON.stringify({ intent: 'Dances' }) });
        await insert('oalgofast', 'delivered', 'g1');
        await insert('oalgo', 'failed', 'g1');
        await insert('oalgo', 'delivered', 'g2');
        await insert('minimax', 'delivered', 'g1');
        const fetchGallery = async query => {
            const response = await fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/gallery${query}`, { headers: { authorization: 'Bearer bot-secret' } });
            return { status: response.status, body: await response.json() };
        };
        const listed = await fetchGallery('?guild_id=g1&variants=oalgo,oalgofast');
        assert.equal(listed.status, 200);
        assert.deepEqual(listed.body.videos.map(video => video.id), ['job-2', 'job-1']);
        assert.deepEqual(listed.body.videos[1], {
            id: 'job-1', model: 'minimax', command_variant: 'oalgo', prompt: 'prompt 1', planned_intent: 'Dances', prompt_tease: null,
            requester_id: 'u', channel_id: 'c', status_message_id: 'status-1', delivery_message_id: '700', delivered_at: 50,
        });
        assert.deepEqual((await fetchGallery('?variants=oalgo')).body.videos, []);
        assert.deepEqual((await fetchGallery('?guild_id=g1')).body.videos, []);
        const unauthorized = await fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/gallery?guild_id=g1&variants=oalgo`);
        assert.equal(unauthorized.status, 401);
    } finally {
        db.close();
        await broker.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});
