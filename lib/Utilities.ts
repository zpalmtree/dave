import * as path from 'path';
import * as fs from 'fs';

import { promisify } from 'util';

import {
    Message
} from 'discord.js';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

export async function readJSON<T>(filepath: string): Promise<{ err: string | undefined, data: T[] }> {
    try {
        const data: string = await readFile(path.join(__dirname, filepath), { encoding: 'utf8' });

        return {
            err: undefined,
            data: JSON.parse(data),
        };
    } catch (err) {
        return {
            err: err.toString(),
            data: [],
        }
    }
}

export async function writeJSON(filepath: string, data: any): Promise<void> {
    try {
        await writeFile(path.join(__dirname, filepath), JSON.stringify(data, null, 4));
    } catch (err) {
        console.log(err);
    }
}

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
