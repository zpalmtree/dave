import { Message, TextChannel, PermissionsBitField, MessageReaction, User } from 'discord.js';

import {
    getUsername,
    truncateResponse,
    sleep,
    tryReactMessage,
} from './Utilities.js';

export async function convertPumpFunLinks(msg: Message): Promise<void> {
    if (!msg.guild!.members.me!.permissionsIn(msg.channel as TextChannel).has(PermissionsBitField.Flags.SendMessages)) {
        return;
    }

    try {
        const content = msg.content.trim();
        const pumpFunRegex = /https:\/\/pump\.fun\/coin\/([a-zA-Z0-9]{44}pump)/gi;

        let match;

        const fixedURLs = [];

        while ((match = pumpFunRegex.exec(content)) !== null) {
            const tokenAddress = match[1];
            const fixedURL = `https://birdeye.so/token/${tokenAddress}`;
            fixedURLs.push(fixedURL);
        }

        if (fixedURLs.length > 0) {
            const username = await getUsername(msg.author.id, msg.guild);
            const content = `${fixedURLs.join('\n')}`;

            const suppressPromise = msg.suppressEmbeds(true);
            const sendPromise = msg.channel.send(content);

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