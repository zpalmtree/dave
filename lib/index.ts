import moment from 'moment';
import sqlite3 from 'sqlite3';

import {
    Message,
    Client,
    GatewayIntentBits,
    GuildChannel,
} from 'discord.js';

import { evaluate } from 'mathjs';

import { config } from './Config.js';
import {
    canAccessCommand,
    tryReactMessage,
    handleGetFromME,
    numberWithCommas
} from './Utilities.js';

import {
    insertQuery,
    createTablesIfNeeded,
    deleteTablesIfNeeded,
} from './Database.js';

import {
    Command,
    CommandFunc,
    Args,
    DontNeedArgsCommandDb,
    DontNeedArgsCommand,
    SplitArgsCommandDb,
    SplitArgsCommand,
    CombinedArgsCommandDb,
    CombinedArgsCommand,
    Quote,
} from './Types.js';

import {
    Commands,
    handleHelp,
} from './CommandDeclarations.js';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

/* This is the main entry point to handling messages. */
async function handleMessage(msg: Message, db: sqlite3.Database): Promise<void> {
    if (!msg.content.startsWith(config.prefix)) {
        return;
    }

    /*
    if (msg.author.bot) {
        return;
    }
    */

    if (msg.author.id === msg.client.user.id) {
        return;
    }

    if (config.devEnv && !config.devChannels.includes(msg.channel.id)) {
        return;
    }

    /* Get the command with prefix, and any args */
    const [ tmp, ...args ] = msg.content.trim().split(' ');

    /* Get the actual command after the prefix is removed */
    const command: string = tmp.substring(tmp.indexOf(config.prefix) + 1, tmp.length).toLowerCase();

    for (const c of Commands) {
        if (c.aliases.includes(command)) {
            if (c.hidden) {
                if (!canAccessCommand(msg, true)) {
                    return;
                }
            }

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
                    moment.utc().format('YYYY-MM-DD HH:mm:ss'),
                ]
            );

            if (args.length === 1 && args[0] === 'help') {
                handleHelp(msg, c.aliases[0]);
                return;
            }

            /* Check if the user is calling a sub command instead of the main
             * function. */
            if (args.length > 0 && c.subCommands && c.subCommands.length > 0) {
                for (const subCommand of c.subCommands) {
                    if (subCommand.aliases && subCommand.aliases.includes(args[0])) {
                        if (!subCommand.disabled) {
                            await dispatchCommand(subCommand, msg, db, args.slice(1));
                        }

                        return;
                    }
                }
            }

            if (!c.primaryCommand.disabled) {
                await dispatchCommand(c.primaryCommand, msg, db, args);
            }

            return;
        }
    }
}

async function dispatchCommand(
    command: CommandFunc,
    msg: Message,
    db: sqlite3.Database,
    args: string[]) {

    switch (command.argsFormat) {
        case Args.DontNeed: {
            if (command.needDb) {
                await (command.implementation as DontNeedArgsCommandDb)(msg, db);
            } else {
                await (command.implementation as DontNeedArgsCommand)(msg);
            }

            break;
        }
        case Args.Split: {
            if (command.needDb) {
                await (command.implementation as SplitArgsCommandDb)(msg, args, db);
            } else {
                await (command.implementation as SplitArgsCommand)(msg, args);
            }

            break;
        }
        case Args.Combined: {
            if (command.needDb) {
                await (command.implementation as CombinedArgsCommandDb)(msg, args.join(' '), db);
            } else {
                await (command.implementation as CombinedArgsCommand)(msg, args.join(' '));
            }

            break;
        }
    }
}

async function handleFloorPriceChannel(client: Client, magicEdenData: any) {
    try {
        const myChannel = client.channels.cache.get(config.priceChannel) as GuildChannel;
        const price = Number(magicEdenData.floorPrice) / LAMPORTS_PER_SOL;
        await myChannel.setName(`Floor Price: ◎${price}`);
    } catch (error) {
        console.log(error);
    }
};

async function handleTotalVolumeChannel(client: Client, magicEdenData: any) {
    try {
        const myChannel = client.channels.cache.get(config.volumeChannel) as GuildChannel;
        const volume = numberWithCommas((Math.round(magicEdenData.volumeAll / LAMPORTS_PER_SOL)).toString());
        await myChannel.setName(`Total Volume: ◎${volume}`);
    } catch (error) {
        console.log(error);
    }
};

async function magicEdenStatUpdater(client: Client) {
    try {
        const magicEdenData = await handleGetFromME("https://api-mainnet.magiceden.dev/v2/collections/sol_slugs/stats");

        handleFloorPriceChannel(client, magicEdenData);
        handleTotalVolumeChannel(client, magicEdenData);
    } catch (err) {
        console.log(err);
    }

    setTimeout(() => magicEdenStatUpdater(client), 60 * 1000);
}

async function main() {
    const db: sqlite3.Database = new sqlite3.Database(config.dbFile);

    await deleteTablesIfNeeded(db);
    await createTablesIfNeeded(db);

    db.on('error', console.error);

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
    		GatewayIntentBits.GuildMessages,
		    GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMessageReactions,
        ],
    });

    client.on('ready', async () => {
        console.log('Logged in');

        magicEdenStatUpdater(client);
    });

    client.on('messageCreate', async (msg) => {
        try {
            await handleMessage(msg as Message, db);
        /* Usually discord permissions errors */
        } catch (err) {
            console.error(`Caught error while executing ${msg.content} for ${msg.author.id}: ${(err as any).toString()}`);
            console.log(`Error stack trace: ${(err as any).stack}`);
            tryReactMessage(msg, '🔥');
        }
    });

    client.on('error', (err) => {
        console.log(`Caught error from discord client: ${err.toString()}`);
        console.log(`Error stack trace: ${err.stack}`);
    });

    client.login(config.token)
          .catch((err) => {
              console.error(err);
              main();
    });
}

main();
