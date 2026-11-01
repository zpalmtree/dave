import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Collection } from 'discord.js';
import { createPurgeHandler } from '../../dist/Purge.js';
import { createFilePurgeCheckpointStore } from '../../dist/PurgeCheckpoint.js';

const [directory, mode] = process.argv.slice(2);
const inventory = join(directory, 'inventory.json');
const userId = '882322615346270268';
const room = { id: '2', isTextBased: () => true, isThread: () => false,
    permissionsFor: () => ({ has: () => true }), send: async () => ({ edit: async () => {} }),
    messages: { fetch: async ({ before }) => new Collection(JSON.parse(readFileSync(inventory, 'utf8'))
        .filter(id => !before || BigInt(id) < BigInt(before)).slice(0, 2).map(id => [id, {
            id, author: { id: id === '100' ? 'other' : userId }, delete: async () => {
                const remaining = JSON.parse(readFileSync(inventory, 'utf8')).filter(value => value !== id);
                writeFileSync(inventory, JSON.stringify(remaining));
            },
        }])) },
};
const guild = { id: '891069801173237800', members: { me: {} }, channels: {
    fetch: async id => id ? room : new Collection([[room.id, room]]),
    fetchActiveThreads: async () => ({ threads: new Collection() }),
} };
let pauses = 0;
process.on('message', () => {}); // Keep IPC alive until the parent deliberately kills/disconnects us.
const purge = createPurgeHandler(async () => {
    if (mode === 'interrupt' && ++pauses === 2) {
        process.send({ deleted: 1 });
        await new Promise(() => {});
    }
}, Date.now, (event, state) => {
    if (mode === 'resume' && event === 'finished') {
        process.send({ event, ...state }, () => process.disconnect());
    }
}, 30000, createFilePurgeCheckpointStore(directory));
if (mode === 'resume') await purge.resumePending({ user: { id: '9000' }, guilds: { fetch: async () => guild } });
else await purge({ guild, channel: room, author: { id: userId }, reply: room.send });
