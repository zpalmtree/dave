import {
    Message,
    EmbedBuilder,
    AttachmentBuilder,
} from 'discord.js';
import { GoogleGenerativeAI, GenerateContentRequest, GenerateContentResult, Content, GenerationConfig, Part } from '@google/generative-ai';
import { config } from './Config.js';
import {
    truncateResponse,
    getUsername,
    getImageURLsFromMessage,
} from './Utilities.js';

// Define interfaces for our handler
interface GeminiOptions {
    systemPrompt?: string;
    temperature?: number;
    maxOutputTokens?: number;
    imageOnly?: boolean;
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
            temperature = 0.7,
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
        
        // Always use the experimental model that supports image generation
        const modelName = "models/gemini-2.0-flash-exp";
        
        // Define generation config - always enable both text and image modalities
        const generationConfig: any = {
            temperature: temperature,
            maxOutputTokens: maxOutputTokens,
            topP: 0.9,
            topK: 40,
            responseModalities: [MODALITIES.TEXT, MODALITIES.IMAGE]
        };
        
        // Initialize the model
        const geminiModel = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: generationConfig,
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
                    parts: [{ text: systemPrompt }]
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
            replyMessage = await msg.reply({
                files: attachments,
                content: truncateResponse(responseText),
            });
        } else if (attachments.length > 0) {
            replyMessage = await msg.reply({
                files: attachments,
                content: "Here's your generated image:",
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
        chatHistoryCache.set(replyMessage.id, updatedHistory);
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
 * Handle Gemini image generation (mainly for backward compatibility)
 * @param {Message} msg - Discord message object
 * @param {string} args - Message content
 * @returns {Promise<void>}
 */
export async function handleGeminiImageGen(msg: Message, args: string): Promise<void> {
    // Use the main handler with imageOnly flag
    await handleGemini(msg, args, {
        imageOnly: true,
        systemPrompt: "You are an artistic image generator. Focus on creating detailed, high-quality images based on the user's description with minimal explanatory text."
    });
}

// Export additional functions as needed for your Discord bot
export default {
    handleGemini,
    handleGeminiImageGen
};
