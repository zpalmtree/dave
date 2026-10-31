// Replay the real command handler with synthetic Discord objects; no network or deletion.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Collection } from 'discord.js';
import { createPurgeHandler } from '../dist/Purge.js';

const records = [];
const target = '882322615346270268';
function fixture(label, { count = 0, permitted = true, fail = false, user = target } = {}) {
    const record = { label, replies: [], edits: [] };
    records.push(record);
    let fetched = false;
    const channel = {
        id: 'fixture-channel', isTextBased: () => true, isThread: () => false,
        permissionsFor: () => ({ has: () => permitted }),
        messages: { fetch: async () => {
            if (fetched) return new Collection();
            fetched = true;
            return new Collection(Array.from({ length: count }, (_, i) => [String(100 + i), {
                author: { id: target }, id: String(100 + i),
                delete: async () => { if (fail) throw new Error('Fixture deletion failure'); },
            }]));
        } },
    };
    return {
        author: { id: user }, channel,
        reply: async ({ content }) => {
            record.replies.push(content);
            return { edit: async ({ content }) => { record.edits.push(content); } };
        },
        guild: {
            id: 'fixture-guild', members: { me: {} }, channels: {
                fetch: async () => new Collection([[channel.id, channel]]),
                fetchActiveThreads: async () => ({ threads: new Collection() }),
            },
        },
    };
}
let clock = 0;
const purge = createPurgeHandler(async () => { clock += 16000; }, () => clock);
await purge(fixture('Success and progress', { count: 2 }));
await purge(fixture('Empty history'));
await purge(fixture('Missing permissions', { permitted: false }));
await purge(fixture('Deletion error', { count: 1, fail: true }));
await purge(fixture('Access disabled', { user: 'fixture-unapproved' }));
await purge(fixture('Idle status'), 'status');
let release;
const gate = new Promise(resolve => { release = resolve; });
const waiting = createPurgeHandler(() => gate);
const run = waiting(fixture('Start and in-progress state', { count: 1 }));
await new Promise(resolve => setImmediate(resolve));
await waiting(fixture('Busy response'));
await waiting(fixture('Running status'), 'status');
release();
await run;
const sourceHash = createHash('sha256').update(await readFile('lib/Purge.ts')).digest('hex').slice(0,12);
const escape = value => value.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const body = records.map(record => `<section><h2>${escape(record.label)}</h2>${record.replies.map(text => `<p><b>Reply</b> ${escape(text)}</p>`).join('')}${record.edits.map(text => `<p><b>Status edit</b> ${escape(text)}</p>`).join('')}</section>`).join('');
await mkdir('artifacts/purge-showcase', { recursive: true });
await writeFile('artifacts/purge-showcase/index.html', `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Purge command fixture transcripts</title><style>body{font:16px/1.55 system-ui;margin:24px auto;padding:0 20px;max-width:960px;color:#20242a;background:#f7f8fa}section{background:white;border:1px solid #ccd2da;border-radius:8px;margin:20px 0;padding:16px}h1{font-size:28px}h2{font-size:20px;margin-top:0}b{display:block;color:#526174;font-size:13px}p{overflow-wrap:anywhere}</style><h1>Purge command fixture transcripts</h1><p>Actual replies and status edits from the shared Purge handler, using synthetic Discord data. This report is not a Discord screenshot. Source SHA-256: ${sourceHash}.</p><p>Regenerate: <code>yarn build &amp;&amp; node scripts/showcase-purge.mjs</code><br>Serve: <code>python3 -m http.server 8766 --directory artifacts/purge-showcase</code></p>${body}</html>`);
console.log('Showcase: artifacts/purge-showcase/index.html');
