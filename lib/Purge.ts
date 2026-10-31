import { ChannelType, GuildBasedChannel, Message, PermissionFlagsBits } from 'discord.js';

const allowedUsers = new Set([
    '354701063955152898',
    '901540415176597534',
    '1231731968064880692',
    '882322615346270268',
]);

// A factory keeps the concurrency guard scoped to the handler and permits fast fixture tests.
export function createPurgeHandler(
    pause = () => new Promise<void>(resolve => setTimeout(resolve, 2000)),
    now = Date.now,
) {
    const runningGuilds = new Map<string, { deleted: number; failures: number; scanned: number; skipped: number }>();
    const summary = (state: { deleted: number; failures: number; scanned: number; skipped: number }) =>
        `${state.deleted} messages deleted; ${state.scanned} channels/threads checked; ${state.skipped} skipped for missing permissions; ${state.failures} errors.`;
    const reply = async (msg: Message, content: string) => {
        try {
            return await msg.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
        } catch (error) {
            console.error('Purge: could not send status', error);
        }
    };

    return async (msg: Message, args = ''): Promise<void> => {
        if (!allowedUsers.has(msg.author.id)) {
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
            await reply(msg, `A purge is already running in this server. ${summary(running)}`);
            return;
        }
        const state = { deleted: 0, failures: 0, scanned: 0, skipped: 0 };
        runningGuilds.set(guild.id, state);
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
                console.error('Purge: could not update status', error);
            }
        };
        const visited = new Set<string>();

        try {
            progress = await reply(msg, 'Purge started. Deleting only your messages across this server, starting in this channel. I will update this message with progress.');
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
                    return;
                }
                state.scanned++;

                let before: string | undefined;
                try {
                    while (true) {
                        const messages = await channel.messages.fetch({ limit: 100, before, cache: false });
                        if (!messages.size) break;
                        // Use snowflakes rather than timestamps (several messages can share a millisecond).
                        const oldest = [...messages.keys()].reduce((a, b) => BigInt(a) < BigInt(b) ? a : b);
                        if (before && BigInt(oldest) >= BigInt(before)) break;
                        before = oldest;
                        await pause();
                        for (const message of messages.values()) {
                            if (message.author.id !== msg.author.id) continue;
                            try {
                                // Individual deletion also supports messages older than two weeks.
                                await message.delete();
                                state.deleted++;
                            } catch (error) {
                                state.failures++;
                                console.error(`Purge: failed deleting ${message.id}`, error);
                            }
                            await pause();
                            await update();
                        }
                        await update();
                    }
                } catch (error) {
                    state.failures++;
                    console.error(`Purge: failed reading channel ${channel.id}`, error);
                }
            };

            const channels = await guild.channels.fetch();
            // Give immediate results where the command was used, before scanning other history.
            const invokingChannel = channels.get(msg.channel.id) ?? (msg.channel.isThread() ? msg.channel : undefined);
            if (invokingChannel) await scan(invokingChannel);
            try {
                const active = await guild.channels.fetchActiveThreads();
                for (const thread of active.threads.values()) await scan(thread);
            } catch (error) {
                state.failures++;
                console.error('Purge: failed listing active threads', error);
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
                        console.error(`Purge: failed listing ${type} archived threads in ${channel.id}`, error);
                    }
                }
            }
        } catch (error) {
            state.failures++;
            console.error(`Purge: failed in guild ${guild.id}`, error);
        } finally {
            runningGuilds.delete(guild.id);
            await update(true);
            console.log(`Purge for ${msg.author.id} in ${guild.id}: ${summary(state)}`);
        }
    };
}

export const handlePurge = createPurgeHandler();
