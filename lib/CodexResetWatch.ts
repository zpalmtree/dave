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
    source: { type: 'x_post' | 'observed' | 'account_observed'; url?: string };
}
interface ScheduledReset extends Reset { status: 'scheduled'; scheduled_for: string | null }
interface Snapshot { resets: Reset[]; scheduled: ScheduledReset | null }
interface Settings { botUserId: string; channelId: string }
export interface ResetWatchState extends Settings {
    version: 1;
    seen: string[];
    pending: { phase: 'announced' | 'dropped'; reset: Reset | ScheduledReset }[];
    recentDrops?: Reset[];
    trackerInitialized?: boolean;
}
type Request = (path: string) => Promise<any>;

function validateReset(value: any): asserts value is Reset {
    if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 64
        || !['regular', 'banked'].includes(value.reset_type)
        || typeof value.announced_at !== 'string' || !Number.isFinite(Date.parse(value.announced_at))
        || typeof value.text !== 'string' || !['x_post', 'observed', 'account_observed'].includes(value.source?.type)) {
        throw new Error('Invalid Codex Resets API reset.');
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
    if (state.recentDrops !== undefined) {
        if (!Array.isArray(state.recentDrops)) throw new Error('Invalid recent Codex resets.');
        state.recentDrops.forEach(validateReset);
    }
}

// There is no shared event ID between an account observation and the public tracker.
// Correlate only across sources, by kind and a bounded six-hour event-time window.
function sameObservedDrop(a: Reset, b: Reset): boolean {
    return a.reset_type === b.reset_type
        && (a.source.type === 'account_observed') !== (b.source.type === 'account_observed')
        && Math.abs(Date.parse(a.announced_at) - Date.parse(b.announced_at)) <= 6 * 3600000;
}

export function planResetAlerts(previous: ResetWatchState | undefined, settings: Settings, snapshot: Snapshot, baselineOnly = false): ResetWatchState {
    if (previous) validateState(previous, settings);
    const seen = new Set(previous?.seen || []);
    const pending = [...(previous?.pending || [])];
    const recentDrops = [...(previous?.recentDrops || [])];
    const completed = new Set(snapshot.resets.map(reset => reset.id));
    for (const reset of [...snapshot.resets].sort((a, b) => Date.parse(a.announced_at) - Date.parse(b.announced_at))) {
        const key = `dropped:${reset.id}`;
        if (previous && !baselineOnly && !seen.has(key) && !recentDrops.some(old => sameObservedDrop(old, reset))) {
            pending.push({ phase: 'dropped', reset });
        }
        if (!recentDrops.some(old => old.id === reset.id)) recentDrops.push(reset);
        seen.add(key);
    }
    const scheduled = snapshot.scheduled;
    if (scheduled && !completed.has(scheduled.id) && !seen.has(`dropped:${scheduled.id}`)
        && !recentDrops.some(old => sameObservedDrop(old, scheduled))) {
        const key = `announced:${scheduled.id}`;
        // A pending announcement is useful even on first startup, unlike old resets.
        if (!seen.has(key)) pending.push({ phase: 'announced', reset: scheduled });
        seen.add(key);
    }
    return { version: 1, ...settings, seen: [...seen], pending, trackerInitialized: previous?.trackerInitialized,
        recentDrops: recentDrops.sort((a, b) => Date.parse(a.announced_at) - Date.parse(b.announced_at)).slice(-200) };
}

export function resetNotification(item: ResetWatchState['pending'][number]): MessageCreateOptions {
    const { phase, reset } = item;
    const announced = phase === 'announced';
    const banked = reset.reset_type === 'banked';
    const accountObserved = reset.source.type === 'account_observed';
    const scheduledFor = 'scheduled_for' in reset ? reset.scheduled_for : null;
    const eta = announced && scheduledFor && Number.isFinite(Date.parse(scheduledFor))
        ? Math.floor(Date.parse(scheduledFor) / 1000) : null;
    const details = escapeMarkdown(reset.text.trim()).slice(0, 1800);
    const description = [announced ? 'Awaiting confirmation.' : '', details].filter(Boolean).join('\n\n');
    const sourceUrl = accountObserved ? 'https://chatgpt.com/codex/settings/usage'
        : typeof reset.source.url === 'string' && /^https:\/\/(?:x\.com|twitter\.com)\//i.test(reset.source.url)
        ? reset.source.url : site;
    return {
        content: `<@&${codexRoleId}>`,
        allowedMentions: { parse: [], roles: [codexRoleId] },
        embeds: [{
            title: accountObserved
                ? (banked ? '✅ Codex reset credit observed on monitored account' : '✅ Codex usage reset observed on monitored account')
                : announced
                ? (banked ? '🕒 Codex reset credit announced' : '🕒 Codex usage reset announced')
                : (banked ? '✅ Codex reset credit added' : '✅ Codex usage limits reset'),
            color: announced ? 0xf0b232 : 0x23a55a,
            url: sourceUrl,
            ...(description ? { description } : {}),
            ...(eta !== null ? { fields: [{
                name: 'Expected reset · estimate',
                value: `<t:${eta}:f> · <t:${eta}:R>`,
            }] } : {}),
            footer: { text: accountObserved ? 'Direct Codex account check · confirmed twice' : 'Data from Codex Resets' },
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

export async function pollResetSources(previous: ResetWatchState | undefined, settings: Settings, sources: {
    observations?: Reset[];
    tracker: () => Promise<Snapshot | null>;
    save: (state: ResetWatchState) => Promise<void>;
    send: (message: MessageCreateOptions) => Promise<unknown>;
    trackerError: (error: Error) => void;
}): Promise<ResetWatchState> {
    let state = previous;
    const persistAndDeliver = async () => {
        await sources.save(state!);
        await deliverResetAlerts(state!, sources.send, () => sources.save(state!));
    };
    if (sources.observations) {
        state = planResetAlerts(state, settings, { resets: sources.observations, scheduled: null });
        // Don't backfill all tracker history if our very first poll finds it unavailable.
        if (!previous) state.trackerInitialized = false;
        await persistAndDeliver();
    }
    let snapshot: Snapshot | null;
    try { snapshot = await sources.tracker(); }
    catch (error) {
        sources.trackerError(error as Error);
        if (state) return state;
        throw error;
    }
    if (!snapshot) {
        if (state) return state;
        throw new Error('Codex reset tracker is waiting for its retry window.');
    }
    state = planResetAlerts(state, settings, snapshot, !state || state.trackerInitialized === false);
    state.trackerInitialized = true;
    await persistAndDeliver();
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
        let trackerRetryAt = 0;
        const request: Request = async path => {
            const response = await fetch(`${site}/api/v1${path}`, { timeout: 30000, size: 5 * 1024 * 1024 });
            if (response.status === 429) {
                const retry = Number(response.headers.get('retry-after'));
                trackerRetryAt = Date.now() + (Number.isFinite(retry) && retry > 0
                    ? Math.max(60000, Math.min(retry * 1000, 86400000)) : 60000);
            }
            if (!response.ok) throw new Error(`Codex Resets HTTP ${response.status}`);
            return response.json();
        };
        const poll = async () => {
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
                // Either source can fail independently. Direct observations should never
                // have to wait for the public tracker to recover or publish a confirmation.
                let observations: Reset[] | undefined;
                try { observations = readUsageFeed(JSON.parse(await fs.readFile(`${configPath}.usage.json`, 'utf8'))); }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[Codex usage feed]', (error as Error).message);
                }
                state = await pollResetSources(state, settings, {
                    observations, tracker: () => Date.now() < trackerRetryAt ? Promise.resolve(null) : readSnapshot(request), send,
                    save: next => saveResetState(statePath, next),
                    trackerError: error => console.error('[Codex resets tracker]', error.message),
                });
                if (!initialized) console.log(`[Codex resets] Baseline saved; channel ${settings.channelId}.`);
            } catch (error) {
                console.error('[Codex resets]', (error as Error).message);
            } finally {
                // A tracker rate-limit backoff must not pause the local observation feed.
                setTimeout(() => void poll(), 60000).unref();
            }
        };
        console.log(`[Codex resets] Watching channel ${settings.channelId} every 60 seconds.`);
        void poll();
    }
}
