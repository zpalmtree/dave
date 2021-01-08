import {
    Guild,
    Message,
    MessageEmbed,
    MessageReaction,
    User,
    TextChannel,
} from 'discord.js';

import translate = require('@vitalets/google-translate-api');

import { RGB } from './Types';
import { config } from './Config';

export function addReaction(emoji: string, message: Message): void {
    /* Find the reaction */
    const reaction = message.guild!.emojis.resolve(emoji);

    /* Couldn't find the reaction */
    if (!reaction) {
        console.error(`Failed to find emoji: ${emoji} on the server!`);
        return;
    }

    /* Add the reaction */
    message.react(reaction).catch(console.error);
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
    if (msg.channel.id === config.mainChannel) {
        return true;
    }

    if (msg.author.id === config.god) {
        return true;
    }

    if (react) {
        msg.react('❌');
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

export function getLanguageNames() {
    const languages = Object.values(translate.languages)
        .filter((x) => typeof x === 'string');

    /* First language is 'Automatic' */
    return languages.slice(1);
}
