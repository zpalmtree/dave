import {
    Message,
    EmbedBuilder,
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
    slugUserGate,
} from './Utilities.js';

import {
    handleDefine,
} from './Define.js'

import {
    handleFortune,
    handleMath,
    handleRoll,
    handleQuote,
    handleQuotes,
    handleSuggest,
    handleKitty,
    handleDoggo,
    handleImgur,
    handleTime,
    handleDate,
    handleStock,
    handleCountdown,
    handlePurge,
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
    handleGroundhog,
    handleGroove,
    handleKek,
    handleNut,
    handleMoney,
    handleViper,
    handleCock,
    handleBurn,
    handle3d,
    handleGen2,
    handleBuy,
    handleVerify,
    handleIncinerator,
    handleTrending,
    handleSign,
    handleBurnt,
    handleFrozen,
    handleIncineratorFAQ,
    handleGen3Count,
    handleGen3CountLegacy,
    handleGen4Count,
    handleGen4Leaderboard,
    handleGen5Count,
    handleGen5Leaderboard,
    handleItsOver,
    handleUtility,
    handleSlime,
    handleGitbook,
    handleAIInfo,
    handleChickenFried,
    handleDot,
    handleMilton,
    handleSlugFloor,
    handleSlugPride,
    handleSupply,
} from './CommandImplementations.js';

import {
    handleChatGPT,
    handleGLADOS,
    handleDrunk,
    handleDoctor,
    handleGf,
    handleTradGf,
    handleAIQuote,
    handleDavinci,
    handleTranscribe,
    handleO1,
    handleQi,
    handleTranslate,
} from './OpenAI.js';

import {
    handleClaude,
} from './Claude.js';

import {
    handleTimers,
    handleTimer,
    deleteTimer,
} from './Timer.js';

import {
    handleSummarize,
    handleLongSummarize,
} from './Summarize.js';

import { exchangeService } from './Exchange.js';

import { handleWeather } from './Weather.js';

import { config } from './Config.js';

export const Commands: Command[] = [
    {
        aliases: ['gen3', 'gen3count', 'gen3supply'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleGen3Count,
            description: 'Displays the current Generation 3 slug supply',
        }
    },
    {
        aliases: ['gen3legacy'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleGen3CountLegacy,
            description: 'Displays the historical Generation 3 eligiblity',
        }
    },
    {
        aliases: ['gen4', 'gen4count', 'gen4supply'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleGen4Count,
            description: 'Displays the current Generation 4 slug supply',
        }
    },
    {
        aliases: ['gen4leaderboard', 'leaderboard'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleGen4Leaderboard,
            description: 'Display users getting the most gen4 slugs',
        },
    },
    {
        aliases: ['gen5', 'gen5count', 'gen5supply'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleGen5Count,
            description: 'Displays the current Generation 5 slug supply',
        }
    },
    {
        aliases: ['gen5leaderboard', 'leaderboard'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleGen5Leaderboard,
            description: 'Display users getting the most gen5 slugs',
        },
    },
    {
        aliases: ['burnt', 'burned'],
        primaryCommand: {
            argsFormat: Args.Combined,
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
        aliases: ['dot'],
        primaryCommand: {
            argsFormat: Args.Combined,
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
    },
    {
        aliases: ['pizza'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleImgur.bind(undefined, 'r/pizza'),
            description: 'Get a random r/pizza picture',
        },
    },
    {
        aliases: ['tortle'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleImgur.bind(undefined, 'r/turtle'),
            description: 'Get a random r/turtle picture',
        },
    },
    {
        aliases: ['time'],
        primaryCommand: {
            argsFormat: Args.Combined,
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
        },
        relatedCommands: [
            'date',
        ],
    },
    {
        aliases: ['date'],
        primaryCommand: {
            argsFormat: Args.Combined,
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
        },
        relatedCommands: [
            'time',
        ],
    },
    {
        aliases: ['timer', 'reminder'],
        primaryCommand: {
            argsFormat: Args.Split,
            implementation: handleTimer,
            description: 'Set a timer to remind you of something',
            helpDescription: 'Set a timer to remind you of something. Available time units: `y` (year), `mm` (month), `w` (week), `d` (day), `h` (hour), `m` (minute), `s` (second)',
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
            ],
        },
        subCommands: [
            {
                argsFormat: Args.DontNeed,
                implementation: handleTimers,
                description: 'View running timers',
                aliases: ['list'],
                needDb: true,
                examples: [
                    {
                        name: 'View running timers',
                        value: 'timer list',
                    },
                ],
            },
            {
                argsFormat: Args.Split,
                implementation: deleteTimer,
                description: 'Delete a timer by ID',
                aliases: ['delete'],
                needDb: true,
                examples: [
                    {
                        name: 'Delete a timer by ID',
                        value: 'timer delete 1',
                    },
                ],
            },
        ],
        relatedCommands: [
            'timers',
        ],
    },
    {
        aliases: ['countdown'],
        primaryCommand: {
            argsFormat: Args.Combined,
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
        },
        relatedCommands: [
            'ready',
            'pause',
        ],
    },
    {
        aliases: ['purge'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handlePurge,
            description: 'Delete all your messages in a channel',
        },
    },
    {
        aliases: ['translate'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleTranslate,
            description: 'Translate text from one language to another',
            examples: [
                {
                    name: 'Translate to english',
                    value: 'translate C\'est la vie',
                },
                {
                    name: 'Translate to another language',
                    value: 'translate to french: Such is life',
                }
            ],
        },
    },
    {
        aliases: ['pause'],
        primaryCommand: {
            argsFormat: Args.Combined,
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
        },
        relatedCommands: [
            'countdown',
            'ready',
        ],
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
        commandGates: [
            slugUserGate,
        ],
    },
    {
        aliases: ['exchange'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleExchange,
            description: 'Convert between REAL currencies',
            helpDescriptionFunc: () => `Convert between currencies. Known currencies: \`${exchangeService.getCurrencies().join(',')}\``,
            examples: [
                {
                    value: 'exchange 100 USD to GBP',
                },
                {
                    value: 'exchange 666.66 MXN to EUR',
                },
            ],
        },
    },
    {
        aliases: ['avatar', 'av', 'pfp'],
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
        commandGates: [
            slugUserGate,
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
        aliases: ['burn'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleBurn,
            description: `Explain why you might burn a slug`,
        },
    },
    {
        aliases: ['utility', 'whybuy'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleUtility,
            description: `Explain why you might buy a slug`,
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
        aliases: ['trending'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleTrending,
            description: 'Get info on using the trending bot',
        },
    },
    {
        aliases: ['sign', 'tapthesign', 'tapsign', 'chill'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleSign,
            description: 'Tap the sign',
        },
    },
    {
        aliases: ['ai', 'gpt3', 'prompt'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleDavinci,
            description: 'Provide a prompt to the funny AI and get a completion',
        },
        relatedCommands: [
            'chatgpt',
            'glados',
            'drunk',
        ],
        commandGates: [
            slugUserGate,
        ],
    },
    {
        aliases: ['clowns', 'sendintheclowns'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: (msg: Message) => msg.reply('https://www.youtube.com/watch?v=ZG15oP7q4fI'),
            description: 'Send in the clowns',
        },
    },
    {
        aliases: ['stats'],
        primaryCommand: {
            argsFormat: Args.Split,
            implementation: handleStats,
            description: 'View bot usage statistics',
            needDb: true,
            examples: [
                {
                    name: `View most used commands`,
                    value: 'stats',
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
        subCommands: [
            {
                argsFormat: Args.DontNeed,
                implementation: handleUsersStats,
                description: 'View number of times users have used the bot',
                aliases: ['users', 'user'],
                needDb: true,
                examples: [
                    {
                        name: `View number of times users have used the bot`,
                        value: 'stats users',
                    },
                ],
            },
        ],
    },
    {
        aliases: ['frozen', 'freeze'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleFrozen,
            description: 'Get info on frozen tokens',
        },
    },
    {
        aliases: ['incin', 'incinFAQ', 'tokens'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleIncineratorFAQ,
            description: 'Frequently asked questions about the incinerator',
        },
    },
    {
        aliases: ['image', 'img'],
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
        commandGates: [
            slugUserGate,
        ],
    },
    {
        aliases: ['ready'],
        primaryCommand: {
            argsFormat: Args.Split,
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
        },
        relatedCommands: [
            'countdown',
            'pause',
        ],
    },
    {
        aliases: ['countdown'],
        primaryCommand: {
            argsFormat: Args.Combined,
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
        },
        relatedCommands: [
            'ready',
            'pause',
        ],
    },
    {
        aliases: ['pause'],
        primaryCommand: {
            argsFormat: Args.Combined,
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
        },
        relatedCommands: [
            'countdown',
            'ready',
        ],
    },
    {
        aliases: ['timers'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleTimers,
            description: 'View the status of running timers',
            needDb: true,
        },
        relatedCommands: [
            'timer',
        ],
    },
    {
        aliases: ['timer', 'reminder'],
        primaryCommand: {
            argsFormat: Args.Split,
            implementation: handleTimer,
            description: 'Set a timer to remind you of something',
            helpDescription: 'Set a timer to remind you of something. Available time units: `y` (year), `mm` (month), `w` (week), `d` (day), `h` (hour), `m` (minute), `s` (second)',
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
            ],
        },
        subCommands: [
            {
                argsFormat: Args.DontNeed,
                implementation: handleTimers,
                description: 'View running timers',
                aliases: ['list'],
                needDb: true,
                examples: [
                    {
                        name: 'View running timers',
                        value: 'timer list',
                    },
                ],
            },
            {
                argsFormat: Args.Split,
                implementation: deleteTimer,
                description: 'Delete a timer by ID',
                aliases: ['delete'],
                needDb: true,
                examples: [
                    {
                        name: 'Delete a timer by ID',
                        value: 'timer delete 1',
                    },
                ],
            },
        ],
        relatedCommands: [
            'timers',
        ],
    },
    {
        aliases: ['weather', 'forecast'],
        primaryCommand: {
            argsFormat: Args.Combined,
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
                    name: 'Get the weather in a specific country',
                    value: 'Weather Paris, US',
                },
                {
                    name: 'Get the weather in a zip code',
                    value: 'weather 10001, US',
                },
                {
                    name: 'Get the weather in a post code',
                    value: 'weather SW1, GB',
                },
            ],
        },
    },
    {
        aliases: ['over', 'itsover'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleItsOver,
            description: 'Post it\'s over meme',
        },
    },
    {
        aliases: ['slime'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleSlime,
            description: 'Get a link to slime',
        },
    },
    {
        aliases: ['define', 'definition'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleDefine,
            description: 'Get a definition for a word',
            examples: [
                {
                    name: 'define the word \"based\"',
                    value: 'define based',
                },
            ],
        },
    },
    {
        aliases: ['info', 'gitbook'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleGitbook,
            description: 'Get a link to the slugs gitbook',
        },
    },
    {
        aliases: ['howtoai', 'aiinfo', 'aitut'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleAIInfo,
            description: 'Get info on using the AI image bot',
        },
    },
    {
        aliases: ['time'],
        primaryCommand: {
            argsFormat: Args.Combined,
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
        },
        relatedCommands: [
            'date',
        ],
    },
    {
        aliases: ['date'],
        primaryCommand: {
            argsFormat: Args.Combined,
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
        },
        relatedCommands: [
            'time',
        ],
    },
    {
        aliases: ['chatgpt', 'chatgtp', 'chat-gpt'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleChatGPT,
            description: 'Ask ChatGPT something',
        },
        relatedCommands: [
            'ai',
            'glados',
            'drunk',
            'doctor',
        ],
        commandGates: [
            slugUserGate,
        ],
    },
    {
        aliases: ['glados'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleGLADOS,
            description: 'Ask GLaDOS something',
        },
        relatedCommands: [
            'ai',
            'chatgpt',
            'drunk',
            'doctor',
        ],
        commandGates: [
            slugUserGate,
        ],
    },
    {
        aliases: ['drunk', 'homelander', 'homestead', 'homesteader'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleDrunk,
            description: 'Ask a drunk person something',
        },
        relatedCommands: [
            'ai',
            'chatgpt',
            'glados',
            'doctor',
        ],
        commandGates: [
            slugUserGate,
        ],
    },
    {
        aliases: ['doctor'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleDoctor,
            description: 'Ask the doctor something',
        },
        relatedCommands: [
            'ai',
            'chatgpt',
            'glados',
            'drunk',
        ],
        commandGates: [
            slugUserGate,
        ],
    },
    {
        aliases: ['aiquote'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleAIQuote,
            description: 'Generate AI quote',
        },
        relatedCommands: [
            'ai',
            'chatgpt',
            'glados',
            'drunk',
        ],
        commandGates: [
            slugUserGate,
        ],
    },
    {
        aliases: ['chickenfried', 'fried', 'friday', 'fridaynight', 'coldbeer', 'radio', 'sunrise', 'womanseyes', 'preciouschild', 'motherslove', 'jeans', 'repost'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleChickenFried,
            description: 'Get the chicken fried vid',
        },
    },
    {
        aliases: ['summary', 'summarize', 'longsummary'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleLongSummarize,
            description: 'Get a summary of recent conversation in this channel',
        },
        commandGates: [
            slugUserGate,
        ],
    },
    {
        aliases: ['gf'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleGf,
            description: 'Talk to your virtual gf',
        },
        commandGates: [
            slugUserGate,
        ],
    },
    {
        aliases: ['tradgf'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleTradGf,
            description: 'Talk to your trad virtual gf',
        },
        commandGates: [
            slugUserGate,
        ],
    },
    {
        aliases: ['transcribe'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleTranscribe,
            description: 'Transcribe audio from an audio or video file or URL',
        },
        commandGates: [
            slugUserGate,
        ],
    },
    {
        aliases: ['claude', 'sonnet'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleClaude,
            description: 'Ask Claude something',
        },
        relatedCommands: [
            'ai',
            'glados',
            'drunk',
            'doctor',
        ],
        commandGates: [
            slugUserGate,
        ],
    },
    {
        aliases: ['o1'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleO1,
            description: 'Ask GPT o1-preview something',
        },
        relatedCommands: [
            'ai',
            'glados',
            'drunk',
            'claude',
            'chatgpt',
        ],
    },
    {
        aliases: ['qi'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleQi,
            description: 'Deranged torus bot',
        },
        commandGates: [
            slugUserGate,
        ],
    },
    {
        aliases: ['milton'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleMilton,
            description: 'Track milton',
        },
    },
    {
        aliases: ['floor'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleSlugFloor,
            description: 'Get sol slugs floor price',
        },
    },
    {
        aliases: ['slugpride'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleSlugPride,
            description: 'Get slug pride video',
        },
    },
    {
        aliases: ['supply'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleSupply,
            description: 'Get current sol slugs supply',
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

                const embed = new EmbedBuilder()
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

    const embed = new EmbedBuilder()
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

