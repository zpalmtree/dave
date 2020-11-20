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
    migrateSuggest,
} from './Commands';

import {
    readJSON,
    writeJSON,
} from './Utilities';

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

function createTablesIfNeeded(db: Database) {
    if (config.devEnv) {
        const areYouReallySure = false;

        if (areYouReallySure) {
            db.run(`DROP TABLE IF EXISTS quote`);
            db.run(`DROP TABLE IF EXISTS movie`);
            db.run(`DROP TABLE IF EXISTS movie_link`);
            db.run(`DROP TABLE IF EXISTS watch_event`);
            db.run(`DROP TABLE IF EXISTS user_watch`);
            db.run(`DROP TABLE IF EXISTS timer`);
        }
    }

    /* This table stores our quotes. Simple as. */
    db.run(`CREATE TABLE IF NOT EXISTS quote (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        quote TEXT NOT NULL,
        channel_id VARCHAR(255) NOT NULL,
        timestamp TIMESTAMP
        DEFAULT CURRENT_TIMESTAMP
    )`);

    /* This table stores movie titles. */
    db.run(`CREATE TABLE IF NOT EXISTS movie (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        channel_id VARCHAR(255) NOT NULL
    )`);

    /* This table stores download links for movies. It references the movie
     * title */
    db.run(`CREATE TABLE IF NOT EXISTS movie_link (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        link TEXT NOT NULL,
        movie_id INTEGER NOT NULL,
        FOREIGN KEY(movie_id) REFERENCES movie(id)
    )`);

    /* This table stores a watch "event". This is when a user schedules a time
     * to watch a specific movie. We store the channel to have channel specific
     * watch lists. It references the movies title. */
    db.run(`CREATE TABLE IF NOT EXISTS watch_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TIMESTAMP NOT NULL,
        channel_id VARCHAR(255) NOT NULL,
        movie_id INTEGER NOT NULL,
        FOREIGN KEY(movie_id) REFERENCES movie(id)
    )`);

    /* This table stores watch event attendees. It stores the discord user id,
     * and references the watch event. */
    db.run(`CREATE TABLE IF NOT EXISTS user_watch (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id VARCHAR(255) NOT NULL,
        watch_event INTEGER NOT NULL,
        FOREIGN KEY(watch_event) REFERENCES watch_event(id)
    )`);

    /* This table stores set timers and their messages if they have one. */
    db.run(`CREATE TABLE IF NOT EXISTS timer (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id VARCHAR(255) NOT NULL,
        channel_id VARCHAR(255) NOT NULL,
        message VARCHAR(2000)
    )`);
}

function main() {
    const db: Database = getDB();

    createTablesIfNeeded(db);

    db.on('error', console.error);

    const client = new Client();

    client.on('ready', () => {
        console.log('Logged in');

        client.channels.fetch(config.devEnv ? config.devChannel : config.fit)
            .then((chan) => handleWatchNotifications(chan as TextChannel))
            .catch((err) => { console.error(`Failed to find channel: ${err.toString()}`); });

        migrateSuggest(db);
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

async function handleWatchNotifications(channel: TextChannel) {
    let { err, data } = await readJSON<ScheduledWatch>('watch.json');

    if (err) {
        setTimeout(handleWatchNotifications, config.watchPollInterval, channel);
        return;
    }

    for (const watch of data) {
        const fourHourReminder = moment(watch.time).subtract(4, 'hours');
        const fifteenMinuteReminder = moment(watch.time).subtract(15, 'minutes');

        /* Get our watch 'window' */
        const nMinsAgo = moment().subtract(config.watchPollInterval / 2, 'milliseconds');
        const nMinsAhead = moment().add(config.watchPollInterval / 2, 'milliseconds');

        const mention = watch.attending.map((x) => `<@${x}>`).join(' ');

        if (fourHourReminder.isBetween(nMinsAgo, nMinsAhead)) {
            channel.send(`${mention}, reminder, you are watching ${watch.title} in 4 hours (${moment(watch.time).utcOffset(0).format('HH:mm Z')})`);
        }

        if (fifteenMinuteReminder.isBetween(nMinsAgo, nMinsAhead)) {
            channel.send(`${mention}, reminder, you are watching ${watch.title} ${moment(watch.time).fromNow()}`);
        }
    }

    setTimeout(handleWatchNotifications, config.watchPollInterval, channel);
}

main();
