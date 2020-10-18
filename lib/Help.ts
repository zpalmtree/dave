import {
    Message,
    MessageEmbed,
} from 'discord.js';

export function handleRollHelp(msg: Message): void {
    const embed = new MessageEmbed()
        .setTitle('$roll')
        .setDescription('Roll a dice or multiple dice')
        .addFields(
            {
                name: 'Example',
                value: '`$roll`',
                inline: false,
            },
            {
                name: 'Example',
                value: '`$roll d20`',
                inline: false,
            },
            {
                name: 'Example',
                value: '`$roll 6d10`',
                inline: false,
            },
        );

    msg.channel.send(embed);
}

export function handleQuoteHelp(msg: Message): void {
    const embed = new MessageEmbed()
        .setTitle('$quote')
        .setDescription('Get a random quote')
        .addFields(
            {
                name: 'Example',
                value: '`$quote`',
                inline: false,
            }
        );

    msg.channel.send(embed);
}

export function handleSuggestHelp(msg: Message): void {
    const embed = new MessageEmbed()
        .setTitle('$suggest')
        .setDescription('Suggest a new quote')
        .addFields(
            {
                name: 'Example',
                value: '`$suggest "niggers tongue my anus" - you`',
                inline: false,
            }
        );

    msg.channel.send(embed);
}

export function handleFortuneHelp(msg: Message): void {
    const embed = new MessageEmbed()
        .setTitle('$fortune')
        .setDescription('Get your fortune')
        .addFields(
            {
                name: 'Example',
                value: '`$fortune`',
                inline: false,
            },
            {
                name: 'Example',
                value: '`$fortune I die tomorrow`',
                inline: false,
            }
        );

    msg.channel.send(embed);
}

export function handleMathHelp(msg: Message): void {
    const embed = new MessageEmbed()
        .setTitle('$math')
        .setDescription('Perform math or conversions')
        .addFields(
            {
                name: 'Example',
                value: '`$math 123 * 456`',
                inline: false,
            },
            {
                name: 'Example',
                value: '`$math 100 fahrenheit to celsius`',
                inline: false,
            }
        )
        .setFooter('https://mathjs.org/docs/index.html');

    msg.channel.send(embed);
}

export function handleDoggoHelp(msg: Message): void {
    const embed = new MessageEmbed()
        .setTitle('$doggo')
        .setDescription('Get a random doggo pic')
        .addFields(
            {
                name: 'Example',
                value: '`$doggo`',
                inline: false,
            },
            {
                name: 'Example',
                value: '`$doggo corgi`',
                inline: false,
            },
            {
                name: 'Example',
                value: '`$doggo golden retriever`',
                inline: false,
            }
        )
        .setFooter('https://pastebin.com/BS8JKb7V');

    msg.channel.send(embed);
}

export function handleKittyHelp(msg: Message): void {
    const embed = new MessageEmbed()
        .setTitle('$kitty')
        .setDescription('Get a random kitty pic')
        .addFields(
            {
                name: 'Example',
                value: '`$kitty`',
                inline: false,
            },
            {
                name: 'Example',
                value: '`$kitty persian`',
                inline: false,
            },
            {
                name: 'Example',
                value: '`$kitty european burmese`',
                inline: false,
            }
        )
        .setFooter('https://pastebin.com/0iCzvPJq');

    msg.channel.send(embed);
}

export function handleChinkedHelp(msg: Message): void {
    const embed = new MessageEmbed()
        .setTitle('$kitty')
        .setDescription('Get coronavirus statistics in a specific location.')
        .addFields(
            {
                name: 'Example',
                value: '`$chinked`',
                inline: false,
            },
            {
                name: 'Example',
                value: '`$chinked usa`',
                inline: false,
            },
            {
                name: 'Example',
                value: '`$chinked new york`',
                inline: false,
            }
        );

    msg.channel.send(embed);
}

export function handleDotHelp(msg: Message): void {
    const embed = new MessageEmbed()
        .setTitle('$dot')
        .setDescription(
            'The Global Consciousness Project collects random numbers from ' +
            'around the world. These numbers are available on the GCP website. ' +
            'This website downloads those numbers once a minute and performs ' +
            'sophisticated analysis on these random numbers to see how coherent ' +
            'they are. That is, we compute how random the random numbers coming ' +
            'from the eggs really are. The theory is that the Global Consciousness ' +
            'of all Beings of the Planet affect these random numbers... Maybe ' +
            'they aren\'t quite as random as we thought.\n\nThe probability time ' +
            'window is one and two hours; with the display showing the more ' +
            'coherent of the two. For more information on the algorithm you can ' +
            'read about it on the GCP Basic Science page ' +
            '(<http://global-mind.org/science2.html#hypothesis>)'
        )
        .addFields(
            {
                name: 'Example',
                value: '`$dot`',
                inline: false,
            }
        );

    msg.channel.send(embed);
}

export function handlePizzaHelp(msg: Message): void {
    const embed = new MessageEmbed()
        .setTitle('$pizza')
        .setDescription('Get a random pizza picture from r/pizza')
        .addFields(
            {
                name: 'Example',
                value: '`$pizza`',
                inline: false,
            },
        );

    msg.channel.send(embed);
}

export function handleTurtleHelp(msg: Message): void {
    const embed = new MessageEmbed()
        .setTitle('$pizza')
        .setDescription('Get a random turtle picture from r/turtle.')
        .addFields(
            {
                name: 'Example',
                value: '`$turtle`',
                inline: false,
            },
        );

    msg.channel.send(embed);
}

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
        );

    msg.channel.send(embed);
}

export function handleTimeHelp(msg: Message): void {
    const embed = new MessageEmbed()
        .setTitle('$time')
        .setDescription('Get the current time in a specific UTC offset')
        .addFields(
            {
                name: 'Example',
                value: '`$time`',
                inline: false,
            },
            {
                name: 'Example',
                value: '`$time +01:00`',
                inline: false,
            },
            {
                name: 'Example',
                value: '`$time -06:00`',
                inline: false,
            },
        );

    msg.channel.send(embed);
}

export function handleTimerHelp(msg: Message): void {
    const embed = new MessageEmbed()
        .setTitle('$time')
        .setDescription('Set a timer to remind you of something')
        .addFields(
            {
                name: 'Example',
                value: '`$timer 5m coffee`',
                inline: false,
            },
            {
                name: 'Example',
                value: '`$timer 2h`',
                inline: false,
            },
        );

    msg.channel.send(embed);
}

export function handleCountdownHelp(msg: Message): void {
    const embed = new MessageEmbed()
        .setTitle('$countdown')
        .setDescription('Perform a countdown')
        .addFields(
            {
                name: 'Example',
                value: '`$countdown`',
                inline: false,
            },
            {
                name: 'Example',
                value: '`$countdown 5`',
                inline: false,
            },
            {
                name: 'Example',
                value: '`$pause`',
                inline: false,
            },
        );

    msg.channel.send(embed);
}

export function handlePurgeHelp(msg: Message): void {
    const embed = new MessageEmbed()
        .setTitle('$purge')
        .setDescription('Delete every message you have made in this channel')
        .addFields(
            {
                name: 'Example',
                value: '`$purge`',
                inline: false,
            },
        );

    msg.channel.send(embed);
}

export function handleTranslateHelp(msg: Message): void {
    const embed = new MessageEmbed()
        .setTitle('$translate')
        .setDescription('Translate text from one language to another')
        .addFields(
            {
                name: 'Translate to english',
                value: '`$translate C\'est la vie`',
                inline: false,
            },
            {
                name: 'Translate to another language',
                value: '`$translate french Such is life`',
                inline: false,
            }
        );

    msg.channel.send(embed);
}

export function handleQueryHelp(msg: Message): void {
    const embed = new MessageEmbed()
        .setTitle('$query')
        .setDescription('Query duckduckgo instant answers (Very simple queries)')
        .addFields(
            {
                name: 'Define something',
                value: '`$query apple`',
                inline: false,
            },
            {
                name: 'Use duckduckgo bangs - https://duckduckgo.com/bang',
                value: '`$query !w Arnold Schwarzenegger`',
                inline: false,
            },
            {
                name: `Topic Summaries`,
                value: '`$query Valley Forge National Historical Park`',
                inline: false,
            },
            {
                name: 'Categories',
                value: '`$query Simpsons Characters`',
                inline: false,
            },
        );

    msg.channel.send(embed);
}
