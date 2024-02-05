import { Message, Guild, PermissionsBitField, TextChannel } from 'discord.js';

import { getUsername, truncateResponse } from './Utilities.js';

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
            const fixedURL = `https://vxtwitter.com/${user}/status/${statusId}`;
            fixedURLs.push(fixedURL);
        }

        if (fixedURLs.length > 0) {
            const username = await getUsername(msg.author.id, msg.guild);

            const content = `${fixedURLs.join('\n')}`;

            const surpressPromise = msg.suppressEmbeds(true);
            const sendPromise = msg.channel.send(content);

            await Promise.all([
                surpressPromise,
                sendPromise,
            ]);
        }
    } catch (err) {
        console.log(err);
    }
}
