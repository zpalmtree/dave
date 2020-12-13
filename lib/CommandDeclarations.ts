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
} from './Utilities';

import {
    handleFortune,
    handleMath,
    handleRoll,
    handleQuote,
    handleSuggest,
    handleKitty,
    handleDoggo,
    handleChinked,
    handleDot,
    handleImgur,
    handleWatch,
    handleTime,
    handleDate,
    handleTimer,
    handleCountdown,
    handlePurge,
    handleTranslate,
    handleQuery,
    handleExchange,
    handleAvatar,
    handleNikocado,
    handleImage,
    handleYoutube,
    handleStats,
    handleTimers,
} from './CommandImplementations';

import {
    handleWatchHelp,
} from './Help';

import { exchangeService } from './Exchange';

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
                value: '`$roll`',
            },
            {
                name: 'Example',
                value: '`$roll d20`',
            },
            {
                name: 'Example',
                value: '`$roll 6d10`',
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
    },
    {
        aliases: ['suggest'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleSuggest,
        description: 'Suggest a new quote',
        needDb: true,
        examples: [
            {
                value: '`$suggest "im a prancing lala boy" - you`',
            },
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
                value: '`$fortune`',
            },
            {
                value: '`$fortune I die tomorrow`',
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
                value: '`$math 123 * 456`',
            },
            {
                value: '`$math 100 fahrenheit to celsius`',
            }
        ],
    },
    {
        aliases: ['doggo'],
        argsFormat: Args.Split,
        hidden: false,
        implementation: handleDoggo,
        description: 'Get a random dog picture',
        examples: [
            {
                value: '`$doggo`',
            },
            {
                value: '`$doggo corgi`',
            },
            {
                value: '`$doggo golden retriever`',
            },
        ],
    },
    {
        aliases: ['kitty'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleKitty,
        description: 'Get a random cat picture',
        examples: [
            {
                value: '`$kitty`',
            },
            {
                value: '`$kitty persian`',
            },
            {
                value: '`$kitty european burmese`',
            },
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
                value: '`$chinked`',
            },
            {
                value: '`$chinked usa`',
            },
            {
                value: '`$chinked new york`',
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
        hidden: true,
        implementation: handleWatch,
        helpFunction: handleWatchHelp,
        description: 'Display or schedule a movie/series to watch',
        needDb: true,
    },
    {
        aliases: ['time'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleTime,
        description: 'Get the current time in a specific UTC offset',
        examples: [
            {
                value: '`$time`',
            },
            {
                value: '`$time +01:00`',
            },
            {
                value: '`$time -06:00`',
            },
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
                value: '`$date`',
            },
            {
                value: '`$date +01:00`',
            },
            {
                value: '`$date -06:00`',
            },
        ],
    },
    {
        aliases: ['timer'],
        argsFormat: Args.Split,
        hidden: false,
        implementation: handleTimer,
        description: 'Set a timer to remind you of something',
        needDb: true,
        examples: [
            {
                value: '`$timer 5m coffee`',
            },
            {
                value: '`$timer 2h`',
            },
            {
                name: 'View running timers',
                value: '`$timer list`',
            },
            {
                name: 'Delete a timer by ID - you must be the timer creator',
                value: '`$timer delete 1`',
            },
        ]
    },
    {
        aliases: ['countdown'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleCountdown.bind(undefined, 'Lets jam!'),
        description: 'Perform a countdown',
        examples: [
            {
                value: '`$countdown`',
            },
            {
                value: '`$countdown 5`',
            },
        ],
    },
    {
        aliases: ['purge'],
        argsFormat: Args.DontNeed,
        hidden: true,
        implementation: handlePurge,
        description: 'Delete all your messages in a channel',
        disabled: true,
    },
    {
        aliases: ['translate'],
        argsFormat: Args.Split,
        hidden: false,
        implementation: handleTranslate,
        description: 'Translate text from one language to another',
        examples: [
            {
                name: 'Translate to english',
                value: '`$translate C\'est la vie`',
            },
            {
                name: 'Translate to another language',
                value: '`$translate french Such is life`',
            }
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
                value: '`$pause`',
            },
            {
                value: '`$pause 5`',
            },
        ]
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
                value: '`$query apple`',
            },
            {
                name: 'Use duckduckgo bangs - https://duckduckgo.com/bang',
                value: '`$query !w Arnold Schwarzenegger`',
            },
            {
                name: `Topic Summaries`,
                value: '`$query Valley Forge National Historical Park`',
            },
            {
                name: 'Categories',
                value: '`$query Simpsons Characters`',
            },
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
                value: '`$exchange 100 USD to GBP`',
            },
            {
                value: '`$exchange 666.66 MXN to EUR`',
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
                value: '`$avatar @bob`',
            },
            {
                name: 'Retrieve your own avatar',
                value: '`$avatar`',
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
                value: '`$image sunset`',
            },
        ],
    },
    {
        aliases: ['youtube'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleYoutube,
        description: 'Query youtube',
        examples: [
            {
                value: '`$youtube install gentoo`',
            },
        ],
    },
    {
        aliases: ['stats'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleStats,
        description: 'View bot usage statistics',
        needDb: true,
        examples: [
            {
                name: `View most used commands`,
                value: '`$stats`',
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
                    value: `\`${callString}\``,
                }]

                if (c.examples && c.examples.length > 0) {
                    examples = c.examples;
                }

                const embed = new MessageEmbed()
                    .setTitle(callString)
                    .setDescription(c.helpDescription || c.description)
                    .addFields(examples.map((e) => {
                        return {
                            name: 'Example',
                            ...e,
                        }
                    }));

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
