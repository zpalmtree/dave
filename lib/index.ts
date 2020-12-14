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

import { restoreTimers } from './Timer';

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

main();
