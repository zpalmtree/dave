import {
    Guild,
    Message,
    MessageReaction,
    User,
    TextChannel,
    escapeMarkdown,
} from 'discord.js';

import moment from 'moment';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { PublicKey } from '@solana/web3.js'

import { RGB } from './Types.js';
import { config } from './Config.js';

const SLUGS_GUILD = '891069801173237800';

const SlugRoles = {
    SLUG_HOLDER: "957503404404527144",
    SLUG_GANG: "961026739704844308",
    SLUG_BOSS: "891077439277645884",
}

/* If we're running in the slugs server, this user must be a burner or holder */
export function slugUserGate(message: Message): { canAccess: boolean, error?: string } {
    if (!message.guild) {
        return {
            canAccess: true,
            error: undefined,
        };
    }

    if (message.guild.id !== SLUGS_GUILD) {
        return {
            canAccess: true,
            error: undefined,
        };
    }

    if (!message.member) {
        return {
            canAccess: true,
            error: undefined,
        };
    }

    const specialUsers = [
        '523335703913037837',
    ];

    if (specialUsers.includes(message.author.id)) {
        return {
            canAccess: true,
            error: undefined,
        };
    }

    const canAccess = Object.values(SlugRoles).some((id) => message.member!.roles.cache.has(id));

    if (!canAccess) {
        return {
            canAccess: false,
            error: `Sorry, this command is usable for slug holders or burners only. [Buy Sol Slugs!](https://www.tensor.trade/trade/sol_slugs)`,
        };
    }

    return {
        canAccess: true,
        error: undefined,
    };
}

export function numberWithCommas(s: string) {
    return s.replace(/\B(?<!\.\d*)(?=(\d{3})+(?!\d))/g, ",");
}

export function isValidSolAddress(address: string) {
    try {
        const pubkey = new PublicKey(address);
        return PublicKey.isOnCurve(pubkey.toBuffer());
    } catch (error) {
        return false;
    }
}

export function chunk(arr: string, len: number) {
    const chunks = [];
    let i = 0;
    const n = arr.length;

    while (i < n) {
        chunks.push(arr.slice(i, i += len));
    }

    return chunks;
}

export function capitalize(str: string): string {
    return str && str[0].toUpperCase() + str.slice(1);
}

export function capitalizeAllWords(str: string): string {
    return str.split(' ').map(capitalize).join(' ');
}

export async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function haveRole(msg: Message, role: string): boolean {
    if (!msg.member) {
        return false;
    }

    return msg.member.roles.cache.some((r) => r.name === role);
}

// convert a hex value (#212233) to an RGB object ({ r: 33, g: 34, b: 51 })
export function hexToRGB(hex: string): RGB {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
    } : {r: 0, g: 0, b: 0};
}

// convert an RGB object ({ r: 31, g: 127, b: 255 }) to a hex value (#207fff)
export function rgbToHex(rgb: RGB): string {
    return `#${componentToHex(rgb.r)}${componentToHex(rgb.g)}${componentToHex(rgb.b)}`;
}

function componentToHex(c: number) {
    const hex = c.toString(16);
    return hex.length === 1 ? `0${hex}` : hex;
}

export function pickRandomItem<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)];
}

export function shuffleArray(array: any[]) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

export function canAccessCommand(msg: Message, react: boolean): boolean {
    if (config.privilegedChannels.includes(msg.channel.id)) {
        return true;
    }

    if (msg.author.id === config.god) {
        return true;
    }

    if (react) {
        tryReactMessage(msg, '❌');
    }

    return false;
}

export async function getUsername(id: string, guild: Guild | null | undefined): Promise<string> {
    const ping = `<@${id}>`;
 
    if (!guild) {
        return ping;
    }

    try {
        const user = await guild.members.fetch(id);

        if (!user) {
            return ping;
        }

        return user.displayName;
    } catch (err) {
        return ping;
    }
}

export function roundToNPlaces(num: number, places: number) {
    const x = Math.pow(10, places);

    return Math.round((num + Number.EPSILON) * x) / x;
}

export function formatLargeNumber(num: number): string {
    const million = 1_000_000;
    const billion = 1000 * million;
    const trillion = 1000 * billion;
    const quadrillion = 1000 * trillion;
    const quintillion = 1000 * quadrillion;
    const sextillion = 1000 * quintillion;
    const septillion = 1000 * sextillion;
    const octillion = 1000 * septillion;
    const nonillion = 1000 * octillion;
    const decillion = 1000 * nonillion;

    if (num < million) {
        return num.toString();
    }

    if (num < billion) {
        return `${roundToNPlaces(num / million, 2)} million`;
    }

    if (num < trillion) {
        return `${roundToNPlaces(num / billion, 2)} billion`;
    }

    if (num < quadrillion) {
        return `${roundToNPlaces(num / trillion, 2)} trillion`;
    }

    if (num < quintillion) {
        return `${roundToNPlaces(num / quadrillion, 2)} quadrillion`;
    }

    if (num < sextillion) {
        return `${roundToNPlaces(num / quintillion, 2)} quintillion`;
    }

    if (num < septillion) {
        return `${roundToNPlaces(num / sextillion, 2)} sextillion`;
    }

    if (num < octillion) {
        return `${roundToNPlaces(num / septillion, 2)} septillion`;
    }

    if (num < nonillion) {
        return `${roundToNPlaces(num / octillion, 2)} octillion`;
    }

    if (num < decillion) {
        return `${roundToNPlaces(num / decillion, 2)} decillion`;
    }

    /* Whatever, who the fuck even knows the names of numbers this big. */
    return num.toString();

}

export async function tryDeleteMessage(msg: Message) {
    try {
        await msg.delete();
    } catch (err) {
        console.log(`Failed to delete message ${msg.id}, ${(err as any).toString()}, ${(err as any).stack}`);
    }
}

export async function tryReactMessage(msg: Message, reaction: string) {
    try {
        await msg.react(reaction);
    } catch (err) {
        console.log(`Failed to react with ${reaction} to message ${msg.id}, ${(err as any).toString()}, ${(err as any).stack}`);
    }
}

export async function tryDeleteReaction(reaction: MessageReaction, id: string) {
    try {
        await reaction.users.remove(id);
    } catch (err) {
        console.log(`Failed to remove reaction ${reaction.emoji.name} for ${id}, ${(err as any).toString()}, ${(err as any).stack}`);
    }
}

export async function uploadToImgur(image: any, filename?: string): Promise<string> {
    const form = new FormData();

    form.append('image', image, {
        filename,
    });

    const response = await fetch(`https://api.imgur.com/3/image`, {
        method: 'POST',
        headers: {
            'Authorization': `Client-ID ${config.imgurClientId}`,
        },
        body: form,
    });

    const data = await response.json();

    if (!data.success) {
        throw new Error(data.data.error.message);
    }

    return data.data.link;
}

export function getDefaultTimeZone() {
    if (moment().isDST()) {
        return {
            offset: -4,
            label: 'EDT',
        };
    } else {
        return {
            offset: -5,
            label: 'EST',
        };
    }
}

export function escapeDiscordMarkdown(text: string) {
    return escapeMarkdown(
        text,
        {
            codeBlock: true,
            inlineCode: true,
            bold: true,
            italic: true,
            underline: true,
            strikethrough: true,
            spoiler: true,
            codeBlockContent: true,
            inlineCodeContent: true,
            escape: true,
            heading: true,
            bulletedList: true,
            numberedList: true,
            maskedLink: true,
        },
    );
}

export async function handleGetFromME(url: string) {    
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error("failed to fetch from API");
    }
    const data = await res.json();
    return data;
}

export function isCapital(char: string) {
    const charCode = char.charCodeAt(0);
    return (charCode >= 65 && charCode <= 90);
}

export function truncateResponse(msg: string, limit: number = 1999): string {
    return msg.slice(0, limit);
}

/**
 * Splits a message into multiple parts if it exceeds the Discord character limit
 * @param message The message to split
 * @param limit The character limit per message (default: 1999)
 * @returns An array of message parts
 */
export function splitMessage(message: string, limit: number = 1999): string[] {
    if (!message) return [];
    if (message.length <= limit) return [message];

    const parts: string[] = [];
    let currentIndex = 0;

    while (currentIndex < message.length) {
        // Find a good split point (at a newline, space, or punctuation if possible)
        let endIndex = currentIndex + limit;
        
        if (endIndex >= message.length) {
            // Last part
            parts.push(message.slice(currentIndex));
            break;
        }
        
        // Look for a better split point by moving backward from the limit
        let splitIndex = endIndex;
        
        // Try to find a newline first
        const newlineIndex = message.lastIndexOf('\n', endIndex);
        if (newlineIndex > currentIndex && newlineIndex > endIndex - 100) {
            splitIndex = newlineIndex + 1; // Include the newline in the first part
        } else {
            // Then try to find a space
            const spaceIndex = message.lastIndexOf(' ', endIndex);
            if (spaceIndex > currentIndex && spaceIndex > endIndex - 30) {
                splitIndex = spaceIndex + 1; // Include the space in the first part
            } else {
                // If no good natural break found, look for punctuation
                for (let i = endIndex; i > endIndex - 30 && i > currentIndex; i--) {
                    const char = message[i];
                    if ('.!?,;:)]}'.includes(char)) {
                        splitIndex = i + 1;
                        break;
                    }
                }
            }
        }
        
        // Fall back to hard split if no good break point found
        if (splitIndex === endIndex && splitIndex > currentIndex) {
            // Just split at the limit
            splitIndex = endIndex;
        }
        
        // Add this part
        parts.push(message.slice(currentIndex, splitIndex));
        currentIndex = splitIndex;
    }

    return parts;
}

/**
 * Sends a message as multiple parts if it exceeds Discord's character limit
 * @param channel The Discord channel to send the message to
 * @param content The content to send
 * @param options Additional options for the message
 * @returns An array of sent messages
 */
export async function sendLongMessage(
    channel: import('discord.js').TextBasedChannel,
    content: string,
    options: any = {}
): Promise<import('discord.js').Message[]> {
    const parts = splitMessage(content);
    const messages: import('discord.js').Message[] = [];
    
    for (const part of parts) {
        if ('send' in channel) {
            const sentMessage = await (channel as TextChannel).send({
                ...options,
                content: part
            });
            messages.push(sentMessage);
        }
    }
    
    return messages;
}

/**
 * Replies to a message with content that may exceed Discord's character limit
 * @param message The message to reply to
 * @param content The content of the reply
 * @param options Additional options for the reply
 * @returns An array of sent reply messages
 */
export async function replyLongMessage(
    message: import('discord.js').Message,
    content: string,
    options: any = {}
): Promise<import('discord.js').Message[]> {
    const parts = splitMessage(content);
    const messages: import('discord.js').Message[] = [];
    
    for (let i = 0; i < parts.length; i++) {
        // Only use reply reference for the first message to avoid multiple notifications
        let replyOptions: any;
        if (i === 0) {
            replyOptions = options;
        } else {
            const { files: _files, attachments: _attachments, ...rest } = options || {};
            replyOptions = {
                ...rest,
                failIfNotExists: false,
            };
        }
        
        const sentMessage = await message.reply({
            ...replyOptions,
            content: parts[i]
        });
        
        messages.push(sentMessage);
    }
    
    return messages;
}

export function extractURLs(messageContent: string): string[] {
    // This regular expression is designed to match most common URLs.
    const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%_+.~#?&//=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_+.~#?&//=]*)/gi;

    // Use the match method to find all the matches in the given message content.
    const urls = messageContent.match(urlRegex);

    // If there are URLs found, return them; otherwise, return an empty array.
    return urls ? urls : [];
}

export function extractURLsAndValidateExtensions(
    messageContent: string, 
    extensions: string[]
): { validURLs: string[], invalidURLs: string[] } {
    // Join the extensions into a string to insert into the regex pattern
    const extensionsPattern = extensions.join('|');

    // URL regex with a group for possible filenames at the end
    const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi;

    // Iterate over all matches and separate valid from invalid URLs
    const validURLs: string[] = [];
    const invalidURLs: string[] = [];
    let match;

    while ((match = urlRegex.exec(messageContent)) !== null) {
        const url = match[0];

        const extensionRegex = /\/(\w+)\.(\w{3,4})($|\?)/i;

        const extensionMatch = url.match(extensionRegex);

        if (extensionMatch && extensionMatch.length >= 3) {
            const fileExtension = extensionMatch[2].toLowerCase();
            if (extensions.includes(fileExtension)) {
                validURLs.push(url);
            } else {
                invalidURLs.push(url);
            }
        } else {
            // No recognizable file extension - not an image URL
            invalidURLs.push(url);
        }
    }

    return {
        validURLs,
        invalidURLs,
    }
};

export function monthDurationToSeconds(months: string): number {
    const now = moment();
    const futureDate = moment().add(months, 'months');
    return futureDate.unix() - now.unix();
}

export function getImageURLsFromMessage(
    msg: Message,
    repliedMessage?: Message,
): string[] {
    const urlSet = new Set<string>();
    const supportedExtensions = ['png', 'gif', 'jpg', 'jpeg', 'webp'];
    const supportedMimeTypes = ['image/png', 'image/gif', 'image/jpeg', 'image/webp'];

    function processMessage(message: Message) {
        // Check attachments
        message.attachments.forEach((attachment) => {
            if (supportedMimeTypes.includes(attachment.contentType || '')) {
                urlSet.add(attachment.url);
            } else {
                const extension = attachment.name?.split('.').pop()?.toLowerCase();
                if (extension && supportedExtensions.includes(extension)) {
                    urlSet.add(attachment.url);
                }
            }
        });

        // Check embeds
        message.embeds.forEach((embed) => {
            if (embed.image) urlSet.add(embed.image.url);
            if (embed.thumbnail) urlSet.add(embed.thumbnail.url);
        });

        // Extract URLs from content
        const { validURLs } = extractURLsAndValidateExtensions(
            message.content,
            supportedExtensions,
        );
        validURLs.forEach((url) => urlSet.add(url));
    }

    processMessage(msg);
    if (repliedMessage) {
        processMessage(repliedMessage);
    }

    return Array.from(urlSet);
}

// Type guard for sendable channels
export function isSendableChannel(channel: import('discord.js').TextBasedChannel): channel is import('discord.js').TextBasedChannel & { send: TextChannel['send']; sendTyping: TextChannel['sendTyping'] } {
    return 'send' in channel && typeof (channel as any).send === 'function';
}

// helper ­– put in a shared util file
export function withTyping<T>(
  channel: import('discord.js').TextBasedChannel,
  fn: () => Promise<T>,
) {
  let keepAlive: NodeJS.Timeout | undefined;

  const start = async () => {
    if (!isSendableChannel(channel)) return;
    await channel.sendTyping();               // immediately
    keepAlive = setInterval(
      () => (channel as any).sendTyping?.().catch(() => {}), // refresh every 8 s
      8_000,
    );
  };
  const stop = () => keepAlive && clearInterval(keepAlive);

  return (async () => {
    await start();
    try {
      return await fn();
    } finally {
      stop();
    }
  })();
}
