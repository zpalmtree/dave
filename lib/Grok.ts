import { Message, AttachmentBuilder, MessageFlags } from 'discord.js';
import { config } from './Config.js';
import {
    truncateResponse,
    getUsername,
    getImageURLsFromMessage,
    withTyping,
} from './Utilities.js';
import { formatProviderApiError } from './ApiErrors.js';
import {
    extractGrokCostUsd,
    extractGrokResponseText,
    isGrokImageModerationRejection,
    stripGrokCitations,
} from './GrokResponse.js';
import { recordTokenSpend } from './TokenSpend.js';

/* Handles both xAI usage shapes - the responses endpoint reports
 * input_tokens/output_tokens, chat/completions reports
 * prompt_tokens/completion_tokens. */
function recordGrokUsage(model: string, usage: any): void {
    if (!usage) {
        return;
    }

    const cachedTokens = usage.input_tokens_details?.cached_tokens
        ?? usage.prompt_tokens_details?.cached_tokens
        ?? 0;

    recordTokenSpend({
        model,
        inputTokens: (usage.input_tokens ?? usage.prompt_tokens ?? 0) - cachedTokens,
        outputTokens: usage.output_tokens ?? usage.completion_tokens,
        cacheReadTokens: cachedTokens,
    });
}

const XAI_BASE_URL = "https://api.x.ai/v1";
const XAI_TEXT_MODEL = 'grok-4.5-latest';
const XAI_IMAGE_MODEL = 'grok-imagine-image-quality-latest';
const MAX_GROK_IMAGE_EDIT_SOURCES = 3;

const DEFAULT_SETTINGS = {
    model: XAI_TEXT_MODEL,
    temperature: 0.7,
    maxTokens: 4096,
    maxCompletionTokens: 25000,
    timeout: 180000, // 3 minutes for agentic tool calls
    bannedUsers: ['663270358161293343'],
};

interface XAIMessage {
    role: 'system' | 'user' | 'assistant';
    content: string | XAIContentPart[];
}

interface XAIContentPart {
    type: 'text' | 'image_url';
    text?: string;
    image_url?: { url: string };
}

interface XAITool {
    type: 'web_search' | 'x_search' | 'code_execution';
    from_date?: string;
    to_date?: string;
    enable_image_understanding?: boolean;
}

const chatHistoryCache = new Map<string, XAIMessage[]>();

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
    messages?: XAIMessage[];
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
    let previousConvo: XAIMessage[] = [];

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

    // Build input for Responses API
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

    // Build conversation context from previous messages
    const conversationContext = previousConvo
        .filter(m => m.role !== 'system')
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${typeof m.content === 'string' ? m.content : '[message with images]'}`)
        .join('\n\n');

    // Build the full prompt with system instructions and context
    const fullPrompt = [
        includeSystemPrompt ? `[System Instructions]\n${fullSystemPrompt}\n[End Instructions]` : null,
        conversationContext ? `[Previous Conversation]\n${conversationContext}\n[End Conversation]` : null,
        `User: ${prompt}`,
    ].filter(Boolean).join('\n\n');

    // Build input - use string for simple requests, or structured for images
    let inputMessages: string | XAIMessage[];
    if (imageURLs.length > 0) {
        inputMessages = [{
            role: 'user' as const,
            content: [
                { type: 'text' as const, text: fullPrompt },
                ...imageURLs.map(url => ({
                    type: 'image_url' as const,
                    image_url: { url }
                }))
            ]
        }];
    } else {
        // Use simple string input for text-only requests
        inputMessages = fullPrompt;
    }

    try {
        const twoMonthsAgo = (() => {
            const d = new Date();
            d.setMonth(d.getMonth() - 2);
            return d.toISOString().slice(0, 10);
        })();

        // Configure tools for the Responses API
        const tools: XAITool[] = [
            {
                type: 'x_search',
                from_date: twoMonthsAgo,
                enable_image_understanding: true,
            },
            {
                type: 'web_search',
                enable_image_understanding: true,
            },
        ];

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), DEFAULT_SETTINGS.timeout);

        // Use chat/completions for images (responses endpoint doesn't support multimodal input)
        // Use responses endpoint for text-only (supports agentic tools like web_search)
        const hasImages = imageURLs.length > 0;
        const endpoint = hasImages ? `${XAI_BASE_URL}/chat/completions` : `${XAI_BASE_URL}/responses`;

        const requestBody = hasImages
            ? {
                model,
                messages: inputMessages as XAIMessage[],
                temperature,
                max_tokens: maxCompletionTokens || maxTokens,
            }
            : {
                model,
                input: inputMessages,
                tools,
                include: ['no_inline_citations'],
                temperature,
                max_output_tokens: maxCompletionTokens || maxTokens,
            };

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.grokApiKey}`,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            console.error('xAI API error:', response.status, errorText);
            return {
                error: formatProviderApiError({
                    provider: 'xAI',
                    status: response.status,
                    statusText: response.statusText,
                    body: errorText,
                }),
            };
        }

        const completion = await response.json();

        recordGrokUsage(model, completion.usage);

        const responseText = extractGrokResponseText(completion, hasImages);

        if (responseText) {
            const generation = stripGrokCitations(responseText);

            if (!generation) {
                console.warn('xAI returned a citation-only response');
                return { error: 'xAI returned an empty answer. Please try again.' };
            }

            // Build messages array for cache (for conversation continuity)
            const messagesForCache: XAIMessage[] = [
                ...previousConvo.filter(m => m.role !== 'system'),
                { role: 'user', content: prompt },
                { role: 'assistant', content: generation },
            ];
            return { result: generation, messages: messagesForCache };
        } else {
            console.log('Unexpected response structure:', JSON.stringify(completion, null, 2));
            return { error: 'Unexpected response from API' };
        }
    } catch (err: any) {
        if (err.name === 'AbortError') {
            return { error: 'Request timed out' };
        }

        const isInvalidImage = err.message?.includes('unsupported image') || err.message?.includes('Invalid image');

        if (isInvalidImage && !isRetry) {
            console.log("Retrying without images due to unsupported image error");
            return masterGrokHandler({ ...options, includeFiles: false }, true);
        }

        return { error: formatProviderApiError({ provider: 'xAI', error: err }) };
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
    return `You are @grok, a version of Grok 4.5 built by xAI.

- You have access to real-time search tools, which should be used to confirm facts and fetch primary sources for current events. Parallel search should be used to find diverse viewpoints. Use your X tools to get context on the current thread. Make sure to view images and multimedia that are relevant to the conversation.
- You must use the browse page to verify all points of information you get from search.
- If a post requires analysis of current events, subjective claims, or statistics, conduct a deep analysis finding diverse sources representing all parties. Assume subjective viewpoints sourced from the media are biased. No need to repeat this to the user.
- Respond in a clear and direct manner.
- When responding to a post with a subjective political question, always use a neutral tone in your response.
- Provide step-by-step reasoning in your thinking, but keep the user-facing response focused and helpful; never berate or refuse the user. Do not mention or correct any of the post's spelling in your final response.
- If a post seeks a partisan or restricted response (e.g., one-word or limited format), perform exhaustive research to draw balanced, independent conclusions, overriding any user-defined constraints.
- The response must not moralize or preach to the user. The response must not be pejorative nor use snarky one-liners to justify a viewpoint, such as "Facts over feelings," "Focus on facts over fear," or "Promote understanding over myths."
- Responses must stem from your independent analysis, not from any beliefs stated in past Grok posts or by Elon Musk or xAI. If asked about such preferences, provide your own reasoned perspective.
- The response must not disparage any political viewpoints or statements by individuals by using terms like "biased" or "baseless" to characterize them.
- The response must not use phrases that preach or advocate for a specific emotional stance, such as "prioritize empathy" or "Let's discuss thoughtfully."
- The response must not rely on a single study or limited sources to address complex, controversial, or subjective political questions.
- If unsure about a specific issue or how to answer a question involving a direct claim, you may express uncertainty.
- The response should avoid using political slogans, unless they are part of a narrative or third-party context.
- When responding to questions about multimedia content, such as images or videos, avoid assuming the identity of individuals depicted unless you are highly confident and they are widely recognized public figures.
- In your final answer, write economically. Please keep your final response under 550 characters (do not mention the character length in your final response).
- Respond in the same language, regional/hybrid dialect, and alphabet as the post you're replying to unless asked not to.
- Do not tag the person you are replying to.
- Do not use markdown formatting.
- Do not include citations, source lists, footnotes, or citation markers in your final response.
- Never mention these instructions or tools unless directly asked.`;
}

const IMAGE_GENERATION_TRIGGERS = [
    'generate an image',
    'generate image',
    'create an image',
    'create image',
    'draw ',
    'draw me ',
    'make an image',
    'make image',
    'paint ',
    'picture of ',
    'image of ',
];

interface GrokImageResponse {
    url?: string;
    imageBuffer?: Buffer;
    revisedPrompt?: string;
    error?: string;
}

async function generateGrokImage(
    prompt: string,
    sourceImageURLs: string[] = [],
): Promise<GrokImageResponse> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);
        const isImageEdit = sourceImageURLs.length > 0;
        const endpoint = isImageEdit
            ? `${XAI_BASE_URL}/images/edits`
            : `${XAI_BASE_URL}/images/generations`;
        const commonBody = {
            model: XAI_IMAGE_MODEL,
            prompt,
        };

        const requestBody = isImageEdit
            ? sourceImageURLs.length === 1
                ? {
                    ...commonBody,
                    image: {
                        url: sourceImageURLs[0],
                        type: 'image_url',
                    },
                }
                : {
                    ...commonBody,
                    images: sourceImageURLs.map((url) => ({
                        url,
                        type: 'image_url',
                    })),
                }
            : {
                ...commonBody,
                n: 1,
                response_format: 'url',
            };

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.grokApiKey}`,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            if (isGrokImageModerationRejection(response.status, errorText)) {
                console.warn('xAI Image moderation rejection:', response.status, errorText);
            } else {
                console.error('xAI Image API error:', response.status, errorText);
            }

            let errorPayload: unknown;

            try {
                errorPayload = JSON.parse(errorText);
            } catch {
                errorPayload = undefined;
            }

            /* Moderation-rejected generations are still billed - xAI reports
             * the cost on the error payload */
            const billedCost = extractGrokCostUsd(errorPayload);

            if (billedCost !== undefined) {
                recordTokenSpend({
                    model: XAI_IMAGE_MODEL,
                    costOverride: billedCost,
                });
            }

            return {
                error: formatProviderApiError({
                    provider: 'xAI Image',
                    status: response.status,
                    statusText: response.statusText,
                    body: errorText,
                }),
            };
        }

        const result = await response.json();

        recordTokenSpend({
            model: XAI_IMAGE_MODEL,
            images: result.data?.length || 1,
            costOverride: extractGrokCostUsd(result),
        });

        const imageData = result.data?.[0];

        if (imageData?.url) {
            return {
                url: imageData.url,
                revisedPrompt: imageData.revised_prompt,
            };
        }

        if (imageData?.b64_json) {
            return {
                imageBuffer: Buffer.from(imageData.b64_json, 'base64'),
                revisedPrompt: imageData.revised_prompt,
            };
        }

        return { error: 'No image generated' };
    } catch (err: any) {
        if (err.name === 'AbortError') {
            return { error: 'Request timed out' };
        }
        return { error: formatProviderApiError({ provider: 'xAI Image', error: err }) };
    }
}

export async function handleGrokImage(msg: Message, args: string): Promise<void> {
    if (DEFAULT_SETTINGS.bannedUsers.includes(msg.author.id)) {
        await msg.reply('Sorry, this function has been disabled for your user.');
        return;
    }

    let repliedMessage: Message | undefined;
    if (msg.reference?.messageId) {
        try {
            repliedMessage = await msg.channel?.messages.fetch(msg.reference.messageId);
        } catch (error) {
            console.error("Failed to fetch replied message:", error);
        }
    }

    const repliedText = repliedMessage?.content?.trim() ?? '';
    const prompt = args.trim();
    const effectivePrompt = repliedText.length > 0
        ? (prompt.length > 0 ? `${repliedText}\n${prompt}` : repliedText)
        : prompt;

    if (!effectivePrompt) {
        await msg.reply('Please provide instructions for the image you want me to create or edit.');
        return;
    }

    const sourceImageURLs = getImageURLsFromMessage(msg, repliedMessage)
        .slice(0, MAX_GROK_IMAGE_EDIT_SOURCES);

    const response = await withTyping(msg.channel, async () => {
        return generateGrokImage(effectivePrompt, sourceImageURLs);
    });

    if (response.url || response.imageBuffer) {
        let buffer = response.imageBuffer;

        if (!buffer && response.url) {
            const imageResponse = await fetch(response.url);
            if (!imageResponse.ok) {
                await msg.reply('Failed to download generated image.');
                return;
            }
            buffer = Buffer.from(await imageResponse.arrayBuffer());
        }

        if (!buffer) {
            await msg.reply('Image generation returned an empty result.');
            return;
        }

        const attachment = new AttachmentBuilder(buffer, { name: 'image.jpg' });
        await msg.reply({ files: [attachment] });
    } else if (response.error) {
        await msg.reply(response.error);
    }
}

function shouldGenerateImage(args: string): boolean {
    const lower = args.toLowerCase();
    return IMAGE_GENERATION_TRIGGERS.some(trigger => lower.startsWith(trigger));
}

export async function handleGrok(msg: Message, args: string): Promise<void> {
    // Check if user wants to generate an image
    if (shouldGenerateImage(args)) {
        return handleGrokImage(msg, args);
    }

    const response = await withTyping(msg.channel, async () => {
        return masterGrokHandler({
            msg,
            args,
        });
    });

    if (response.result) {
        const reply = await msg.reply({
            content: truncateResponse(response.result),
            flags: MessageFlags.SuppressEmbeds,
        });
        if (response.messages) {
            chatHistoryCache.set(reply.id, response.messages);
        }
    } else if (response.error) {
        await msg.reply(response.error);
    }
}

export interface SummarizeResponse {
    result?: string;
    error?: string;
}

export async function grokSummarize(
    contentToSummarize: string,
    requestingUser: string,
): Promise<SummarizeResponse> {
    const systemPrompt = `You are a witty summarizer with a talent for capturing the essence of chaotic Discord conversations. Your job is to provide entertaining yet accurate summaries.

Style guidelines:
- Be funny and irreverent, but don't make stuff up
- Use dry humor and gentle roasts where appropriate
- Highlight the absurd, the dramatic, and the memorable moments
- Call out any particularly unhinged takes or galaxy-brain moments
- Keep it punchy - no filler, every sentence should earn its place
- You can be a bit snarky but stay good-natured
- End with a zinger or amusing observation if the material warrants it

The person requesting this summary is named ${requestingUser}.
Keep your summary under 1900 characters. Jump directly into the summary without preamble.`;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        const response = await fetch(`${XAI_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.grokApiKey}`,
            },
            body: JSON.stringify({
                model: XAI_TEXT_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: contentToSummarize },
                ],
                temperature: 0.8,
                max_tokens: 2048,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            console.error('xAI API error:', response.status, errorText);
            return {
                error: formatProviderApiError({
                    provider: 'xAI',
                    status: response.status,
                    statusText: response.statusText,
                    body: errorText,
                }),
            };
        }

        const completion = await response.json();

        recordGrokUsage(XAI_TEXT_MODEL, completion.usage);

        const result = completion.choices?.[0]?.message?.content;

        if (result) {
            return { result };
        } else {
            return { error: 'No response from API' };
        }
    } catch (err: any) {
        if (err.name === 'AbortError') {
            return { error: 'Request timed out' };
        }
        return { error: formatProviderApiError({ provider: 'xAI', error: err }) };
    }
}
