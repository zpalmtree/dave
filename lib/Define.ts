import {
    Message,
    MessageEmbed,
} from 'discord.js';

import fetch from 'node-fetch';

import {
    Paginate,
    DisplayType,
} from './Paginate.js';

export async function handleDefine(msg: Message, args: string): Promise<void> {
    let query = args.trim();

    if (query === '') {
        msg.reply(`No word given.`);
        return;
    }
    
    const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(query)}`;

    try {
        const res = await fetch(url);
        
        if (res.status === 404) {
            throw new Error('404');
        }
        
        const data = await res.json();
        const embed = new MessageEmbed();
        const meanings = data[0].meanings;

        let definitions = [];
        for (const meaning of meanings) {
            for (const partOfSpeech of meaning.definitions) {
                definitions.push({
                    name: meaning.partOfSpeech,
                    value: partOfSpeech.definition,
                    inline: true,
                });
            }
        }

        const pages = new Paginate({
            sourceMessage: msg,
            itemsPerPage: 9,
            displayFunction: (item: any) => item,
            displayType: DisplayType.EmbedFieldData,
            data: definitions,
            embed,
        });
    
        await pages.sendMessage();
    } catch (err) {
        if (err.message === '404') {
            await msg.reply(`"${query}" not found in dictionary`);
        } else {
            await msg.reply(`Failed to get definition: ${err.toString()}`);
        }
    }
}
