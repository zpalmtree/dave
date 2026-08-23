import moment from 'moment';
import { Message } from 'discord.js';
import { Database } from 'sqlite3';

import { config } from './Config.js';
import { insertQuery } from './Database.js';
import { Commands, handleHelp } from './CommandDeclarations.js';
import {
    Args,
    CombinedArgsCommand,
    CombinedArgsCommandDb,
    CommandFunc,
    DontNeedArgsCommand,
    DontNeedArgsCommandDb,
    SplitArgsCommand,
    SplitArgsCommandDb,
} from './Types.js';
import { runWithTokenSpendContext } from './TokenSpend.js';
import {
    isAllowedByUserChannelRestriction,
    userChannelRestrictions,
} from './UserChannelRestrictions.js';
import { canAccessCommand } from './Utilities.js';

export function isMessageAllowed(msg: Message): boolean {
    if (config.devEnv && !config.devChannels.includes(msg.channel.id)) {
        return false;
    }

    const userChannelRestriction = userChannelRestrictions.find(
        ({ userId }) => userId === msg.author.id
    );

    return !userChannelRestriction || isAllowedByUserChannelRestriction(
        userChannelRestriction,
        msg.channel.id,
        msg.guild?.id ?? null
    );
}

export async function dispatchPrefixedCommand(msg: Message, db: Database): Promise<void> {
    if (!isMessageAllowed(msg) || !msg.content.startsWith(config.prefix)) {
        return;
    }

    const [tmp, ...args] = msg.content.trim().split(/\s+/);
    const command = tmp.substring(tmp.indexOf(config.prefix) + 1).toLowerCase();

    for (const c of Commands) {
        if (!c.aliases.includes(command)) {
            continue;
        }

        if (c.discordOnly && (msg as any).platform === 'uproar') {
            return;
        }

        if (c.hidden && !canAccessCommand(msg, true)) {
            return;
        }

        insertQuery(
            `INSERT INTO logs
                (user_id, channel_id, guild_id, command, args, timestamp)
            VALUES
                (?, ?, ?, ?, ?, ?)`,
            db,
            [
                msg.author.id,
                msg.channel.id,
                msg.guild?.id ?? null,
                c.aliases[0],
                args.join(' '),
                moment.utc().format('YYYY-MM-DD HH:mm:ss'),
            ]
        );

        if (args.length === 1 && args[0] === 'help') {
            handleHelp(msg, c.aliases[0]);
            return;
        }

        if (c.commandGates) {
            for (const gate of c.commandGates) {
                const { canAccess, error } = gate(msg);

                if (!canAccess) {
                    if (error) {
                        await msg.reply(error);
                    }
                    return;
                }
            }
        }

        if (args.length > 0 && c.subCommands && c.subCommands.length > 0) {
            for (const subCommand of c.subCommands) {
                if (subCommand.aliases && subCommand.aliases.includes(args[0])) {
                    if (!subCommand.disabled) {
                        await runWithTokenSpendContext(msg, c.aliases[0], () =>
                            dispatchCommand(subCommand, msg, db, args.slice(1)));
                    }

                    return;
                }
            }
        }

        if (!c.primaryCommand.disabled) {
            await runWithTokenSpendContext(msg, c.aliases[0], () =>
                dispatchCommand(c.primaryCommand, msg, db, args));
        }

        return;
    }
}

async function dispatchCommand(
    command: CommandFunc,
    msg: Message,
    db: Database,
    args: string[],
): Promise<void> {
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
