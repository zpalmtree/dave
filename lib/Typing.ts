import type { TextBasedChannel, TextChannel } from 'discord.js';

type TypingChannel = TextBasedChannel & {
    send: TextChannel['send'];
    sendTyping: TextChannel['sendTyping'];
};

function isTypingChannel(channel: TextBasedChannel): channel is TypingChannel {
    return 'send' in channel
        && typeof (channel as any).send === 'function'
        && 'sendTyping' in channel
        && typeof (channel as any).sendTyping === 'function';
}

export async function trySendTyping(channel: TextBasedChannel): Promise<void> {
    if (!isTypingChannel(channel)) return;

    try {
        await channel.sendTyping();
    } catch (error) {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.warn(`[Discord] Failed to send typing indicator: ${detail}`);
    }
}

export function withTyping<T>(
    channel: TextBasedChannel,
    fn: () => Promise<T>,
): Promise<T> {
    let keepAlive: NodeJS.Timeout | undefined;

    const start = async () => {
        if (!isTypingChannel(channel)) return;

        await trySendTyping(channel);
        keepAlive = setInterval(
            () => channel.sendTyping().catch(() => {}),
            8_000,
        );
    };

    return (async () => {
        await start();
        try {
            return await fn();
        } finally {
            if (keepAlive) clearInterval(keepAlive);
        }
    })();
}
