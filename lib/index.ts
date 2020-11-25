import * as moment from 'moment';
import { Database } from 'sqlite3';

import {
    Message,
    Client,
    TextChannel,
    User,
    MessageEmbed,
    MessageAttachment
} from 'discord.js';

import { evaluate } from 'mathjs';

import { config } from './Config';
import { catBreeds } from './Cats';
import { dogBreeds } from './Dogs';
import { fortunes } from './Fortunes';
import { dubTypes } from './Dubs';

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
} from './Commands';

import {
    sendTimer,
    readJSON,
} from './Utilities';

import {
    insertQuery,
    createTablesIfNeeded,
    deleteTablesIfNeeded,
} from './Database';

import {
    Command,
    ScheduledWatch,
    Args,
    DontNeedArgsCommandDb,
    DontNeedArgsCommand,
    SplitArgsCommandDb,
    SplitArgsCommand,
    CombinedArgsCommandDb,
    CombinedArgsCommand,
    Quote,
} from './Types';

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
} from './Help';

import {
    handleWatchNotifications,
} from './Watch';

const commands: Command[] = [
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
        hidden: true,
        implementation: handleQuote,
        helpFunction: handleQuoteHelp,
        description: 'Gets a random quote',
        needDb: true,
    },
    {
        aliases: ['suggest'],
        argsFormat: Args.Combined,
        hidden: true,
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
        argsFormat: Args.DontNeed,
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
        implementation: handleImgur.bind(this, 'r/pizza'),
        helpFunction: handlePizzaHelp,
        description: 'Get a random r/pizza picture',
    },
    {
        aliases: ['turtle'],
        argsFormat: Args.DontNeed,
        hidden: false,
        implementation: handleImgur.bind(this, 'r/turtle'),
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
        hidden: true,
        implementation: handleCountdown.bind(this, 'Lets jam!'),
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
        hidden: true,
        implementation: handleCountdown.bind(this, 'pause'),
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
];

function handleMessage(msg: Message, db: Database) {
    if (!msg.content.startsWith(config.prefix)) {
        return;
    }

    if (msg.author.bot) {
        return;
    }

    if (config.devEnv && msg.channel.id !== config.devChannel) {
        return;
    }

    /* Get the command with prefix, and any args */
    const [ tmp, ...args ] = msg.content.split(' ');

    /* Get the actual command after the prefix is removed */
    const command: string = tmp.substring(tmp.indexOf(config.prefix) + 1, tmp.length);

    for (const c of commands) {
        if (c.disabled) {
            continue;
        }

        if (c.aliases.includes(command)) {
            if (c.hidden) {
                if (!canAccessCommand(msg, true)) {
                    return;
                }
            }

            if (args.length === 1 && args[0] === 'help' && c.helpFunction) {
                c.helpFunction(msg);
                return;
            }

            switch (c.argsFormat) {
                case Args.DontNeed: {
                    if (c.needDb) {
                        (c.implementation as DontNeedArgsCommandDb)(msg, db);
                    } else {
                        (c.implementation as DontNeedArgsCommand)(msg);
                    }

                    break;
                }
                case Args.Split: {
                    if (c.needDb) {
                        (c.implementation as SplitArgsCommandDb)(msg, args, db);
                    } else {
                        (c.implementation as SplitArgsCommand)(msg, args);
                    }

                    break;
                }
                case Args.Combined: {
                    if (c.needDb) {
                        (c.implementation as CombinedArgsCommandDb)(msg, args.join(' '), db);
                    } else {
                        (c.implementation as CombinedArgsCommand)(msg, args.join(' '));
                    }

                    break;
                }
            }

            return;
        }
    }
}

function getDB(): Database {
    return new Database(config.dbFile);
}

async function main() {
    const db: Database = getDB();

    await deleteTablesIfNeeded(db);
    await createTablesIfNeeded(db);

    db.on('error', console.error);

    const client = new Client();

    client.on('ready', async () => {
        console.log('Logged in');

        client.channels.fetch(config.devEnv ? config.devChannel : config.fit)
            .then((chan) => handleWatchNotifications(chan as TextChannel, db))
            .catch((err) => { console.error(`Failed to find channel: ${err.toString()}`); });

        const migrate = false;

        if (migrate) {
            await migrateSuggest(db);
            await migrateWatch(db);
        }

        restoreTimers(db, client);
    });

    client.on('message', (msg) => {
        try {
            handleMessage(msg as Message, db);
        /* Usually discord permissions errors */
        } catch (err) {
            console.error('Caught error: ' + err.toString());
        }
    });

    client.on('error', console.error);

    client.login(config.token)
          .catch((err) => {
              console.error(err);
              main();
    });
}

function canAccessCommand(msg: Message, react: boolean): boolean {
    if (msg.channel.id === config.fit) {
        return true;
    }

    if (msg.author.id === config.god) {
        return true;
    }

    if (react) {
        msg.react('❌');
    }

    return false;
}

function handleHelp(msg: Message): void {
    const embed = new MessageEmbed()
        .setFooter('Enter <command> help for more info and examples on any command');

    for (const c of commands) {
        if (c.hidden && !canAccessCommand(msg, false)) {
            continue;
        }

        embed.addFields({
            name: '$' + c.aliases[0],
            value: c.description,
            inline: true,
        });
    }

    msg.reply(embed);
}

export async function restoreTimers(db: Database, client: Client) {
    db.all(
        `SELECT
            user_id,
            channel_id,
            message,
            expire_time
        FROM
            timer`,
        async (err, rows) => {
            if (err) {
                console.log('got error: ' + err);
                return;
            }

            for (const row of rows) {
                const milliseconds = moment(row.expire_time).diff(moment());

                if (milliseconds < 0) {
                    continue;
                }

                const chan = await client.channels.fetch(row.channel_id);

                sendTimer(chan as TextChannel, milliseconds, row.user_id, row.message);
            }
        }
    );
}

export async function migrateSuggest(db: Database) {
    console.log('-- Performing quote migration');

    const { err, data: quotes } = await readJSON<Quote>('./quotes.json');

    if (err) {
        console.error(err);
        return;
    }

    for (const quote of quotes) {
        console.log(`---- Inserting ${quote.quote}..`);

        if (quote.timestamp && quote.timestamp !== 0) {
            await insertQuery(
                `INSERT INTO quote
                    (quote, channel_id, timestamp)
                VALUES
                    (?, ?, ?)`,
                db,
                [
                    quote.quote,
                    config.devEnv
                        ? config.devChannel
                        : config.fit,
                    moment(quote.timestamp).utcOffset(0).format('YYYY-MM-DD hh:mm:ss')
                ]
            );
        } else {
            await insertQuery(
                `INSERT INTO quote
                    (quote, channel_id, timestamp)
                VALUES
                    (?, ?, NULL)`,
                db,
                [
                    quote.quote,
                    config.devEnv
                        ? config.devChannel
                        : config.fit
                ]
            );
        }
    }

    console.log('-- Done');
}

export async function migrateWatch(db: Database) {
    console.log('-- Performing watch migration');

    const { err, data } = await readJSON<any>('watch.json');

    if (err) {
        console.error(err);
        return;
    }

    for (const watch of data) {
        console.log(`---- Inserting ${watch.title}...`);

        const movieID = await insertQuery(
            `INSERT INTO movie
                (title, channel_id)
            VALUES
                (?, ?)`,
            db,
            [ watch.title, config.devChannel ]
        );

        if (watch.link) {
            await insertQuery(
                `INSERT INTO movie_link
                    (link, movie_id, is_download)
                VALUES
                    (?, ?, 0)`,
                db,
                [ watch.link, movieID ]
            );
        }

        if (watch.magnet) {
            await insertQuery(
                `INSERT INTO movie_link
                    (link, movie_id, is_download)
                VALUES
                    (?, ?, 1)`,
                db,
                [ watch.magnet, movieID ]
            );
        }

        const watchEventID = await insertQuery(
            `INSERT INTO watch_event
                (timestamp, channel_id, movie_id)
            VALUES
                (?, ?, ?)`,
            db,
            [ moment(watch.time).utcOffset(0).format('YYYY-MM-DD hh:mm:ss'), config.devChannel, movieID ]
        );

        for (const attendee of watch.attending) {
            await insertQuery(
                `INSERT INTO user_watch
                    (user_id, watch_event)
                VALUES
                    (?, ?)`,
                db,
                [ attendee, watchEventID ]
            );
        }
    }

    console.log('-- Done');
}

main();
