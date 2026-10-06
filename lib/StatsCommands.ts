/* $stats and $tokens: command usage and AI token spend reports. */

import { EmbedBuilder, Message } from 'discord.js';
import { Database } from 'sqlite3';

import { config } from './Config.js';
import { Commands } from './CommandDeclarations.js';
import { DisplayType, Paginate } from './Paginate.js';
import { selectQuery } from './Database.js';
import { syncVideoUsageForBot } from './VideoGeneration.js';
import {
    canAccessCommand,
    formatCompactNumber,
    formatUsdCost,
    getUsername,
    pluralize,
} from './Utilities.js';

async function handleUserStats(msg: Message, db: Database, user: string): Promise<void> {
    const username = await getUsername(user, msg.guild);

    /* Get stats on which commands are used the most */
    const commands = await selectQuery(
        `SELECT
            command AS command,
            COUNT(*) AS usage
        FROM
            logs
        WHERE
            guild_id = ?
            AND user_id = ?
        GROUP BY
            command
        ORDER BY
            usage DESC`,
        db,
        [ msg.guild?.id, user ]
    );

    if (commands.length === 0) {
        await msg.reply('User has never used the bot!');
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle(`${username}'s bot usage statistics`)
        .setDescription('Number of times a command has been used');

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 9,
        displayFunction: (command: any) => {
            return {
                name: command.command,
                value: command.usage.toString(),
                inline: true,
            };
        },
        displayType: DisplayType.EmbedFieldData,
        data: commands,
        embed,
    });

    pages.sendMessage();
}

export async function handleUsersStats(msg: Message, db: Database): Promise<void> {
    const users = await selectQuery(
        `SELECT
            COUNT(*) AS usage,
            user_id AS user
        FROM
            logs
        WHERE
            guild_id = ?
        GROUP BY
            user_id
        ORDER BY
            usage DESC`,
        db,
        [ msg.guild?.id ]
    );

    const embed = new EmbedBuilder()
        .setTitle('Bot user usage statistics')
        .setDescription('Number of times a user has used the bot');

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 9,
        displayFunction: async (user: any) => {
            return {
                name: await getUsername(user.user, msg.guild),
                value: user.usage.toString(),
                inline: true,
            };
        },
        displayType: DisplayType.EmbedFieldData,
        data: users,
        embed,
    });

    pages.sendMessage();
}

async function handleCommandStats(msg: Message, db: Database, command: string): Promise<void> {
    const users = await selectQuery(
        `SELECT
            COUNT(*) AS usage,
            user_id AS user
        FROM
            logs
        WHERE
            guild_id = ?
            AND command = ?
        GROUP BY
            user_id
        ORDER BY
            usage DESC`,
        db,
        [ msg.guild?.id, command ]
    );

    const embed = new EmbedBuilder()
        .setTitle(`Bot user usage statistics`)
        .setDescription(`Number of times a user has used \`${config.prefix}${command}\``);

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 9,
        displayFunction: async (user: any) => {
            return {
                name: await getUsername(user.user, msg.guild),
                value: user.usage.toString(),
                inline: true,
            };
        },
        displayType: DisplayType.EmbedFieldData,
        data: users,
        embed,
    });

    await pages.sendMessage();
}

export async function handleStats(msg: Message, args: string[], db: Database): Promise<void> {
    const mentionedUsers = [...msg.mentions.users.values()];

    /* Get stats on commands used by a specific user */
    if (mentionedUsers.length > 0) {
        await handleUserStats(msg, db, mentionedUsers[0].id);
        return;
    }

    if (args.length > 0) {
        for (const command of Commands) {
            if (command.aliases.includes(args[0])) {
                /* Get stats on which users used a specific command the most */
                await handleCommandStats(msg, db, command.aliases[0]);
                return;
            }
        }
    }

    /* Get stats on which commands are used the most */
    const commands = await selectQuery(
        `SELECT
            command AS command,
            COUNT(*) AS usage
        FROM
            logs
        WHERE
            guild_id = ?
        GROUP BY
            command
        ORDER BY
            usage DESC`,
        db,
        [ msg.guild?.id ]
    );

    const embed = new EmbedBuilder()
        .setTitle('Bot usage statistics')
        .setDescription('Number of times a command has been used');

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 9,
        displayFunction: (command: any) => {
            return {
                name: command.command,
                value: command.usage.toString(),
                inline: true,
            };
        },
        displayType: DisplayType.EmbedFieldData,
        data: commands,
        embed,
    });

    await pages.sendMessage();
}

function formatTokenSpend(row: any): string {
    const cost = formatUsdCost(Number(row.cost || 0));
    const tokens = formatCompactNumber(Number(row.tokens || 0));
    const calls = Number(row.calls || 0);
    const images = Number(row.images || 0);
    const searches = Number(row.web_searches || 0);
    const units = [
        `${tokens} tokens`,
        ...(images ? [`${images} ${pluralize(images, 'image')}`] : []),
        ...(searches ? [`${searches} web ${pluralize(searches, 'search', 'searches')}`] : []),
        `${calls} ${pluralize(calls, 'call')}`,
    ];

    return `${cost}\n${units.join(', ')}`;
}

function formatTokenSpendTotal(rows: any[]): string {
    const cost = rows.reduce((sum, row) => sum + Number(row.cost || 0), 0);
    const tokens = rows.reduce((sum, row) => sum + Number(row.tokens || 0), 0);
    const calls = rows.reduce((sum, row) => sum + Number(row.calls || 0), 0);
    const images = rows.reduce((sum, row) => sum + Number(row.images || 0), 0);
    const searches = rows.reduce((sum, row) => sum + Number(row.web_searches || 0), 0);
    const extras = [
        ...(images ? [`${images} ${pluralize(images, 'image')}`] : []),
        ...(searches ? [`${searches} web ${pluralize(searches, 'search', 'searches')}`] : []),
    ];

    return `**Total: ${formatUsdCost(cost)}, ${formatCompactNumber(tokens)} tokens${
        extras.length ? `, ${extras.join(', ')}` : ''
    }, ${calls} ${pluralize(calls, 'call')}**`;
}

const TOKEN_SPEND_SELECT = `
    SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens,
    SUM(images) AS images,
    SUM(web_searches) AS web_searches,
    SUM(cost) AS cost,
    COUNT(*) AS calls`;

async function handleUserTokens(msg: Message, db: Database, user: string, global: boolean = false): Promise<void> {
    const username = await getUsername(user, msg.guild, msg.client);

    const commands = await selectQuery(
        `SELECT
            command AS command,
            ${TOKEN_SPEND_SELECT}
        FROM
            token_usage
        WHERE
            user_id = ?
            ${global ? '' : 'AND guild_id = ?'}
        GROUP BY
            command
        ORDER BY
            cost DESC`,
        db,
        global
            ? [ user ]
            : [ user, msg.guild?.id ]
    );

    if (commands.length === 0) {
        await msg.reply('User has not used any AI commands!');
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle(`${username}'s ${global ? 'global ' : ''}token spend`)
        .setDescription(`Estimated AI token spend by command${global ? ', across all servers' : ''}\n\n${formatTokenSpendTotal(commands)}`);

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 9,
        displayFunction: (command: any) => {
            return {
                name: command.command,
                value: formatTokenSpend(command),
                inline: true,
            };
        },
        displayType: DisplayType.EmbedFieldData,
        data: commands,
        embed,
    });

    await pages.sendMessage();
}

export async function handleUsersTokens(msg: Message, db: Database, global: boolean = false): Promise<void> {
    if (msg.client.user) await syncVideoUsageForBot(msg.client.user.id);
    const users = await selectQuery(
        `SELECT
            user_id AS user,
            ${TOKEN_SPEND_SELECT}
        FROM
            token_usage
        ${global ? '' : 'WHERE guild_id = ?'}
        GROUP BY
            user_id
        ORDER BY
            cost DESC`,
        db,
        global
            ? []
            : [ msg.guild?.id ]
    );

    if (users.length === 0) {
        await msg.reply('No token usage has been recorded yet!');
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle(`${global ? 'Global token' : 'Token'} spend by user`)
        .setDescription(`Estimated AI token spend per user${global ? ', across all servers' : ''}\n\n${formatTokenSpendTotal(users)}`);

    // Keep name lookups for the lifetime of this spend snapshot, including
    // failed lookups. Global rows often belong to users outside this guild;
    // use cached nicknames without probing membership for every page visit.
    const usernames = new Map<string, Promise<string>>();
    // Platform adapters without global user lookup still resolve via guilds.
    const useGlobalLookup = global && Boolean(msg.client.users);
    const usernameFor = (id: string): Promise<string> => {
        let username = usernames.get(id);
        if (!username) {
            const cachedNickname = useGlobalLookup ? msg.guild?.members.cache?.get(id)?.displayName : undefined;
            username = cachedNickname
                ? Promise.resolve(cachedNickname)
                : getUsername(id, useGlobalLookup ? null : msg.guild, msg.client);
            usernames.set(id, username);
        }
        return username;
    };

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 9,
        displayFunction: async (user: any) => {
            return {
                name: await usernameFor(user.user),
                value: formatTokenSpend(user),
                inline: true,
            };
        },
        displayType: DisplayType.EmbedFieldData,
        data: users,
        embed,
    });

    await pages.sendMessage();
}

export async function handleGlobalTokens(msg: Message, args: string[], db: Database): Promise<void> {
    if (!canAccessCommand(msg, true)) {
        return;
    }
    const mentionedUsers = [...msg.mentions.users.values()];

    /* Get global token spend of a specific user, broken down by command */
    if (mentionedUsers.length > 0) {
        if (msg.client.user) await syncVideoUsageForBot(msg.client.user.id);
        await handleUserTokens(msg, db, mentionedUsers[0].id, true);
        return;
    }

    /* Get global token spend, broken down by user */
    await handleUsersTokens(msg, db, true);
}

async function handleCommandTokens(msg: Message, db: Database, command: string): Promise<void> {
    const users = await selectQuery(
        `SELECT
            user_id AS user,
            ${TOKEN_SPEND_SELECT}
        FROM
            token_usage
        WHERE
            guild_id = ?
            AND command = ?
        GROUP BY
            user_id
        ORDER BY
            cost DESC`,
        db,
        [ msg.guild?.id, command ]
    );

    if (users.length === 0) {
        await msg.reply(`No token usage has been recorded for \`${config.prefix}${command}\`!`);
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle(`Token spend on ${config.prefix}${command}`)
        .setDescription(`Estimated AI token spend on \`${config.prefix}${command}\` per user\n\n${formatTokenSpendTotal(users)}`);

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 9,
        displayFunction: async (user: any) => {
            return {
                name: await getUsername(user.user, msg.guild),
                value: formatTokenSpend(user),
                inline: true,
            };
        },
        displayType: DisplayType.EmbedFieldData,
        data: users,
        embed,
    });

    await pages.sendMessage();
}

export async function handleTokens(msg: Message, args: string[], db: Database): Promise<void> {
    if (msg.client.user) await syncVideoUsageForBot(msg.client.user.id);
    const mentionedUsers = [...msg.mentions.users.values()];

    /* Get token spend of a specific user, broken down by command */
    if (mentionedUsers.length > 0) {
        await handleUserTokens(msg, db, mentionedUsers[0].id);
        return;
    }

    /* Get token spend on a specific command, broken down by user */
    if (args.length > 0) {
        for (const command of Commands) {
            if (command.aliases.includes(args[0])) {
                await handleCommandTokens(msg, db, command.aliases[0]);
                return;
            }
        }

        /* Not a real command, but usage may be recorded under it, e.g.
         * autotranscribe */
        await handleCommandTokens(msg, db, args[0]);
        return;
    }

    /* Get overall token spend, broken down by user */
    await handleUsersTokens(msg, db);
}

export async function handleCommandsTokens(msg: Message, db: Database): Promise<void> {
    if (msg.client.user) await syncVideoUsageForBot(msg.client.user.id);
    /* Get overall token spend, broken down by command */
    const commands = await selectQuery(
        `SELECT
            command AS command,
            ${TOKEN_SPEND_SELECT}
        FROM
            token_usage
        WHERE
            guild_id = ?
        GROUP BY
            command
        ORDER BY
            cost DESC`,
        db,
        [ msg.guild?.id ]
    );

    if (commands.length === 0) {
        await msg.reply('No token usage has been recorded yet!');
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle('Token spend by command')
        .setDescription(`Estimated AI token spend per command\n\n${formatTokenSpendTotal(commands)}`);

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 9,
        displayFunction: (command: any) => {
            return {
                name: command.command,
                value: formatTokenSpend(command),
                inline: true,
            };
        },
        displayType: DisplayType.EmbedFieldData,
        data: commands,
        embed,
    });

    await pages.sendMessage();
}
