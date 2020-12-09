import * as moment from 'moment';

import {
    Message,
    MessageEmbed,
    TextChannel,
} from 'discord.js';

import { Database } from 'sqlite3';

import {
    selectQuery,
    selectOneQuery,
    insertQuery,
    deleteQuery,
    updateQuery,
    serializeQueries,
} from './Database';

import {
    handleWatchHelp,
} from './Help';

import {
    haveRole,
    capitalize,
} from './Utilities';

import {
    ScheduledWatch,
} from './Types';

import { config } from './Config';

import {
    Paginate,
    DisplayType,
} from './Paginate';

interface IGetWatchDetails {
    excludeComplete?: boolean;
    excludeIncomplete?: boolean;
    id?: number | string;
}

async function doesWatchIDExist(id: number, channelID: string, db: Database): Promise<boolean> {
    const count: number | undefined = await selectOneQuery(
        `SELECT
            COUNT(*)
        FROM
            watch_event AS we
        WHERE
            we.id = ?
            AND we.channel_id = ?`,
        db,
        [ id, channelID ]
    );

    if (!count) {
        return false;
    }

    return count > 0;
}

export async function displayScheduledWatches(msg: Message, db: Database): Promise<void> {
    const events = await getWatchDetails(
        msg.channel.id,
        db, {
            excludeComplete: true,
        },
    );

    if (!events || events.length === 0) {
        msg.reply('Nothing has been scheduled to be watched yet! Use `$watch help` for more info');
        return;
    }

    const embed = new MessageEmbed()
        .setTitle('Scheduled Movies/Series To Watch');

    const f = (watch: ScheduledWatch) => {
        return [
            {
                name: `ID: ${watch.watchID}`,
                value: watch.infoLinks.length > 0
                    ? `[${watch.title}](${watch.infoLinks[0]})`
                    : watch.title,
                inline: true,
            },
            {
                name: 'Time',
                /* If we're watching in less than 6 hours, give a relative time. Otherwise, give date. */
                value: moment().isBefore(moment(watch.time).subtract(6, 'hours'))
                    ? moment(watch.time).utcOffset(-6).format('dddd, MMMM Do, HH:mm') + ' CST'
                    : `${capitalize(moment(watch.time).fromNow())}, ${moment(watch.time).utcOffset(-6).format('HH:mm')} CST`,
                inline: true,
            },
            {
                name: 'Attending',
                value: watch.attending.map((user: string) => {
                    const userObj = msg.guild!.members.cache.get(user)

                    if (userObj !== undefined) {
                        return userObj.displayName;
                    }

                    return `Unknown User <@${user}>`;
                }).join(', '),
                inline: true,
            },
        ];
    }

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 7,
        displayFunction: f,
        displayType: DisplayType.EmbedFieldData,
        data: events,
        embed,
    });

    pages.sendMessage();
}

export async function displayAllWatches(msg: Message, db: Database): Promise<void> {
    const data = await getWatchDetails(
        msg.channel.id,
        db, {
            excludeIncomplete: true,
        },
    );

    if (!data || data.length === 0) {
        msg.reply('Nothing has been watched before!');
        return;
    }

    const f = (watch: ScheduledWatch) => {
        return [
            {
                name: `ID: ${watch.watchID}`,
                value: watch.infoLinks.length > 0
                    ? `[${watch.title}](${watch.infoLinks[0]})`
                    : watch.title,
                inline: true,
            },
            {
                name: 'Time',
                value : moment(watch.time).utcOffset(-6).format('YYYY/MM/DD'),
                inline: true,
            },
            {
                name: 'Attended',
                value: watch.attending.map((user: string) => {
                    const userObj = msg.guild!.members.cache.get(user)

                    if (userObj !== undefined) {
                        return userObj.displayName;
                    }

                    return `Unknown User <@${user}>`;
                }).join(', '),
                inline: true,
            },
        ];
    }

    const embed = new MessageEmbed()
        .setTitle('Previously Watched Movies/Series');

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 10,
        displayFunction: f,
        displayType: DisplayType.EmbedFieldData,
        data,
        embed,
    });

    pages.sendMessage();
}

export async function addLink(msg: Message, args: string[], db: Database): Promise<void> {
    if (args.length < 2) {
        handleWatchHelp(msg, 'Sorry, your input was invalid. Please try one of the following options.');
        return;
    }

    const id = Number(args[0]);

    if (Number.isNaN(id)) {
        handleWatchHelp(msg, 'Sorry, your input was invalid. Please try one of the following options.');
        return;
    }

    if (!/^(magnet:\?.+|https?:\/\/.*(?:youtube\.com|youtu\.be)\/\S+)$/.test(args[1])) {
        handleWatchHelp(msg, 'Input does not look like a magnet or youtube link. Please try one of the following options.');
        return;
    }

    if (args[1].length > 1000) {
        msg.reply('Link is too long. Must be less than 1000 chars.');
        return;
    }

    const watch = await getWatchDetailsById(id, msg.channel.id, db);

    if (!watch) {
        msg.reply(`Could not find movie ID "${id}". Use \`$watch\` to list all scheduled watches.`);
        return;
    }

    await insertQuery(
        `INSERT INTO movie_link
            (link, movie_id, is_download)
        VALUES
            (?, ?, 1)`,
        db,
        [ args[1], watch.movieID ]
    );

    msg.reply(`Successfully added/updated link for ${watch.title}`);
}

export async function updateTime(msg: Message, args: string[], db: Database): Promise<void> {
    const regex = /(\d+) (\d\d\d\d\/\d\d?\/\d\d? \d?\d:\d\d(?: ?[+-]\d\d?:?\d\d))/;

    const results = regex.exec(args.join(' '));

    if (results) {
        const [ , id, time ] = results;

        const parsedTime = moment(time, 'YYYY/MM/DD hh:mm ZZ');

        if (!parsedTime.isValid()) {
            msg.reply(`Failed to parse date/time "${time}"`);
            return;
        }

        const watch = await getWatchDetailsById(id, msg.channel.id, db);

        if (!watch) {
            msg.reply(`Could not find movie ID "${id}". Use \`$watch\` to list all scheduled watches.`);
            return;
        }

        await updateQuery(
            `UPDATE
                watch_event
            SET
                timestamp = ?
            WHERE
                id = ?`,
            db,
            [ id, parsedTime.utcOffset(0).format('YYYY-MM-DD hh:mm:ss') ],
        );

        msg.reply(`Successfully updated time for ${watch.title} to ${parsedTime.utcOffset(-6).format('dddd, MMMM Do, HH:mm')} CST!`);
    } else {
        handleWatchHelp(msg, 'Sorry, your input was invalid. Please try one of the following options.');
    }
}

export async function deleteWatch(msg: Message, args: string[], db: Database): Promise<void> {
    if (args.length === 0) {
        handleWatchHelp(msg, 'Sorry, your input was invalid. Please try one of the following options.');
        return;
    }

    const id = Number(args[0]);

    if (Number.isNaN(id)) {
        handleWatchHelp(msg, 'Sorry, your input was invalid. Please try one of the following options.');
        return;
    }

    const attending = await selectQuery(
        `SELECT
            user_id
        FROM
            user_watch
        WHERE
            watch_event = ?`,
        db,
        [ id ]
    );

    const areOnlyAttendee = attending.length === 1 && attending[0].user_id === msg.author.id;

    if (!areOnlyAttendee && !haveRole(msg, 'Mod')) {
        msg.reply('You must be the only watch attendee, or be a mod, to remove a movie');
        return;
    }

    const response = await removeWatchById(id, db);
    msg.reply(response);
}

async function removeWatchById(id: number, db: Database) {
    const [ watch ] = await selectQuery(
        `SELECT
            m.title
        FROM
            watch_event AS we
            INNER JOIN movie AS m
                ON we.movie_id = m.id
        WHERE
            we.id = ?`,
        db,
        [ id ]
    );

    if (!watch) {
        return `Could not find movie ID "${id}". Use \`$watch\` to list all scheduled watches.`;
    }

    await deleteQuery(
        `DELETE FROM user_watch
        WHERE
            watch_event = ?`,
        db,
        [ id ]
    );

    await deleteQuery(
        `DELETE FROM watch_event
        WHERE
            id = ?`,
        db,
        [ id ]
    );

    return `Successfully deleted scheduled watch ${watch.title}`;
}

export async function displayWatchById(msg: Message, id: number, db: Database): Promise<void> {
    const watch = await getWatchDetailsById(id, msg.channel.id, db);

    if (!watch) {
        msg.reply(`Could not find movie ID "${id}". Use \`$watch\` to list all scheduled watches.`);
        return;
    }

    const embed = new MessageEmbed()
        .setTitle(watch.title)
        .setFooter('React with 👍 if you want to attend this movie night')

    embed.addFields(
        {
            name: 'Time',
            /* If we're watching in less than 6 hours, give a relative time. Otherwise, give date. */
            value: moment().isBefore(moment(watch.time).subtract(6, 'hours'))
                ? moment(watch.time).utcOffset(-6).format('dddd, MMMM Do, HH:mm') + ' CST'
                : `${capitalize(moment(watch.time).fromNow())}, ${moment(watch.time).utcOffset(-6).format('HH:mm')} CST`,
        },
        {
            name: 'Attending',
            value: watch.attending.map((user) => {
                const userObj = msg.guild!.members.cache.get(user);

                if (userObj !== undefined) {
                    return userObj.displayName;
                }

                return `Unknown User <@${user}>`;
            }).join(', '),
        },
    );

    if (watch.infoLinks.length > 0) {
        embed.addFields({
            name: 'Info Link',
            value: watch.infoLinks[0],
        });
    }

    if (watch.downloadLinks.length > 0) {
        embed.addField('Download Link', watch.downloadLinks[0]);
    }

    const sentMessage = await msg.channel.send(embed);

    awaitWatchReactions(sentMessage, watch.title, id, new Set(watch.attending), 1, db);
}

export async function scheduleWatch(
    msg: Message,
    args: string,
    db: Database): Promise<boolean> {

    /* Non greedy title match, optional imdb/myanimelist link, time, optional magnet/youtube link */
    const regex = /^(.+?) (?:(https:\/\/.*imdb\.com\/\S+|https:\/\/.*myanimelist\.net\/\S+) )?([0-9+-: \/dhm]+?) ?(magnet:\?.+|https:\/\/.*(?:youtube\.com|youtu\.be)\/\S+)?$/;

    const results = regex.exec(args);

    if (results) {
        const [ , title, infoLink, time, downloadLink ] = results;

        if (infoLink && infoLink.length > 1000) {
            msg.reply('Link is too long. Must be less than 1000 chars.');
            return true;
        }

        if (title && title.length > 1000) {
            msg.reply('Title is too long. Must be less than 1000 chars.');
            return true;
        }

        const timeRegex = /^(\d\d\d\d\/\d\d?\/\d\d? \d?\d:\d\d [+-]\d\d?:?\d\d)$/;
        const relativeTimeRegex = /^(?:([0-9\.]+)d)?(?:([0-9\.]+)h)?(?:([0-9\.]+)m)?(?: (.+))?$/

        let timeObject = moment(time, 'YYYY/MM/DD hh:mm ZZ');

        if (!timeRegex.test(time) || !timeObject.isValid()) {
            const [, daysStr, hoursStr, minutesStr ] = relativeTimeRegex.exec(time) || [ undefined, undefined, undefined, undefined ];

            if (daysStr === undefined && hoursStr === undefined && minutesStr === undefined) {
                msg.reply(`Could not parse time "${time}". Should be in the form \`YYYY/MM/DD HH:MM [+-]HH:MM\``);
                return true;
            }

            const days = Number(daysStr) || 0;
            const hours = Number(hoursStr) || 0;
            const minutes = Number(minutesStr) || 0;

            timeObject = moment().add({
                days,
                hours,
                minutes,
            });
        }

        await createWatch(msg, db, title, timeObject, infoLink, downloadLink);
        return true;
    }

    return false;
}

export async function createWatch(
    msg: Message,
    db: Database,
    title: string,
    time: moment.Moment,
    infoLink?: string,
    downloadLink?: string) {

    const movieID = await insertQuery(
        `INSERT INTO movie
            (title, channel_id)
        VALUES
            (?, ?)`,
        db,
        [ title, msg.channel.id ]
    );

    if (infoLink) {
        await insertQuery(
            `INSERT INTO movie_link
                (link, movie_id, is_download)
            VALUES
                (?, ?, 0)`,
            db,
            [ infoLink, movieID ]
        );
    }

    if (downloadLink) {
        await insertQuery(
            `INSERT INTO movie_link
                (link, movie_id, is_download)
            VALUES
                (?, ?, 1)`,
            db,
            [ downloadLink, movieID ]
        );
    }

    const watchEventID = await insertQuery(
        `INSERT INTO watch_event
            (timestamp, channel_id, movie_id)
        VALUES
            (?, ?, ?)`,
        db,
        [ time.utcOffset(0).format('YYYY-MM-DD hh:mm:ss'), msg.channel.id, movieID ]
    );

    await insertQuery(
        `INSERT INTO user_watch
            (user_id, watch_event)
        VALUES
            (?, ?)`,
        db,
        [ msg.author.id, watchEventID ]
    );

    const embed = new MessageEmbed()
        .setTitle(title)
        .setDescription(`${title} has been successfully scheduled for ${time.utcOffset(-6).format('dddd, MMMM Do, HH:mm')} CST!`)
        .setFooter('React with 👍 if you want to attend this movie night')
        .addFields(
            {
                name: 'Attending',
                value: [msg.author.id].map((user) => {
                    const userObj = msg.guild!.members.cache.get(user)

                    if (userObj !== undefined) {
                        return userObj.displayName;
                    }

                    return `Unknown User <@${user}>`;
                }).join(', '),
                inline: true,
            },
        );

    const sentMessage = await msg.channel.send(embed);

    awaitWatchReactions(sentMessage, title, movieID, new Set([msg.author.id]), 0, db);
}

async function awaitWatchReactions(
    msg: Message,
    title: string,
    id: number,
    attending: Set<string>,
    attendingFieldIndex: number,
    db: Database) {

    await msg.react('👍');
    await msg.react('👎');

    const collector = msg.createReactionCollector((reaction, user) => {
        return ['👍', '👎'].includes(reaction.emoji.name) && !user.bot;
    }, { time: 3000000 });

    collector.on('collect', async (reaction, user) => {
        const embed = new MessageEmbed(msg.embeds[0]);

        if (reaction.emoji.name === '👍') {
            attending.add(user.id);
        } else {
            attending.delete(user.id);
        }

        if (attending.size === 0) {
            msg.channel.send('All attendees removed! Cancelling watch.');
            collector.stop();
            const watchDeletionResponse = await removeWatchById(id, db);
            msg.channel.send(watchDeletionResponse);
            return;
        }

        embed.spliceFields(attendingFieldIndex, 1, {
            name: 'Attending',
            value: [...attending].map((user) => {
                const userObj = msg.guild!.members.cache.get(user)

                if (userObj !== undefined) {
                    return userObj.displayName;
                }

                return `Unknown User <@${user}>`;
            }).join(', '),
            inline: true,
        });

        await serializeQueries(async () => {
            await deleteQuery(
                `DELETE FROM
                    user_watch
                WHERE
                    watch_event = ?`,
                db,
                [ id ],
            );

            for (const attendee of attending) {
                await insertQuery(
                    `INSERT INTO user_watch
                        (user_id, watch_event)
                    VALUES
                        (?, ?)`,
                    db,
                    [ attendee, id ]
                );
            }
        }, db);

        msg.edit(embed);
    });
}

async function getWatchDetailsById(id: number | string, channelID: string, db: Database, options?: IGetWatchDetails): Promise<ScheduledWatch | undefined> {
    return getWatchDetailsImpl(
        channelID, {
            id,
            ...options,
        },
        db
    ) as Promise<ScheduledWatch | undefined>;
}

async function getWatchDetails(channelID: string, db: Database, options?: IGetWatchDetails): Promise<ScheduledWatch[] | undefined> {
    return getWatchDetailsImpl(
        channelID, {
            ...options,
        },
        db
    ) as Promise<ScheduledWatch[] | undefined>;
}

async function getWatchDetailsImpl(
    channelID: string,
    options: IGetWatchDetails,
    db: Database): Promise<ScheduledWatch | ScheduledWatch[] | undefined> {

    const {
        excludeComplete,
        excludeIncomplete,
        id,
    } = options;

    if (Number.isNaN(id)) {
        return undefined;
    }

    const args = {
        $channel_id: channelID,
    } as any;

    let query =
        `SELECT
            m.id AS movieID,
            m.title AS title,
            we.id AS watchID,
            we.timestamp AS time
        FROM
            watch_event AS we
            INNER JOIN movie AS m
                ON m.id = we.movie_id
        WHERE
            we.channel_id = $channel_id`;

    if (excludeComplete !== undefined && excludeComplete) {
        query += ` AND we.timestamp > STRFTIME('%Y-%m-%d %H:%M:%S', 'NOW', '-3 HOURS')`;
    }

    if (excludeIncomplete !== undefined && excludeIncomplete) {
        query += ` AND we.timestamp < STRFTIME('%Y-%m-%d %H:%M:%S', 'NOW', '-3 HOURS')`;
    }

    if (id !== undefined) {
        query += ` AND we.id = $movie_id`;
        args['$movie_id'] = id;
    }

    query += ` ORDER BY we.timestamp`;

    const events = await selectQuery(
        query,
        db,
        args
    );

    if (events.length === 0) {
        return undefined;
    }

    for (let event of events) {
        const links = await selectQuery(
            `SELECT
                link,
                is_download
            FROM
                movie_link
            WHERE
                movie_id = ?`,
            db,
            [ event.movieID ],
        );

        event.downloadLinks = [];
        event.infoLinks = [];

        for (const link of links) {
            if (link.is_download) {
                event.downloadLinks.push(link.link);
            } else {
                event.infoLinks.push(link.link);
            }
        }

        const attending = await selectQuery(
            `SELECT
                user_id
            FROM
                user_watch
            WHERE
                watch_event = ?`,
            db,
            [ event.watchID ]
        );

        event.attending = attending.map((x) => x.user_id);
    }

    if (id !== undefined) {
        return events[0];
    } else {
        return events;
    }
}

export async function handleWatchNotifications(channel: TextChannel, db: Database) {
    const events = await getWatchDetails(channel.id, db, {
        excludeComplete: true,
    });

    if (events) {
        for (const watch of events) {
            const fourHourReminder = moment(watch.time).subtract(4, 'hours');
            const twentyMinuteReminder = moment(watch.time).subtract(20, 'minutes');

            /* Get our watch 'window' */
            const nMinsAgo = moment().subtract(config.watchPollInterval / 2, 'milliseconds');
            const nMinsAhead = moment().add(config.watchPollInterval / 2, 'milliseconds');

            const mention = watch.attending.map((x) => `<@${x}>`).join(' ');

            if (fourHourReminder.isBetween(nMinsAgo, nMinsAhead)) {
                channel.send(`${mention}, reminder, you are watching ${watch.title} in 4 hours (${moment(watch.time).utcOffset(0).format('HH:mm Z')})`);
            }

            if (twentyMinuteReminder.isBetween(nMinsAgo, nMinsAhead)) {
                channel.send(`${mention}, reminder, you are watching ${watch.title} ${moment(watch.time).fromNow()}`);
            }
        }
    }

    setTimeout(handleWatchNotifications, config.watchPollInterval, channel, db);
}

