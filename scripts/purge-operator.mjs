#!/usr/bin/env node
// Uses the existing PM2 IPC channel; creates no network listener or extra bot login.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [action, app, guildId, userId, channelId, ...extra] = process.argv.slice(2);
if (!['status', 'start'].includes(action) || !['dave', 'slug-bot'].includes(app)
    || extra.length || (action === 'status' && guildId)
    || (action === 'start' && ![guildId, userId, channelId].every(id => /^\d{17,20}$/.test(id ?? '')))) {
    console.error('Usage: node scripts/purge-operator.mjs status <dave|slug-bot>\n'
        + '       node scripts/purge-operator.mjs start <dave|slug-bot> <guild-id> <user-id> <channel-id>');
    process.exit(1);
}
const require = createRequire(import.meta.url);
const pm2 = require(join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'pm2'));
const call = (method, ...args) => new Promise((resolve, reject) => {
    pm2[method](...args, (error, value) => error ? reject(error) : resolve(value));
});
let bus;
try {
    await call('connect');
    const apps = (await call('list')).filter(process => process.name === app && process.pm2_env.status === 'online');
    if (apps.length !== 1) throw new Error('Expected exactly one online bot with that name.');
    const id = apps[0].pm_id;
    const requestId = randomUUID();
    bus = await call('launchBus');
    const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No bot acknowledgment. Inspect operator logs before retrying a start.')), 20000);
        bus.on('process:msg', packet => {
            if (packet.process?.pm_id !== id || packet.data?.topic !== 'purge-operator' || packet.data.requestId !== requestId) return;
            clearTimeout(timer);
            resolve(packet.data);
        });
        pm2.sendDataToProcessId({ id, type: 'process:msg', topic: 'purge-operator',
            data: { requestId, action, guildId, userId, channelId } }, error => {
            if (error) { clearTimeout(timer); reject(error); }
        });
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    bus?.close();
    pm2.disconnect();
}
