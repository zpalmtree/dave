import { Message, AttachmentBuilder } from 'discord.js';
import { config } from './Config.js';
import {
    truncateResponse,
    getUsername,
    getImageURLsFromMessage,
    withTyping,
} from './Utilities.js';

const XAI_BASE_URL = "https://api.x.ai/v1";
const XAI_IMAGE_MODEL = 'grok-imagine-image';
const MAX_GROK_IMAGE_EDIT_SOURCES = 3;

const DEFAULT_SETTINGS = {
    model: 'grok-4-1-fast',
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

interface XAIResponseMessage {
    role: string;
    content: string;
}

interface XAIResponse {
    id: string;
    output: XAIResponseMessage[];
    citations?: string[];
    usage?: {
        input_tokens: number;
        output_tokens: number;
    };
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
            return { error: `API error: ${response.status}` };
        }

        const completion = await response.json();

        // Find the assistant message - different structure for chat/completions vs responses
        let assistantOutput: XAIResponseMessage | undefined;
        if (hasImages) {
            // chat/completions format: { choices: [{ message: { role, content } }] }
            assistantOutput = (completion as any).choices?.[0]?.message;
        } else {
            // responses format: { output: [{ role, content }] }
            assistantOutput = (completion as XAIResponse).output?.find(o => o.role === 'assistant');
        }

        // Extract text content (could be string or array of content parts)
        const getTextContent = (content: any): string | null => {
            if (typeof content === 'string') return content;
            if (Array.isArray(content)) {
                const textPart = content.find((p: any) => p.type === 'text' || p.type === 'output_text');
                return textPart?.text || textPart?.content || null;
            }
            if (content?.text) return content.text;
            if (content?.content) return content.content;
            return null;
        };

        const responseText = getTextContent(assistantOutput?.content);

        if (responseText) {
            // Extract citations from annotations in content
            let citations: string[] = [];
            if (assistantOutput && Array.isArray(assistantOutput.content)) {
                for (const part of (assistantOutput.content as any[])) {
                    if (part.annotations && Array.isArray(part.annotations)) {
                        for (const annotation of part.annotations) {
                            // Try different possible URL field names
                            const url = annotation.url || annotation.href || annotation.link || annotation.source;
                            if (url) {
                                citations.push(url);
                            }
                        }
                    }
                }
            }
            // Fallback to other possible locations
            if (!citations.length) {
                citations = completion.citations ||
                    (assistantOutput as any)?.citations ||
                    (completion as any).search_results?.map((r: any) => r.url) ||
                    [];
            }

            const extractHandle = (url: string): string | null => {
                try {
                    const [, handle] = new URL(url).pathname.split('/', 3);
                    return handle ? `@${handle}` : null;
                } catch {
                    return null;
                }
            };

            // Keep original text and build citation list at bottom
            // Wrap URLs in markdown links with <> to prevent Discord link expansion
            // [1](https://...) -> [1](<https://...>)
            let processedText = responseText.trim()
                .replace(/\]\((https?:\/\/[^\s\)>]+)\)/g, '](<$1>)');

            // Collect unique citations with their numbers
            const citationMap = new Map<string, string>(); // title -> url
            if (assistantOutput && Array.isArray(assistantOutput.content)) {
                for (const part of (assistantOutput.content as any[])) {
                    if (part.annotations && Array.isArray(part.annotations)) {
                        for (const ann of part.annotations) {
                            if (ann.url && ann.title) {
                                citationMap.set(ann.title, ann.url);
                            }
                        }
                    }
                }
            }

            // Build citation footer
            let citationFooter = '';
            if (citationMap.size > 0) {
                const sortedCitations = Array.from(citationMap.entries())
                    .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
                citationFooter = '\n\n' + sortedCitations
                    .map(([num, url]) => `[${num}] <${url}>`)
                    .join('\n');
            }

            const generation = processedText + citationFooter;

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
            console.error('xAI Image API error:', response.status, errorText);
            return { error: `API error: ${response.status}` };
        }

        const result = await response.json();
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
        return { error: err.toString() };
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
        const reply = await msg.reply(truncateResponse(response.result));
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
                model: 'grok-3-fast',
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
            return { error: `API error: ${response.status}` };
        }

        const completion = await response.json();
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
        return { error: err.toString() };
    }
}
