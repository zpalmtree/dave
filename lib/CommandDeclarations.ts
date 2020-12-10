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
} from './CommandImplementations';

import {
    handleRollHelp,
    handleQuoteHelp,
    handleSuggestHelp,
    handleFortuneHelp,
    handleMathHelp,
    handleDoggoHelp,
    handleKittyHelp,
    handleChinkedHelp,
    handleDotHelp,
    handlePizzaHelp,
    handleTurtleHelp,
    handleWatchHelp,
    handleTimeHelp,
    handleDateHelp,
    handleTimerHelp,
    handleCountdownHelp,
    handlePurgeHelp,
    handleTranslateHelp,
    handleQueryHelp,
    handleExchangeHelp,
    handleAvatarHelp,
    handleNikocadoHelp,
    handleImageHelp,
    handleYoutubeHelp,
    handleStatsHelp,
} from './Help';

import { config } from './Config';

export const Commands: Command[] = [
    {
        aliases: ['roll', 'reroll'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleRoll,
        helpFunction: handleRollHelp,
        description: 'Gets your post number and its repeating digits',
    },
    {
        aliases: ['quote'],
        argsFormat: Args.DontNeed,
        hidden: false,
        implementation: handleQuote,
        helpFunction: handleQuoteHelp,
        description: 'Gets a random quote',
        needDb: true,
    },
    {
        aliases: ['suggest'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleSuggest,
        helpFunction: handleSuggestHelp,
        description: 'Suggest a new quote',
        needDb: true,
    },
    {
        aliases: ['fortune'],
        argsFormat: Args.DontNeed,
        hidden: false,
        implementation: handleFortune,
        helpFunction: handleFortuneHelp,
        description: 'Get your fortune',
    },
    {
        aliases: ['math'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleMath,
        helpFunction: handleMathHelp,
        description: 'Perform math or conversions',
    },
    {
        aliases: ['doggo'],
        argsFormat: Args.Split,
        hidden: false,
        implementation: handleDoggo,
        helpFunction: handleDoggoHelp,
        description: 'Get a random dog picture',
    },
    {
        aliases: ['kitty'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleKitty,
        helpFunction: handleKittyHelp,
        description: 'Get a random cat picture',
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
        helpFunction: handleChinkedHelp,
        description: 'Display coronavirus statistics',
    },
    {
        aliases: ['dot'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleDot,
        helpFunction: handleDotHelp,
        description: 'Get the Global Consciousness Project Dot Graph',
    },
    {
        aliases: ['pizza'],
        argsFormat: Args.DontNeed,
        hidden: false,
        implementation: handleImgur.bind(undefined, 'r/pizza'),
        helpFunction: handlePizzaHelp,
        description: 'Get a random r/pizza picture',
    },
    {
        aliases: ['turtle'],
        argsFormat: Args.DontNeed,
        hidden: false,
        implementation: handleImgur.bind(undefined, 'r/turtle'),
        helpFunction: handleTurtleHelp,
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
        helpFunction: handleTimeHelp,
        description: 'Get the current time in a specific UTC offset',
    },
    {
        aliases: ['date'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleDate,
        helpFunction: handleDateHelp,
        description: 'Get the current date in a specific UTC offset',
    },
    {
        aliases: ['timer'],
        argsFormat: Args.Split,
        hidden: false,
        implementation: handleTimer,
        helpFunction: handleTimerHelp,
        description: 'Set a timer to remind you of something',
        needDb: true,
    },
    {
        aliases: ['countdown'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleCountdown.bind(undefined, 'Lets jam!'),
        helpFunction: handleCountdownHelp,
        description: 'Perform a countdown',
    },
    {
        aliases: ['purge'],
        argsFormat: Args.DontNeed,
        hidden: true,
        implementation: handlePurge,
        helpFunction: handlePurgeHelp,
        description: 'Delete all your messages in a channel',
        disabled: true,
    },
    {
        aliases: ['translate'],
        argsFormat: Args.Split,
        hidden: false,
        implementation: handleTranslate,
        helpFunction: handleTranslateHelp,
        description: 'Translate text from one language to another',
    },
    {
        aliases: ['pause'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleCountdown.bind(undefined, 'pause'),
        helpFunction: handleCountdownHelp,
        description: 'Perform a pause',
    },
    {
        aliases: ['query', 'search'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleQuery,
        helpFunction: handleQueryHelp,
        description: 'Query duckduckgo',
    },
    {
        aliases: ['exchange', 'convert'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleExchange,
        helpFunction: handleExchangeHelp,
        description: 'Convert between REAL currencies',
    },
    {
        aliases: ['avatar'],
        argsFormat: Args.DontNeed,
        hidden: false,
        implementation: handleAvatar,
        helpFunction: handleAvatarHelp,
        description: 'Retrieve a users avatar',
    },
    {
        aliases: ['nikocado', 'orlin', 'niko', 'avocado'],
        argsFormat: Args.DontNeed,
        hidden: true,
        implementation: handleNikocado,
        helpFunction: handleNikocadoHelp,
        description: 'Get a random nikocado',
    },
    {
        aliases: ['image'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleImage,
        helpFunction: handleImageHelp,
        description: 'Query duckduckgo images',
    },
    {
        aliases: ['youtube'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleYoutube,
        helpFunction: handleYoutubeHelp,
        description: 'Query youtube',
    },
    {
        aliases: ['stats'],
        argsFormat: Args.Combined,
        hidden: false,
        implementation: handleStats,
        helpFunction: handleStatsHelp,
        description: 'View bot usage statistics',
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

                if (c.examples && c.examples.length > 0) {
                    const embed = new MessageEmbed()
                        .setTitle(`${config.prefix}${args}`)
                        .setDescription(c.description)
                        .addFields(c.examples.map((e) => {
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
