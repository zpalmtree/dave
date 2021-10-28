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
} from './CommandImplementations';

import {
    handleTimers,
    handleTimer,
    deleteTimer,
} from './Timer';

import {
    handleWatch,
    deleteWatch,
    displayAllWatches,
    updateTime,
    addLink,
    handleWatchStats,
} from './Watch';

import { exchangeService } from './Exchange';

import { handleWeather } from './Weather';

import { config } from './Config';

export const Commands: Command[] = [
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
        aliases: ['image'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleImage,
            description: 'Query duckduckgo images',
            examples: [
                {
                    value: 'image sunset',
                },
            ],
        },
        relatedCommands: [
            'query',
            'youtube',
        ],
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
