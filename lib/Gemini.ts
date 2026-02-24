import {
    Message,
    EmbedBuilder,
    AttachmentBuilder,
} from 'discord.js';
import {
    GoogleGenAI,
    HarmCategory,
    HarmBlockThreshold,
    type GenerateContentResponse,
    type GenerateImagesResponse,
    type Part,
    type SafetySetting,
} from '@google/genai';
import { config } from './Config.js';
import {
    truncateResponse,
    getUsername,
    getImageURLsFromMessage,
    replyLongMessage,
} from './Utilities.js';

// Define interfaces for our handler
interface GeminiOptions {
    systemPrompt?: string;
    temperature?: number;
    maxOutputTokens?: number;
    imageOnly?: boolean;
    timeoutMs?: number;
}

interface ImageData {
    mimeType: string;
    data: string;
}

// Finish reason types for safety checks
// Using string literals instead of an enum to match the Google API strings exactly
type FinishReason =
    | 'STOP'
    | 'MAX_TOKENS'
    | 'SAFETY'
    | 'RECITATION'
    | 'OTHER'
    | 'UNSPECIFIED'
    | 'IMAGE_SAFETY'
    | 'TEXT_SAFETY';

// Hardcoded banned users list
const BANNED_USERS = ['663270358161293343'];

// Users exempt from image generation rate limits (in addition to god user)
const RATE_LIMIT_EXEMPT_USERS = ['283097824021839873', '590587699795329045', '518203238474973193'];

// Rate limiting for image generation: 3 requests per 5 minutes per user
const IMAGE_RATE_LIMIT = { maxRequests: 3, windowMs: 5 * 60 * 1000 };
const imageRateLimitMap = new Map<string, number[]>();

function checkImageRateLimit(userId: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const timestamps = imageRateLimitMap.get(userId) || [];
    const recent = timestamps.filter(t => now - t < IMAGE_RATE_LIMIT.windowMs);
    imageRateLimitMap.set(userId, recent);

    if (recent.length >= IMAGE_RATE_LIMIT.maxRequests) {
        const oldestInWindow = recent[0];
        const retryAfterMs = IMAGE_RATE_LIMIT.windowMs - (now - oldestInWindow);
        return { allowed: false, retryAfterMs };
    }

    recent.push(now);
    imageRateLimitMap.set(userId, recent);
    return { allowed: true, retryAfterMs: 0 };
}

// Initialize the Gemini API client
const genAI = new GoogleGenAI({
    apiKey: config.geminiApiKey,
    // v1alpha is needed for preview Gemini 3 image/text models
    apiVersion: 'v1alpha',
});

const ART_STYLES = [
    'pixel art',
    'vaporwave',
    'synthwave',
    'retrofuturism',
    'psychedelic',
    'biopunk',
    'cyberdelic',
    'kawaii',
    'anime',
    'post-apocalyptic surrealism',
    'Abstract Expressionism',
    'Ghibli-esque',
    'yokai',
    'rubber hose',
    'claymation',
    'comic strip',
    'steampunk',
    'photorealistic',
    'hyperrealistic',
    'isometric',
    'neon',
    'geometric',
    'organic',
    'biomechanical',
];

const TEXT_MODEL = "gemini-3-flash";
const IMAGE_MODEL = "gemini-3-pro-image-preview";

const SAFETY_SETTINGS: SafetySetting[] = [
    {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_NONE
    },
    {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_NONE
    },
    {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_NONE
    },
    {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_NONE
    },
    {
        category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
        threshold: HarmBlockThreshold.BLOCK_NONE
    },
];

// Cache for conversation history
const chatHistoryCache = new Map<string, any[]>();

function appendArtStyle(prompt: string, numStyles: number = 0) {
    if (numStyles === 0) {
        return prompt;
    }

    const styles = [];
    for (let i = 0; i < numStyles; i++) {
        const artStyle = ART_STYLES[Math.floor(Math.random() * ART_STYLES.length)];
        styles.push(`${artStyle} art style`);
    }

    return `${prompt}, ${styles.join(', ')}`;
}

/**
 * Fetches an image from a URL and converts it to base64
 * @param {string} url - The image URL to fetch
 * @returns {Promise<ImageData | null>} - Object with mime type and base64 data
 */
async function fetchImageAsBase64(url: string): Promise<ImageData | null> {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') || 'image/jpeg';
        const buffer = await response.arrayBuffer();
        const base64Data = Buffer.from(buffer).toString('base64');

        return {
            mimeType: contentType,
            data: base64Data
        };
    } catch (error) {
        console.error('Error fetching image:', error);
        return null;
    }
}

/**
 * Prepare content parts for Gemini API including text and images
 * @param {string} text - The text content
 * @param {string[]} imageURLs - Array of image URLs
 * @returns {Promise<Array<any>>} - Array of content parts for Gemini API
 */
async function prepareContentParts(text: string, imageURLs: string[] = []): Promise<Part[]> {
    const contentParts: Part[] = [{ text }];

    // Process images if any
    if (imageURLs && imageURLs.length > 0) {
        for (const url of imageURLs) {
            const imageData = await fetchImageAsBase64(url);
            if (imageData) {
                contentParts.push({
                    inlineData: {
                        mimeType: imageData.mimeType,
                        data: imageData.data
                    }
                });
            }
        }
    }

    return contentParts;
}

/**
 * Get user-friendly message for safety rejections
 * @param {string} safetyReason - The safety reason type
 * @param {boolean} imageOnly - Whether this was an image generation request
 * @returns {string} - User-friendly error message
 */
function getSafetyErrorMessage(safetyReason: string, imageOnly: boolean): string {
    switch (safetyReason) {
        case 'IMAGE_SAFETY':
            return "The Gemini API refused to generate this image. Please try a different image description.";
        case 'TEXT_SAFETY':
            return "The Gemini API refused to process this text content. Please try rephrasing your request.";
        case 'SAFETY':
            return imageOnly
                ? "The Gemini API refused to generate this image. Try a different description."
                : "The Gemini API refused to respond to this request. Please try a different prompt.";
        default:
            return "The Gemini API rejected this request. Please try again with different content.";
    }
}

function formatGeminiError(error: any, action: string): string {
    let errorMessage = `An error occurred while ${action}.`;

    if (error?.message && typeof error.message === 'string') {
        const errMsg = error.message;
        if (errMsg.includes("safety")) {
            return "The Gemini API rejected this request due to safety policies. Please try a different prompt.";
        }
        if (errMsg.includes("invalid image") || errMsg.includes("unsupported image")) {
            return "The Gemini API couldn't process this image format. Please try a different image.";
        }
        if (errMsg.includes("timeout")) {
            return "The request timed out. Please try again with a shorter prompt.";
        }
        errorMessage = `Error: ${errMsg}`;
    }

    if (typeof error === 'object' && error) {
        if (error.status === 400) {
            errorMessage = "The Gemini API rejected the request format. This might be a configuration issue.";
        } else if (error.status === 429) {
            errorMessage = "The Gemini API rate limit was exceeded. Please try again in a few minutes.";
        } else if (error.status === 500 || error.status === 503) {
            errorMessage = "The Gemini API is currently experiencing issues. Please try again later.";
        }
    }

    return errorMessage;
}

/**
 * Handle Gemini chat requests with history support and integrated image generation
 * @param {Message} msg - Discord message object
 * @param {string} args - Message content
 * @param {GeminiOptions} options - Additional options
 * @returns {Promise<void>}
 */
export async function handleGemini(msg: Message, args: string, options: GeminiOptions = {}): Promise<void> {
    try {
        const {
            systemPrompt = "You are Gemini, a helpful and versatile AI. You can provide both text responses and generate images. Keep responses concise and informative.",
            temperature = 1,
            maxOutputTokens = 1024,
            imageOnly = false // When true, prioritize image output with minimal text
        } = options;

        // Don't process in dev channels unless in dev environment
        if (config.devChannels && config.devChannels.includes(msg.channel.id) && !config.devEnv) {
            return;
        }

        // Check for banned users using hardcoded list
        if (BANNED_USERS.includes(msg.author.id)) {
            await msg.reply("Sorry, this function has been disabled for your user.");
            return;
        }

        // Get username for personalization
        const username = await getUsername(msg.author.id, msg.guild);

        // Check for replied message for context
        const replyMsgId = msg?.reference?.messageId;
        let history: any[] = [];
        let contextMessage: Message | undefined;

        if (replyMsgId) {
            const cachedHistory = chatHistoryCache.get(replyMsgId);
            if (cachedHistory) {
                history = cachedHistory;
            }

            // If no history found but replying to message, fetch it for context
            if (history.length === 0) {
                try {
                    contextMessage = await msg.channel?.messages.fetch(replyMsgId);
                } catch (error) {
                    console.error("Failed to fetch replied message:", error);
                }
            }
        }

        // Get image URLs - all from current message, first from replied bot message
        let imageURLs: string[] = [];

        // Always get all images from current user message
        const currentMessageImages = getImageURLsFromMessage(msg);
        imageURLs.push(...currentMessageImages);

        // If replying to a message, add images from it
        if (contextMessage) {
            const repliedMessageImages = getImageURLsFromMessage(contextMessage);
            if (repliedMessageImages.length > 0) {
                // If replied message is from bot, only use first image
                if (contextMessage.author.bot) {
                    imageURLs.push(repliedMessageImages[0]);
                } else {
                    // If replied message is from user, use all images
                    imageURLs.push(...repliedMessageImages);
                }
            }
        }

        // Adjust the prompt based on whether this is image-only mode
        let effectivePrompt = args.trim();
        if (imageOnly && !effectivePrompt.toLowerCase().startsWith("generate") &&
            !effectivePrompt.toLowerCase().startsWith("create")) {
            effectivePrompt = "Generate an image of " + effectivePrompt;
        }

        // Add replied message context if present
        let fullPrompt = effectivePrompt;
        if (contextMessage && contextMessage.content.trim()) {
            fullPrompt = contextMessage.content.trim() + '\n' + effectivePrompt;
        }

        // Route image-only requests to the image model directly
        if (imageOnly) {
            let sourceImages: ImageData[] | null = null;
            if (imageURLs.length > 0) {
                const collectedImages: ImageData[] = [];
                for (const url of imageURLs) {
                    const imageData = await fetchImageAsBase64(url);
                    if (imageData) {
                        collectedImages.push(imageData);
                    }
                }
                if (collectedImages.length > 0) {
                    sourceImages = collectedImages;
                }
            }

            // Check rate limit (god user and exempt users are exempt)
            if (msg.author.id !== config.god && !RATE_LIMIT_EXEMPT_USERS.includes(msg.author.id)) {
                const rateCheck = checkImageRateLimit(msg.author.id);
                if (!rateCheck.allowed) {
                    const retryMinutes = Math.ceil(rateCheck.retryAfterMs / 60000);
                    await msg.reply(`You've reached the image generation limit (3 per 5 minutes). Try again in ~${retryMinutes} minute${retryMinutes !== 1 ? 's' : ''}.`);
                    return;
                }
            }

            const imagePaths = await generateSingleImage(fullPrompt, options, sourceImages);
            if (imagePaths.length === 0) {
                await msg.reply("I couldn't generate an image for that request. Please try a different description.");
                return;
            }

            const attachments = imagePaths.map((imagePath) => new AttachmentBuilder(imagePath)
                .setName(imagePath.split('/').pop() || 'generated-image.png'));

            await msg.reply({ files: attachments });

            for (const imagePath of imagePaths) {
                const fs = await import('fs/promises');
                await fs.unlink(imagePath).catch(console.error);
            }
            return;
        }

        const contentParts = await prepareContentParts(fullPrompt, imageURLs);

        const chat = genAI.chats.create({
            model: TEXT_MODEL,
            config: {
                temperature,
                maxOutputTokens,
                topP: 0.95,
                safetySettings: SAFETY_SETTINGS,
            },
            history: history.length > 0 ? history : [{
                role: "user",
                parts: [{ text: systemPrompt }]
            }]
        });

        const response = await chat.sendMessage({ message: contentParts });

        // Check for safety finish reasons directly in candidates
        if (response.candidates && response.candidates.length > 0) {
            for (const candidate of response.candidates) {
                const finishReason = candidate.finishReason as string;
                if (finishReason === 'SAFETY' ||
                    finishReason === 'IMAGE_SAFETY' ||
                    finishReason === 'TEXT_SAFETY') {
                    await msg.reply(getSafetyErrorMessage(finishReason, imageOnly));
                    return;
                }
            }
        }

        const responseText = response.text?.trim() || "";
        const imagePaths = await processResponseImages(response);
        const hasImages = imagePaths.length > 0;

        // If we have no text and no images, check for candidates with safety issues again
        if (!responseText && !hasImages && response.candidates && response.candidates.length > 0) {
            for (const candidate of response.candidates) {
                const finishReason = candidate.finishReason as string;
                if (finishReason === 'SAFETY' ||
                    finishReason === 'IMAGE_SAFETY' ||
                    finishReason === 'TEXT_SAFETY') {
                    await msg.reply(getSafetyErrorMessage(finishReason, imageOnly));
                    return;
                }
            }
        }

        let replyMessage;
        const attachments = [];

        for (const imagePath of imagePaths) {
            const attachment = new AttachmentBuilder(imagePath)
                .setName(imagePath.split('/').pop() || 'generated-image.png');

            attachments.push(attachment);
        }

        if (responseText) {
            if (responseText.length > 1999) {
                const replies = await replyLongMessage(msg, responseText, { files: attachments });
                if (replies.length > 0) {
                    replyMessage = replies[0];
                }
            } else {
                replyMessage = await msg.reply({
                    files: attachments,
                    content: responseText,
                });
            }
        } else if (attachments.length > 0) {
            replyMessage = await msg.reply({
                files: attachments,
            });
        } else {
            console.log("Empty response details:", response);

            let errorMessage = "The Gemini API returned an empty response. Please try rephrasing or simplifying your prompt.";

            if (response && response.candidates && response.candidates.length > 0) {
                const finishReason = response.candidates[0].finishReason as string;
                if (finishReason && finishReason !== 'STOP') {
                    errorMessage = `The Gemini API couldn't complete this request (${finishReason}). Please try a different prompt.`;
                }
            }

            replyMessage = await msg.reply(errorMessage);
        }

        for (const imagePath of imagePaths) {
            const fs = await import('fs/promises');
            await fs.unlink(imagePath).catch(console.error);
        }

        let updatedHistory: any[] = [];

        if (history.length > 0) {
            updatedHistory = [...history];
        } else if (replyMessage) {
            updatedHistory = [{
                role: "user",
                parts: [{ text: replyMessage.content }]
            }, {
                role: "model",
                parts: [{ text: responseText }]
            }];
        }

        updatedHistory.push({
            role: "user",
            parts: contentParts
        });

        const responseParts: any[] = [];
        if (responseText) {
            responseParts.push({ text: responseText });
        }

        if (hasImages) {
            responseParts.push({ text: "[IMAGE GENERATED]" });
        }

        updatedHistory.push({
            role: "model",
            parts: responseParts
        });

        if (replyMessage) {
            chatHistoryCache.set(replyMessage.id, updatedHistory);
        }
    } catch (error: any) {
        console.error("Error in Gemini handler:", error);

        await msg.reply(formatGeminiError(error, "processing your request"));
    }
}

/**
 * Save a base64 image to a temporary file and return its path
 * @param {string} base64Data - Base64 encoded image data
 * @param {string} mimeType - MIME type of the image
 * @returns {Promise<string>} - Path to the saved file
 */
async function saveBase64ImageToFile(base64Data: string, mimeType: string): Promise<string> {
    const fs = await import('fs/promises');
    const path = await import('path');
    const crypto = await import('crypto');

    // Generate a random filename
    const randomName = crypto.randomBytes(16).toString('hex');
    const extension = mimeType.split('/')[1] || 'png';
    const filename = `gemini_${randomName}.${extension}`;
    const tempDir = '/tmp';
    const filePath = path.join(tempDir, filename);

    // Create temp directory if it doesn't exist
    try {
        await fs.mkdir(tempDir, { recursive: true });
    } catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
    }

    // Decode and save the image
    const buffer = Buffer.from(base64Data, 'base64');
    await fs.writeFile(filePath, buffer);

    return filePath;
}

/**
 * Process and extract images from Gemini response
 * @param {any} response - Gemini API response
 * @returns {Promise<Array<string>>} - Array of paths to saved images
 */
async function processResponseImages(response: GenerateContentResponse | GenerateImagesResponse | undefined): Promise<string[]> {
    const imagePaths: string[] = [];

    if (!response) {
        return imagePaths;
    }

    // Handle image responses from generateImages/editImage
    if ('generatedImages' in response && response.generatedImages) {
        for (const generated of response.generatedImages) {
            const imageData = generated?.image;
            if (imageData?.imageBytes && imageData.mimeType?.startsWith('image/')) {
                const imagePath = await saveBase64ImageToFile(imageData.imageBytes, imageData.mimeType);
                imagePaths.push(imagePath);
            }
        }
        return imagePaths;
    }

    // Handle inline images from content responses
    const processParts = async (parts?: Part[]) => {
        if (!parts) return;
        for (const part of parts) {
            if (part.inlineData && part.inlineData.mimeType?.startsWith('image/') && part.inlineData.data) {
                const imagePath = await saveBase64ImageToFile(part.inlineData.data, part.inlineData.mimeType);
                imagePaths.push(imagePath);
            }
        }
    };

    if ('candidates' in response) {
        const candidates = response.candidates || [];
        for (const candidate of candidates) {
            await processParts(candidate.content?.parts);
        }
    }

    return imagePaths;
}

/**
 * Generate a single image using Gemini with timeout
 * @param {string} prompt - The image description
 * @param {GeminiOptions} options - Additional options
 * @param {ImageData[]|null} sourceImages - Optional array of source images for editing
 * @returns {Promise<string[]>} - Array of paths to saved images
 */
async function generateSingleImage(
    prompt: string,
    options: GeminiOptions = {},
    sourceImages: ImageData[] | null = null
): Promise<string[]> {
    const timeoutMs = options.timeoutMs || 120_000;

    const timeoutPromise = new Promise<string[]>((_, reject) => {
        setTimeout(() => reject(new Error("Image generation timed out")), timeoutMs);
    });

    const generationPromise = async (): Promise<string[]> => {
        const imageOptions: GeminiOptions = {
            temperature: options.temperature || 1,
            imageOnly: true,
            systemPrompt: options.systemPrompt || "You are an artistic image generator. Focus on creating detailed, high-quality images based on the user's description with minimal explanatory text."
        };

        let effectivePrompt = prompt.trim();
        if (sourceImages && sourceImages.length > 0) {
            // For image editing, use the prompt directly as instructions for editing
            if (!effectivePrompt.toLowerCase().includes("edit") &&
                !effectivePrompt.toLowerCase().includes("modify") &&
                !effectivePrompt.toLowerCase().includes("change")) {
                effectivePrompt = sourceImages.length === 1
                    ? "Edit this image to " + effectivePrompt
                    : "Edit these images to " + effectivePrompt;
            }
        } else if (!effectivePrompt.toLowerCase().startsWith("generate") &&
                  !effectivePrompt.toLowerCase().startsWith("create")) {
            effectivePrompt = "Generate an image of " + effectivePrompt;
        }

        if (imageOptions.systemPrompt) {
            effectivePrompt = `${imageOptions.systemPrompt}\n${effectivePrompt}`;
        }

        const parts: Part[] = [{ text: effectivePrompt }];
        if (sourceImages && sourceImages.length > 0) {
            for (const src of sourceImages) {
                parts.push({
                    inlineData: {
                        mimeType: src.mimeType,
                        data: src.data,
                    },
                });
            }
        }

        const response = await genAI.models.generateContent({
            model: IMAGE_MODEL,
            contents: [{ role: 'user', parts }],
            config: {
                temperature: imageOptions.temperature,
                topP: 0.95,
                responseModalities: ['IMAGE'],
                imageConfig: {
                    aspectRatio: '1:1',
                    imageSize: '1K',
                },
                safetySettings: SAFETY_SETTINGS,
                systemInstruction: imageOptions.systemPrompt ? { role: 'system', parts: [{ text: imageOptions.systemPrompt }]} : undefined,
            },
        });

        return processResponseImages(response);
    };

    return Promise.race([generationPromise(), timeoutPromise]);
}

/**
 * Handle Gemini image generation with multiple images
 * @param {Message} msg - Discord message object
 * @param {string} args - Message content
 * @returns {Promise<void>}
 */
export async function handleGeminiImageGen(msg: Message, args: string): Promise<void> {
    // Create an array to track created image paths for cleanup
    const allImagePaths: string[] = [];
    // Array to collect error messages from failed generations
    const errorMessages: string[] = [];

    try {
        // Check rate limit (god user and exempt users are exempt)
        if (msg.author.id !== config.god && !RATE_LIMIT_EXEMPT_USERS.includes(msg.author.id)) {
            const rateCheck = checkImageRateLimit(msg.author.id);
            if (!rateCheck.allowed) {
                const retryMinutes = Math.ceil(rateCheck.retryAfterMs / 60000);
                await msg.reply(`You've reached the image generation limit (3 per 5 minutes). Try again in ~${retryMinutes} minute${retryMinutes !== 1 ? 's' : ''}.`);
                return;
            }
        }

        // Send typing indicator if the channel has typing capability
        if (msg.channel && 'sendTyping' in msg.channel) {
            await msg.channel.sendTyping();
        }

        // Check for images - all from current message, first from replied bot message
        let imageURLs: string[] = [];
        let contextMessage: Message | undefined;

        // Always get all images from current user message
        const currentMessageImages = getImageURLsFromMessage(msg);
        imageURLs.push(...currentMessageImages);

        // Check for replied message
        if (msg.reference?.messageId) {
            try {
                contextMessage = await msg.channel?.messages.fetch(msg.reference.messageId);
                if (contextMessage) {
                    const repliedMessageImages = getImageURLsFromMessage(contextMessage);
                    if (repliedMessageImages.length > 0) {
                        // If replied message is from bot, only use first image
                        if (contextMessage.author.bot) {
                            imageURLs.push(repliedMessageImages[0]);
                        } else {
                            // If replied message is from user, use all images
                            imageURLs.push(...repliedMessageImages);
                        }
                    }
                }
            } catch (error) {
                console.error("Failed to fetch replied message:", error);
            }
        }

        // Add replied message context if present
        let fullPrompt = args;
        if (contextMessage && contextMessage.content.trim()) {
            fullPrompt = contextMessage.content.trim() + '\n' + args;
        }

        // Generate multiple images
        if (imageURLs.length > 0) {
            // SOURCE IMAGE MODE: Process all images as sources for editing
            const sourceImageDataArray: ImageData[] = [];
            for (const imageUrl of imageURLs) {
                const imageData = await fetchImageAsBase64(imageUrl);
                if (imageData) {
                    sourceImageDataArray.push(imageData);
                }
            }

            if (sourceImageDataArray.length === 0) {
                await msg.reply("Failed to process the source images. Please try with different images.");
                return;
            }

            // Generate a single image with the source image
            try {
                const paths = await generateSingleImage(fullPrompt, { temperature: 1 }, sourceImageDataArray);
                allImagePaths.push(...paths);
            } catch (error: any) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                errorMessages.push(errorMsg);
            }
        } else {
            // Generate a single image from text
            try {
                const paths = await generateSingleImage(fullPrompt, { temperature: 1 });
                allImagePaths.push(...paths);
            } catch (error: any) {
                console.error("Image generation error:", error);
                const errorMsg = error instanceof Error ? error.message : String(error);
                errorMessages.push(errorMsg);
            }
        }

        if (allImagePaths.length === 0) {
            // If we have error messages, provide them to the user
            if (errorMessages.length > 0) {
                // Note: Prompt enhancement errors are now handled with fallback, no need to check here

                // Categorize errors by type
                const safetyErrors = errorMessages.filter(err =>
                    err.includes("safety") || err.includes("Safety")).length;
                const timeoutErrors = errorMessages.filter(err =>
                    err.includes("timeout") || err.includes("timed out")).length;
                const imageFormatErrors = errorMessages.filter(err =>
                    err.includes("invalid image") || err.includes("unsupported image")).length;
                const rateLimitErrors = errorMessages.filter(err =>
                    err.includes("rate limit") || err.includes("quota")).length;
                const serverErrors = errorMessages.filter(err =>
                    err.includes("500") || err.includes("503") || err.includes("server error")).length;

                // Determine the most common error type
                const errorCounts = [
                    { type: "safety", count: safetyErrors, message: "The content may violate safety policies (potentially sensitive content)" },
                    { type: "timeout", count: timeoutErrors, message: "The generation process timed out (try a simpler description)" },
                    { type: "format", count: imageFormatErrors, message: "There was an issue with the image format" },
                    { type: "rateLimit", count: rateLimitErrors, message: "API rate limit reached (please try again later)" },
                    { type: "server", count: serverErrors, message: "The Gemini service is experiencing issues (please try again later)" }
                ];

                // Sort by count, descending
                errorCounts.sort((a, b) => b.count - a.count);

                // Create a user-friendly error message focusing on the most common error
                let errorResponse = imageURLs.length > 0
                    ? "I couldn't edit the image based on that prompt. "
                    : "I couldn't generate any images based on that prompt. ";

                if (errorCounts[0].count > 0) {
                    // Include the most common error
                    errorResponse += `Error: ${errorCounts[0].message}. `;

                    // If there's a second common error that's different, include it too
                    if (errorCounts[1].count > 0 && errorCounts[1].count >= errorCounts[0].count * 0.5) {
                        errorResponse += `Additionally: ${errorCounts[1].message}. `;
                    }
                } else {
                    // If none of our categorized errors matched, include the first unique error
                    const uniqueErrors = [...new Set(errorMessages)];
                    if (uniqueErrors.length > 0) {
                        errorResponse += `Error: ${uniqueErrors[0]}. `;
                    }
                }

                errorResponse += "Please try a different description or try again later.";

                await msg.reply(errorResponse);
            } else {
                // Fallback if no specific errors were captured
                const errorMessage = imageURLs.length > 0
                    ? "I couldn't edit the image based on that prompt. The API didn't return any specific errors. Please try a different description or image."
                    : "I couldn't generate any images based on that prompt. The API didn't return any specific errors. Please try a different description.";

                await msg.reply(errorMessage);
            }
            return;
        }

        // Create attachments for Discord
        const attachments = [];
        for (const imagePath of allImagePaths) {
            const attachment = new AttachmentBuilder(imagePath)
                .setName(imagePath.split('/').pop() || 'generated-image.png');
            attachments.push(attachment);
        }

        await msg.reply({
            files: attachments,
        });
    } catch (error: unknown) {
        console.error("Error in Gemini image generation:", error);
        await msg.reply(formatGeminiError(error, "generating images"));
    } finally {
        // Clean up temporary files
        for (const imagePath of allImagePaths) {
            const fs = await import('fs/promises');
            await fs.unlink(imagePath).catch(err => {
                console.error(`Failed to delete temp file ${imagePath}:`, err);
            });
        }
    }
}

/**
 * Handle adding captions to images
 * @param {Message} msg - Discord message object
 * @param {string} args - Message content (caption text)
 * @returns {Promise<void>}
 */
export async function handleGeminiCaption(msg: Message, args: string): Promise<void> {
    // Create an array to track created image paths for cleanup
    const imagePaths: string[] = [];

    try {
        if (!args || args.trim() === '') {
            await msg.reply("Please provide caption text. Example usage: `!caption This is my vacation photo`");
            return;
        }

        // Send typing indicator if the channel has typing capability
        if (msg.channel && 'sendTyping' in msg.channel) {
            await msg.channel.sendTyping();
        }

        // Get image URLs - all from current message, first from replied bot message
        let imageURLs: string[] = [];

        // Always get all images from current user message
        const currentMessageImages = getImageURLsFromMessage(msg);
        imageURLs.push(...currentMessageImages);

        // Check for replied message
        if (msg.reference?.messageId) {
            try {
                const contextMessage = await msg.channel?.messages.fetch(msg.reference.messageId);
                if (contextMessage) {
                    const repliedMessageImages = getImageURLsFromMessage(contextMessage);
                    if (repliedMessageImages.length > 0) {
                        // If replied message is from bot, only use first image
                        if (contextMessage.author.bot) {
                            imageURLs.push(repliedMessageImages[0]);
                        } else {
                            // If replied message is from user, use all images
                            imageURLs.push(...repliedMessageImages);
                        }
                    }
                }
            } catch (error) {
                console.error("Failed to fetch replied message:", error);
            }
        }

        if (imageURLs.length === 0) {
            await msg.reply("Please provide an image to add a caption to. You can upload an image with your command or reply to a message containing an image.");
            return;
        }

        // Use only the first image for captioning
        const imageUrl = imageURLs[0];
        const imageData = await fetchImageAsBase64(imageUrl);

        if (!imageData) {
            await msg.reply("Failed to process the image. Please try with a different image.");
            return;
        }

        // Create a specific prompt for adding captions
        const captionText = args.trim();
        const captionPrompt = `Add the following text as a visible caption directly ON this image (not as a separate image or description):

"${captionText}"

The caption should be:
1. Clearly visible and readable
2. Properly positioned (preferably at the bottom, top, or where it fits best)
3. Have sufficient contrast with the background (add shadow, outline, or background to text if needed)
4. Match the style/mood of the image
5. Use an appropriate font size and style

        IMPORTANT: DO NOT describe what you're doing or explain your process. ONLY generate the image with the caption text overlaid.`;

        // Initialize model with specific caption settings
        const systemPrompt = "You are an expert at adding text captions directly onto images. You always position text in visually appealing ways, ensure readability, and never return images without the requested caption text visibly overlaid on them.";

        const generatedImagePaths = await generateSingleImage(captionPrompt, {
            temperature: 1,
            systemPrompt,
        }, [imageData]);

        imagePaths.push(...generatedImagePaths);

        if (imagePaths.length === 0) {
            await msg.reply("I couldn't add a caption to the image. This might be due to content guidelines or technical limitations. Please try a different image or caption text.");
            return;
        }

        // Create attachment for Discord
        const attachments = [];
        for (const imagePath of imagePaths) {
            const attachment = new AttachmentBuilder(imagePath)
                .setName(imagePath.split('/').pop() || 'captioned-image.png');
            attachments.push(attachment);
        }

        // Send the captioned image
        await msg.reply({
            files: attachments,
            content: "Here's your image with the caption added:",
        });
    } catch (error: unknown) {
        console.error("Error in Gemini caption:", error);
        await msg.reply(formatGeminiError(error, "adding the caption"));
    } finally {
        // Clean up temporary files
        for (const imagePath of imagePaths) {
            const fs = await import('fs/promises');
            await fs.unlink(imagePath).catch(err => {
                console.error(`Failed to delete temp file ${imagePath}:`, err);
            });
        }
    }
}

// Export additional functions as needed for your Discord bot
export default {
    handleGemini,
    handleGeminiImageGen,
    handleGeminiCaption
};
