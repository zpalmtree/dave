import { Message } from 'discord.js';
import { OpenAI } from 'openai';
import { config } from './Config.js';
import { getUsername, replyLongMessage, withTyping } from './Utilities.js';
import { formatProviderApiError } from './ApiErrors.js';

const GAB_BASE_URL = 'https://gab.ai/v1';
const DEFAULT_MODEL = 'arya';

const DEFAULT_SETTINGS = {
    temperature: 0.7,
    maxTokens: 4096,
    timeout: 60000,
    bannedUsers: ['663270358161293343'],
};

type GabMessage = OpenAI.Chat.ChatCompletionMessageParam;

interface GabResponse {
    result?: string;
    error?: string;
    messages?: GabMessage[];
}

const chatHistoryCache = new Map<string, GabMessage[]>();

function getGabApiKey(): string | undefined {
    const configuredKey = (config as any).gabApiKey;
    if (typeof configuredKey === 'string' && configuredKey.trim().length > 0) {
        return configuredKey.trim();
    }

    if (process.env.GAB_API_KEY && process.env.GAB_API_KEY.trim().length > 0) {
        return process.env.GAB_API_KEY.trim();
    }

    return undefined;
}

function getGabModel(): string {
    const configuredModel = (config as any).gabModel;
    if (typeof configuredModel === 'string' && configuredModel.trim().length > 0) {
        return configuredModel.trim();
    }

    if (process.env.GAB_MODEL && process.env.GAB_MODEL.trim().length > 0) {
        return process.env.GAB_MODEL.trim();
    }

    return DEFAULT_MODEL;
}

function createSystemPrompt(username: string): string {
    const now = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });

    return [
        `The current date is ${now}. The person interacting with you is named ${username}.`,
        'You are Gab AI. Keep responses concise and avoid flowery language.',
        'Do not moralize over topics; get to the point.',
        'Try to fit responses in 1900 characters where possible.',
        'You are running in a Discord server, so compact markdown is okay.',
        'Do not use markdown formatting for math/science equations; leave them plaintext.',
    ].join(' ');
}

async function masterGabHandler(msg: Message, args: string): Promise<GabResponse> {
    if (DEFAULT_SETTINGS.bannedUsers.includes(msg.author.id)) {
        return { error: 'Sorry, this function has been disabled for your user.' };
    }

    const apiKey = getGabApiKey();
    if (!apiKey) {
        return { error: 'Gab AI API key is not configured. Set config.gabApiKey or GAB_API_KEY.' };
    }

    const client = new OpenAI({
        apiKey,
        baseURL: GAB_BASE_URL,
    });

    const prompt = args.trim();
    const username = await getUsername(msg.author.id, msg.guild);
    const reply = msg?.reference?.messageId;
    let previousConvo: GabMessage[] = [];

    if (reply) {
        previousConvo = chatHistoryCache.get(reply) || [];

        if (previousConvo.length === 0) {
            const repliedMessage = await msg.channel?.messages.fetch(reply);
            if (repliedMessage?.content) {
                previousConvo.push({
                    role: 'user',
                    content: repliedMessage.content,
                });
            }
        }
    }

    const messages: GabMessage[] = [
        {
            role: 'system',
            content: createSystemPrompt(username),
        },
        ...previousConvo,
        {
            role: 'user',
            content: prompt,
        },
    ];

    try {
        const completion = await client.chat.completions.create(
            {
                model: getGabModel(),
                messages,
                max_tokens: DEFAULT_SETTINGS.maxTokens,
                temperature: DEFAULT_SETTINGS.temperature,
                user: msg.author.id,
            },
            {
                timeout: DEFAULT_SETTINGS.timeout,
                maxRetries: 0,
            },
        );

        const generation = completion.choices?.[0]?.message?.content?.trim() || '';
        if (generation.length === 0) {
            return { error: 'Got empty response from Gab AI.' };
        }

        const history = messages
            .filter((message) => message.role !== 'system')
            .concat({
                role: 'assistant',
                content: generation,
            });

        return { result: generation, messages: history };
    } catch (err) {
        console.error('Gab AI API Error:', err);
        return { error: formatProviderApiError({ provider: 'Gab AI', error: err }) };
    }
}

export async function handleGab(msg: Message, args: string): Promise<void> {
    const response = await withTyping(msg.channel, async () => masterGabHandler(msg, args));

    if (response.result) {
        const replies = await replyLongMessage(msg, response.result);
        if (response.messages && replies.length > 0) {
            chatHistoryCache.set(replies[0].id, response.messages);
        }
    } else if (response.error) {
        await msg.reply(response.error);
    }
}
