import { Message, Guild } from 'discord.js';

import { config } from './Config.js';
import {
    SummarizeResponse,
    grokSummarize,
    grokSummarizeChunk,
    grokSynthesizeSummaries,
} from './Grok.js';
import { getUsername } from './Utilities.js';

export interface CachedMessage {
    content: string;
    author: string;
    createdTimestamp: number;
    id: string;
    reply?: string;
}

export const SUMMARY_WINDOW_MS = 12 * 60 * 60 * 1000;
export const SUMMARY_OUTPUT_MAX_LENGTH = 1900;

const MAX_SUMMARIZE_MESSAGE_COUNT = 5000;
const SUMMARY_FETCH_BATCH_SIZE = 100;
const SUMMARY_CHUNK_MAX_INPUT_LENGTH = 120000;
const SUMMARY_CHUNK_CONCURRENCY = 4;

const EXCLUDED_SUMMARY_AUTHOR_ID = '446154284514541579';

const cachedMessages = new Map<string, CachedMessage[]>();

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
        createdTimestamp: msg.createdTimestamp,
        id: msg.id,
        reply: msg.reference?.messageId || undefined,
    };
}

export async function fetchRecentMessagesForSummarization(
    msg: Message,
    windowStartTimestamp: number,
): Promise<CachedMessage[]> {
    const fetchedMessages: Message[] = [];
    let inspectedMessageCount = 0;
    let before = msg.id;

    while (inspectedMessageCount < MAX_SUMMARIZE_MESSAGE_COUNT) {
        const limit = Math.min(
            SUMMARY_FETCH_BATCH_SIZE,
            MAX_SUMMARIZE_MESSAGE_COUNT - inspectedMessageCount,
        );
        const batch = await msg.channel.messages.fetch({
            before,
            cache: false,
            limit,
        });

        if (batch.size === 0) {
            break;
        }

        const batchMessages = [...batch.values()];
        inspectedMessageCount += batchMessages.length;
        fetchedMessages.push(...batchMessages.filter((storedMessage) =>
            storedMessage.createdTimestamp >= windowStartTimestamp
        ));

        const oldestMessage = batchMessages.reduce((oldest, candidate) =>
            candidate.createdTimestamp < oldest.createdTimestamp ? candidate : oldest
        );
        before = oldestMessage.id;

        if (oldestMessage.createdTimestamp < windowStartTimestamp || batch.size < limit) {
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

export function chunkSummaryInput(
    messageLines: string[],
    maxLength: number = SUMMARY_CHUNK_MAX_INPUT_LENGTH,
): string[] {
    const chunks: string[] = [];
    let currentChunk = '';

    for (const line of messageLines) {
        if (currentChunk && currentChunk.length + line.length > maxLength) {
            chunks.push(currentChunk);
            currentChunk = '';
        }

        currentChunk += line;
    }

    if (currentChunk) {
        chunks.push(currentChunk);
    }

    return chunks;
}

export function fitSummaryInDiscordMessage(summary: string): string {
    if (summary.length <= SUMMARY_OUTPUT_MAX_LENGTH) {
        return summary;
    }

    const shortened = summary.slice(0, SUMMARY_OUTPUT_MAX_LENGTH - 1);
    const sentenceBoundary = Math.max(
        shortened.lastIndexOf('. '),
        shortened.lastIndexOf('! '),
        shortened.lastIndexOf('? '),
        shortened.lastIndexOf('\n'),
    );
    const wordBoundary = shortened.lastIndexOf(' ');
    const boundary = sentenceBoundary >= SUMMARY_OUTPUT_MAX_LENGTH * 0.75
        ? sentenceBoundary + 1
        : wordBoundary > 0 ? wordBoundary : shortened.length;

    return `${shortened.slice(0, Math.max(boundary, 0)).trimEnd()}…`;
}

async function summarizeChunks(chunks: string[]): Promise<SummarizeResponse[]> {
    const responses = new Array<SummarizeResponse>(chunks.length);
    let nextChunkIndex = 0;

    async function worker(): Promise<void> {
        while (nextChunkIndex < chunks.length) {
            const chunkIndex = nextChunkIndex;
            nextChunkIndex += 1;
            responses[chunkIndex] = await grokSummarizeChunk(
                chunks[chunkIndex],
                chunkIndex + 1,
                chunks.length,
            );
        }
    }

    await Promise.all(
        Array.from(
            { length: Math.min(SUMMARY_CHUNK_CONCURRENCY, chunks.length) },
            () => worker(),
        ),
    );

    return responses;
}

export async function summarizeMessages(
    msg: Message,
    channel: string,
    guild: Guild | null,
    authorId: string) {

    const windowStartTimestamp = msg.createdTimestamp - SUMMARY_WINDOW_MS;
    let previousMessages: CachedMessage[];

    try {
        previousMessages = await fetchRecentMessagesForSummarization(msg, windowStartTimestamp);
        cachedMessages.set(channel, previousMessages);
    } catch (err) {
        console.error(`Failed to fetch message history for summary in ${channel}:`, err);
        previousMessages = (cachedMessages.get(channel) || []).filter((storedMessage) =>
            storedMessage.createdTimestamp >= windowStartTimestamp
        );
    }

    if (previousMessages.length === 0) {
        return {
            error: `No recent messages could be loaded for this channel.`,
            result: undefined,
        };
    }

    let currentId = 1000;

    /* This maps a discord message id, e.g. 1146565736538587278 to a shortened id
     * like 1000, 1001, 3, etc. This saves tokens in the GPT prompt. */
    const idMap = new Map<string, number>();

    /* Save us making constant lookups to find usernames */
    const usernameMap = new Map<string, string>();

    const messageLines: string[] = [];

    for (const storedMessage of previousMessages) {
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

        const timestamp = new Date(storedMessage.createdTimestamp)
            .toISOString()
            .slice(5, 16)
            .replace('T', ' ');
        messageLines.push(`[${timestamp} UTC] ${id}${reply} ${username}: ${storedMessage.content}\n`);

        currentId++;
    }

    const requestingUser = await getUsername(authorId, guild);
    const chunks = chunkSummaryInput(messageLines);

    if (chunks.length === 1) {
        return grokSummarize(chunks[0], requestingUser);
    }

    const chunkResponses = await summarizeChunks(chunks);
    const failedChunk = chunkResponses.find(({ error, result }) => error || !result);

    if (failedChunk) {
        return {
            error: failedChunk.error || 'Unknown Error',
            result: undefined,
        };
    }

    return grokSynthesizeSummaries(
        chunkResponses.map(({ result }) => result!),
        requestingUser,
    );
}

export async function handleSummarize(msg: Message): Promise<void> {
    const statusMessage = await msg.reply(`Generating summary, please wait...`);

    const { error, result } = await summarizeMessages(
        msg,
        msg.channel.id,
        msg.guild,
        msg.author.id,
    );

    if (error || !result) {
        await statusMessage.edit(fitSummaryInDiscordMessage(
            `Error trying to summarize content: ${error || 'Unknown Error'}`,
        ));
        return;
    }

    await statusMessage.edit(fitSummaryInDiscordMessage(result));
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
