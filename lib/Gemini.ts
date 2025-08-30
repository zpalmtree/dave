import {
    Message,
    EmbedBuilder,
    AttachmentBuilder,
} from 'discord.js';
import { GoogleGenerativeAI, GenerateContentRequest, GenerateContentResult, Content, GenerationConfig, Part, InlineDataPart, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';

import { config } from './Config.js';
import {
    truncateResponse,
    getUsername,
    getImageURLsFromMessage,
    replyLongMessage,
} from './Utilities.js';

// Define extended generation config with responseModalities
interface ExtendedGenerationConfig extends GenerationConfig {
    responseModalities?: string[];
}

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

// Initialize the Gemini API client
const genAI = new GoogleGenerativeAI(config.geminiApiKey);

// Define response modalities for various content types
const MODALITIES = {
    TEXT: "TEXT",
    IMAGE: "IMAGE"
};

// Cache for conversation history
const chatHistoryCache = new Map<string, any[]>();

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
async function prepareContentParts(text: string, imageURLs: string[] = []): Promise<any[]> {
    const contentParts: any[] = [{ text }];
    
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
        
        // Get image URLs if any
        let imageURLs: string[] = [];
        if (contextMessage) {
            imageURLs = getImageURLsFromMessage(msg, contextMessage);
        } else {
            imageURLs = getImageURLsFromMessage(msg);
        }
        
        // Format the date for system prompt context
        const now = new Date().toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
        
        const modelName = "gemini-2.5-flash-image-preview";
        
        // Define generation config - always enable both text and image modalities
        const generationConfig: ExtendedGenerationConfig = {
            temperature: temperature,
            maxOutputTokens: maxOutputTokens,
            topP: 0.95,
            responseModalities: [MODALITIES.TEXT, MODALITIES.IMAGE],
        };
        
        // Initialize the model
        const geminiModel = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: generationConfig,
            safetySettings: [
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
            ],
        });
        
        // Adjust the prompt based on whether this is image-only mode
        let effectivePrompt = args.trim();
        if (imageOnly && !effectivePrompt.toLowerCase().startsWith("generate") && 
            !effectivePrompt.toLowerCase().startsWith("create")) {
            effectivePrompt = "Generate an image of " + effectivePrompt;
        }
        
        // Create chat instance with history
        let chat;
        if (history.length > 0) {
            chat = geminiModel.startChat({
                history: history,
                generationConfig: generationConfig
            });
        } else {
            chat = geminiModel.startChat({
                history: [{
                    role: "user", 
                    parts: [{ text: systemPrompt }] as Part[]
                }],
                generationConfig: generationConfig
            });
        }
        
        // Prepare content parts (text and images)
        const contentParts = await prepareContentParts(effectivePrompt, imageURLs);
        
        // Generate response
        const result = await chat.sendMessage(contentParts);
        const response = result.response;
        
        // Check if response has candidates
        if (response && response.candidates && response.candidates.length > 0) {
            // Check for safety finish reasons directly in candidates
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
        
        // Variables to track response components
        let responseText = "";
        let hasImages = false;
        
        // Check if response has text
        if (response && response.text) {
            responseText = response.text().trim();
        }
        
        // Process images in the response
        const rawResponse = response.candidates?.[0]?.content;
        const imagePaths = await processResponseImages(rawResponse);
        hasImages = imagePaths.length > 0;
        
        // If we have no text and no images, check for candidates with safety issues again
        // This catches the case in your error log where we have candidates with finishReason: 'IMAGE_SAFETY'
        // but no actual content
        if (!responseText && !hasImages && response && response.candidates && response.candidates.length > 0) {
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
        
        // If this was an image request but no images were generated (without safety trigger)
        if (imageOnly && !hasImages && responseText) {
            // Check if the response text indicates inability to generate an image
            if (responseText.toLowerCase().includes("can't generate") || 
                responseText.toLowerCase().includes("cannot generate") ||
                responseText.toLowerCase().includes("unable to generate") ||
                responseText.toLowerCase().includes("couldn't generate")) {
                await msg.reply("I couldn't generate that image. This might be due to content guidelines or technical limitations. Please try a different description.");
                return;
            }
        }
        
        // Reply with the text response
        let replyMessage;

        const attachments = [];

        for (const imagePath of imagePaths) {
            const attachment = new AttachmentBuilder(imagePath)
                .setName(imagePath.split('/').pop() || 'generated-image.png');

            attachments.push(attachment);
        }

        if (responseText) {
            if (responseText.length > 1999) {
                // Use replyLongMessage for text content
                const replies = await replyLongMessage(msg, responseText, { files: attachments });
                if (replies.length > 0) {
                    replyMessage = replies[0]; // Use the first message for history
                }
            } else {
                // Use regular reply for short messages
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
            // If we have no text or images and didn't catch any safety issues yet,
            // there might be a different issue or an empty response
            console.log("Empty response details:", response);
            
            // Check one more time for any finish reasons in the raw response object
            let errorMessage = "The Gemini API returned an empty response. Please try rephrasing or simplifying your prompt.";
            
            if (response && response.candidates && response.candidates.length > 0) {
                const finishReason = response.candidates[0].finishReason as string;
                if (finishReason && finishReason !== 'STOP') {
                    errorMessage = `The Gemini API couldn't complete this request (${finishReason}). Please try a different prompt.`;
                }
            }
            
            replyMessage = await msg.reply(errorMessage);
        }
        
        // Clean up temporary files
        for (const imagePath of imagePaths) {
            const fs = await import('fs/promises');
            await fs.unlink(imagePath).catch(console.error);
        }
        
        // Update chat history
        let updatedHistory: any[] = [];
        
        // Either use existing history or create new
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
        
        // Add current exchange
        updatedHistory.push({
            role: "user",
            parts: contentParts
        });
        
        // Add response parts
        const responseParts: any[] = [];
        if (responseText) {
            responseParts.push({ text: responseText });
        }
        
        // If there were images, add placeholders in the history
        if (hasImages) {
            responseParts.push({ text: "[IMAGE GENERATED]" });
        }
        
        updatedHistory.push({
            role: "model",
            parts: responseParts
        });
        
        // Cache updated history with the message ID
        if (replyMessage) {
            chatHistoryCache.set(replyMessage.id, updatedHistory);
        }
    } catch (error: any) {
        console.error("Error in Gemini handler:", error);
        
        let errorMessage = "An error occurred while processing your request.";
        
        // Enhanced error handling to extract more specific details
        if (error.message && typeof error.message === 'string') {
            // Check for common error types with better messaging
            if (error.message.includes("safety")) {
                errorMessage = "The Gemini API rejected this request due to safety policies. Please try a different prompt.";
            } else if (error.message.includes("invalid image") || error.message.includes("unsupported image")) {
                errorMessage = "The Gemini API couldn't process this image format. Please try a different image.";
            } else if (error.message.includes("Invalid value at 'generation_config.media_resolution'")) {
                errorMessage = "The Gemini API rejected the image quality settings. Please try again.";
            } else if (error.message.includes("First content should be with role")) {
                errorMessage = "The Gemini API rejected the conversation format. Please try starting a new conversation.";
            } else if (error.status === 400) {
                // More specific error for 400 status
                errorMessage = "The Gemini API rejected the request format. This might be a configuration issue.";
                // Try to extract field violations
                if (error.errorDetails && Array.isArray(error.errorDetails)) {
                    const violations = error.errorDetails.flatMap((detail: any) => 
                        detail.fieldViolations || []
                    );
                    if (violations.length > 0) {
                        const violationMessages = violations.map((v: any) => v.description || "Unknown field error").join("; ");
                        errorMessage = `Gemini API error: ${violationMessages}`;
                    }
                }
            } else if (error.status === 429) {
                errorMessage = "The Gemini API rate limit was exceeded. Please try again in a few minutes.";
            } else if (error.status === 500 || error.status === 503) {
                errorMessage = "The Gemini API is currently experiencing issues. Please try again later.";
            }
        }
        
        await msg.reply(errorMessage);
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
async function processResponseImages(response: any): Promise<string[]> {
    const imagePaths: string[] = [];
    
    // Check if the response contains parts with inline data
    if (response?.parts) {
        for (const part of response.parts) {
            if (part.inlineData) {
                const { mimeType, data } = part.inlineData;
                if (mimeType && mimeType.startsWith('image/')) {
                    const imagePath = await saveBase64ImageToFile(data, mimeType);
                    imagePaths.push(imagePath);
                }
            }
        }
    } else if (response?.candidates && response.candidates.length > 0) {
        for (const candidate of response.candidates) {
            if (candidate.content?.parts) {
                for (const part of candidate.content.parts) {
                    if (part.inlineData) {
                        const { mimeType, data } = part.inlineData;
                        if (mimeType && mimeType.startsWith('image/')) {
                            const imagePath = await saveBase64ImageToFile(data, mimeType);
                            imagePaths.push(imagePath);
                        }
                    }
                }
            }
        }
    }
    
    return imagePaths;
}

/**
 * Generate a single image using Gemini with timeout
 * @param {string} prompt - The image description
 * @param {GeminiOptions} options - Additional options
 * @param {ImageData|null} sourceImage - Optional source image for editing
 * @returns {Promise<string[]>} - Array of paths to saved images
 */
async function generateSingleImage(
    prompt: string, 
    options: GeminiOptions = {}, 
    sourceImage: ImageData | null = null
): Promise<string[]> {
    // Add timeout for reliability
    const timeoutMs = options.timeoutMs || 120_000;
    
    const timeoutPromise = new Promise<string[]>((_, reject) => {
        setTimeout(() => reject(new Error("Image generation timed out")), timeoutMs);
    });
    
    const generationPromise = async (): Promise<string[]> => {
        // Set defaults for image generation
        const imageOptions: GeminiOptions = {
            temperature: options.temperature || 1,
            maxOutputTokens: options.maxOutputTokens || 1024,
            imageOnly: true,
            systemPrompt: options.systemPrompt || "You are an artistic image generator. Focus on creating detailed, high-quality images based on the user's description with minimal explanatory text."
        };
        
        // Ensure the prompt is formatted for image generation or editing
        let effectivePrompt = prompt.trim();
        if (sourceImage) {
            // For image editing, use the prompt directly as instructions for editing
            if (!effectivePrompt.toLowerCase().includes("edit") && 
                !effectivePrompt.toLowerCase().includes("modify") &&
                !effectivePrompt.toLowerCase().includes("change")) {
                effectivePrompt = "Edit this image to " + effectivePrompt;
            }
        } else if (!effectivePrompt.toLowerCase().startsWith("generate") && 
                  !effectivePrompt.toLowerCase().startsWith("create")) {
            effectivePrompt = "Generate an image of " + effectivePrompt;
        }
        
        // Initialize the model
        const modelName = "gemini-2.5-flash-image-preview";
        
        const generationConfig: ExtendedGenerationConfig = {
            temperature: imageOptions.temperature,
            maxOutputTokens: imageOptions.maxOutputTokens,
            topP: 0.95,
            responseModalities: [MODALITIES.TEXT, MODALITIES.IMAGE],
        };
        
        const geminiModel = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: generationConfig,
            safetySettings: [
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
            ],
        });
        
        // Create chat instance
        const chat = geminiModel.startChat({
            history: [{
                role: "user", 
                parts: [{ text: imageOptions.systemPrompt || "" }] as Part[]
            }],
            generationConfig: generationConfig
        });
        
        // Prepare content parts
        const contentParts: Part[] = [{ text: effectivePrompt } as Part];
        
        // Add source image if provided
        if (sourceImage) {
            contentParts.push({
                inlineData: {
                    mimeType: sourceImage.mimeType,
                    data: sourceImage.data
                }
            } as InlineDataPart);
        }
        
        // Send message for image generation
        const result = await chat.sendMessage(contentParts);
        
        // Process and return image paths
        return processResponseImages(result.response.candidates?.[0]?.content);
    };
    
    // Race between timeout and generation
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
        // Send typing indicator if the channel has typing capability
        if (msg.channel && 'sendTyping' in msg.channel) {
            await msg.channel.sendTyping();
        }
        
        // Check for images in message or replied message
        let imageURLs = getImageURLsFromMessage(msg);
        let contextMessage: Message | undefined;
        
        // Check for replied message with image if no images in current message
        if (imageURLs.length === 0 && msg.reference?.messageId) {
            try {
                contextMessage = await msg.channel?.messages.fetch(msg.reference.messageId);
                if (contextMessage) {
                    imageURLs = getImageURLsFromMessage(contextMessage);
                }
            } catch (error) {
                console.error("Failed to fetch replied message:", error);
            }
        }
        
        // Generate multiple images
        if (imageURLs.length > 0) {
            // SOURCE IMAGE MODE: Use the first image as source for editing
            const sourceImageUrl = imageURLs[0];
            const sourceImageData = await fetchImageAsBase64(sourceImageUrl);
            
            if (!sourceImageData) {
                await msg.reply("Failed to process the source image. Please try with a different image.");
                return;
            }
            
            // Generate variations with the source image
            const imagePromises = [];
            for (let i = 0; i < 3; i++) {
                const temperature = 1 + (0.1 * i);

                imagePromises.push(
                    generateSingleImage(args, { temperature }, sourceImageData)
                );
            }
            
            // Use Promise.allSettled to handle partial successes
            const results = await Promise.allSettled(imagePromises);
            
            // Collect successful image paths and error messages
            results.forEach(result => {
                if (result.status === 'fulfilled') {
                    allImagePaths.push(...result.value);
                } else if (result.status === 'rejected') {
                    // Extract error message
                    let errorMsg = "Unknown error";
                    if (result.reason instanceof Error) {
                        errorMsg = result.reason.message;
                    } else if (typeof result.reason === 'string') {
                        errorMsg = result.reason;
                    } else if (result.reason && typeof result.reason === 'object') {
                        errorMsg = JSON.stringify(result.reason);
                    }
                    errorMessages.push(errorMsg);
                }
            });
        } else {
            // NO SOURCE IMAGE MODE: Generate from text only
            const imagePromises = [];
            for (let i = 0; i < 3; i++) {
                const temperature = 1 + (0.1 * i);

                imagePromises.push(generateSingleImage(args, { temperature }));
            }
            
            // Use Promise.allSettled to handle partial successes
            const results = await Promise.allSettled(imagePromises);
            
            // Collect successful image paths and error messages
            results.forEach(result => {
                if (result.status === 'fulfilled') {
                    allImagePaths.push(...result.value);
                } else if (result.status === 'rejected') {
                    // Extract error message
                    let errorMsg = "Unknown error";
                    if (result.reason instanceof Error) {
                        errorMsg = result.reason.message;
                    } else if (typeof result.reason === 'string') {
                        errorMsg = result.reason;
                    } else if (result.reason && typeof result.reason === 'object') {
                        errorMsg = JSON.stringify(result.reason);
                    }
                    errorMessages.push(errorMsg);
                }
            });
        }
        
        if (allImagePaths.length === 0) {
            // If we have error messages, provide them to the user
            if (errorMessages.length > 0) {
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
        
        // Extract detailed error information
        let errorMessage = "An error occurred while generating images.";
        
        if (error instanceof Error) {
            // Process the error message to extract useful information
            const errMsg = error.message;
            
            if (errMsg.includes("safety") || errMsg.includes("Safety")) {
                errorMessage = "The Gemini API rejected this request due to safety policies. Please try a different prompt.";
            } else if (errMsg.includes("timeout") || errMsg.includes("timed out")) {
                errorMessage = "The image generation process timed out. Please try a simpler description.";
            } else if (errMsg.includes("invalid image") || errMsg.includes("unsupported image")) {
                errorMessage = "The Gemini API couldn't process this image format. Please try a different image.";
            } else if (errMsg.includes("rate limit") || errMsg.includes("quota")) {
                errorMessage = "The Gemini API rate limit was exceeded. Please try again later.";
            } else if (errMsg.includes("500") || errMsg.includes("503") || errMsg.includes("server")) {
                errorMessage = "The Gemini API is currently experiencing issues. Please try again later.";
            } else {
                // Include a sanitized version of the error message
                // Remove any sensitive information like API keys
                const sanitizedMsg = errMsg.replace(/key[-=a-zA-Z0-9]{5,}/g, "[API_KEY]");
                errorMessage = `Error: ${sanitizedMsg}. Please try again with a different prompt.`;
            }
        } else if (typeof error === 'string') {
            errorMessage = `Error: ${error}. Please try again with a different prompt.`;
        } else if (error && typeof error === 'object') {
            try {
                // For API errors that might be objects with status codes and messages
                const errorObj = error as any;
                if (errorObj.status) {
                    errorMessage = `API Error (${errorObj.status}): `;
                    if (errorObj.message) {
                        errorMessage += errorObj.message;
                    } else if (errorObj.error) {
                        errorMessage += errorObj.error;
                    } else {
                        errorMessage += "Unknown error";
                    }
                } else {
                    errorMessage = `Error: ${JSON.stringify(error)}`;
                }
            } catch (e) {
                errorMessage = "An unexpected error occurred. Please try again.";
            }
        }
        
        await msg.reply(errorMessage);
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
        
        // Get image URLs from message or replied message
        let imageURLs = getImageURLsFromMessage(msg);
        
        // Check for replied message with image if no images in current message
        if (imageURLs.length === 0 && msg.reference?.messageId) {
            try {
                const contextMessage = await msg.channel?.messages.fetch(msg.reference.messageId);
                imageURLs = getImageURLsFromMessage(contextMessage);
            } catch (error) {
                console.error("Failed to fetch replied message:", error);
            }
        }
        
        if (imageURLs.length === 0) {
            await msg.reply("Please provide an image to add a caption to. You can upload an image with your command or reply to a message containing an image.");
            return;
        }
        
        // We'll only use the first image if multiple are provided
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
        
        // Initialize the model
        const modelName = "gemini-2.5-flash-image-preview";
        
        const generationConfig: ExtendedGenerationConfig = {
            temperature: 1,
            maxOutputTokens: 512,
            topP: 0.95,
            responseModalities: [MODALITIES.TEXT, MODALITIES.IMAGE],
        };
        
        const geminiModel = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: generationConfig,
            safetySettings: [
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
            ],
        });
        
        // Create chat instance
        const chat = geminiModel.startChat({
            history: [{
                role: "user", 
                parts: [{ text: systemPrompt }] as Part[]
            }],
            generationConfig: generationConfig
        });
        
        // Prepare content parts with both text and image
        const contentParts: Part[] = [
            { text: captionPrompt } as Part,
            {
                inlineData: {
                    mimeType: imageData.mimeType,
                    data: imageData.data
                }
            } as InlineDataPart
        ];
        
        // Generate response
        const result = await chat.sendMessage(contentParts);
        const response = result.response;
        
        // Process images in the response
        const generatedImagePaths = await processResponseImages(response.candidates?.[0]?.content);
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
        let errorMessage = "An error occurred while adding the caption. Please try again with a different image or caption text.";
        
        if (error instanceof Error && error.message) {
            if (error.message.includes("safety")) {
                errorMessage = "The Gemini API rejected this request due to safety policies. Please try a different image or caption.";
            }
        }
        
        await msg.reply(errorMessage);
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
