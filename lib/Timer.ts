import {
    Client,
    Message,
    TextChannel,
    EmbedBuilder,
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
    getUsername,
    monthDurationToSeconds
} from './Utilities.js';

import { config } from './Config.js';
import { formatDiscordDateAndRelative } from './DiscordTime.js';

export type TimerPlatform = 'discord' | 'uproar';

interface TimerChannel {
    send: (payload: any) => unknown;
}

type TimerChannelResolver = (channelId: string) => Promise<TimerChannel | null>;

export function getMessagePlatform(msg: Message): TimerPlatform {
    return (msg as Message & { platform?: string }).platform === 'uproar'
        ? 'uproar'
        : 'discord';
}

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
            AND user_id = ?
            AND platform = ?`,
        db,
        [ args[0], msg.channel.id, msg.author.id, getMessagePlatform(msg) ]
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
    const regex = /^(?:([0-9\.]+)y)?(?:([0-9\.]+)mm)?(?:([0-9\.]+)w)?(?:([0-9\.]+)d)?(?:([0-9\.]+)h)?(?:([0-9\.]+)m)?(?:([0-9\.]+)s)?(?: (.+))?$/;

    const results = regex.exec(args.join(' '));

    if (!results) {
        msg.reply(`Failed to parse input, try \`${config.prefix}help timer\``);
        return;
    }

    const [
        ,
        years=0,
        months='0',
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
                           + monthDurationToSeconds(months)
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
            (user_id, channel_id, platform, message, expire_time)
        VALUES
            (?, ?, ?, ?, ?)`,
        db,
        [
            msg.author.id,
            msg.channel.id,
            getMessagePlatform(msg),
            description,
            time.format('YYYY-MM-DD HH:mm:ss'),
        ],
    );

    sendTimer(
        msg.channel as TextChannel,
        totalTimeSeconds * 1000,
        timerID,
        msg.author.id,
        description
    );

    const message = `Success. Timer #${timerID} will go off ${formatDiscordTimestamp(time)}.`;

    await msg.reply(message);
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
            AND platform = ?
            AND expire_time >= STRFTIME('%Y-%m-%d %H:%M:%S', 'NOW')
        ORDER BY
            expire_time ASC` ,
        db,
        [ msg.channel.id, getMessagePlatform(msg) ]
    );

    if (!timers || timers.length === 0) {
        msg.reply('There are no timers currently running!');
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle('Running Timers');

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
                    value: formatDiscordTimestamp(moment.utc(timer.expire_time)),
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

function formatDiscordTimestamp(time: moment.Moment): string {
    return formatDiscordDateAndRelative(time.unix());
}

export async function restoreTimers(db: Database, client: Client) {
    await restoreTimersForPlatform(
        db,
        'discord',
        async (channelId) => await client.channels.fetch(channelId) as TextChannel | null,
    );
}

export async function restoreTimersForPlatform(
    db: Database,
    platform: TimerPlatform,
    resolveChannel: TimerChannelResolver,
): Promise<void> {
    const timers = await getActiveTimersForPlatform(db, platform);

    if (timers.length === 0) {
        return;
    }

    const channels = new Map<string, TimerChannel>();

    for (const timer of timers) {
        let channel = channels.get(timer.channel_id);

        if (channel === undefined) {
            try {
                channel = await resolveChannel(timer.channel_id) ?? undefined;

                if (!channel) {
                    console.log(`Failed to get ${platform} channel ${timer.channel_id}`);
                    continue;
                }

                channels.set(timer.channel_id, channel);
            } catch (err) {
                console.log(`Failed to get ${platform} channel ${timer.channel_id}`);
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

export async function getActiveTimersForPlatform(
    db: Database,
    platform: TimerPlatform,
): Promise<any[]> {
    return selectQuery(
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
            AND platform = ?
        ORDER BY
            expire_time ASC`,
        db,
        [ platform ],
    );
}

export function sendTimer(
    channel: TimerChannel,
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
        const content = description
            ? `${mention} Your ${description} timer has elapsed.`
            : `${mention} Your timer has elapsed.`;

        Promise.resolve(channel.send(content)).catch((err) => {
            console.error(`Failed to send timer #${timerID}: ${(err as any)?.stack ?? err}`);
        });
        runningTimers.delete(timerID);
    }, milliseconds);

    runningTimers.set(timerID, timeoutID);
}

const runningTimers = new Map<number, NodeJS.Timeout>();
