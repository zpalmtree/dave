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
import translate from '@vitalets/google-translate-api';
import { PublicKey } from '@solana/web3.js'

import { RGB } from './Types.js';
import { config } from './Config.js';

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

export function getLanguageNames() {
    const languages = Object.values(translate.languages)
        .filter((x) => typeof x === 'string');

    /* First language is 'Automatic' */
    return languages.slice(1);
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
            offset: -5,
            label: 'CDT',
        };
    } else {
        return {
            offset: -6,
            label: 'CST',
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