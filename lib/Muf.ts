import {
    Message,
    MessageAttachment,
    MessageEmbed,
} from 'discord.js';
import {
    Paginate,
    DisplayType,
} from './Paginate';
import * as moment from 'moment';

import { config } from './Config';
import {
    getUsername,
    capitalize,
} from './Utilities';

const cachedMessages = new Map<string, Message[]>();

interface Page {
    content: string;
    attachment?: string;
    timestamp: number;
}

export async function handleMuf(msg: Message) {
    if (config.usersToCacheDeletions.length === 0) {
        msg.reply({
            content: 'No stored deleted messages.',
        });
        return;
    }

    const [ userId ] = config.usersToCacheDeletions;

    const existingMessages = cachedMessages.get(userId) || [];

    if (existingMessages.length === 0) {
        msg.reply({
            content: 'No stored deleted messages.',
        });
        return;
    }

    const username = await getUsername(userId, msg.guild);

    const embed = new MessageEmbed()
        .setTitle(`${capitalize(username)}'s last ${existingMessages.length} deleted messages`);

    const pages: Page[][] = [];

    /* Buffer of entries for a single page. May be either one attachment, or
     * multiple string messages. */
    let pageData: Page[] = [];

    for (const message of existingMessages) {
        let initial = true;

        if (message.attachments.size > 0) {
            if (pageData.length !== 0) {
                pages.push(pageData);
            }

            for (const attachment of [...message.attachments.values()]) {
                /* Only include content with first attachment */
                pages.push([{
                    content: initial ? message.content : '',
                    attachment: attachment.url,
                    timestamp: message.createdTimestamp,
                }]);

                initial = false;
            }
        } else {
            pageData.push({
                content: message.content,
                timestamp: message.createdTimestamp,
            });
        }
    }

    if (pageData.length !== 0) {
        pages.push(pageData);
    }

    const paginate = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 1,
        displayType: DisplayType.EmbedData,
        displayFunction: (data: any, embed: MessageEmbed) => {
            /* Multiple fields, must be messages not attachments */
            if (data.length > 1 || data.length === 1 && !data[0].attachment) {
                embed.image = null;
                embed.description = '';
                for (const message of data) {
                    embed.addField(moment.utc(message.timestamp).fromNow(), message.content);
                }
            } else {
                embed.fields = [];

                const message = data[0];

                if (message.content !== '') {
                    embed.setDescription(`${message.content} - ${moment.utc(message.timestamp).fromNow()}`);
                } else {
                    embed.setDescription(moment.utc(message.timestamp).fromNow());
                }

                embed.setImage(message.attachment);
            }
        },
        data: pages,
        embed,
    });

    await paginate.sendMessage();
}

export async function handleDeletedMessage(msg: Message) {
    if (config.usersToCacheDeletions.includes(msg.author.id)) {
        const existingMessages = cachedMessages.get(msg.author.id) || [];

        if (existingMessages.length >= 5) {
            existingMessages.pop();
        }

        existingMessages.unshift(msg);

        cachedMessages.set(msg.author.id, existingMessages);
    }
}
