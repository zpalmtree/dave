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
            const fixedURL = `https://birdeye.so/token/${tokenAddress}?chain=solana`;
            fixedURLs.push(fixedURL);
        }

        if (fixedURLs.length > 0) {
            const username = await getUsername(msg.author.id, msg.guild);
            const content = `${fixedURLs.join('\n')}`;

            // Send the birdeye links without suppressing the original embed
            const sentMsg = await msg.channel.send(content);

            await tryReactMessage(sentMsg, '❌');

            // Create a reaction collector
            const filter = (reaction: MessageReaction, user: User) => reaction.emoji.name === '❌' && user.id === msg.author.id;

            const collector = sentMsg.createReactionCollector({ filter, time: 60000, max: 1 });

            collector.on('collect', async () => {
                await sentMsg.delete();
            });
        }
    } catch (err) {
        console.log(err);
    }
} 