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
    sendTimer,
    readJSON,
    canAccessCommand,
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
    handleWatchNotifications,
} from './Watch';

import {
    Commands,
    handleHelp,
} from './CommandDeclarations';

async function handleMessage(msg: Message, db: Database): Promise<void> {
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
    const command: string = tmp.substring(tmp.indexOf(config.prefix) + 1, tmp.length).toLowerCase();

    for (const c of Commands) {
        if (c.disabled) {
            continue;
        }

        if (c.aliases.includes(command)) {
            insertQuery(
                `INSERT INTO logs
                    (user_id, channel_id, command, args, timestamp)
                VALUES
                    (?, ?, ?, ?, ?)`,
                db,
                [
                    msg.author.id,
                    msg.channel.id,
                    c.aliases[0],
                    args.join(' '),
                    moment().utcOffset(0).format('YYYY-MM-DD hh:mm:ss'),
                ]
            );

            if (c.hidden) {
                if (!canAccessCommand(msg, true)) {
                    return;
                }
            }

            if (args.length === 1 && args[0] === 'help') {
                handleHelp(msg, c.aliases[0]);
                return;
            }

            switch (c.argsFormat) {
                case Args.DontNeed: {
                    if (c.needDb) {
                        await (c.implementation as DontNeedArgsCommandDb)(msg, db);
                    } else {
                        await (c.implementation as DontNeedArgsCommand)(msg);
                    }

                    break;
                }
                case Args.Split: {
                    if (c.needDb) {
                        await (c.implementation as SplitArgsCommandDb)(msg, args, db);
                    } else {
                        await (c.implementation as SplitArgsCommand)(msg, args);
                    }

                    break;
                }
                case Args.Combined: {
                    if (c.needDb) {
                        await (c.implementation as CombinedArgsCommandDb)(msg, args.join(' '), db);
                    } else {
                        await (c.implementation as CombinedArgsCommand)(msg, args.join(' '));
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

        const migrate = false;

        if (migrate) {
            await migrateSuggest(db);
            await migrateWatch(db);
        }

        handleWatchNotifications(client, db);
        restoreTimers(db, client);
    });

    client.on('message', async (msg) => {
        try {
            await handleMessage(msg as Message, db);
        /* Usually discord permissions errors */
        } catch (err) {
            console.error('Caught error: ' + err.toString());
            msg.react('🔥');
        }
    });

    client.on('error', console.error);

    client.login(config.token)
          .catch((err) => {
              console.error(err);
              main();
    });
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
                        : config.mainChannel,
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
                        : config.mainChannel
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
            [
                watch.title,
                config.devEnv
                    ? config.devChannel
                    : config.mainChannel
            ]
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
            [
                moment(watch.time).utcOffset(0).format('YYYY-MM-DD hh:mm:ss'),
                config.devEnv
                    ? config.devChannel
                    : config.mainChannel,
                movieID
            ]
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
