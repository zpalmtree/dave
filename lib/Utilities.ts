import * as path from 'path';
import * as fs from 'fs';

import { RGB } from './Types';
import { promisify } from 'util';

import {
    Message,
    MessageEmbed,
    MessageReaction,
    User,
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

export async function paginate<T>(
    msg: Message,
    itemsPerPage: number,
    displayFunction: (item: T) => any,
    data: T[],
    embed: MessageEmbed,
    addInitialFooter: boolean = false) {

    for (const item of data.slice(0, itemsPerPage)) {
        const newFields = displayFunction(item);

        if (newFields) {
            embed.addFields(displayFunction(item));
        }
    }

    const shouldPaginate = data.length > itemsPerPage;

    let currentPage = 1;
    const totalPages = Math.floor(data.length / itemsPerPage)
                     + (data.length % itemsPerPage ? 1 : 0);

    if (shouldPaginate) {
        if (addInitialFooter) {
            embed.setFooter(`Page ${currentPage} of ${totalPages}`);
        }
    }

    const sentMessage = await msg.channel.send(embed);

    if (!shouldPaginate) {
        return;
    }

    let lock = {
        locked: false,
        lockedId: '',
    };

    await sentMessage.react('⬅️');
    await sentMessage.react('➡️');

    /* Not essential to be ordered or to block execution, lets do these non async */
    sentMessage.react('🔒');
    sentMessage.react('❌');

    const collector = sentMessage.createReactionCollector((reaction, user) => {
        return ['⬅️', '➡️', '🔒', '❌'].includes(reaction.emoji.name) && !user.bot;
    }, { time: 600000, dispose: true }); // 10 minutes

    const changePage = (amount: number, reaction: MessageReaction, user: User) => {
        reaction.users.remove(user.id);

        if (lock.locked && user.id !== lock.lockedId) {
            console.log(`currently locked by ${lock.lockedId}, you cannot change`);
            return;
        }

        /* Check we can move this many pages */
        if (currentPage + amount >= 1 && currentPage + amount <= totalPages) {
            currentPage += amount;
        } else {
            return;
        }

        embed.fields = [];
        embed.setFooter(`Page ${currentPage} of ${totalPages}`);

        const startIndex = (currentPage - 1) * itemsPerPage;
        const endIndex = (currentPage) * itemsPerPage;

        for (const item of data.slice(startIndex, endIndex)) {
            const newFields = displayFunction(item);

            if (newFields) {
                embed.addFields(displayFunction(item));
            }
        }

        sentMessage.edit(embed);
    };

    const lockEmbed = (reaction: MessageReaction, user: User) => {
        const allowedRoles = [
            'Mod',
            'Los de Intendencia'
        ];

        console.log(`${user.username} lock/unlocking`);
        console.log('current status: ' + JSON.stringify(lock));

        const guildUser = msg.guild!.members.cache.get(user.id);

        if (!guildUser) {
            reaction.users.remove(user.id);
            return;
        }

        for (let role of allowedRoles) {
            /* User has permission to perform action */
            if (guildUser.roles.cache.some((r) => r.name === role)) {
                console.log('user has permission');

                /* Embed is currently locked */
                if (lock.locked) {
                    console.log('embed is currently locked');

                    reaction.users.remove(user.id);

                    /* Locker is the current user, remove the lock */
                    if (lock.lockedId === user.id) {
                        console.log('removing lock');

                        lock.locked = false;
                        lock.lockedId = '';
                    /* Locker is not the current user, do nothing, it's locked */
                    } else {
                        reaction.users.remove(user.id);
                    }
                /* Embed is unlocked, lock it */
                } else {
                    console.log('adding lock');

                    lock.locked = true;
                    lock.lockedId = user.id;
                }

                return;
            }
        }

        reaction.users.remove(user.id);
    };

    const removeEmbed = (reaction: MessageReaction, user: User) => {
        const allowedRoles = [
            'Mod',
            'Los de Intendencia'
        ];

        const guildUser = msg.guild!.members.cache.get(user.id);

        if (!guildUser) {
            reaction.users.remove(user.id);
            return;
        }

        for (let role of allowedRoles) {
            if (guildUser.roles.cache.some((r) => r.name === role)) {
                sentMessage.delete();
                return;
            }
        }

        reaction.users.remove(user.id);
    };

    collector.on('collect', async (reaction: MessageReaction, user: User) => {
        switch (reaction.emoji.name) {
            case '⬅️': {
                changePage(-1, reaction, user);
                break;
            }
            case '➡️': {
                changePage(1, reaction, user);
                break;
            }
            case '🔒': {
                lockEmbed(reaction, user);
                break;
            }
            case '❌': {
                removeEmbed(reaction, user);
                break;
            }
            default: {
                console.log('default case in paginate');
                break;
            }
        }
     });

    collector.on('remove', async (reaction: MessageReaction, user: User) => {
        switch (reaction.emoji.name) {
            case '🔒': {
                lockEmbed(reaction, user);
                break;
            }
            default: {
                break;
            }
        }
     });
}
