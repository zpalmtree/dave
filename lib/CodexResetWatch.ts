import { Client, escapeMarkdown, MessageCreateOptions } from 'discord.js';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

const codexRoleId = '1560349689025532064';
interface Reset {
    id: string;
    reset_type: 'regular' | 'banked';
    announced_at: string;
    text: string;
    source: { type: 'x_post' | 'observed' | 'account_observed'; url?: string };
}
interface Settings { botUserId: string; channelId: string }
export interface ResetWatchState extends Settings {
    version: 1;
    seen: string[];
    pending: { phase: 'announced' | 'dropped'; reset: Reset }[];
    recentDrops?: Reset[];
    trackerInitialized?: boolean;
}

function validateReset(value: any): asserts value is Reset {
    if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 64
        || !['regular', 'banked'].includes(value.reset_type)
        || typeof value.announced_at !== 'string' || !Number.isFinite(Date.parse(value.announced_at))
        || typeof value.text !== 'string' || !['x_post', 'observed', 'account_observed'].includes(value.source?.type)) {
        throw new Error('Invalid Codex reset.');
    }
}

export function readUsageFeed(value: any): Reset[] {
    if (value?.version !== 1 || !Number.isFinite(Date.parse(value.updatedAt))
        || !Array.isArray(value.events) || value.events.length > 200) throw new Error('Invalid Codex usage observation feed.');
    for (const event of value.events) {
        validateReset(event);
        if (event.source.type !== 'account_observed' || !event.id.startsWith('usage-')) {
            throw new Error('Invalid Codex account observation.');
        }
    }
    return value.events;
}

export function validateState(state: ResetWatchState, settings: Settings): void {
    if (state?.version !== 1 || !Array.isArray(state.seen) || !state.seen.every(key => typeof key === 'string')
        || !Array.isArray(state.pending)) throw new Error('Invalid Codex reset watch state.');
    if (state.botUserId !== settings.botUserId || state.channelId !== settings.channelId) {
        throw new Error('Codex reset watch destination changed; use a new config/state file.');
    }
    for (const item of state.pending) {
        if (!item || !['announced', 'dropped'].includes(item.phase)) throw new Error('Invalid pending Codex reset.');
        validateReset(item.reset);
    }
    if (state.recentDrops !== undefined) {
        if (!Array.isArray(state.recentDrops)) throw new Error('Invalid recent Codex resets.');
        state.recentDrops.forEach(validateReset);
    }
}

// Accept the old state format for migration, but discard tracker queues and
// correlation history before any delivery. Keep account event IDs across restarts.
function accountOnlyState(previous: ResetWatchState, settings: Settings): ResetWatchState {
    validateState(previous, settings);
    return { version: 1, ...settings,
        seen: previous.seen.filter(key => key.startsWith('dropped:usage-')),
        pending: previous.pending.filter(item => item.phase === 'dropped' && isObservation(item.reset)) };
}

function isObservation(reset: Reset): boolean {
    return reset.source.type === 'account_observed' && reset.id.startsWith('usage-');
}

export function planResetAlerts(previous: ResetWatchState | undefined, settings: Settings, observations: Reset[]): ResetWatchState {
    const state = previous ? accountOnlyState(previous, settings) : { version: 1 as const, ...settings, seen: [], pending: [] };
    const seen = new Set(state.seen);
    for (const reset of [...observations].sort((a, b) => Date.parse(a.announced_at) - Date.parse(b.announced_at))) {
        validateReset(reset);
        if (!isObservation(reset)) throw new Error('Invalid Codex account observation.');
        const key = `dropped:${reset.id}`;
        if (previous && !seen.has(key) && !state.pending.some(item => item.reset.id === reset.id)) {
            state.pending.push({ phase: 'dropped', reset });
        }
        seen.add(key);
    }
    return { ...state, seen: [...seen] };
}

export function resetNotification(item: ResetWatchState['pending'][number]): MessageCreateOptions {
    const { phase, reset } = item;
    if (phase !== 'dropped' || !isObservation(reset)) throw new Error('Only confirmed Codex account observations can be sent.');
    const banked = reset.reset_type === 'banked';
    const description = escapeMarkdown(reset.text.trim()).slice(0, 1800);
    return {
        content: `<@&${codexRoleId}>`,
        allowedMentions: { parse: [], roles: [codexRoleId] },
        embeds: [{
            title: banked ? '✅ Codex reset credit observed on monitored account' : '✅ Codex usage reset observed on monitored account',
            color: 0x23a55a,
            url: 'https://chatgpt.com/codex/settings/usage',
            ...(description ? { description } : {}),
            footer: { text: 'Direct Codex account check · confirmed twice' },
            timestamp: new Date(reset.announced_at).toISOString(),
        }],
    };
}

export async function saveResetState(path: string, state: ResetWatchState): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.writeFile(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(`${path}.tmp`, path);
}

export async function deliverResetAlerts(state: ResetWatchState, send: (message: MessageCreateOptions) => Promise<unknown>, save: () => Promise<void>): Promise<void> {
    while (state.pending.length) {
        await send(resetNotification(state.pending[0]));
        state.pending.shift();
        await save();
    }
}

export async function pollResetObservations(previous: ResetWatchState | undefined, settings: Settings, sources: {
    observations?: Reset[];
    save: (state: ResetWatchState) => Promise<void>;
    send: (message: MessageCreateOptions) => Promise<unknown>;
}): Promise<ResetWatchState | undefined> {
    // Missing or invalid feeds must not create an empty first-start baseline.
    // Existing confirmed deliveries still retry while the desktop is unavailable.
    if (!previous && sources.observations === undefined) return undefined;
    const state = planResetAlerts(previous, settings, sources.observations ?? []);
    await sources.save(state);
    await deliverResetAlerts(state, sources.send, () => sources.save(state));
    return state;
}

const started = new WeakSet<Client>();
export function startCodexResetWatch(client: Client): void {
    if (started.has(client)) return;
    started.add(client);
    void initialize().catch(error => console.error('[Codex resets] Setup failed:', error.message));
    async function initialize() {
        const configPath = process.env.CODEX_RESET_WATCH_CONFIG_FILE || join(homedir(), '.config', 'dave-codex-resets.json');
        let settings: Settings;
        try { settings = JSON.parse(await fs.readFile(configPath, 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        if (!settings || typeof settings.botUserId !== 'string' || !/^\d+$/.test(settings.botUserId)
            || typeof settings.channelId !== 'string' || !/^\d+$/.test(settings.channelId)) throw new Error('Invalid Codex reset watch configuration.');
        // Both deployment tracks load this file, but only the selected bot posts.
        if (settings.botUserId !== client.user?.id) return;
        const statePath = `${configPath}.state.json`;
        const poll = async () => {
            try {
                const channel = await client.channels.fetch(settings.channelId);
                if (!channel || !channel.isTextBased() || channel.isDMBased()) throw new Error('Destination is not an accessible server text channel.');
                let state: ResetWatchState | undefined;
                try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
                const send = async (message: MessageCreateOptions) => {
                    if (channel.isThread() && channel.archived) await channel.setArchived(false);
                    return channel.send(message);
                };
                const initialized = Boolean(state);
                let observations: Reset[] | undefined;
                try { observations = readUsageFeed(JSON.parse(await fs.readFile(`${configPath}.usage.json`, 'utf8'))); }
                catch (error) {
                    console.error('[Codex usage feed]', (error as NodeJS.ErrnoException).code === 'ENOENT'
                        ? 'Observation feed missing; waiting for the desktop account poller.' : (error as Error).message);
                }
                state = await pollResetObservations(state, settings, {
                    observations, send,
                    save: next => saveResetState(statePath, next),
                });
                if (!initialized && state) console.log(`[Codex resets] Baseline saved; channel ${settings.channelId}.`);
            } catch (error) {
                console.error('[Codex resets]', (error as Error).message);
            } finally {
                setTimeout(() => void poll(), 60000).unref();
            }
        };
        console.log(`[Codex resets] Watching direct account observations for channel ${settings.channelId} every 60 seconds.`);
        void poll();
    }
}
