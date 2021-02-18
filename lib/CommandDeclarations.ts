import {
    Message,
    MessageEmbed,
} from 'discord.js';

import {
    Args,
    Command,
} from './Types';

import {
    Paginate,
    DisplayType,
} from './Paginate';

import {
    canAccessCommand,
    getLanguageNames,
} from './Utilities';

import {
    handleFortune,
    handleMath,
    handleRoll,
    handleQuote,
    handleQuotes,
    handleSuggest,
    handleKitty,
    handleDoggo,
    handleChinked,
    handleDot,
    handleImgur,
    handleWatch,
    handleTime,
    handleDate,
    handleCountdown,
    handlePurge,
    handleTranslate,
    handleTranslateFrom,
    handleQuery,
    handleExchange,
    handleAvatar,
    handleNikocado,
    handleImage,
    handleYoutube,
    handleStats,
    handleReady,
    handlePoll,
    handleMultiPoll,
} from './CommandImplementations';

import {
    handleTimers,
    handleTimer,
} from './Timer';

import { exchangeService } from './Exchange';

import { handleWeather } from './Weather';

import { config } from './Config';

export const Commands: Command[] = [
    {
        aliases: ['roll', 'reroll'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleRoll,
        description: 'Gets your post number and its repeating digits',
        examples: [
            {
                name: 'Example',
                value: 'roll',
            },
            {
                name: 'Example',
                value: 'roll d20',
            },
            {
                name: 'Example',
                value: 'roll 6d10',
            },
        ],
    },
    {
        aliases: ['quote'],
        argsFormat: Args.DontNeed,
        hidden: false,
        implementation: handleQuote,
        description: 'Gets a random quote',
        needDb: true,
        relatedCommands: [
            'addquote',
            'quotes',
        ],
    },
    {
        aliases: ['addquote', 'suggest', 'suggestquote'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleSuggest,
        description: 'Suggest a new quote',
        needDb: true,
        examples: [
            {
                value: 'suggest "im a prancing lala boy" - you',
            },
        ],
        relatedCommands: [
            'quote',
            'quotes',
        ],
    },
    {
        aliases: ['quotes'],
        argsFormat: Args.DontNeed,
        hidden: false,
        implementation: handleQuotes,
        description: 'View all quotes',
        needDb: true,
        relatedCommands: [
            'addquote',
            'quote',
        ],
    },
    {
        aliases: ['fortune'],
        argsFormat: Args.DontNeed,
        hidden: false,
        implementation: handleFortune,
        description: 'Get your fortune',
        examples: [
            {
                value: 'fortune',
            },
            {
                value: 'fortune I die tomorrow',
            },
        ],
    },
    {
        aliases: ['math'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleMath,
        description: 'Perform math or conversions',
        examples: [
            {
                value: 'math 123 * 456',
            },
            {
                value: 'math 100 fahrenheit to celsius',
            }
        ],
    },
    {
        aliases: ['doggo', 'dog', 'doggy'],
        argsFormat: Args.Split,
        hidden: false,
        implementation: handleDoggo,
        description: 'Get a random dog picture',
        examples: [
            {
                value: 'doggo',
            },
            {
                value: 'doggo corgi',
            },
            {
                value: 'doggo golden retriever',
            },
        ],
        relatedCommands: [
            'kitty',
        ],
    },
    {
        aliases: ['kitty', 'cat'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleKitty,
        description: 'Get a random cat picture',
        examples: [
            {
                value: 'kitty',
            },
            {
                value: 'kitty persian',
            },
            {
                value: 'kitty european burmese',
            },
        ],
        relatedCommands: [
            'doggo',
        ],
    },
    {
        aliases: ['help'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleHelp,
        description: 'Displays this help',
    },
    {
        aliases: ['chinked', 'corona', 'coronavirus', 'chinavirus'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleChinked,
        description: 'Display coronavirus statistics',
        examples: [
            {
                value: 'chinked',
            },
            {
                value: 'chinked usa',
            },
            {
                value: 'chinked new york',
            },
        ],
    },
    {
        aliases: ['dot'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleDot,
        description: 'Get the Global Consciousness Project Dot Graph',
        helpDescription: 'The Global Consciousness Project collects random numbers from ' +
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
            '(<http://global-mind.org/science2.html#hypothesis>)',
    },
    {
        aliases: ['pizza'],
        argsFormat: Args.DontNeed,
        hidden: false,
        implementation: handleImgur.bind(undefined, 'r/pizza'),
        description: 'Get a random r/pizza picture',
    },
    {
        aliases: ['turtle'],
        argsFormat: Args.DontNeed,
        hidden: false,
        implementation: handleImgur.bind(undefined, 'r/turtle'),
        description: 'Get a random r/turtle picture',
    },
    {
        aliases: ['watch', 'movie'],
        argsFormat: Args.Split,
        hidden: false,
        implementation: handleWatch,
        description: 'Display or schedule a movie/series to watch',
        examples: [
            {
                name: 'List all movies/series scheduled to watch',
                value: 'watch',
            },
            {
                name: 'Schedule a new movie/series to be watched',
                value: 'watch <Title> <Optional IMDB or MyAnimeList Link> <YYYY/MM/DD HH:MM UTC TIMEZONE OFFSET> <Optional Magnet or Youtube Link>',
            },
            {
                name: 'Schedule a new movie/series to be watched',
                value: 'watch Jagten https://www.imdb.com/title/tt2106476/?ref_=fn_al_tt_1 2020/07/29 19:00 -08:00',
            },
            {
                name: 'Schedule a new movie/series to be watched',
                value: 'watch Tseagure! Bukatsumono https://myanimelist.net/anime/19919/Tesagure_Bukatsumono 5h30m',
            },
            {
                name: 'Find more info about a specific movie',
                value: 'watch 1',
            },
            {
                name: 'View previously seen movies',
                value: 'watch history',
            },
            {
                name: 'Delete a scheduled movie (You must be a mod or the single watcher)',
                value: 'watch delete 1',
            },
            {
                name: 'Add a youtube or magnet link for a movie',
                value: 'watch addlink 1 magnet:?xt=urn:btih:e5f8d9251b8ca1f285b8474da1aa72844d830...',
            },
            {
                name: 'Add a youtube or magnet link for a movie',
                value: 'watch addlink 1 https://www.youtube.com/watch?v=vJykw3H4PDw',
            },
            {
                name: 'Update the date/time of a scheduled watch',
                value: 'watch updatetime 1 2020/07/29 03:00 +01:00',
            },
            {
                name: 'Update the date/time of a scheduled watch',
                value: 'watch updatetime 1 10m',
            },
            /*
            {
                name: 'Add a movie to the movie bank',
                value: 'watch addbank Rocky https://www.imdb.com/title/tt0075148/?ref_=fn_al_tt_1',
            },
            {
                name: 'Find an unwatched movie',
                value: 'watch bank',
            },
            {
                name: 'Find a movie unwatched by a group',
                value: 'watch bank @tom @bob',
            },
            */
        ],
        needDb: true,
        relatedCommands: [
            'countdown',
            'ready',
            'pause',
        ],
    },
    {
        aliases: ['time'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleTime,
        description: 'Get the current time in a specific UTC offset',
        examples: [
            {
                value: 'time',
            },
            {
                value: 'time +01:00',
            },
            {
                value: 'time -06:00',
            },
        ],
        relatedCommands: [
            'date',
        ],
    },
    {
        aliases: ['date'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleDate,
        description: 'Get the current date in a specific UTC offset',
        examples: [
            {
                value: 'date',
            },
            {
                value: 'date +01:00',
            },
            {
                value: 'date -06:00',
            },
        ],
        relatedCommands: [
            'time',
        ],
    },
    {
        aliases: ['timer', 'reminder'],
        argsFormat: Args.Split,
        hidden: false,
        implementation: handleTimer,
        description: 'Set a timer to remind you of something',
        helpDescription: 'Set a timer to remind you of something. Available time units: `y` (year), `w` (week), `d` (day), `h` (hour), `m` (minute), `s` (second)',
        needDb: true,
        examples: [
            {
                name: 'Set a timer with a description',
                value: 'timer 5m coffee',
            },
            {
                name: 'Set a timer',
                value: 'timer 2h5m',
            },
            {
                name: 'Set a super long timer',
                value: 'timer 1y2w3d4h5m6s',
            },
            {
                name: 'View running timers',
                value: 'timer list',
            },
            {
                name: 'Delete a timer by ID - you must be the timer creator',
                value: 'timer delete 1',
            },
        ],
        relatedCommands: [
            'timers',
        ],
    },
    {
        aliases: ['countdown'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleCountdown.bind(undefined, "Let's jam!"),
        description: 'Perform a countdown',
        examples: [
            {
                value: 'countdown',
            },
            {
                value: 'countdown 5',
            },
        ],
        relatedCommands: [
            'watch',
            'ready',
            'pause',
        ],
    },
    {
        aliases: ['purge'],
        argsFormat: Args.DontNeed,
        hidden: true,
        implementation: handlePurge,
        description: 'Delete all your messages in a channel',
        disabled: false,
    },
    {
        aliases: ['translate'],
        argsFormat: Args.Split,
        hidden: false,
        implementation: handleTranslate,
        description: 'Translate text from one language to another',
        helpDescription: `Translate text from one language to another. Known languages: ${getLanguageNames().map((x) => `\`${x}\``).join(', ')}`,
        examples: [
            {
                name: 'Translate to english',
                value: 'translate C\'est la vie',
            },
            {
                name: 'Translate to another language',
                value: 'translate french Such is life',
            }
        ],
        relatedCommands: [
            'translatefrom',
        ],
    },
    {
        aliases: ['translatefrom'],
        argsFormat: Args.Split,
        hidden: false,
        implementation: handleTranslateFrom,
        description: 'Translate text from a specific language to another',
        helpDescription: `Translate text from a specific language to another. Known languages: ${getLanguageNames().map((x) => `\`${x}\``).join(', ')}`,
        examples: [
            {
                name: 'Translate to english',
                value: 'translatefrom french C\'est la vie',
            },
            {
                name: 'Translate to another language',
                value: 'translatefrom french spanish C\'est la vie',
            }
        ],
        relatedCommands: [
            'translate',
        ],
    },
    {
        aliases: ['pause'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleCountdown.bind(undefined, 'pause'),
        description: 'Perform a pause',
        examples: [
            {
                value: 'pause',
            },
            {
                value: 'pause 5',
            },
        ],
        relatedCommands: [
            'watch',
            'countdown',
            'ready',
        ],
    },
    {
        aliases: ['query', 'search'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleQuery,
        description: 'Query duckduckgo',
        examples: [
            {
                name: 'Define something',
                value: 'query apple',
            },
            {
                name: 'Use duckduckgo bangs - https://duckduckgo.com/bang',
                value: 'query !w Arnold Schwarzenegger',
            },
            {
                name: `Topic Summaries`,
                value: 'query Valley Forge National Historical Park',
            },
            {
                name: 'Categories',
                value: 'query Simpsons Characters',
            },
        ],
        relatedCommands: [
            'image',
            'youtube',
        ],
    },
    {
        aliases: ['exchange', 'convert'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleExchange,
        description: 'Convert between REAL currencies',
        helpDescription: `Convert between currencies. Known currencies: \`${exchangeService.getCurrencies().join(',')}\``,
        examples: [
            {
                value: 'exchange 100 USD to GBP',
            },
            {
                value: 'exchange 666.66 MXN to EUR',
            },
        ],
    },
    {
        aliases: ['avatar'],
        argsFormat: Args.DontNeed,
        hidden: false,
        implementation: handleAvatar,
        description: 'Retrieve a users avatar',
        examples: [
            {
                name: `Retrieve bob's avatar`,
                value: 'avatar @bob',
            },
            {
                name: 'Retrieve your own avatar',
                value: 'avatar',
            },
        ]
    },
    {
        aliases: ['nikocado', 'orlin', 'niko', 'avocado'],
        argsFormat: Args.DontNeed,
        hidden: true,
        implementation: handleNikocado,
        description: 'Get a random nikocado',
    },
    {
        aliases: ['image'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleImage,
        description: 'Query duckduckgo images',
        examples: [
            {
                value: 'image sunset',
            },
        ],
        relatedCommands: [
            'query',
            'youtube',
        ],
    },
    {
        aliases: ['youtube', 'video'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleYoutube,
        description: 'Query youtube',
        examples: [
            {
                value: 'youtube install gentoo',
            },
        ],
        relatedCommands: [
            'query',
            'image',
        ],
    },
    {
        aliases: ['stats'],
        argsFormat: Args.Split,
        hidden: false,
        implementation: handleStats,
        description: 'View bot usage statistics',
        needDb: true,
        examples: [
            {
                name: `View most used commands`,
                value: 'stats',
            },
            {
                name: `View number of times users have used the bot`,
                value: 'stats users',
            },
            {
                name: `View number of times users have used a specific command`,
                value: 'stats fortune',
            },
            {
                name: 'View most used commands for a user',
                value: 'stats @bob',
            },
        ],
    },
    {
        aliases: ['timers'],
        argsFormat: Args.DontNeed,
        hidden: false,
        implementation: handleTimers,
        description: 'View the status of running timers',
        needDb: true,
        relatedCommands: [
            'timer',
        ],
    },
    {
        aliases: ['ready'],
        argsFormat: Args.Split,
        hidden: false,
        implementation: handleReady,
        description: 'Verify if users are ready to launch a countdown',
        helpDescription: 'Lets you verify if users are ready for a movie, or other ' +
            'event, and launches a countdown to start the event once all users are ready.' +
            ' The ready event will expire after 5 minutes if all users do not ready up.',
        needDb: true,
        examples: [
            {
                name: 'Check if everyone is ready for a movie',
                value: 'ready 1',
            },
            {
                name: 'Check if specific users are ready',
                value: 'ready @james @bob',
            },
            {
                name: 'Check if movie users and specific users are ready',
                value: 'ready 1 @james @bob',
            },
        ],
        relatedCommands: [
            'watch',
            'countdown',
            'pause',
        ],
    },
    {
        aliases: ['poll', 'vote'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handlePoll,
        description: 'Propose a yes/no query and let users vote',
        examples: [
            {
                value: 'poll Do you like peanut butter?',
            },
        ],
        relatedCommands: [
            'multipoll',
        ],
    },
    {
        aliases: ['multipoll', 'multivote'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleMultiPoll,
        description: 'Create a query with multiple options and let users vote',
        helpDescription: 'Create a query with multiple options and let users vote. ' +
            'Multipoll should start with the query, then be followed by a forward slash (`/`). ' +
            'Then, enter the poll options, each one again separated by a forward slash.',
        examples: [
            {
                value: 'multipoll What is your favourite fast food restaurant? / McDonalds / Burger King / Wendys / Taco Bell',
            },
        ],
        relatedCommands: [
            'poll',
        ],
    },
    {
        aliases: ['weather', 'forecast'],
        argsFormat: Args.Split,
        hidden: false,
        implementation: handleWeather,
        description: 'Retrieve the weather forecast for a region',
        helpDescription: 'Retrieve the weather forecast for a region. Returns ' +
            '5 days of forecasts, at 3 hour intervals.',
        examples: [
            {
                name: 'Get the weather in a city',
                value: 'weather Paris',
            },
            {
                name: 'Get the weather in a specific city',
                value: 'Weather Paris,US',
            },
            {
                name: 'Get the weather in a zip code',
                value: 'weather 10001,US',
            },
            {
                name: 'Get the weather in a post code',
                value: 'weather SW1,GB',
            },
        ],
    },
];

export function handleHelp(msg: Message, args: string): void {
    const availableCommands = Commands.filter((c) => {
        if (c.disabled) {
            return false;
        }

        if (c.hidden && !canAccessCommand(msg, false)) {
            return false;
        }

        return true;
    })

    if (args !== '') {
        for (const c of availableCommands) {
            if (c.aliases.includes(args)) {
                if (c.helpFunction) {
                    c.helpFunction(msg);
                    return;
                }

                const callString = config.prefix + args;

                let examples = [{
                    value: args,
                }]

                if (c.examples && c.examples.length > 0) {
                    examples = c.examples;
                }

                const embed = new MessageEmbed()
                    .setTitle(callString)
                    .setDescription(c.helpDescription || c.description);

                embed.addFields(examples.map((e: any) => {
                    return {
                        name: e.name || 'Example',
                        value: `\`${config.prefix}${e.value}\``,
                    }
                }));

                if (c.relatedCommands && c.relatedCommands.length > 0) {
                    embed.addFields({
                        name: 'Related commands',
                        value: c.relatedCommands.map((x) => `\`${config.prefix + x}\``).join(', '),
                    });
                }

                if (c.aliases.length > 1) {
                    embed.addFields({
                        name: 'Aliases',
                        value: c.aliases.map((x) => `\`${config.prefix + x}\``).join(', '),
                    });
                }

                msg.channel.send(embed);

                return;
            }
        }
    }

    const embed = new MessageEmbed()
        .setTitle('Available commands')
        .setDescription(`Enter \`${config.prefix}command help\` for more info and examples on a specific command`);

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 9,
        displayType: DisplayType.EmbedFieldData,
        data: availableCommands,
        embed: embed,
        displayFunction: (item: Command) => {
            return {
                name: config.prefix + item.aliases[0],
                value: item.description,
                inline: true,
            };
        },
    });

    pages.sendMessage();
}
