import { Client, escapeMarkdown, MessageCreateOptions } from 'discord.js';
import fetch from 'node-fetch';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

const site = 'https://codex-resets.com';
const codexRoleId = '1560349689025532064';
interface Reset {
    id: string;
    reset_type: 'regular' | 'banked';
    announced_at: string;
    text: string;
    source: { type: 'x_post' | 'observed'; url?: string };
}
interface ScheduledReset extends Reset { status: 'scheduled'; scheduled_for: string | null }
interface Snapshot { resets: Reset[]; scheduled: ScheduledReset | null }
interface Settings { botUserId: string; channelId: string }
export interface ResetWatchState extends Settings {
    version: 1;
    seen: string[];
    pending: { phase: 'announced' | 'dropped'; reset: Reset | ScheduledReset }[];
}
type Request = (path: string) => Promise<any>;

function validateReset(value: any): asserts value is Reset {
    if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 64
        || !['regular', 'banked'].includes(value.reset_type)
        || typeof value.announced_at !== 'string' || !Number.isFinite(Date.parse(value.announced_at))
        || typeof value.text !== 'string' || !['x_post', 'observed'].includes(value.source?.type)) {
        throw new Error('Invalid Codex Resets API reset.');
    }
}

export async function readSnapshot(request: Request): Promise<Snapshot> {
    const status = await request('/status');
    if (!status?.data || !('latest_reset' in status.data) || !('scheduled_reset' in status.data)) {
        throw new Error('Invalid Codex Resets API status.');
    }
    const scheduled: ScheduledReset | null = status.data.scheduled_reset;
    if (scheduled !== null) {
        validateReset(scheduled);
        if (scheduled.status !== 'scheduled' || (scheduled.scheduled_for !== null
            && (typeof scheduled.scheduled_for !== 'string' || !Number.isFinite(Date.parse(scheduled.scheduled_for))))) {
            throw new Error('Invalid Codex Resets scheduled reset.');
        }
    }
    // Read every page so resets during downtime aren't lost. Only executed resets
    // appear in this endpoint; forecasts and elapsed ETAs are never completion evidence.
    const resets = new Map<string, Reset>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
        const page = await request(`/resets?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (!Array.isArray(page?.data) || typeof page.pagination?.has_more !== 'boolean') {
            throw new Error('Invalid Codex Resets API history.');
        }
        for (const reset of page.data) { validateReset(reset); resets.set(reset.id, reset); }
        cursor = page.pagination.has_more ? page.pagination.next_cursor : null;
        if (page.pagination.has_more && (typeof cursor !== 'string' || !cursor || cursors.has(cursor))) {
            throw new Error('Invalid Codex Resets pagination cursor.');
        }
        if (cursor) cursors.add(cursor);
    } while (cursor);
    if (status.data.latest_reset !== null) {
        validateReset(status.data.latest_reset);
        resets.set(status.data.latest_reset.id, status.data.latest_reset);
    }
    return { resets: [...resets.values()], scheduled };
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
}

export function planResetAlerts(previous: ResetWatchState | undefined, settings: Settings, snapshot: Snapshot): ResetWatchState {
    if (previous) validateState(previous, settings);
    const seen = new Set(previous?.seen || []);
    const pending = [...(previous?.pending || [])];
    const completed = new Set(snapshot.resets.map(reset => reset.id));
    for (const reset of [...snapshot.resets].sort((a, b) => Date.parse(a.announced_at) - Date.parse(b.announced_at))) {
        const key = `dropped:${reset.id}`;
        if (previous && !seen.has(key)) pending.push({ phase: 'dropped', reset });
        seen.add(key);
    }
    const scheduled = snapshot.scheduled;
    if (scheduled && !completed.has(scheduled.id) && !seen.has(`dropped:${scheduled.id}`)) {
        const key = `announced:${scheduled.id}`;
        // A pending announcement is useful even on first startup, unlike old resets.
        if (!seen.has(key)) pending.push({ phase: 'announced', reset: scheduled });
        seen.add(key);
    }
    return { version: 1, ...settings, seen: [...seen], pending };
}

export function resetNotification(item: ResetWatchState['pending'][number]): MessageCreateOptions {
    const { phase, reset } = item;
    const announced = phase === 'announced';
    const banked = reset.reset_type === 'banked';
    const scheduledFor = 'scheduled_for' in reset ? reset.scheduled_for : null;
    const eta = announced && scheduledFor && Number.isFinite(Date.parse(scheduledFor))
        ? Math.floor(Date.parse(scheduledFor) / 1000) : null;
    const text = reset.text.trim();
    // Short completion boilerplate adds no information beyond the headline.
    const details = !announced && /^(?:done|complete|completed|reset complete|reset completed)[.!]?$/i.test(text)
        ? '' : escapeMarkdown(text).slice(0, 1800);
    const description = [announced ? 'Awaiting confirmation.' : '', details].filter(Boolean).join('\n\n');
    const sourceUrl = typeof reset.source.url === 'string' && /^https:\/\/(?:x\.com|twitter\.com)\//i.test(reset.source.url)
        ? reset.source.url : site;
    return {
        content: `<@&${codexRoleId}>`,
        allowedMentions: { parse: [], roles: [codexRoleId] },
        embeds: [{
            title: announced
                ? (banked ? '🕒 Codex reset credit announced' : '🕒 Codex usage reset announced')
                : (banked ? '✅ Codex reset credit added' : '✅ Codex usage limits reset'),
            color: announced ? 0xf0b232 : 0x23a55a,
            url: sourceUrl,
            ...(description ? { description } : {}),
            ...(eta !== null ? { fields: [{
                name: 'Expected reset · estimate',
                value: `<t:${eta}:f> · <t:${eta}:R>`,
            }] } : {}),
            footer: { text: 'Data from Codex Resets' },
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
        let retryDelay = 60000;
        const request: Request = async path => {
            const response = await fetch(`${site}/api/v1${path}`, { timeout: 30000, size: 5 * 1024 * 1024 });
            if (response.status === 429) {
                const retry = Number(response.headers.get('retry-after'));
                if (Number.isFinite(retry) && retry > 0) retryDelay = Math.max(retryDelay, Math.min(retry * 1000, 86400000));
            }
            if (!response.ok) throw new Error(`Codex Resets HTTP ${response.status}`);
            return response.json();
        };
        const poll = async () => {
            retryDelay = 60000;
            try {
                const channel = await client.channels.fetch(settings.channelId);
                if (!channel || !channel.isTextBased() || channel.isDMBased()) throw new Error('Destination is not an accessible server text channel.');
                let state: ResetWatchState | undefined;
                try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
                const save = () => saveResetState(statePath, state!);
                const send = async (message: MessageCreateOptions) => {
                    if (channel.isThread() && channel.archived) await channel.setArchived(false);
                    return channel.send(message);
                };
                if (state) {
                    validateState(state, settings);
                    await deliverResetAlerts(state, send, save);
                }
                const initialized = Boolean(state);
                const snapshot = await readSnapshot(request);
                state = planResetAlerts(state, settings, snapshot);
                await save();
                await deliverResetAlerts(state, send, save);
                if (!initialized) console.log(`[Codex resets] Baseline saved: ${snapshot.resets.length} historical resets; channel ${settings.channelId}.`);
            } catch (error) {
                console.error('[Codex resets]', (error as Error).message);
            } finally {
                setTimeout(() => void poll(), retryDelay).unref();
            }
        };
        console.log(`[Codex resets] Watching channel ${settings.channelId} every 60 seconds.`);
        void poll();
    }
}
