import { Message, Guild } from 'discord.js';

import { config } from './Config.js';
import { grokSummarize } from './Grok.js';
import { getUsername, splitMessage } from './Utilities.js';

export interface CachedMessage {
    content: string;
    author: string;
    id: string;
    reply?: string;
}

const MAX_SUMMARIZE_MESSAGE_COUNT = 1500;

const MAX_AVERAGE_MESSAGE_LENGTH = 60;

const SHORT_SUMMARY_MESSAGE_COUNT = 50;
const SHORT_SUMMARY_MAX_INPUT_LENGTH = MAX_AVERAGE_MESSAGE_LENGTH * SHORT_SUMMARY_MESSAGE_COUNT;

const LONG_SUMMARY_MESSAGE_COUNT = 1500;

/* 16k context length */
const LONG_SUMMARY_MAX_INPUT_LENGTH = Math.floor(16385 * 0.75);

const EXCLUDED_SUMMARY_AUTHOR_ID = '446154284514541579';

const cachedMessages = new Map<string, CachedMessage[]>();
const fetchedHistoryLimits = new Map<string, number>();

function toCachedMessage(msg: Message): CachedMessage | undefined {
    let content = msg.content.trim();

    if (msg.attachments.size) {
        content += '\n' + [...msg.attachments.values()].map((a) => a.url).join(' ');
    }

    if (content === '') {
        return undefined;
    }

    return {
        content,
        author: msg.author.id,
        id: msg.id,
        reply: msg.reference?.messageId || undefined,
    };
}

export async function fetchRecentMessagesForSummarization(
    msg: Message,
    messageCount: number,
): Promise<CachedMessage[]> {
    const fetchedMessages: Message[] = [];
    let before = msg.id;

    while (fetchedMessages.length < messageCount) {
        const limit = Math.min(100, messageCount - fetchedMessages.length);
        const batch = await msg.channel.messages.fetch({
            before,
            cache: false,
            limit,
        });

        if (batch.size === 0) {
            break;
        }

        const batchMessages = [...batch.values()];
        fetchedMessages.push(...batchMessages);

        const oldestMessage = batchMessages.reduce((oldest, candidate) =>
            candidate.createdTimestamp < oldest.createdTimestamp ? candidate : oldest
        );
        before = oldestMessage.id;

        if (batch.size < limit) {
            break;
        }
    }

    return fetchedMessages
        .filter((storedMessage) =>
            storedMessage.author.id !== msg.client.user?.id
            && storedMessage.author.id !== EXCLUDED_SUMMARY_AUTHOR_ID
            && !storedMessage.content.startsWith(config.prefix)
        )
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map(toCachedMessage)
        .filter((storedMessage): storedMessage is CachedMessage => storedMessage !== undefined);
}

export async function summarizeMessages(
    msg: Message,
    channel: string,
    guild: Guild | null,
    authorId: string,
    messageCount: number,
    maxLength: number) {

    let previousMessages = cachedMessages.get(channel) || [];

    if ((fetchedHistoryLimits.get(channel) || 0) < messageCount) {
        try {
            previousMessages = await fetchRecentMessagesForSummarization(msg, messageCount);
            cachedMessages.set(channel, previousMessages);
            fetchedHistoryLimits.set(channel, messageCount);
        } catch (err) {
            console.error(`Failed to fetch message history for summary in ${channel}:`, err);
        }
    }

    if (previousMessages.length === 0) {
        return {
            error: `No recent messages could be loaded for this channel.`,
            result: undefined,
        };
    }

    /* Get the messageCount newest messages */
    const newestMessages = previousMessages.slice(Math.max(previousMessages.length - messageCount, 0));

    let currentId = 1000;

    /* This maps a discord message id, e.g. 1146565736538587278 to a shortened id
     * like 1000, 1001, 3, etc. This saves tokens in the GPT prompt. */
    const idMap = new Map<string, number>();

    /* Save us making constant lookups to find usernames */
    const usernameMap = new Map<string, string>();

    let contentToSummarize = '';

    for (const storedMessage of newestMessages) {
        idMap.set(storedMessage.id, currentId);

        let username;

        if (usernameMap.has(storedMessage.author)) {
            username = usernameMap.get(storedMessage.author);
        } else {
            username = await getUsername(storedMessage.author, guild);
            usernameMap.set(storedMessage.author, username);
        }

        const id = `[ID#${currentId}]`;

        let reply = '';

        if (storedMessage.reply) {
            let replyId = idMap.get(storedMessage.reply);

            /* May be a message before bot started listening */
            if (!replyId) {
                /* Use a random ID before the first message ID (1000) */
                replyId = Number(storedMessage.reply.slice(-3));
            }

            reply = ` [Reply to ID#${replyId}]`;
        }

        contentToSummarize += `${id}${reply} ${username}: ${storedMessage.content}\n`;

        currentId++;
    }

    if (contentToSummarize.length > maxLength) {
        const startIndex = contentToSummarize.length - maxLength;
        contentToSummarize = contentToSummarize.slice(startIndex);
    }

    const requestingUser = await getUsername(authorId, guild);

    return grokSummarize(contentToSummarize, requestingUser);
}

export async function handleSummarize(msg: Message): Promise<void> {
    await msg.reply(`Generating summary, please wait, this will take some time...`);

    const { error, result } = await summarizeMessages(
        msg,
        msg.channel.id,
        msg.guild,
        msg.author.id,
        SHORT_SUMMARY_MESSAGE_COUNT,
        SHORT_SUMMARY_MAX_INPUT_LENGTH,
    );

    if (error || !result) {
        await msg.reply(`Error trying to summarize content: ${error || 'Unknown Error'}`);
        return;
    }

    const parts = splitMessage(result);
    for (const part of parts) {
        await msg.reply(part);
    }
}

export async function handleLongSummarize(msg: Message): Promise<void> {
    await msg.reply(`Generating summary, please wait, this will take some time...`);

    const { error, result } = await summarizeMessages(
        msg,
        msg.channel.id,
        msg.guild,
        msg.author.id,
        LONG_SUMMARY_MESSAGE_COUNT,
        LONG_SUMMARY_MAX_INPUT_LENGTH,
    );

    if (error || !result) {
        await msg.reply(`Error trying to summarize content: ${error || 'Unknown Error'}`);
        return;
    }

    const parts = splitMessage(result);
    for (const part of parts) {
        await msg.reply(part);
    }
}

export async function cacheMessageForSummarization(msg: Message): Promise<void> {
    const channel = msg.channel.id;

    const existingMessages = cachedMessages.get(channel) || [];
    const storedMessage = toCachedMessage(msg);

    if (!storedMessage) {
        return;
    }

    existingMessages.push(storedMessage);

    while (existingMessages.length > MAX_SUMMARIZE_MESSAGE_COUNT) {
        existingMessages.shift();
    }

    cachedMessages.set(channel, existingMessages);
}
