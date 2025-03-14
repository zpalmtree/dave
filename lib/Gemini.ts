import {
    Message,
    EmbedBuilder,
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
        
        // Create typing indicator to show processing
        await msg.channel.sendTyping();
        
        // Check for replied message for context
        const replyMsgId = msg?.reference?.messageId;
        let history: any[] = [];
        let replyMessage: Message | undefined;
        
        if (replyMsgId) {
            const cachedHistory = chatHistoryCache.get(replyMsgId);
            if (cachedHistory) {
                history = cachedHistory;
            }
            
            // If no history found but replying to message, fetch it for context
            if (history.length === 0) {
                try {
                    replyMessage = await msg.channel?.messages.fetch(replyMsgId);
                } catch (error) {
                    console.error("Failed to fetch replied message:", error);
                }
            }
        }
        
        // Get image URLs if any
        let imageURLs: string[] = [];
        if (replyMessage) {
            imageURLs = getImageURLsFromMessage(msg, replyMessage);
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
        // Removed mediaResolution: "HIGH" that was causing the error
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
            // Add system prompt as first message when starting new chat
            const fullSystemPrompt = `System Information (do not use in image generation) [The current date is ${now}. The person interacting with you is named ${username}].${systemPrompt}`;
            
            // For image-only mode, add an additional instruction
            const initialPrompt = imageOnly 
                ? fullSystemPrompt + " Focus primarily on generating images based on the user's description with minimal text explanation."
                : fullSystemPrompt;
            
            chat = geminiModel.startChat({
                history: [{
                    role: "user", 
                    parts: [{ text: initialPrompt }]
                }],
                generationConfig: generationConfig
            });
        }
        
        // Indicate processing first before sending the actual request
        const processingMsg = await msg.reply(imageOnly ? 
            "Generating image... Please wait, this may take a moment." : 
            "Processing your request...");
        
        // Prepare content parts (text and images)
        const contentParts = await prepareContentParts(effectivePrompt, imageURLs);
        
        // Generate response
        const result = await chat.sendMessage(contentParts);
        const response = result.response;
        
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
        
        // Update the processing message with the text response (if appropriate)
        if (responseText && (!imageOnly || !hasImages)) {
            await processingMsg.edit(truncateResponse(responseText));
        } else if (hasImages && imageOnly) {
            // For image-only mode with successful image generation, 
            // either keep the "generating" message or replace with minimal text
            if (responseText.length > 200) {
                // If there's substantial text, truncate it significantly
                await processingMsg.edit(responseText.substring(0, 200) + "...");
            } else {
                // Otherwise use a simple message
                await processingMsg.edit("Here's your generated image:");
            }
        }
        
        // Send any generated images
        if (hasImages) {
            for (const imagePath of imagePaths) {
                await msg.channel.send({
                    files: [{
                        attachment: imagePath,
                        name: imagePath.split('/').pop() || 'generated-image.png'
                    }]
                });
                
                // Clean up the temporary file
                const fs = await import('fs/promises');
                await fs.unlink(imagePath).catch(console.error);
            }
        } else if (imageOnly) {
            // If image-only mode but no images generated, inform the user
            await processingMsg.edit(responseText || "I couldn't generate an image based on your request. Please try a different description.");
        } else if (!responseText) {
            // No text or images in response
            await processingMsg.edit("I couldn't generate a response. Please try again.");
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
        chatHistoryCache.set(processingMsg.id, updatedHistory);
    } catch (error: any) {
        console.error("Error in Gemini handler:", error);
        
        let errorMessage = "An error occurred while processing your request.";
        
        // Enhanced error handling to extract more specific details
        if (error.message && typeof error.message === 'string') {
            // Check for common error types with better messaging
            if (error.message.includes("safety")) {
                errorMessage = "I couldn't respond to that due to safety concerns.";
            } else if (error.message.includes("invalid image") || error.message.includes("unsupported image")) {
                errorMessage = "There was a problem processing the image. Please try a different image format.";
            } else if (error.message.includes("Invalid value at 'generation_config.media_resolution'")) {
                errorMessage = "There was a configuration issue with the image quality settings. Please try again.";
            } else if (error.message.includes("First content should be with role")) {
                errorMessage = "There was an issue with the conversation history format. Please try starting a new conversation.";
            } else if (error.status === 400) {
                // More specific error for 400 status
                errorMessage = "The request format was invalid. This might be due to a configuration issue.";
                // Try to extract field violations
                if (error.errorDetails && Array.isArray(error.errorDetails)) {
                    const violations = error.errorDetails.flatMap((detail: any) => 
                        detail.fieldViolations || []
                    );
                    if (violations.length > 0) {
                        const violationMessages = violations.map((v: any) => v.description || "Unknown field error").join("; ");
                        errorMessage = `Request error: ${violationMessages}`;
                    }
                }
            } else if (error.status === 429) {
                errorMessage = "Rate limit exceeded. Please try again in a few minutes.";
            } else if (error.status === 500 || error.status === 503) {
                errorMessage = "The Gemini service is currently experiencing issues. Please try again later.";
            }
            
            // Log the full error details for debugging
            console.error(`Gemini error:`, error);
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
    const tempDir = './temp';
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
