import { ChannelType, GuildBasedChannel, Message, PermissionFlagsBits } from 'discord.js';

const allowedUsers = new Set([
    '354701063955152898',
    '901540415176597534',
    '1231731968064880692',
    '882322615346270268',
]);

// A factory keeps the concurrency guard scoped to the handler and permits fast fixture tests.
export function createPurgeHandler(pause = () => new Promise<void>(resolve => setTimeout(resolve, 2000))) {
    const runningGuilds = new Set<string>();

    return async (msg: Message): Promise<void> => {
        if (!allowedUsers.has(msg.author.id) || !msg.guild) return;
        const guild = msg.guild;
        if (runningGuilds.has(guild.id)) return;
        runningGuilds.add(guild.id);
        let deleted = 0;
        let failures = 0;
        const visited = new Set<string>();

        try {
            const member = guild.members.me ?? await guild.members.fetchMe();
            const scan = async (channel: GuildBasedChannel) => {
                if (visited.has(channel.id)) return;
                visited.add(channel.id);
                if (!channel.isTextBased() || !channel.permissionsFor(member)?.has([
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.ManageMessages,
                ])) return;

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
                                deleted++;
                            } catch (error) {
                                failures++;
                                console.error(`Purge: failed deleting ${message.id}`, error);
                            }
                            await pause();
                        }
                    }
                } catch (error) {
                    failures++;
                    console.error(`Purge: failed reading channel ${channel.id}`, error);
                }
            };

            const channels = await guild.channels.fetch();
            // Include the invoking thread even if Discord omits it from the active list.
            if (msg.channel.isThread()) await scan(msg.channel);
            try {
                const active = await guild.channels.fetchActiveThreads();
                for (const thread of active.threads.values()) await scan(thread);
            } catch (error) {
                failures++;
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
                        failures++;
                        console.error(`Purge: failed listing ${type} archived threads in ${channel.id}`, error);
                    }
                }
            }
        } catch (error) {
            failures++;
            console.error(`Purge: failed in guild ${guild.id}`, error);
        } finally {
            runningGuilds.delete(guild.id);
            console.log(`Purge for ${msg.author.id} in ${guild.id}: ${deleted} deleted, ${failures} failures.`);
        }
    };
}

export const handlePurge = createPurgeHandler();
