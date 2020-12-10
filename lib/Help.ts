import {
    Message,
    MessageEmbed,
} from 'discord.js';

import {
    exchangeService
} from './Exchange';

export function handleWatchHelp(msg: Message, description?: string): void {
    const embed = new MessageEmbed()
        .setTitle('$watch')
        .setDescription(description || 'Schedule a movie to watch or view scheduled movies')
        .addFields(
            {
                name: 'List all movies/series scheduled to watch',
                value: '`$watch`',
                inline: false,
            },
            {
                name: 'Schedule a new movie/series to be watched',
                value: '`$watch <Title> <Optional IMDB or MyAnimeList Link> <YYYY/MM/DD HH:MM UTC TIMEZONE OFFSET> <Optional Magnet or Youtube Link>`',
                inline: false,
            },
            {
                name: 'Schedule a new movie/series to be watched',
                value: '`$watch Jagten https://www.imdb.com/title/tt2106476/?ref_=fn_al_tt_1 2020/07/29 19:00 -08:00`',
                inline: false,
            },
            {
                name: 'Schedule a new movie/series to be watched',
                value: '`$watch Tseagure! Bukatsumono https://myanimelist.net/anime/19919/Tesagure_Bukatsumono 5h30m`',
                inline: false,
            },
            {
                name: 'Find more info about a specific movie',
                value: '`$watch 1`',
                inline: false,
            },
            {
                name: 'View previously seen movies',
                value: '`$watch history`',
                inline: false,
            },
            {
                name: 'Delete a scheduled movie (You must be a mod or the single watcher)',
                value: '`$watch delete 1`',
                inline: false,
            },
            {
                name: 'Add a youtube or magnet link for a movie',
                value: '`$watch addlink 1 magnet:?xt=urn:btih:e5f8d9251b8ca1f285b8474da1aa72844d830...`',
                inline: false,
            },
            {
                name: 'Add a youtube or magnet link for a movie',
                value: '`$watch addlink 1 https://www.youtube.com/watch?v=vJykw3H4PDw`',
                inline: false,
            },
            {
                name: 'Update the date/time of a scheduled watch',
                value: '`$watch updatetime 1 2020/07/29 03:00 +01:00`',
                inline: false,
            },
            {
                name: 'Update the date/time of a scheduled watch',
                value: '`$watch updatetime 1 10m`',
                inline: false,
            },
        );

    msg.channel.send(embed);
}
