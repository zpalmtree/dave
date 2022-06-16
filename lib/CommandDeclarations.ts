import {
    Message,
    MessageEmbed,
} from 'discord.js';

import {
    Args,
    Command,
} from './Types.js';

import {
    Paginate,
    DisplayType,
} from './Paginate.js';

import {
    canAccessCommand,
    getLanguageNames,
} from './Utilities.js';

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
    handleImgur,
    handleTime,
    handleDate,
    handleStock,
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
    handleUsersStats,
    handleReady,
    handlePoll,
    handleMultiPoll,
    handlePrice,
    handleSlug,
    handleGroundhog,
    handleGroove,
    handleKek,
    handleNut,
    handleMoney,
    handleViper,
    handleCock,
    handleUtility,
    handle3d,
    handleGen2,
    handleBuy,
    handleVerify,
    handleIncinerator,
    handleTrending,
    handleSign,
    handleBurnt,
} from './CommandImplementations.js';

import {
    handleTimers,
    handleTimer,
    deleteTimer,
} from './Timer.js';

import {
    handleWatch,
    deleteWatch,
    displayAllWatches,
    updateTime,
    addLink,
    handleWatchStats,
} from './Watch.js';

import { exchangeService } from './Exchange.js';

import { handleWeather } from './Weather.js';

import { config } from './Config.js';

export const Commands: Command[] = [
    {
        aliases: ['burnt'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleBurnt,
            description: 'Displays the current number of slugs burnt by the incinerator',
        }
    },
    {
        aliases: ['roll', 'reroll'],
        primaryCommand: {
            argsFormat: Args.Combined,
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
        }
    },
    {
        aliases: ['fortune'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
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
    },
    {
        aliases: ['price'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handlePrice,
            description: "Displays cryptocurrency prices",
        },
    },
    {
        aliases: ['help'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleHelp,
            description: 'Displays this help',
        },
    },
    {
        aliases: ['query', 'search'],
        primaryCommand: {
            argsFormat: Args.Combined,
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
        },
        relatedCommands: [
            'image',
            'youtube',
        ],
    },
    {
        aliases: ['avatar'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
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
            ],
        },
    },
    {
        aliases: ['youtube', 'video'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleYoutube,
            description: 'Query youtube',
            examples: [
                {
                    value: 'youtube install gentoo',
                },
            ],
        },
        relatedCommands: [
            'query',
            'image',
        ],
    },
    {
        aliases: ['quote'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleQuote,
            description: 'Gets a random quote',
            needDb: true,
        },
        relatedCommands: [
            'addquote',
            'quotes',
        ],
    },
    {
        aliases: ['addquote', 'suggest', 'suggestquote'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleSuggest,
            description: 'Suggest a new quote',
            needDb: true,
            examples: [
                {
                    value: 'suggest "im a prancing lala boy" - you',
                },
            ],
        },
        relatedCommands: [
            'quote',
            'quotes',
        ],
    },
    {
        aliases: ['quotes'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleQuotes,
            description: 'View all quotes',
            needDb: true,
        },
        relatedCommands: [
            'addquote',
            'quote',
        ],
    },
    {
        aliases: ['slug'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleSlug,
            description: 'Get a random slug image',
            needDb: false,
        },
    },
    {
        aliases: ['poll', 'vote'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handlePoll,
            description: 'Propose a yes/no query and let users vote',
            examples: [
                {
                    value: 'poll Do you like peanut butter?',
                },
            ],
        },
        relatedCommands: [
            'multipoll',
        ],
    },
    {
        aliases: ['multipoll', 'multivote'],
        primaryCommand: {
            argsFormat: Args.Combined,
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
        },
        relatedCommands: [
            'poll',
        ],
    },
    {
        aliases: ['math'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleMath,
            description: 'Perform math or conversions',
            helpDescription: 'Perform computations using the [math.js](https://mathjs.org/docs/index.html) library',
            examples: [
                {
                    value: 'math 123 * 456',
                },
                {
                    value: 'math 100 fahrenheit to celsius',
                }
            ],
        },
    },
    {
        aliases: ['groundhog', 'woodchuck', 'hog'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleGroundhog,
            description: 'Make the groundhog say something',
            examples: [
                {
                    value: 'groundhog Slorg',
                },
                {
                    value: 'groundhog @Slorg',
                },
            ],
        },
    },
    {
        aliases: ['dance', 'groove'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleGroove,
            description: 'Dance for me',
            examples: [
                {
                    value: 'groove Slorg',
                },
            ],
        },
    },
    {
        aliases: ['kek', 'lmao'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleKek,
            description: 'Kek slug say thing',
            examples: [
                {
                    value: 'kek Slorg',
                },
            ],
        },
    },
    {
        aliases: ['nut', 'nutnut'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleNut,
            description: 'Nut slug say thing',
            examples: [
                {
                    value: 'nut Slorg',
                },
            ],
        },
    },
    {
        aliases: ['money', 'cash'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleMoney,
            description: 'money man say thing',
            examples: [
                {
                    value: 'money Slorg',
                },
            ],
        },
    },
    {
        aliases: ['viper'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleViper,
            description: 'viper say thing',
            examples: [
                {
                    value: 'viper Slorg',
                },
            ],
        },
    },
    {
        aliases: ['cock', 'downbad', 'stepbro'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleCock,
            description: 'get a compliment',
        },
    },
    {
        aliases: ['burn', 'utility'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleUtility,
            description: 'Explain Slugs utility and burning',
        },
    },
    {
        aliases: ['doggo', 'dog', 'doggy'],
        primaryCommand: {
            argsFormat: Args.Split,
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
        },
        relatedCommands: [
            'kitty',
        ],
    },
    {
        aliases: ['kitty', 'cat'],
        primaryCommand: {
            argsFormat: Args.Combined,
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
        },
        relatedCommands: [
            'doggo',
        ],
    },
    {
        aliases: ['3dslugs', '3d'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handle3d,
            description: 'Get info on 3d slugs',
        },
    },
    {
        aliases: ['gen2', 'generation2'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleGen2,
            description: 'Get info on gen 2',
        },
    },
    {
        aliases: ['buy', 'market'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleBuy,
            description: 'Get a link to markets',
        },
    },
    {
        aliases: ['verify'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleVerify,
            description: 'Get a verify link',
        },
    },
    {
        aliases: ['incinerator'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleIncinerator,
            description: 'Get incinerator link',
        },
    },
    {
        aliases: ['translate'],
        primaryCommand: {
            argsFormat: Args.Split,
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
        },
        relatedCommands: [
            'translatefrom',
        ],
    },
    {
        aliases: ['translatefrom'],
        primaryCommand: {
            argsFormat: Args.Split,
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
        },
        relatedCommands: [
            'translate',
        ],
    },
    {
        aliases: ['trending'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleTrending,
            description: 'Get info on using the trending bot',
        },
    },
    {
        aliases: ['sign', 'tapthesign', 'chill'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleSign,
            description: 'Tap the sign',
        },
    },
];

export function handleHelp(msg: Message, args: string): void {
    const availableCommands = Commands.filter((c) => {
        if (c.primaryCommand.disabled) {
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
                const callString = config.prefix + args;

                let examples = [{
                    value: args,
                }]

                if (c.primaryCommand.examples && c.primaryCommand.examples.length > 0) {
                    examples = c.primaryCommand.examples;
                }

                if (c.subCommands && c.subCommands.length > 0) {
                    for (const subCommand of c.subCommands) {
                        if (subCommand.examples && !subCommand.disabled) {
                            examples = examples.concat(subCommand.examples);
                        }
                    }
                }

                let description = c.primaryCommand.description;

                if (c.primaryCommand.helpDescription) {
                    description = c.primaryCommand.helpDescription;
                } else if (c.primaryCommand.helpDescriptionFunc) {
                    description = c.primaryCommand.helpDescriptionFunc();
                }

                const embed = new MessageEmbed()
                    .setTitle(callString)
                    .setDescription(description);

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

                msg.channel.send({
                    embeds: [embed],
                });

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
                value: item.primaryCommand.description,
                inline: true,
            };
        },
    });

    pages.sendMessage();
}
