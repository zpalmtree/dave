import { Message } from 'discord.js';

import { aiSummarize } from './OpenAI.js';
import { getUsername } from './Utilities.js';

export interface CachedMessage {
    content: string;
    author: string;
}

const MAX_SUMMARIZE_MESSAGE_COUNT = 50;
const MAX_SUMMARIZE_INPUT_LENGTH = 3000;

const cachedMessages = new Map<string, CachedMessage[]>;

export async function handleSummarize(msg: Message): Promise<void> {
    const channel = msg.channel.id;

    let contentToSummarize = '';

    const previousMessages = cachedMessages.get(channel) || [];

    if (previousMessages.length === 0) {
        await msg.reply(`No messages cached for this channel. Bot may have recently restarted.`);
        return;
    }

    for (const storedMessage of previousMessages) {
        const username = await getUsername(storedMessage.author, msg.guild);
        contentToSummarize += `${username}: ${storedMessage.content}\n`;
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

    existingMessages.push({
        content: msg.content.trim(),
        author: msg.author.id,
    });

    console.log(`Existing messages: ${JSON.stringify(existingMessages, null, 4)}`);

    cachedMessages.set(channel, existingMessages);
}
