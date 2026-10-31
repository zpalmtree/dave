import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

test('operator status and rejected starts receive correlated replies over actual process IPC', { timeout: 5000 }, async () => {
    const moduleUrl = new URL('../dist/PurgeOperator.js', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { installPurgeOperator } from ${JSON.stringify(moduleUrl)};
        installPurgeOperator({ guilds: { fetch: () => { throw new Error('Unexpected Discord request'); } } });
        process.send({ ready: true });
    `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const response = predicate => new Promise(resolve => {
        const listener = packet => {
            if (predicate(packet)) { child.off('message', listener); resolve(packet); }
        };
        child.on('message', listener);
    });
    try {
        await response(packet => packet.ready);
        const statusReply = response(packet => packet.data?.requestId === 'fixture-status');
        child.send({ topic: 'purge-operator', data: { action: 'status', requestId: 'fixture-status' } });
        assert.deepEqual((await statusReply).data, {
            topic: 'purge-operator', requestId: 'fixture-status', ok: true, runs: [],
        });
        const deniedReply = response(packet => packet.data?.requestId === 'fixture-denied');
        child.send({ topic: 'purge-operator', data: {
            action: 'start', requestId: 'fixture-denied', guildId: '891069801173237800',
            userId: '111111111111111111', channelId: '952698229663866960',
        } });
        assert.equal((await deniedReply).data.reason, 'user_not_allowed');
    } finally {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
    }
    assert.match(output, /"event":"operator_ready","ipcAvailable":true/);
    assert.match(output, /EDT|EST/);
});
