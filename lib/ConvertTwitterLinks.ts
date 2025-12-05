import { Message, Guild, PermissionsBitField, TextChannel, MessageReaction, User } from 'discord.js';

import {
    getUsername,
    truncateResponse,
    sleep,
    tryReactMessage,
} from './Utilities.js';

export async function convertTwitterLinks(msg: Message): Promise<void> {
    if (!msg.guild!.members.me!.permissionsIn(msg.channel as TextChannel).has(PermissionsBitField.Flags.SendMessages)) {
        return;
    }

    try {
        const content = msg.content.trim();
        const twitterRegex = /https:\/\/(twitter\.com|x\.com)\/(.+)\/status\/(\d+)/gi;

        let match;

        const fixedURLs = [];

        while ((match = twitterRegex.exec(content)) !== null) {
            const user = match[2];
            const statusId = match[3];
            const fixedURL = `https://fxtwitter.com/${user}/status/${statusId}`;
            fixedURLs.push(fixedURL);
        }

        if (fixedURLs.length > 0) {
            const username = await getUsername(msg.author.id, msg.guild);
            const content = `${fixedURLs.join('\n')}`;

            const suppressPromise = msg.suppressEmbeds(true);
            const sendPromise = (msg.channel as TextChannel).send(content);

            const [, sentMsg] = await Promise.all([
                suppressPromise,
                sendPromise,
            ]);

            await tryReactMessage(sentMsg, '❌');

            // Create a reaction collector
            const filter = (reaction: MessageReaction, user: User) => reaction.emoji.name === '❌' && user.id === msg.author.id;

            const collector = sentMsg.createReactionCollector({ filter, time: 60000, max: 1 });

            collector.on('collect', async () => {
                await sentMsg.delete();
            });

            await sleep(2000);

            /* Sometimes takes time for embed to load */
            await msg.suppressEmbeds(true);
        }
    } catch (err) {
        console.log(err);
    }
}
