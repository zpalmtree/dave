import {
    Client,
    Message,
    MessageEmbed,
    TextChannel,
} from 'discord.js';

import moment from 'moment';

import { Database } from 'sqlite3';

import {
    Paginate,
    DisplayType,
} from './Paginate.js';

import {
    insertQuery,
    selectQuery,
    deleteQuery,
} from './Database.js';

import {
    capitalize,
    getUsername,
    getDefaultTimeZone,
} from './Utilities.js';

import { config } from './Config.js';

export async function deleteTimer(msg: Message, args: string[], db: Database) {
    if (args.length === 0) {
        msg.reply('No timer ID given');
        return;
    }

    const id = Number(args[0]);

    if (Number.isNaN(id)) {
        msg.reply('Invalid timer ID given. Should be a number.');
        return;
    }

    const nodeTimerID = runningTimers.get(id);

    if (!nodeTimerID) {
        msg.reply('Failed to delete, unknown ID or completed timer.');
        return;
    }

    const changes = await deleteQuery(
        `DELETE FROM
            timer
        WHERE
            id = ?
            AND channel_id = ?
            AND user_id = ?`,
        db,
        [ args[0], msg.channel.id, msg.author.id ]
    );

    if (changes === 1) {
        runningTimers.delete(id);
        clearTimeout(nodeTimerID);
        msg.reply(`Successfully deleted timer #${args[0]}.`);
    } else {
        msg.reply(`Failed to delete, unknown ID or not your timer.`);
    }
}

export async function handleTimer(msg: Message, args: string[], db: Database) {
    const regex = /^(?:([0-9\.]+)y)?(?:([0-9\.]+)w)?(?:([0-9\.]+)d)?(?:([0-9\.]+)h)?(?:([0-9\.]+)m)?(?:([0-9\.]+)s)?(?: (.+))?$/;

    const results = regex.exec(args.join(' '));

    if (!results) {
        msg.reply(`Failed to parse input, try \`${config.prefix}help timer\``);
        return;
    }

    const [
        ,
        years=0,
        weeks=0,
        days=0,
        hours=0,
        minutes=0,
        seconds=0,
        description
    ] = results;

    const totalTimeSeconds = Number(seconds)
                           + Number(minutes) * 60
                           + Number(hours) * 60 * 60
                           + Number(days) * 60 * 60 * 24
                           + Number(weeks) * 60 * 60 * 24 * 7
                           + Number(years) * 60 * 60 * 24 * 365;

    if (totalTimeSeconds > 60 * 60 * 24 * 365 * 100) {
        msg.reply('Timers longer than 100 years are not supported.');
        return;
    }

    if (totalTimeSeconds <= 0) {
        msg.reply(`Invalid or no time duration given, try \`${config.prefix}help timer\``);
        return;
    }

    const time = moment.utc().add(totalTimeSeconds, 'seconds');

    const timerID = await insertQuery(
        `INSERT INTO timer
            (user_id, channel_id, message, expire_time)
        VALUES
            (?, ?, ?, ?)`,
        db,
        [ msg.author.id, msg.channel.id, description, time.format('YYYY-MM-DD HH:mm:ss') ],
    );

    sendTimer(
        msg.channel as TextChannel,
        totalTimeSeconds * 1000,
        timerID,
        msg.author.id,
        description
    );

    const { offset, label } = getDefaultTimeZone();

    const embed = new MessageEmbed()
        .addFields(
            {
                name: `Timer #${timerID}`,
                value: `${capitalize(moment.utc(time).fromNow())}, ${moment.utc(time).utcOffset(offset).format('HH:mm')} ${label}`,
            }
        );

    if (description) {
        embed.addFields({
            name: 'Message',
            value: description,
        });
    }

    msg.channel.send({
        embeds: [embed],
    });
}

export async function handleTimers(msg: Message, db: Database): Promise<void> {
    const timers = await selectQuery(
        `SELECT
            id,
            user_id,
            message,
            expire_time
        FROM
            timer
        WHERE
            channel_id = ?
            AND expire_time >= STRFTIME('%Y-%m-%d %H:%M:%S', 'NOW')
        ORDER BY
            expire_time ASC` ,
        db,
        [ msg.channel.id ]
    );

    if (!timers || timers.length === 0) {
        msg.reply('There are no timers currently running!');
        return;
    }

    const embed = new MessageEmbed()
        .setTitle('Running Timers');

    const { offset, label } = getDefaultTimeZone();

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 7,
        displayFunction: async (timer: any) => {
            const fields = [];

            fields.push({
                name: `ID: ${timer.id}`,
                value: timer.message || 'N/A',
                inline: true,
            });

            fields.push(
                {
                    name: 'Time',
                    value: `${capitalize(moment.utc(timer.expire_time).fromNow())}, ${moment.utc(timer.expire_time).utcOffset(offset).format('HH:mm')} ${label}`,

                    inline: true,
                },
                {
                    name: 'Requester',
                    value: await getUsername(timer.user_id, msg.guild),
                    inline: true,
                }
            );

            return fields;
        },
        displayType: DisplayType.EmbedFieldData,
        data: timers,
        embed,
    });

    pages.sendMessage();
}

export async function restoreTimers(db: Database, client: Client) {
    const timers = await selectQuery(
        `SELECT
            id,
            user_id,
            channel_id,
            message,
            expire_time
        FROM
            timer
        WHERE
            expire_time > STRFTIME('%Y-%m-%d %H:%M:%S', 'NOW')
        ORDER BY
            expire_time ASC`,
        db,
    );

    if (!timers || timers.length === 0) {
        return;
    }

    const channels = new Map<string, TextChannel>();

    for (const timer of timers) {
        let channel = channels.get(timer.channel_id);

        if (channel === undefined) {
            try {
                channel = await client.channels.fetch(timer.channel_id) as TextChannel;

                if (!channel) {
                    console.log(`Failed to get channel ${timer.channel_id}`);
                    continue;
                }

                channels.set(timer.channel_id, channel);
            } catch (err) {
                console.log(`Failed to get channel ${timer.channel_id}`);
                continue;
            }
        }

        const milliseconds = moment.utc(timer.expire_time).diff(moment.utc());

        if (milliseconds < 0) {
            continue;
        }

        sendTimer(
            channel,
            milliseconds,
            timer.id,
            timer.user_id,
            timer.message,
        );
    }
}

export function sendTimer(
    channel: TextChannel,
    milliseconds: number,
    timerID: number,
    userID: string,
    description?: string) {

    const maxTimeout = (2 ** 31) - 1;

    /* setTimeout uses a 32 bit signed value so any timeouts above this will
     * overflow. To handle this, we just set a timeout for the max value, then
     * repeat the process with this amount taken off. */
    if (milliseconds > maxTimeout) {
        const timeoutID = setTimeout(() => sendTimer(channel, milliseconds - maxTimeout, timerID, userID, description), maxTimeout);
        runningTimers.set(timerID, timeoutID);
        return;
    }

    const mention = `<@${userID}>,`;

    const timeoutID = setTimeout(() => {
        if (description) {
            channel.send(`${mention} Your ${description} timer has elapsed.`);
        } else {
            channel.send(`${mention} Your timer has elapsed.`);
        }
    }, milliseconds);

    runningTimers.set(timerID, timeoutID);
}

const runningTimers = new Map<number, NodeJS.Timeout>();
