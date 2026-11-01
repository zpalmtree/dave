import { randomUUID } from 'node:crypto';
import { Client, ChannelType, GuildBasedChannel, Message, PermissionFlagsBits } from 'discord.js';

import { createFilePurgeCheckpointStore, PurgeCheckpoint, PurgeCheckpointError, PurgeCheckpointStore, PurgeState } from './PurgeCheckpoint.js';

const allowedUsers = new Set([
    '354701063955152898',
    '901540415176597534',
    '1231731968064880692',
    '882322615346270268',
]);

export const isPurgeUserAllowed = (userId: string) => allowedUsers.has(userId);

export function logPurgeEvent(event: string, details: Record<string, unknown> = {}): void {
    const timestamp = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
    }).format(new Date());
    console.log('[Purge] ' + JSON.stringify({ timestamp, pid: process.pid, event, ...details }));
}

// A factory keeps the concurrency guard scoped to the handler and permits fast fixture tests.
export function createPurgeHandler(
    pause = () => new Promise<void>(resolve => setTimeout(resolve, 2000)),
    log = logPurgeEvent,
    heartbeatMs = 30000,
    store?: PurgeCheckpointStore,
) {
    const runningGuilds = new Map<string, PurgeState>();
    const restoring = new Set<string>();
    const summary = (state: { deleted: number; failures: number; scanned: number; skipped: number }) =>
        `${state.deleted} messages deleted; ${state.scanned} channels/threads checked; ${state.skipped} skipped for missing permissions; ${state.failures} errors.`;
    const reply = async (msg: Message, content: string) => {
        try {
            return await msg.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
        } catch (error) {
            log('notification_error', { guildId: msg.guild?.id, userId: msg.author.id });
        }
    };

    const handle = async (msg: Message, args = ''): Promise<void> => {
        if (!isPurgeUserAllowed(msg.author.id)) {
            log('access_denied', { userId: msg.author.id, guildId: msg.guild?.id });
            await reply(msg, 'You do not have access to purge.');
            return;
        }
        if (!msg.guild) {
            await reply(msg, 'Run purge in a server channel.');
            return;
        }
        const guild = msg.guild;
        const running = runningGuilds.get(guild.id);
        if (args.trim().toLowerCase() === 'status') {
            const saved = store?.load(guild.id);
            await reply(msg, running ? `Purge is running. ${summary(running)}`
                : saved ? `Purge is saved and waiting to resume. ${summary(saved.state)}` : 'No purge is running in this server.');
            return;
        }
        if (args.trim()) {
            await reply(msg, 'Use purge with no arguments to delete your messages, or purge status to check progress.');
            return;
        }
        if (running) {
            log('already_running', { ...running, requestedBy: msg.author.id });
            await reply(msg, `A purge is already running in this server. ${summary(running)}`);
            return;
        }
        if (restoring.has(guild.id)) {
            await reply(msg, 'A saved purge is being restored in this server.');
            return;
        }
        const saved = store?.load(guild.id);
        if (saved && saved.state.userId !== msg.author.id) {
            await reply(msg, 'Another user has a saved purge in this server. It will resume automatically.');
            return;
        }
        await run(msg, saved);
    };

    const run = async (msg: Message, saved?: PurgeCheckpoint): Promise<void> => {
        const guild = msg.guild!;
        if (runningGuilds.has(guild.id)) return;
        const state: PurgeState = saved?.state ?? { runId: randomUUID(), guildId: guild.id, userId: msg.author.id,
            deleted: 0, failures: 0, scanned: 0, skipped: 0, pages: 0, phase: 'starting' };
        const checkpoint: PurgeCheckpoint = saved ?? { version: 1, state, invokingChannelId: msg.channel.id, channels: {} };
        delete checkpoint.progressMessageId; // Retire notices created by older versions.
        const persist = () => {
            try { store?.save(checkpoint); }
            catch { throw new PurgeCheckpointError('Could not persist purge progress.'); }
        };
        let complete = true;
        runningGuilds.set(guild.id, state);
        log(saved ? 'resumed' : 'started', { ...state, invokingChannelId: msg.channel.id });
        // Progress is operator-only; never post automatic Discord messages.
        const heartbeat = setInterval(() => log('progress', { ...state }), heartbeatMs);
        heartbeat.unref();
        const visited = new Set(Object.keys(checkpoint.channels).filter(id => checkpoint.channels[id].done));

        try {
            persist();
            state.phase = 'fetching_member';
            const member = guild.members.me ?? await guild.members.fetchMe();
            const scan = async (channel: GuildBasedChannel) => {
                if (visited.has(channel.id)) return;
                visited.add(channel.id);
                if (!channel.isTextBased()) return;
                if (!channel.permissionsFor(member)?.has([
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.ManageMessages,
                ])) {
                    state.skipped++;
                    checkpoint.channels[channel.id] = { ...checkpoint.channels[channel.id], done: true };
                    persist();
                    log('channel_skipped', { ...state, skippedChannelId: channel.id, reason: 'missing_permissions' });
                    return;
                }
                const cursor = checkpoint.channels[channel.id] ?? { done: false };
                if (!checkpoint.channels[channel.id]) state.scanned++;
                checkpoint.channels[channel.id] = cursor;
                state.channelId = channel.id;
                state.before = cursor.before;
                state.phase = 'fetching_history';
                log('channel_started', { ...state });

                let before = cursor.before;
                persist();
                try {
                    while (true) {
                        state.phase = 'fetching_history';
                        const messages = await channel.messages.fetch({ limit: 100, before, cache: false });
                        state.pages++;
                        if (!messages.size) { cursor.done = true; persist(); break; }
                        // Use snowflakes rather than timestamps (several messages can share a millisecond).
                        const oldest = [...messages.keys()].reduce((a, b) => BigInt(a) < BigInt(b) ? a : b);
                        if (before && BigInt(oldest) >= BigInt(before)) {
                            complete = false;
                            state.failures++;
                            log('history_not_advancing', { ...state });
                            break;
                        }
                        state.before = oldest;
                        state.phase = 'scanning_messages';
                        await pause();
                        for (const message of messages.values()) {
                            if (message.author.id !== msg.author.id) continue;
                            try {
                                // Individual deletion also supports messages older than two weeks.
                                state.phase = 'deleting_message';
                                await message.delete();
                                state.phase = 'scanning_messages';
                                state.deleted++;
                                persist();
                            } catch (error) {
                                if (error instanceof PurgeCheckpointError) throw error;
                                if ((error as { code?: number })?.code === 10008) continue;
                                state.failures++;
                                log('delete_error', { ...state, messageId: message.id, code: (error as { code?: unknown })?.code });
                            }
                            await pause();
                        }
                        before = oldest;
                        cursor.before = before;
                        persist();
                    }
                } catch (error) {
                    if (error instanceof PurgeCheckpointError) throw error;
                    complete = false;
                    state.failures++;
                    persist();
                    log('history_error', { ...state, code: (error as { code?: unknown })?.code });
                }
                log('channel_finished', { ...state });
            };

            state.phase = 'listing_channels';
            const channels = await guild.channels.fetch();
            // Give immediate results where the command was used, before scanning other history.
            // Resume unfinished channels (including archived threads) before any fresh history.
            if (saved) for (const [id, cursor] of Object.entries(checkpoint.channels)) {
                if (cursor.done) continue;
                try {
                    const channel = channels.get(id) ?? await guild.channels.fetch(id);
                    if (channel) await scan(channel);
                    else { cursor.done = true; persist(); }
                } catch (error) {
                    if (error instanceof PurgeCheckpointError) throw error;
                    if ((error as { code?: number })?.code === 10003) { cursor.done = true; persist(); }
                    else { complete = false; state.failures++; log('resume_channel_error', { ...state, channelId: id }); }
                }
            }
            const invokingChannel = channels.get(msg.channel.id) ?? (msg.channel.isThread() ? msg.channel : undefined);
            if (invokingChannel) await scan(invokingChannel);
            try {
                state.phase = 'listing_active_threads';
                const active = await guild.channels.fetchActiveThreads();
                for (const thread of active.threads.values()) await scan(thread);
            } catch (error) {
                if (error instanceof PurgeCheckpointError) throw error;
                complete = false;
                state.failures++;
                log('active_threads_error', { ...state, code: (error as { code?: unknown })?.code });
            }

            for (const channel of channels.values()) {
                if (!channel) continue;
                await scan(channel);
                if (!('threads' in channel) || !channel.permissionsFor(member)?.has([
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.ManageMessages,
                ])) continue;

                const types: ('public' | 'private')[] = channel.type === ChannelType.GuildText
                    ? ['public', 'private'] : ['public'];
                for (const type of types) {
                    const fetchAll = type === 'private' && !!channel.permissionsFor(member)?.has(PermissionFlagsBits.ManageThreads);
                    let before: string | Date | undefined;
                    try {
                        while (true) {
                            state.phase = 'listing_archived_threads';
                            state.channelId = channel.id;
                            const page = await channel.threads.fetchArchived({ type, fetchAll, limit: 100, before });
                            for (const thread of page.threads.values()) await scan(thread);
                            if (!page.hasMore || !page.threads.size) break;
                            const last = page.threads.last()!;
                            const next = type === 'private' && !fetchAll ? last.id : last.archiveTimestamp;
                            if (next == null || String(next) === String(before instanceof Date ? before.getTime() : before)) break;
                            before = typeof next === 'number' ? new Date(next) : next;
                            await pause();
                        }
                    } catch (error) {
                        if (error instanceof PurgeCheckpointError) throw error;
                        complete = false;
                        state.failures++;
                        log('archived_threads_error', { ...state, archiveType: type, code: (error as { code?: unknown })?.code });
                    }
                }
            }
            if (complete) {
                try { store?.remove(guild.id); }
                catch { throw new PurgeCheckpointError('Could not finalize purge checkpoint.'); }
            } else persist();
        } catch (error) {
            complete = false;
            state.failures++;
            log(error instanceof PurgeCheckpointError ? 'checkpoint_error' : 'run_error', { ...state, code: (error as { code?: unknown })?.code });
        } finally {
            clearInterval(heartbeat);
            runningGuilds.delete(guild.id);
            state.phase = complete ? 'finished' : 'waiting_to_resume';
            log(complete ? 'finished' : 'waiting_to_resume', { ...state });
        }
    };
    return Object.assign(handle, {
        status: () => {
            const states = new Map(store?.list().map(saved => [saved.state.guildId,
                { ...saved.state, phase: 'waiting_to_resume' }]) ?? []);
            for (const [id, state] of runningGuilds) states.set(id, { ...state });
            return [...states.values()];
        },
        resumePending: async (client: Client) => {
            let checkpoints: PurgeCheckpoint[];
            try { checkpoints = store?.list() ?? []; }
            catch { log('checkpoint_load_error'); return; }
            for (let saved of checkpoints) {
                const { guildId, userId } = saved.state;
                if (runningGuilds.has(guildId) || restoring.has(guildId)) continue;
                // A job may have completed while another guild was being restored.
                try {
                    const current = store?.load(guildId);
                    if (!current || current.state.runId !== saved.state.runId) continue;
                    saved = current;
                } catch { log('checkpoint_load_error', { guildId }); continue; }
                if (!isPurgeUserAllowed(userId)) { log('resume_access_denied', { guildId, userId }); continue; }
                restoring.add(guildId);
                try {
                    const guild = await client.guilds.fetch(guildId);
                    let channel: GuildBasedChannel | null | undefined;
                    try { channel = await guild.channels.fetch(saved.invokingChannelId); } catch { /* The original command channel may no longer exist. */ }
                    const context = {
                        guild, client, author: { id: userId },
                        channel: channel ?? { id: saved.invokingChannelId, isThread: () => false },
                    } as unknown as Message;
                    // Do not await the multi-day job; restore other guilds and return promptly.
                    void run(context, saved).catch(() => log('resume_run_error', { guildId, userId }));
                } catch (error) {
                    log('resume_context_error', { guildId, userId, code: (error as { code?: unknown })?.code });
                } finally { restoring.delete(guildId); }
            }
        },
    });
}

export const handlePurge = createPurgeHandler(undefined, undefined, undefined,
    createFilePurgeCheckpointStore('.purge-state'));
