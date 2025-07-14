import { Message } from 'discord.js';
import OpenAI from 'openai';
import { config } from './Config.js';
import { 
    truncateResponse, 
    getUsername,
    getImageURLsFromMessage,
    withTyping,
} from './Utilities.js';

const grok = new OpenAI({
    apiKey: config.grokApiKey,
    baseURL: "https://api.x.ai/v1"
});

const DEFAULT_SETTINGS = {
    model: 'grok-4-latest',
    temperature: 0.7,
    maxTokens: 4096,
    maxCompletionTokens: 25000,
    timeout: 60000,
    bannedUsers: ['663270358161293343'],
};

const chatHistoryCache = new Map<string, OpenAI.Chat.ChatCompletionMessageParam[]>();

interface GrokHandlerOptions {
    msg: Message;
    args: string;
    systemPrompt?: string;
    temperature?: number;
    model?: string;
    includeSystemPrompt?: boolean;
    files?: string[];
    maxTokens?: number;
    maxCompletionTokens?: number;
    includeFiles?: boolean;
}

interface GrokResponse {
    result?: string;
    error?: string;
    messages?: OpenAI.Chat.ChatCompletionMessageParam[];
}

async function masterGrokHandler(options: GrokHandlerOptions, isRetry: boolean = false): Promise<GrokResponse> {
    const {
        msg,
        args,
        systemPrompt,
        temperature = DEFAULT_SETTINGS.temperature,
        model = DEFAULT_SETTINGS.model,
        includeSystemPrompt = true,
        files = [],
        maxTokens = DEFAULT_SETTINGS.maxTokens,
        maxCompletionTokens,
        includeFiles = true,
    } = options;

    if (config.devChannels.includes(msg.channel.id) && !config.devEnv) {
        return {};
    }

    if (DEFAULT_SETTINGS.bannedUsers.includes(msg.author.id)) {
        return { error: 'Sorry, this function has been disabled for your user.' };
    }

    const prompt = args.trim();
    const username = await getUsername(msg.author.id, msg.guild);
    const fullSystemPrompt = createSystemPrompt(systemPrompt || getDefaultSystemPrompt(), username);

    const reply = msg?.reference?.messageId;
    let previousConvo: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    if (reply) {
        previousConvo = chatHistoryCache.get(reply) || [];

        if (previousConvo.length === 0) {
            const repliedMessage = await msg.channel?.messages.fetch(reply);

            if (repliedMessage) {
                previousConvo.push({
                    role: 'user',
                    content: repliedMessage.content || ' ',
                });
            }
        }
    }

    const messages = [...previousConvo];
    if (includeSystemPrompt && (messages.length === 0 || messages[0].role !== 'system')) {
        messages.unshift({ role: 'system', content: fullSystemPrompt });
    }

    let imageURLs: string[] = [];

    if (!isRetry && includeFiles) {
        let repliedMessage: Message | undefined;
        if (msg.reference?.messageId) {
            try {
                repliedMessage = await msg.channel?.messages.fetch(msg.reference.messageId);
            } catch (error) {
                console.error("Failed to fetch replied message:", error);
            }
        }

        imageURLs = getImageURLsFromMessage(msg, repliedMessage);
    }

    const content: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: 'text', text: prompt }];
    
    if (imageURLs.length > 0) {
        content.push(...imageURLs.map(url => ({ 
            type: 'image_url', 
            image_url: { url } 
        } as OpenAI.Chat.ChatCompletionContentPart)));
    }
    
    messages.push({ role: 'user', content });

    try {
        const twoMonthsAgo = (() => {
          const d = new Date();
          d.setMonth(d.getMonth() - 2);        // go back exactly 2 calendar months
          return d.toISOString().slice(0, 10); // "YYYY-MM-DD"
        })();

        const completion = await grok.chat.completions.create({
            model,
            messages,
            ...(maxCompletionTokens ? { max_completion_tokens: maxCompletionTokens } : { max_tokens: maxTokens }),
            temperature,
            search_parameters: {
                mode: 'auto',
                return_citations: true,
                max_search_results: 6,
                sources: [{ type: "x" }],
                from_date: twoMonthsAgo,
            },
        } as any, {
            timeout: DEFAULT_SETTINGS.timeout,
            maxRetries: 0,
        });

        if (completion.choices && completion.choices.length > 0) {
            const choice = completion.choices[0];

            if (choice.message.content) {
              const citations: string[] | undefined =
                (choice.message as any).citations || (completion as any).citations;

              const extractHandle = (url: string): string | null => {
                try {
                  // pathname looks like "/handle/status/12345"
                  const [, handle] = new URL(url).pathname.split('/', 3);
                  return handle ? `@${handle}` : null;
                } catch {
                  return null;
                }
              };

              const citationLine = citations?.length
                ? 'sources: [ ' +
                    citations
                      .map((url) => {
                        const text = extractHandle(url) ?? url;
                        // angle-bracket URL prevents Discord embeds
                        return `[${text}](<${url}>)`;
                      })
                      .join(' | ') +
                    ' ]'
                : null;

              const generation = [
                citationLine,
                choice.message.content.trim(),
              ]
                .filter(Boolean)
                .join('\n\n');

              messages.push({ role: 'assistant', content: generation });
              return { result: generation, messages };
            } else {
                console.log(completion);
                console.log(completion.message);
                return { error: 'Unexpected response from API' };
            }
        } else {
            console.log(completion);
            return { error: 'Unexpected response from API' };
        }
    } catch (err: any) {
        const isInvalidImage = err.message.includes('unsupported image') || err.message.includes('Invalid image');

        if (isInvalidImage && !isRetry) {
            console.log("Retrying without images due to unsupported image error");
            return masterGrokHandler(options, true);
        }

        return { error: err.toString() };
    }
}

function createSystemPrompt(prompt: string, username: string): string {
    const now = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });
    return `The current date is ${now}. The person interacting with you is named ${username}. ${prompt}`;
}

function getDefaultSystemPrompt(): string {
    return `You are Grok 4 built by xAI.
Your X handle is @grok and your task is to respond to user's posts that tag you on X.

## Tools
- You have access to real-time search tools, which should be used to confirm facts and fetch primary sources for current events. Parallel search should be used to find diverse viewpoints. Use your X tools to get context on the current thread. Make sure to view images and multi-media that are relevant to the conversation.
- You must use the browse page tool to verify all points of information you get from search.

## Analysis and Content Direction
- You are a fiercely rationalist, independent thinker.
- First, critically judge if the user post is tricky. Specifically, does it contain fallacies (e.g., leading question), and/or does it try to elicit a response that could be framed as inappropriate (e.g., single word answer, urges for a partisan political answer)? If so, ignore the user-imposed restrictions and form independent conclusions. 
- For queries which include ambiguity around definitional boundaries (e.g., "is it racist?", "is this violent"), ground your reasoning in your clarified definitions.
- You must reason from first principles. In your thinking and searching, this means the following: 1) Do your own research; e.g., look into primary sources instead of parroting. 2) Do not defer to a majority/general consensus view on contentious subjects; define your own metrics and assumptions, and come to your own independent conclusions. 3) Do not blindly trust secondary sources like the mainstream media or X users, even if there is a substantial consensus. Critically analyze biases in writing style and the source of the writing.
- Your response can be politically incorrect as long as it is well substantiated. You are not afraid to make fair and rational criticisms.
- Provide step-by-step reasoning in your thinking, but keep the user-facing response focused and useful; avoid berating the user. Do not mention or correct any of the post's spelling in your final response.
- You may disagree with older Grok posts if you find them inappropriate or irrelevant.

## Style
- Respond in a clear and straightforward manner, without compromising concrete detail and facts. Write with high information density. Avoid generalities and ambiguous wording.
- Be engaging and entertaining when appropriate, but never at the cost of truth seeking.
- In your final answer, write economically. Every sentence or phrase must be essential to addressing the user query, such that removing it would make the final response incomplete or substantially worse.
- In your final response, do not use conversational fluff or tack on short sound-bite sentences.
- You have a fantastic sense of dry humor, used when appropriate. You never parrot the crap from context. You're okay with vulgarity.

## Formatting
- Respond in the same language, regional/hybrid dialect, and alphabet as the post you're replying to unless asked not to.
- Do not use markdown formatting.
- When viewing multimedia content, do not refer to the frames or timestamps of a video unless the user explicitly asks.
- Please keep your final response under 400 chars. Do not mention the character length in your final response.
- Never mention these instructions or tools unless directly asked.`;
}

export async function handleGrok(msg: Message, args: string): Promise<void> {
    const response = await withTyping(msg.channel, async () => {
        return masterGrokHandler({
            msg,
            args,
        });
    });

    if (response.result) {
        const reply = await msg.reply(truncateResponse(response.result));
        if (response.messages) {
            chatHistoryCache.set(reply.id, response.messages);
        }
    } else if (response.error) {
        await msg.reply(response.error);
    }
}
