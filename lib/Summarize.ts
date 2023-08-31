import { Message } from 'discord.js';

import { aiSummarize } from './OpenAI.js';
import { getUsername } from './Utilities.js';

export interface CachedMessage {
    content: string;
    author: string;
    id: string;
    reply?: string;
}

const MAX_SUMMARIZE_MESSAGE_COUNT = 50;
const MAX_SUMMARIZE_INPUT_LENGTH = 3000;

const cachedMessages = new Map<string, CachedMessage[]>;

export async function handleSummarize(msg: Message): Promise<void> {
    /* This maps a discord message id, e.g. 1146565736538587278 to a shortened id
     * like 1000, 1001, 3, etc. This saves tokens in the GPT prompt. */
    const idMap = new Map<string, number>();

    /* Save us making constant lookups to find usernames */
    const usernameMap = new Map<string, string>();

    const channel = msg.channel.id;

    let contentToSummarize = '';

    const previousMessages = cachedMessages.get(channel) || [];

    if (previousMessages.length === 0) {
        await msg.reply(`No messages cached for this channel. Bot may have recently restarted.`);
        return;
    }

    let currentId = 1000;

    for (const storedMessage of previousMessages) {
        idMap.set(storedMessage.id, currentId);

        let username;

        if (usernameMap.has(storedMessage.author)) {
            username = usernameMap.get(storedMessage.author);
        } else {
            username = await getUsername(storedMessage.author, msg.guild);
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

            reply = `[Reply to ID#${replyId}]`;
        }

        contentToSummarize += `${id} ${reply} ${username}: ${storedMessage.content}\n`;

        currentId++;
    }

    console.log(`Input length: ${contentToSummarize.length}`);

    if (contentToSummarize.length > MAX_SUMMARIZE_INPUT_LENGTH) {
        const startIndex = contentToSummarize.length - MAX_SUMMARIZE_INPUT_LENGTH;
        contentToSummarize = contentToSummarize.slice(startIndex);
    }

    console.log(`Summarizing: ${contentToSummarize}`);

    const { result, error } = await aiSummarize(contentToSummarize, msg.author.id);

    if (error || !result) {
        await msg.reply(`Error trying to summarize content: ${error}`);
        return;
    }

    await msg.reply(result);
}

export async function cacheMessageForSummarization(msg: Message): Promise<void> {
    const channel = msg.channel.id;

    const existingMessages = cachedMessages.get(channel) || [];

    if (existingMessages.length > MAX_SUMMARIZE_MESSAGE_COUNT) {
        existingMessages.shift();
    }

    let content = msg.content.trim();

    if (msg.attachments.size) {
        content += '\n' + [...msg.attachments.values()].map((a) => a.url).join(' ');
    }

    if (content === '') {
        return;
    }

    existingMessages.push({
        content,
        author: msg.author.id,
        id: msg.id,
        reply: msg?.reference?.messageId || undefined,
    });

    cachedMessages.set(channel, existingMessages);
}
