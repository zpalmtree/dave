import { randomUUID } from 'node:crypto';
import { ChannelType, GuildBasedChannel, Message, PermissionFlagsBits } from 'discord.js';

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

interface PurgeState {
    runId: string;
    guildId: string;
    userId: string;
    deleted: number;
    failures: number;
    scanned: number;
    skipped: number;
    pages: number;
    phase: string;
    channelId?: string;
    before?: string;
}

// A factory keeps the concurrency guard scoped to the handler and permits fast fixture tests.
export function createPurgeHandler(
    pause = () => new Promise<void>(resolve => setTimeout(resolve, 2000)),
    now = Date.now,
    log = logPurgeEvent,
    heartbeatMs = 30000,
) {
    const runningGuilds = new Map<string, PurgeState>();
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
            await reply(msg, running ? `Purge is running. ${summary(running)}` : 'No purge is running in this server.');
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
        const state: PurgeState = { runId: randomUUID(), guildId: guild.id, userId: msg.author.id,
            deleted: 0, failures: 0, scanned: 0, skipped: 0, pages: 0, phase: 'starting' };
        runningGuilds.set(guild.id, state);
        log('started', { ...state, invokingChannelId: msg.channel.id });
        // Operator progress must continue even if Discord status messages cannot be sent.
        const heartbeat = setInterval(() => log('progress', { ...state }), heartbeatMs);
        heartbeat.unref();
        let progress: Message | undefined;
        let lastUpdate = now();
        const update = async (finished = false) => {
            if (!progress || (!finished && now() - lastUpdate < 15000)) return;
            lastUpdate = now();
            try {
                await progress.edit({
                    content: `${finished ? 'Purge finished.' : 'Purge is running.'} ${summary(state)}${finished ? '' : ' Scanning server history can take a while.'}`,
                    allowedMentions: { parse: [], repliedUser: false },
                });
            } catch (error) {
                log('notification_error', { ...state });
            }
        };
        const visited = new Set<string>();

        try {
            progress = await reply(msg, 'Purge started. Deleting only your messages across this server, starting in this channel. I will update this message with progress.');
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
                    log('channel_skipped', { ...state, skippedChannelId: channel.id, reason: 'missing_permissions' });
                    return;
                }
                state.scanned++;
                state.channelId = channel.id;
                state.before = undefined;
                state.phase = 'fetching_history';
                log('channel_started', { ...state });

                let before: string | undefined;
                try {
                    while (true) {
                        state.phase = 'fetching_history';
                        const messages = await channel.messages.fetch({ limit: 100, before, cache: false });
                        state.pages++;
                        if (!messages.size) break;
                        // Use snowflakes rather than timestamps (several messages can share a millisecond).
                        const oldest = [...messages.keys()].reduce((a, b) => BigInt(a) < BigInt(b) ? a : b);
                        if (before && BigInt(oldest) >= BigInt(before)) break;
                        before = oldest;
                        state.before = before;
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
                            } catch (error) {
                                state.failures++;
                                log('delete_error', { ...state, messageId: message.id, code: (error as { code?: unknown })?.code });
                            }
                            await pause();
                            await update();
                        }
                        await update();
                    }
                } catch (error) {
                    state.failures++;
                    log('history_error', { ...state, code: (error as { code?: unknown })?.code });
                }
                log('channel_finished', { ...state });
            };

            state.phase = 'listing_channels';
            const channels = await guild.channels.fetch();
            // Give immediate results where the command was used, before scanning other history.
            const invokingChannel = channels.get(msg.channel.id) ?? (msg.channel.isThread() ? msg.channel : undefined);
            if (invokingChannel) await scan(invokingChannel);
            try {
                state.phase = 'listing_active_threads';
                const active = await guild.channels.fetchActiveThreads();
                for (const thread of active.threads.values()) await scan(thread);
            } catch (error) {
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
                        state.failures++;
                        log('archived_threads_error', { ...state, archiveType: type, code: (error as { code?: unknown })?.code });
                    }
                }
            }
        } catch (error) {
            state.failures++;
            log('run_error', { ...state, code: (error as { code?: unknown })?.code });
        } finally {
            clearInterval(heartbeat);
            runningGuilds.delete(guild.id);
            state.phase = 'finished';
            log('finished', { ...state });
            await update(true);
        }
    };
    return Object.assign(handle, {
        status: () => [...runningGuilds.values()].map(state => ({ ...state })),
    });
}

export const handlePurge = createPurgeHandler();
