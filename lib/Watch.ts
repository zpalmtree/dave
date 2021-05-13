import * as moment from 'moment';

import {
    Client,
    Message,
    MessageEmbed,
    TextChannel,
    MessageReaction,
    User,
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
    haveRole,
    capitalize,
    getUsername,
    shuffleArray,
    tryReactMessage,
    getDefaultTimeZone,
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
    sort?: 'ASC' | 'DESC';
    channelID?: string;
}

export async function handleWatch(msg: Message, args: string[], db: Database): Promise<void> {
    /* No args, display scheduled things to watch */
    if (args.length === 0) {
        await displayScheduledWatches(msg, db);
        return;
    }

    /* Single arg, should be trying to get a specific movie by id */
    if (args.length === 1) {
        displayWatchById(msg, Number(args[0]), db);
        return;
    }

    /* Otherwise, try and parse it as a scheduling */
    const success = await scheduleWatch(msg, args.join(' '), db);

    if (!success) {
        msg.reply(`Invalid input. Try \`${config.prefix}help watch\``);
    }
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
    const events = await getWatchDetails(db, {
            excludeComplete: true,
            channelID: msg.channel.id,
        },
    );

    if (!events || events.length === 0) {
        msg.reply(`Nothing has been scheduled to be watched yet! Use \`${config.prefix}help watch\` for more info`);
        return;
    }

    const embed = new MessageEmbed()
        .setTitle('Scheduled Movies/Series To Watch');

    const { offset, label } = getDefaultTimeZone();

    const f = async (watch: ScheduledWatch) => {
        const names = await Promise.all(watch.attending.map((user) => getUsername(user, msg.guild)));

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
                /* If we're watching in less than a day, give a relative time. Otherwise, give date. */
                value: moment.utc().isBefore(moment.utc(watch.time).subtract(1, 'day'))
                    ? `${moment.utc(watch.time).utcOffset(offset).format('dddd, MMMM Do, HH:mm')} ${label}`
                    : `${capitalize(moment.utc(watch.time).fromNow())}, ${moment.utc(watch.time).utcOffset(offset).format('HH:mm')} ${label}`,
                inline: true,
            },
            {
                name: 'Attending',
                value: names.join(', '),
                inline: true,
            },
        ];
    }

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 3,
        displayFunction: f,
        displayType: DisplayType.EmbedFieldData,
        data: events,
        embed,
    });

    pages.sendMessage();
}

export async function displayAllWatches(msg: Message, db: Database): Promise<void> {
    const data = await getWatchDetails(db, {
            excludeIncomplete: true,
            sort: 'DESC',
            channelID: msg.channel.id,
        },
    );

    if (!data || data.length === 0) {
        msg.reply('Nothing has been watched before!');
        return;
    }

    const { offset } = getDefaultTimeZone();

    const f = async (watch: ScheduledWatch) => {
        const names = await Promise.all(watch.attending.map((user) => getUsername(user, msg.guild)));

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
                value : moment.utc(watch.time).utcOffset(offset).format('YYYY/MM/DD'),
                inline: true,
            },
            {
                name: 'Attended',
                value: names.join(', '),
                inline: true,
            },
        ];
    }

    const embed = new MessageEmbed()
        .setTitle('Previously Watched Movies/Series');

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 4,
        displayFunction: f,
        displayType: DisplayType.EmbedFieldData,
        data,
        embed,
    });

    pages.sendMessage();
}

export async function addLink(msg: Message, args: string[], db: Database): Promise<void> {
    if (args.length < 2) {
        msg.reply(`Invalid input, not enough args. Try \`${config.prefix}help watch\``);

        return;
    }

    const id = Number(args[0]);

    if (Number.isNaN(id)) {
        msg.reply(`Invalid input, non numeric ID. Try \`${config.prefix}help watch\``);
        return;
    }

    if (!/^(magnet:\?.+|https?:\/\/.*(?:youtube\.com|youtu\.be)\/\S+)$/.test(args[1])) {
        msg.reply(`Invalid input, does not look like a magnet or youtube link. Try \`${config.prefix}help watch\``);
        return;
    }

    if (args[1].length > 1000) {
        msg.reply('Link is too long. Must be less than 1000 chars.');
        return;
    }

    const watch = await getWatchDetailsById(id, msg.channel.id, db);

    if (!watch) {
        msg.reply(`Could not find movie ID "${id}". Use \`${config.prefix}watch\` to list all scheduled watches.`);
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

    msg.reply(`Successfully added link for ${watch.title}`);
}

export async function updateTime(msg: Message, args: string, db: Database): Promise<void> {
    const timeRegex = /^(\d+) (\d\d\d\d\/\d\d?\/\d\d? \d?\d:\d\d [+-]\d\d?:?\d\d)$/;
    const relativeTimeRegex = /^(\d+) (?:([0-9\.]+)d)?(?:([0-9\.]+)h)?(?:([0-9\.]+)m)?(?: (.+))?$/

    const results = timeRegex.exec(args);
    const relativeResults = relativeTimeRegex.exec(args);

    if (results || relativeResults) {
        let parsedTime = moment();
        let parsedID = '';

        if (results) {
            const [ , id, time ] = results;

            parsedTime = moment(time, 'YYYY/MM/DD hh:mm ZZ');
            parsedID = id;
        } else {
            const [ , id, daysStr, hoursStr, minutesStr ] = relativeResults || [];
            
            parsedID = id;

            if (daysStr === undefined && hoursStr === undefined && minutesStr === undefined) {
                msg.reply(`Could not parse time. Should be in the form \`YYYY/MM/DD HH:MM [+-]HH:MM\``);
                return;
            }

            const days = Number(daysStr) || 0;
            const hours = Number(hoursStr) || 0;
            const minutes = Number(minutesStr) || 0;

            parsedTime = moment.utc().add({
                days,
                hours,
                minutes,
            });
        }

        if (!parsedTime.isValid()) {
            msg.reply(`Could not parse time. Should be in the form \`YYYY/MM/DD HH:MM [+-]HH:MM\``);
            return;
        }

        const watch = await getWatchDetailsById(parsedID, msg.channel.id, db);

        if (!watch) {
            msg.reply(`Could not find movie ID "${parsedID}". Use \`${config.prefix}watch\` to list all scheduled watches.`);
            return;
        }

        await updateQuery(
            `UPDATE
                watch_event
            SET
                timestamp = ?
            WHERE
                movie_id = ?`,
            db,
            [ parsedTime.utc().format('YYYY-MM-DD HH:mm:ss'), parsedID ],
        );

        const { offset, label } = getDefaultTimeZone();

        msg.reply(`Successfully updated time for ${watch.title} to ${parsedTime.utcOffset(offset).format('dddd, MMMM Do, HH:mm')} ${label}!`);
    } else {
        msg.reply(`Invalid input. Try \`${config.prefix}help watch\``);
    }
}

export async function deleteWatch(msg: Message, args: string, db: Database): Promise<void> {
    if (args.length === 0) {
        msg.reply(`Invalid input. No movie ID given. Try \`${config.prefix}help watch\``);
        return;
    }

    const id = Number(args);

    if (Number.isNaN(id)) {
        msg.reply(`Invalid input, non numeric ID. Try \`${config.prefix}help watch\``);
        return;
    }

    const response = await removeWatchById(id, msg, db);
    msg.reply(response);
}

async function removeWatchById(id: number, msg: Message, db: Database, forceDelete: boolean = false) {
    const [ watch ] = await selectQuery(
        `SELECT
            m.title
        FROM
            watch_event AS we
            INNER JOIN movie AS m
                ON we.movie_id = m.id
        WHERE
            we.id = ?
            AND we.channel_id = ?`,
        db,
        [ id, msg.channel.id ]
    );

    if (!watch) {
        return `Could not find movie ID "${id}". Use \`${config.prefix}watch\` to list all scheduled watches.`;
    }

    if (!forceDelete) {
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

        if (attending.length > 0) {
            const areOnlyAttendee = attending.length === 1 && attending[0].user_id === msg.author.id;

            if (!areOnlyAttendee && !haveRole(msg, 'Mod')) {
                return 'You must be the only watch attendee, or be a mod, to remove a movie';
            }
        }
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
        msg.reply(`Could not find movie ID "${id}". Use \`${config.prefix}watch\` to list all scheduled watches.`);
        return;
    }

    const attending = new Set(watch.attending);

    const { offset, label } = getDefaultTimeZone();

    const getFields = async (currentPage: number, totalPage: number) => {
        const names = await Promise.all([...attending].map((user) => getUsername(user, msg.guild)));

        const fields = [];

        fields.push(
            {
                name: 'Time',
                /* If we're watching in less than a day, give a relative time. Otherwise, give date. */
                value: moment.utc().isBefore(moment.utc(watch.time).subtract(1, 'day'))
                    ? `${moment.utc(watch.time).utcOffset(offset).format('dddd, MMMM Do, HH:mm')} ${label}`
                    : `${capitalize(moment.utc(watch.time).fromNow())}, ${moment.utc(watch.time).utcOffset(offset).format('HH:mm')} ${label}`,
            },
            {
                name: 'Attending',
                value: names.join(', '),
            },
        );

        if (watch.infoLinks.length > 0) {
            fields.push({
                name: 'Info Link',
                value: watch.infoLinks[0],
            });
        }

        if (watch.downloadLinks.length === 1) {
            fields.push({
                name: 'Download Link',
                value: watch.downloadLinks[0],
            });
        } else if (watch.downloadLinks.length > 1) {
            fields.push({
                name: `Download Link ${currentPage + 1} of ${totalPage}`,
                value: watch.downloadLinks[currentPage],
            });
        }

        return fields;
    }

    const embed = new MessageEmbed()
        .setTitle(watch.title)
        .setFooter('React with 👍 if you want to attend this movie night');

    const fields = await getFields(0, watch.downloadLinks.length);

    embed.addFields(fields);

    const f = async function(this: Paginate<string>, downloadLink: string, embed: MessageEmbed) {
        embed.fields = [];

        const newFields = await getFields(this.currentPage, this.totalPages);

        embed.addFields(newFields);

        return embed;
    };

    const updateAttendeesFunction = async function(
        this: Paginate<string>,
        downloadLink: string[],
        embed: MessageEmbed,
        reaction: MessageReaction,
        user: User,
    ) {
        if (reaction.emoji.name === '👍') {
            attending.add(user.id);
        } else {
            attending.delete(user.id);
        }

        if (attending.size === 0) {
            msg.channel.send('All attendees removed! Cancelling watch.');

            this.deleteMessage();

            const watchDeletionResponse = await removeWatchById(id, msg, db, true);

            msg.channel.send(watchDeletionResponse);

            return;
        }

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

        embed.fields = [];

        const newFields = await getFields(this.currentPage, this.totalPages);

        embed.addFields(newFields);

        return embed;
    }

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 1,
        displayFunction: f,
        displayType: DisplayType.EmbedData,
        data: watch.downloadLinks,
        embed,
        hideFooter: true,
        customReactions: ['👍', '👎'],
        customReactionFunction: updateAttendeesFunction,
    });

    await pages.sendMessage();
}

export async function addToBank(
    msg: Message,
    args: string,
    db: Database): Promise<void> {

    /* Non greedy title match, optional imdb/myanimelist link, time, optional magnet/youtube link */
    const regex = /^(.+?)(?: (https:\/\/.*imdb\.com\/\S+|https:\/\/.*myanimelist\.net\/\S+))?(?: (magnet:\?.+|https:\/\/.*(?:youtube\.com|youtu\.be)\/\S+))?$/

    const results = regex.exec(args);

    if (results) {
        const [ , title, infoLink, downloadLink ] = results;

        if (infoLink && infoLink.length > 1000) {
            msg.reply('Info link is too long. Must be less than 1000 chars.');
            return;
        }

        if (downloadLink && downloadLink.length > 1000) {
            msg.reply('Download link is too long. Must be less than 1000 chars.');
            return;
        }

        if (title && title.length > 1000) {
            msg.reply('Title is too long. Must be less than 1000 chars.');
            return;
        }

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

        msg.reply(`Successfully added ${title} to movie bank!`);
        return;
    }

    msg.reply(`Invalid input. Try \`${config.prefix}help watch\``);
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
            msg.reply('Info link is too long. Must be less than 1000 chars.');
            return true;
        }

        if (downloadLink && downloadLink.length > 1000) {
            msg.reply('Download link is too long. Must be less than 1000 chars.');
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

            timeObject = moment.utc().add({
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
        [ time.utc().format('YYYY-MM-DD HH:mm:ss'), msg.channel.id, movieID ]
    );

    await insertQuery(
        `INSERT INTO user_watch
            (user_id, watch_event)
        VALUES
            (?, ?)`,
        db,
        [ msg.author.id, watchEventID ]
    );

    const user = await getUsername(msg.author.id, msg.guild);

    const { offset, label } = getDefaultTimeZone();

    const embed = new MessageEmbed()
        .setTitle(`ID: ${movieID} - ${title}`)
        .setDescription(`${title} has been successfully scheduled for ${time.utcOffset(offset).format('dddd, MMMM Do, HH:mm')} ${label}!`)
        .setFooter('React with 👍 if you want to attend this movie night')
        .addFields(
            {
                name: 'Attending',
                value: user,
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

    await tryReactMessage(msg, '👍');
    await tryReactMessage(msg, '👎');

    const collector = msg.createReactionCollector((reaction, user) => {
        return ['👍', '👎'].includes(reaction.emoji.name) && !user.bot;
    }, { time: 60 * 15 * 1000 });

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
            const watchDeletionResponse = await removeWatchById(id, msg, db, true);
            msg.channel.send(watchDeletionResponse);
            return;
        }

        const names = await Promise.all([...attending].map((user) => getUsername(user, msg.guild)));

        embed.spliceFields(attendingFieldIndex, 1, {
            name: 'Attending',
            value: names.join(', '),
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

export async function getWatchDetailsById(id: number | string, channelID: string, db: Database, options?: IGetWatchDetails): Promise<ScheduledWatch | undefined> {
    return getWatchDetailsImpl({
            id,
            channelID,
            ...options,
        },
        db
    ) as Promise<ScheduledWatch | undefined>;
}

async function getWatchDetails(db: Database, options?: IGetWatchDetails): Promise<ScheduledWatch[] | undefined> {
    return getWatchDetailsImpl({
            ...options,
        },
        db
    ) as Promise<ScheduledWatch[] | undefined>;
}

async function getWatchDetailsImpl(
    options: IGetWatchDetails,
    db: Database): Promise<ScheduledWatch | ScheduledWatch[] | undefined> {

    const {
        excludeComplete,
        excludeIncomplete,
        id,
        sort = 'ASC',
        channelID,
    } = options;

    if (Number.isNaN(id)) {
        return undefined;
    }

    const args = {} as any;

    let query =
        `SELECT
            m.id AS movieID,
            m.title AS title,
            we.id AS watchID,
            we.timestamp AS time,
            we.channel_id AS channelID
        FROM
            watch_event AS we
            INNER JOIN movie AS m
                ON m.id = we.movie_id
        WHERE
            1 = 1`;

    if (channelID) {
        query += ` AND we.channel_id = $channel_id`;
        args['$channel_id'] = channelID;
    }

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

    if (sort === 'ASC') {
        query += ` ORDER BY we.timestamp ASC`;
    } else {
        query += ` ORDER BY we.timestamp DESC`;
    }

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

export async function handleWatchNotifications(client: Client, db: Database) {
    const events = await getWatchDetails(db, {
        excludeComplete: true,
    });

    const channels = new Map<string, TextChannel>();

    if (events) {
        for (const watch of events) {
            if (config.devEnv && !config.devChannels.includes(watch.channelID)) {
                continue;
            }

            const fourHourReminder = moment.utc(watch.time).subtract(4, 'hours');
            const twentyMinuteReminder = moment.utc(watch.time).subtract(20, 'minutes');

            /* Get our watch 'window' */
            const nMinsAgo = moment.utc().subtract(config.watchPollInterval / 2, 'milliseconds');
            const nMinsAhead = moment.utc().add(config.watchPollInterval / 2, 'milliseconds');

            const mention = watch.attending.map((x) => `<@${x}>`).join(' ');

            let channel = channels.get(watch.channelID);

            if (channel === undefined) {
                try {
                    channel = await client.channels.fetch(watch.channelID) as TextChannel;

                    if (!channel) {
                        console.log(`Failed to get channel ${watch.channelID}`);
                        continue;
                    }

                    channels.set(watch.channelID, channel);
                } catch (err) {
                    console.log(`Failed to get channel ${watch.channelID}`);
                    continue;
                }
            }

            if (fourHourReminder.isBetween(nMinsAgo, nMinsAhead)) {
                channel.send(`${mention}, reminder, you are watching ${watch.title} in 4 hours (${moment.utc(watch.time).utcOffset(0).format('HH:mm Z')})`);
            }

            if (twentyMinuteReminder.isBetween(nMinsAgo, nMinsAhead)) {
                channel.send(`${mention}, reminder, you are watching ${watch.title} ${moment.utc(watch.time).fromNow()}`);
            }
        }
    }

    setTimeout(handleWatchNotifications, config.watchPollInterval, client, db);
}

export async function handleMovieBank(msg: Message, db: Database) {
    const mentionedUsers = new Set<string>([...msg.mentions.users.keys()]);

    mentionedUsers.add(msg.author.id);

    const movies = await selectQuery(
        `SELECT
            id AS movieID,
            title AS title
        FROM
            movie
        WHERE
            channel_id = ?`,
        db,
        [ msg.channel.id ]
    );

    if (movies.length === 0) {
        msg.reply(`No stored movies. Use \`${config.prefix}help watch\` for info on how to add movies.`);
        return;
    }

    const validOptions = [];

    for (let movie of movies) {
        const links = await selectQuery(
            `SELECT
                link,
                is_download
            FROM
                movie_link
            WHERE
                movie_id = ?`,
            db,
            [ movie.movieID ],
        );

        movie.downloadLinks = [];
        movie.infoLinks = [];

        for (const link of links) {
            if (link.is_download) {
                movie.downloadLinks.push(link.link);
            } else {
                movie.infoLinks.push(link.link);
            }
        }

        const previouslyAttended = await selectQuery(
            `SELECT
                uw.user_id
            FROM user_watch AS uw
            INNER JOIN watch_event AS we
                ON we.id = uw.watch_event
            WHERE
                we.movie_id = ?`,
            db,
            [ movie.watchID ]
        );

        /* Check none of the users have seen this before */
        for (const attendee of previouslyAttended) {
            if (mentionedUsers.has(attendee)) {
                continue;
            }
        }

        validOptions.push(movie);
    }

    /* Shuffle so we can pick a few suggestions */
    shuffleArray(validOptions);

    const embed = new MessageEmbed()
        .setTitle('Movie Suggestions')
        .setDescription('Here are a few movies that you have not seen')
        .setFooter('React with the movie number to mark this movie as seen')

    /* Pick 3 suggestions and display them */
    const options = validOptions.slice(0, 3);

    if (options.length === 0) {
        msg.reply(`No stored movies that you haven't seen. Use \`${config.prefix}help watch\` for info on how to add movies.`);
        return;
    }

    for (const option of options) {
        embed.addFields([
            {
                name: 'Title',
                value: option.title,
                inline: true,
            },
            {
                name: 'Info Link',
                value: option.infoLinks.length > 0
                    ? option.infoLinks[0]
                    : 'N/A',
                inline: true,
            },
            {
                name: 'Download Link',
                value: option.downloadLinks.length > 0
                    ? option.downloadLinks[0]
                    : 'N/A',
                inline: true,
            },
        ]);
    }

    const sentMessage = await msg.channel.send(embed);

    const reactions = ['1⃣'];

    if (options.length >= 2) {
        reactions.push('2⃣');
    }

    if (options.length >= 3) {
        reactions.push('3⃣');
    }

    const collector = msg.createReactionCollector((reaction, user) => {
        return reactions.includes(reaction.emoji.name) && !user.bot;
    }, { time: 60 * 15 * 1000 });

    collector.on('collect', async (reaction: MessageReaction, user: User) => {
    });
}

export async function handleWatchStats(msg: Message, db: Database) {
    const data = await getWatchDetails(db, {
            excludeIncomplete: true,
            channelID: msg.channel.id,
        },
    );

    if (!data) {
        msg.reply('Nothing has been watched yet.');
        return;
    }

    const watchesWithMultipleAttendees = data.filter((x) => x.attending.length > 1);

    const embed = new MessageEmbed()
        .setTitle('Movies attended with more than one attendee')
        .setDescription(`In Total: ${watchesWithMultipleAttendees.length}`);

    const userMapping = new Map();

    for (const watch of watchesWithMultipleAttendees) {
        for (const user of watch.attending) {
            let watchCount = userMapping.get(user) || 0;
            watchCount++;
            userMapping.set(user, watchCount);
        }
    }

    const userArray = Array.from(userMapping, ([user, count]) => {
        return {
            user,
            count,
        }
    });

    for (const user of userArray) {
        user.user = await getUsername(user.user, msg.guild);
    }

    userArray.sort((a, b) => b.count - a.count);

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 9,
        displayFunction: async (watch: any) => {
            return {
                name: watch.user,
                value: watch.count,
                inline: true,
            };
        },
        displayType: DisplayType.EmbedFieldData,
        data: userArray,
        embed,
    });

    pages.sendMessage();
}
