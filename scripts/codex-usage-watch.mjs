// Run once per minute using the supplied systemd timer. No inference or reset redemption.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseUsageSample, advanceUsageWatch, validateUsageWatchState } from '../dist/CodexUsageWatch.js';

export function readCodexUsage(command = process.env.CODEX_USAGE_CODEX || join(homedir(), '.local/bin/codex'), timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, ['app-server', '--listen', 'stdio://'], {
            stdio: ['pipe', 'pipe', 'ignore'], detached: true,
        });
        const lines = createInterface({ input: child.stdout });
        let settled = false;
        const kill = signal => {
            if (child.pid) try { process.kill(-child.pid, signal); } catch (error) {
                if (error.code !== 'ESRCH') child.kill(signal);
            }
        };
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            lines.close();
            child.stdin.end();
            kill('SIGTERM');
            // Bounded cleanup includes children and a CLI that ignores SIGTERM.
            setTimeout(() => kill('SIGKILL'), 1000);
            error ? reject(error) : resolve(value);
        };
        const timer = setTimeout(() => finish(new Error('Codex rate-limit read timed out.')), timeoutMs);
        const send = value => child.stdin.write(JSON.stringify(value) + '\n');
        child.on('error', () => finish(new Error('Could not start Codex app-server.')));
        child.on('exit', () => finish(new Error('Codex app-server exited before returning limits.')));
        child.stdin.on('error', () => finish(new Error('Codex app-server input closed.')));
        lines.on('line', line => {
            let message;
            try { message = JSON.parse(line); } catch { return; }
            if (message.id !== 1 && message.id !== 2) return;
            // Never log raw RPC responses/errors: they can include account information.
            if (message.error) return finish(new Error(`Codex ${message.id === 1 ? 'initialization' : 'rate-limit read'} failed; check local Codex login.`));
            if (message.id === 1) {
                send({ method: 'initialized', params: {} });
                send({ method: 'account/rateLimits/read', id: 2 });
            } else {
                try { finish(null, parseUsageSample(message.result)); }
                catch (error) { finish(error); }
            }
        });
        send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'dave_reset_watch', version: '1.0.0' } } });
    });
}

async function saveState(path, state) {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.writeFile(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(`${path}.tmp`, path);
}

const receiver = `import json, os, sys, tempfile
data = sys.stdin.buffer.read(2097153)
if len(data) > 2097152: raise ValueError('Feed too large')
feed = json.loads(data)
if feed.get('version') != 1 or not isinstance(feed.get('events'), list): raise ValueError('Invalid feed')
path = os.path.expanduser('~/.config/dave-codex-resets.json.usage.json')
os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
name = None
try:
    with tempfile.NamedTemporaryFile(dir=os.path.dirname(path), prefix='.codex-usage-', delete=False) as f:
        name = f.name
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(name, path)
finally:
    if name and os.path.exists(name): os.unlink(name)
`;
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export function forwardObservations(events, remote = process.env.CODEX_USAGE_REMOTE || 'dave') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(remote)) throw new Error('Invalid SSH destination.');
    const feed = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), events });
    return new Promise((resolve, reject) => {
        const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', remote,
            `python3 -c ${shellQuote(receiver)}`], { stdio: ['pipe', 'ignore', 'ignore'] });
        const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
        child.on('error', () => { clearTimeout(timer); reject(new Error('Could not start observation forwarding.')); });
        child.on('close', code => {
            clearTimeout(timer);
            code === 0 ? resolve() : reject(new Error('Observation forwarding failed; saved events will retry next minute.'));
        });
        child.stdin.on('error', () => {});
        child.stdin.end(feed);
    });
}

export async function main() {
    const statePath = process.env.CODEX_USAGE_STATE_FILE || join(homedir(), '.local/state/dave-codex-usage.json');
    let previous;
    try { previous = JSON.parse(await fs.readFile(statePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous) validateUsageWatchState(previous);
    let sampleError;
    let state = previous;
    try {
        const next = advanceUsageWatch(previous, await readCodexUsage());
        await saveState(statePath, next);
        state = next;
    } catch (error) { sampleError = error; }
    // Previously confirmed observations remain deliverable even when authentication fails.
    if (state) await forwardObservations(state.events);
    if (sampleError) throw sampleError;
    console.log(`Codex usage checked; ${state.candidate ? 'confirmation pending' : 'baseline current'}; ${state.events.length} retained observations forwarded.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
