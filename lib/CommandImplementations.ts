import * as fs from 'fs';
import * as path from 'path';
import * as moment from 'moment';
import * as convert from 'xml-js';

import translate = require('@vitalets/google-translate-api');

import fetch from 'node-fetch';

import { stringify, unescape } from 'querystring';
import { promisify } from 'util';
import { evaluate } from 'mathjs';
import { decode } from 'he';
import { Database } from 'sqlite3';

import {
    Message,
    Client,
    TextChannel,
    User,
    MessageEmbed,
    MessageAttachment,
    GuildMember
} from 'discord.js';

import {
    parse,
    HTMLElement
} from 'node-html-parser';

import { config } from './Config';
import { catBreeds } from './Cats';
import { dogBreeds } from './Dogs';
import { fortunes } from './Fortunes';
import { dubTypes } from './Dubs';

import {
    handleWatchHelp,
} from './Help';

import {
    renderDotGraph,
    renderDot,
} from './Dot';

import {
    chunk,
    capitalize,
    sleep,
    haveRole,
    pickRandomItem,
    sendTimer,
    canAccessCommand,
    getUsername,
} from './Utilities';

import {
    insertQuery,
    selectQuery,
    deleteQuery,
} from './Database';

import {
    TimeUnits,
    Quote,
    ScheduledWatch,
    Command,
} from './Types';

import {
    exchangeService
} from './Exchange';

import {
    displayScheduledWatches,
    displayAllWatches,
    addLink,
    updateTime,
    deleteWatch,
    displayWatchById,
    scheduleWatch,
} from './Watch';

import {
    Paginate,
    DisplayType,
    ModifyMessage,
} from './Paginate';

const timeUnits: TimeUnits = {
    Y: 31536000,
    M: 2592000,
    W: 604800,
    d: 86400,
    h: 3600,
    m: 60,
    s: 1
};

const states = [
    "New York",
    "Washington",
    "New Jersey",
    "California",
    "Illinois",
    "Michigan",
    "Florida",
    "Louisiana",
    "Texas",
    "Massachusetts",
    "Georgia",
    "Colorado",
    "Tennessee",
    "Pennsylvania",
    "Wisconsin",
    "Ohio",
    "Connecticut",
    "North Carolina",
    "Indiana",
    "Mississippi",
    "Maryland",
    "Virginia",
    "South Carolina",
    "Nevada",
    "Utah",
    "Minnesota",
    "Arkansas",
    "Oregon",
    "Alabama",
    "Arizona",
    "Missouri",
    "District of Columbia",
    "Kentucky",
    "Iowa",
    "Maine",
    "Rhode Island",
    "New Hampshire",
    "Oklahoma",
    "New Mexico",
    "Kansas",
    "Delaware",
    "Hawaii",
    "Vermont",
    "Idaho",
    "Nebraska",
    "Montana",
    "Alaska",
    "North Dakota",
    "Wyoming",
    "South Dakota",
    "West Virginia",
];

export function handleFortune(msg: Message): void {
    msg.reply(`Your fortune: ${pickRandomItem(fortunes)}`);
}

export function handleMath(msg: Message, args: string): void {
    try {
        msg.reply(evaluate(args).toString());
    } catch (err) {
        msg.reply('Bad mathematical expression: ' + err.toString());
    }
}

/* Rolls the die given. E.g. diceRoll(6) gives a number from 1-6 */
function diceRoll(die: number): number {
    return Math.ceil(Math.random() * die);
}

export function handleDiceRoll(msg: Message, args: string): void {
    const badRoll: string = 'Invalid roll. Examples: 5d20, d8 + 3, 10d10 * 2'

    /* Optional number of rolls (for example 5d20), 'd', (to indicate a roll),
    one or more numbers - the dice to roll - then zero or more chars for an
    optional mathematical expression (for example, d20 + 3) */
    const rollRegex = /^(\d+)?d(\d+)(.*)$/;

    let [ , numDiceStr, dieStr, mathExpression ] = rollRegex.exec(args) || [undefined, undefined, undefined, undefined];

    if (mathExpression !== undefined && mathExpression.trim() === '') {
        mathExpression = undefined;
    }

    let numDice = Number(numDiceStr);
    let die = Number(dieStr);

    if (numDiceStr === undefined || numDice < 1) {
        numDice = 1;
    }

    if (numDice > 100) {
        msg.reply("Can't roll more than 100 dice!");
        return;
    }

    if (dieStr === undefined || Number.isNaN(numDice) || Number.isNaN(die)) {
        msg.reply(badRoll);
        return;
    }

    let response: string = `Roll ${args}: ${mathExpression === undefined ? '' : '('}`;

    let result: number = 0;

    for (let i = 0; i < numDice; i++) {
        const rollResult: number = diceRoll(die);

        result += rollResult;

        response += rollResult.toString();

        /* Don't add a '+' if we're on the last iteration */
        if (i !== numDice - 1) {
            response += ' + ';
        }
    }

    if (mathExpression !== undefined) {
        response += ')';
        try {
            const expression: string = result.toString() + mathExpression;
            response += mathExpression;
            result = evaluate(expression);
        } catch (err) {
            msg.reply('Bad mathematical expression: ' + err.toString());
            return;
        }
    }

    if (numDice !== 1 || mathExpression !== undefined) {
        response += ' = ' + result.toString();
    }

    msg.reply(response);
}

export function handleRoll(msg: Message, args: string): void {
    if (haveRole(msg, 'Baby Boy')) {
        msg.reply('little bitches are NOT allowed to use the roll bot. Obey the rolls, faggot!');
        return;
    }

    args = args.trim();

    /* Is it a dice roll - d + number, for example, d20, 5d20, d6 + 3 */
    if (/d\d/.test(args)) {
        handleDiceRoll(msg, args);
        return;
    }

    const dubsReaction: string = dubsType(msg.id);
    msg.reply(`Your post number is: ${msg.id} ${dubsReaction}`);
}

function dubsType(roll: string): string {
    /* Reverse */
    roll = roll.split('').reverse().join('');

    const initial: string = roll[0];

    let dubsStripped: string = roll;

    while (dubsStripped[0] === initial) {
        dubsStripped = dubsStripped.substr(1);
    }

    /* Find the amount of repeating digits of the roll */
    const numRepeatingDigits: number = roll.length - dubsStripped.length;

    /* No dubs :( */
    if (numRepeatingDigits === 1) {
        /* The final digit of the roll */
        const firstNum: number = Number(initial);
        /* The preceding digit */
        const secondNum: number = Number(roll[1]);

        let greaterNum = firstNum + 1;
        let lesserNum = firstNum - 1;

        if (greaterNum > 10) {
            greaterNum -= 10;
        }

        if (lesserNum < 0) {
            lesserNum += 10;
        }

        if (greaterNum === secondNum || lesserNum === secondNum) {
            return '- Off by one :(';
        }

        return '';
    }

    /* Start at dubs */
    const index: number = numRepeatingDigits - 2;

    if (index >= dubTypes.length) {
        return 'OFF THE FUCKING CHARTS';
    }

    return dubTypes[index];
}

export async function handleQuote(msg: Message, db: Database): Promise<void> {
    db.all(`SELECT quote, timestamp FROM quote WHERE channel_id = ?`, [msg.channel.id], (err, rows) => {
        if (err) {
            msg.reply(err);
            return;
        }

        if (rows.length === 0) {
            msg.reply('No quotes in the database! Use $suggest to suggest one.');
            return;
        }

        const { quote, timestamp } = rows[Math.floor(Math.random() * rows.length)];

        if (timestamp) {
            msg.channel.send(`${quote} - ${new Date(timestamp).toISOString().slice(0, 10)}`);
        } else {
            msg.channel.send(quote);
        }
    });
}

export async function handleSuggest(msg: Message, suggestion: string, db: Database): Promise<void> {
    if (!suggestion || suggestion.length <= 1) {
        msg.reply('Enter a fucking suggestion you wank stain');
        return;
    }

    await insertQuery(
        `INSERT INTO quote
            (quote, channel_id)
        VALUES
            (?, ?)`,
        db,
        [ suggestion, msg.channel.id ]
    );

    await msg.react('👍');
}

export async function handleKitty(msg: Message, args: string): Promise<void> {
    const breed: string = args.trim().toLowerCase();

    const breedId = catBreeds.find((x) => x.name.toLowerCase() === breed);

    if (breed !== '' && breedId === undefined) {
        msg.reply(`Unknown breed. Available breeds: <${config.kittyBreedLink}>`);
    }

    let kittyParams = {
        limit: 1,
        mime_types: 'jpg,png',
        breed_id: breedId ? breedId.id : '',
    };

    const url: string = `https://api.thecatapi.com/v1/images/search?${stringify(kittyParams)}`;

    try {
        const response = await fetch(url);

        const data = await response.json();

        if (!data || data.length < 1 || !data[0].url) {
            msg.reply(`Failed to get kitty pic :( [ ${JSON.stringify(data)} ]`);
            return;
        }

        const attachment = new MessageAttachment(data[0].url);

        msg.channel.send(attachment);
    } catch (err) {
        msg.reply(`Failed to get kitty pic :( [ ${err.toString()} ]`);
    }
}

export async function handleDoggo(msg: Message, breed: string[]): Promise<void> {
    let mainBreed: string = '';
    let subBreed: string = '';

    let [ x, y ] = breed;

    x = x ? x.trim().toLowerCase() : '';
    y = y ? y.trim().toLowerCase() : '';

    if (x) {
        if (dogBreeds.hasOwnProperty(x)) {
            mainBreed = x;
        } else if (y && dogBreeds.hasOwnProperty(y)) {
            mainBreed = y;
        } else {
            msg.reply(`Unknown breed. Available breeds: <${config.doggoBreedLink}>`);
        }
    }

    if (mainBreed !== '' && y) {
        if (dogBreeds[mainBreed].includes(x)) {
            subBreed = x;
        } else if (dogBreeds[mainBreed].includes(y)) {
            subBreed = y;
        } else {
            msg.reply(`Unknown breed. Available breeds: <${config.doggoBreedLink}>`);
        }
    }

    const url: string = mainBreed !== '' && subBreed !== ''
        ? `https://dog.ceo/api/breed/${mainBreed}/${subBreed}/images/random`
        : mainBreed !== ''
            ? `https://dog.ceo/api/breed/${mainBreed}/images/random`
            : 'https://dog.ceo/api/breeds/image/random';

    try {
        const response = await fetch(url);

        const data = await response.json();

        if (data.status !== 'success' || !data.message) {
            msg.reply(`Failed to get doggo pic :( [ ${JSON.stringify(data)} ]`);
            return;
        }

        const attachment = new MessageAttachment(data.message);

        msg.channel.send(attachment);
    } catch (err) {
        msg.reply(`Failed to get doggo pic :( [ ${err.toString()} ]`);
    }
}

async function getChinkedWorldData(msg: Message, host: string): Promise<void> {
    try {
        const response = await fetch(host + '/v2/all');

        const data = await response.json();

        const embed = new MessageEmbed()
            .setColor('#C8102E')
            .setTitle('Coronavirus statistics')
            .setThumbnail('https://i.imgur.com/FnbQwqQ.png')
            .addFields(
                {
                    name: 'Cases',
                    value: `${data.cases} (+${data.todayCases})`,
                    inline: true,
                },
                {
                    name: 'Deaths',
                    value: `${data.deaths} (+${data.todayDeaths})`,
                    inline: true,
                },
                {
                    name: 'Active',
                    value: data.active,
                    inline: true,
                },
                {
                    name: 'Recovered',
                    value: data.recovered,
                    inline: true,
                },
                {
                    name: 'Percentage Infected',
                    value: (100 * (data.casesPerOneMillion / 1_000_000)).toFixed(5) + '%',
                    inline: true,
                },
                {
                    name: 'Last Updated',
                    value: moment(data.updated).fromNow(),
                    inline: true,
                },
            );

        msg.channel.send(embed);
    } catch (err) {
        msg.reply(`Failed to get stats :( [ ${err.toString()} ]`);
    }
}

async function getChinkedCountryData(msg: Message, country: string, host: string): Promise<void> {
    try {
        const response = await fetch(`${host}/v2/countries/${country}`);

        const countryData = await response.json();

        if (countryData.message) {
            msg.reply(`Unknown country "${country}", run \`$chinked countries\` to list all countries and \`$chinked states\` to list all states.`);
            return;
        }

        const embed = new MessageEmbed()
            .setColor('#C8102E')
            .setTitle('Coronavirus statistics, ' + countryData.country)
            .setThumbnail(countryData.countryInfo.flag)
            .addFields(
                {
                    name: 'Cases',
                    value: `${countryData.cases} (+${countryData.todayCases})`,
                    inline: true,
                },
                {
                    name: 'Deaths',
                    value: `${countryData.deaths} (+${countryData.todayDeaths})`,
                    inline: true,
                },
                {
                    name: 'Active',
                    value: countryData.active,
                    inline: true,
                },
                {
                    name: 'Recovered',
                    value: countryData.recovered,
                    inline: true,
                },
                {
                    name: 'Percentage Infected',
                    value: (100 * (countryData.casesPerOneMillion / 1_000_000)).toFixed(5) + '%',
                    inline: true,
                },
                {
                    name: 'Last Updated',
                    value: moment(countryData.updated).fromNow(),
                    inline: true,
                }
            );

        if (countryData.country === 'UK') {
            embed.setFooter('Results from the UK should not be considered accurate. See https://www.cebm.net/covid-19/why-no-one-can-ever-recover-from-covid-19-in-england-a-statistical-anomaly/');
        }

        msg.channel.send(embed);

    } catch (err) {
        if (err.statusCode === 404) {
            msg.reply(`Unknown country "${country}", run \`$chinked countries\` to list all countries and \`$chinked states\` to list all states.`);
        } else {
            msg.reply(`Failed to get stats :( [ ${err.toString()} ]`);
        }
    }
}

async function getChinkedStateData(msg: Message, state: string, host: string): Promise<void> {
    try {
        const response = await fetch(`${host}/v2/states`);

        const data = await response.json();

        for (const stateData of data) {
            if (stateData.state.toLowerCase() === state) {
                const embed = new MessageEmbed()
                    .setColor('#C8102E')
                    .setTitle(`Coronavirus statistics, ${stateData.state}`)
                    .setThumbnail('https://i.imgur.com/FnbQwqQ.png')
                    .addFields(
                        {
                            name: 'Cases',
                            value: `${stateData.cases} (+${stateData.todayCases})`,
                            inline: false,
                        },
                        {
                            name: 'Deaths',
                            value: `${stateData.deaths} (+${stateData.todayDeaths})`,
                            inline: false,
                        },
                        {
                            name: 'Active',
                            value: stateData.active,
                            inline: false,
                        },
                        {
                            name: 'Recovered',
                            value: stateData.cases - stateData.active - stateData.deaths,
                            inline: false,
                        },
                    );

                msg.channel.send(embed);

                return;
            }
        }
    } catch (err) {
        msg.reply(`Failed to get stats :( [ ${err.toString()} ]`);
    }
}

async function getChinkedCountries(msg: Message, host: string): Promise<void> {
    try {
        const response = await fetch(host + '/v2/countries');

        const data = await response.json();

        const countries = 'Known countries/areas: ' + data.map((x: any) => x.country).sort((a: string, b: string) => a.localeCompare(b)).join(', ');

        /* Discord message limit */
        if (countries.length > 2000) {
            /* This splits in the middle of words, but we don't give a shit */
            for (const message of chunk(countries, 1700)) {
                msg.channel.send(message);
            }
        } else {
            msg.reply(countries);
        }
    } catch (err) {
        msg.reply(`Failed to get countries :( [ ${err.toString()} ]`);
    }
}

async function getChinkedStates(msg: Message): Promise<void> {
    const stateData = 'Known states: ' + states.sort((a: string, b: string) => a.localeCompare(b)).join(', ');

    if (stateData.length > 2000) {
        for (const message of chunk(stateData, 1700)) {
            msg.channel.send(message);
        }
    } else {
        msg.reply(stateData);
    }
}

export async function handleChinked(msg: Message, country: string): Promise<void> {
    country = country.trim().toLowerCase();

    const runningLocally = false;
    const host = runningLocally ? 'http://127.0.0.1:7531' : 'https://corona.lmao.ninja';

    switch(country) {
        case '': {
            getChinkedWorldData(msg, host);
            break;
        }
        case 'countries': {
            getChinkedCountries(msg, host);
            break;
        }
        case 'states': {
            getChinkedStates(msg);
            break;
        }
        default: {
            if (states.map((x) => x.toLowerCase()).includes(country)) {
                getChinkedStateData(msg, country, host);
            } else {
                getChinkedCountryData(msg, country, host);
            }

            break;
        }
    }
}

export async function handleDot(msg: Message, arg: string): Promise<void> {
    /* Optional timespan for dot graph (for example 30m, 5s, 20h) */
    const timeRegex = /^([0-9]+)([YMWdhms])/;

    let [ timeString, num, unit ] = timeRegex.exec(arg) || [ '24h', 24, 'h' ];
    let timeSpan: number = Number(num) * timeUnits[unit as keyof TimeUnits];

    /* Timespan cannot be larger than 498 days */
    /* Default timespan is 24h */
    if (timeSpan > 86400 * 498) {
        timeSpan = 86400 * 498;
        timeString = '1w';
    } else if (timeSpan <= 0) {
        timeSpan = 86400;
        timeString = '24h';
    }

    let dotGraph;
    let currentDotColor = '#000000';
    let currentDotValue = 0;
    let dot;

    try {
        [ [ , dotGraph ], [ currentDotColor, currentDotValue, dot ] ] = await Promise.all([
            renderDotGraph(timeSpan * -1),
            renderDot(),
        ]);
    } catch (err) {
        msg.reply(`Failed to get dot data :( [ ${err.toString()} ]`);
        return;
    }

    let description: string = '';

    if (currentDotValue < 0.05) {
        description = 'Significantly large network variance. Suggests broadly shared coherence of thought and emotion.';
    }
    else if (currentDotValue < 0.1) {
        description = 'Strongly increased network variance. May be chance fluctuation.';
    }
    else if (currentDotValue < 0.4) {
        description = 'Slightly increased network variance. Probably chance fluctuation.';
    }
    else if (currentDotValue < 0.9) {
        description = 'Normally random network variance. This is average or expected behavior.';
    }
    else if (currentDotValue < 0.95) {
        description = 'Small network variance. Probably chance fluctuation.';
    }
    else if (currentDotValue <= 1.0) {
        description = 'Significantly small network variance. Suggestive of deeply shared, internally motivated group focus.';
    }

    const dotGraphAttachment = new MessageAttachment(dotGraph.toBuffer(), 'dot-graph.png');
    const dotAttachment = new MessageAttachment(dot.toBuffer(), 'dot.png');

    const percentage = Math.floor(currentDotValue * 100);

    const embed = new MessageEmbed()
        .setColor(currentDotColor)
        .attachFiles([dotAttachment, dotGraphAttachment])
        .setTitle(`${percentage}% Network Variance`)
        .setThumbnail('attachment://dot.png')
        .setImage('attachment://dot-graph.png')
        .setDescription(description);

    msg.channel.send(embed);
}


export async function handleImgur(gallery: string, msg: Message): Promise<void> {
    try {
        // seems to loop around to page 0 if given a page > final page
        const finalPage = ({
            'r/pizza': 14,
            'r/turtle': 3,
        } as any)[gallery];

        const index = Math.floor(Math.random() * (finalPage + 1));

        const response = await fetch(`https://api.imgur.com/3/gallery/${gallery}/top/all/${index}`, {
            headers: {
                'Authorization': 'Client-ID de8a61d6a484c39',
            },
        });

        const data = await response.json();

        const images = data.data.filter((img: any) => img.size > 0);

        const image = images[Math.floor(Math.random() * images.length)];

        if (image == undefined) {
            msg.reply('Failed to fetch image from imgur API');
            return;
        }

        const embed = new MessageEmbed().setTitle(image.title);

        const url = image.is_album
            ? image.images[0].link
            : image.link;

        embed.attachFiles([url]);
        embed.setImage(`attachment://${new URL(image.link).pathname.substr(1)}`);

        if (image.is_album) {
            embed.setFooter(`See ${image.images.length - 1} more images at ${image.link}`);
        }

        msg.channel.send(embed);
    } catch (err) {
        msg.reply(`Failed to get ${gallery} pic :( [ ${err.toString()} ]`);
    }
}

export async function handleWatch(msg: Message, args: string[], db: Database): Promise<void> {
    /* No args, display scheduled things to watch */
    if (args.length === 0) {
        await displayScheduledWatches(msg, db);
        return;
    }

    /* Next lets check for a command match */
    if (args.length >= 1) {
        switch (args[0]) {
            case 'history': {
                displayAllWatches(msg, db);
                return;
            }
            case 'addlink': {
                addLink(msg, args.slice(1), db);
                return;
            }
            case 'delete': {
                deleteWatch(msg, args.slice(1), db);
                return;
            }
            case 'updatetime': {
                updateTime(msg, args.slice(1).join(' '), db);
                return;
            }
        }
    }

    /* Single arg, should be trying to get a specific movie by id */
    if (args.length === 1) {
        displayWatchById(msg, Number(args[0]), db);
        return;
    }

    /* Otherwise, try and parse it as a scheduling */
    const success = await scheduleWatch(msg, args.join(' '), db);

    if (!success) {
        handleWatchHelp(msg, 'Sorry, your input was invalid. Please try one of the following options.');
    }
}

export function handleTime(msg: Message, args: string) {
    let offset: string | number = 0;

    if (args.length > 0) {
        offset = args;
    }

    msg.reply(`The current time is ${moment().utcOffset(offset).format('HH:mm Z')}`);
}

export function handleDate(msg: Message, args: string) {
    let offset: string | number = 0;

    if (args.length > 0) {
        offset = args;
    }

    msg.reply(`The current date is ${moment().utcOffset(offset).format('dddd, MMMM Do YYYY')}`);
}

export async function handleTimer(msg: Message, args: string[], db: Database) {
    if (args.length >= 1) {
        switch (args[0]) {
            case 'list': {
                handleTimers(msg, db);
                return;
            }
            case 'delete': {
                deleteTimer(msg, args.slice(1), db);
                return;
            }
        }
    }

    const regex = /^(?:([0-9\.]+)h)?(?:([0-9\.]+)m)?(?:([0-9\.]+)s)?(?: (.+))?$/;

    const results = regex.exec(args.join(' '));

    if (!results) {
        msg.reply('Failed to parse input, try `$timer 5m coffee` or `$timer 5h10m`. Max 24h timers.');
        return;
    }

    const [, hours=0, minutes=0, seconds=0, description ] = results;

    const totalTimeSeconds = Number(seconds)
                           + Number(minutes) * 60
                           + Number(hours) * 60 * 60;

    if (totalTimeSeconds > 60 * 60 * 24 * 365 * 100) {
        msg.reply('Timers longer than 100 years are not supported.');
        return;
    }

    sendTimer(msg.channel as TextChannel, totalTimeSeconds * 1000, msg.author.id, description);

    const time = moment().add(totalTimeSeconds, 'seconds');

    const timerID = await insertQuery(
        `INSERT INTO timer
            (user_id, channel_id, message, expire_time)
        VALUES
            (?, ?, ?, ?)`,
        db,
        [ msg.author.id, msg.channel.id, description, time.utcOffset(0).format('YYYY-MM-DD hh:mm:ss') ],
    );

    const embed = new MessageEmbed()
        .setTitle('Success')
        .setDescription(`Timer #${timerID} has been scheduled.`)
        .setFooter(`Type ${config.prefix}timer delete ${timerID} to cancel this timer`)
        .addFields(
            {
                name: 'Time',
                value: `${capitalize(moment(time).fromNow())}, ${moment(time).utcOffset(-6).format('HH:mm')} CST`,
            }
        );

    if (description) {
        embed.addFields({
            name: 'Message',
            value: description,
        });
    }

    msg.channel.send(embed);
}

export async function handleCountdown(
    completionMessage: string,
    msg: Message,
    args: string) {

    if (args === '') {
        args = '3';
    }

    let secs = Number(args);

    if (Number.isNaN(secs)) {
        msg.reply('Invalid input, try `$countdown` or `$countdown 5`');
        return;
    }

    if (secs > 120) {
        msg.reply('Countdowns longer than 120 are not supported.');
        return;
    }

    if (secs < 1) {
        msg.reply('Countdowns less than 1 are not supported.');
        return;
    }

    const sentMessage = await msg.channel.send(secs.toString());

    while (secs > 0) {
        secs--;

        const message = secs === 0
            ? completionMessage
            : secs.toString();

        /* Need to be careful not to hit API limits. Can only perform 5 actions
         * in 5 seconds. Experienced limiting with 1200ms delay. */
        await sleep(1500);

        sentMessage.edit(message);
    }
}

export async function handlePurge(msg: Message) {
    const embed = new MessageEmbed()
        .setTitle('Message Deletion')
        .setDescription('This will delete every single message you have made in this channel. Are you sure? The process will take several hours.')
        .setFooter('React with 👍 to confirm the deletion');

    const sentMessage = await msg.channel.send(embed);

    await sentMessage.react('👍');

    const collector = sentMessage.createReactionCollector((reaction, user) => {
        return reaction.emoji.name === '👍' && user.id === msg.author.id
    }, { time: 3000000 });

    let inProgress = false;

    collector.on('collect', async (reaction, user) => {
        if (inProgress) {
            return;
        }

        if (user.id !== msg.author.id) {
            return;
        }

        inProgress = true;

        let messages: Message[] = [];

        let i = 0;

        try {
            do {
                const firstMessage = messages.length === 0 ? undefined : messages[0].id;

                /* Fetch messages, convert to array and sort by timestamp, oldest first */
                messages = (await msg.channel.messages.fetch({ before: firstMessage })).array().sort((a, b) => a.createdTimestamp - b.createdTimestamp);

                for (const message of messages) {
                    if (message.author.id === msg.author.id) {
                        await message.delete();
                        console.log(`Deleted message ${i} for ${msg.author.id}`);
                        i++;
                    }
                }
            } while (messages.length > 0);
        } catch (err) {
            console.log('err: ' + err.toString());
        }

        msg.channel.send(`Message deletion for <@${msg.author.id}> complete`);
    });
}

export async function handleTranslate(msg: Message, args: string[]): Promise<void> {
    if (args.length === 0) {
        msg.reply('No translate string given!');
        return;
    }

    let translateString = args.join(' ');

    let toLang = 'en';

    var keys = Object.keys(translate.languages).filter(function (key) {
        if (typeof translate.languages[key] !== 'string') {
            return false;
        }

        return translate.languages[key].toLowerCase() === (args[0] || '').toLowerCase();
    });

    if (keys.length > 0) {
        translateString = args.slice(1).join(' ');
        toLang = keys[0];
    }

    try {
        const res = await translate(translateString, {
            to: toLang,
            client: 'gtx',
        });

        const description = `${translate.languages[res.from.language.iso as any]} to ${translate.languages[toLang as any]}`;
        const title = res.text;

        const embed = new MessageEmbed();

        /* Max title length of 256 */
        if (title.length < 256) {
            embed.setDescription(description)
            embed.setTitle(title);
        } else {
            embed.setDescription(title);
            embed.setTitle(description);
        }

        if (res.from.text.value !== '') {
            embed.setFooter(`Did you mean "${res.from.text.value}"?`);
        }

        msg.channel.send(embed);

    } catch (err) {
        msg.reply(`Failed to translate: ${err}`);
    }
}

async function getQueryResults(query: string): Promise<false | HTMLElement> {
    const params = {
        q: query,
        kl: 'us-en', // US location
        kp: -2, // safe search off
        kac: -1, // auto suggest off
        kav: 1, // load all results
    };

    const url = `https://html.duckduckgo.com/html/?${stringify(params)}`;

    let data: any;

    try {
        const response = await fetch(url);
        data = await response.text();
    } catch (err) {
        console.log(err);
        return false;
    }

    const html = parse(data);

    return html;
}

async function displayQueryResults(html: HTMLElement, msg: Message) {
    const results = [];
    const errors = [];

    for (const resultNode of html.querySelectorAll('.result__body')) {
        const isAd = resultNode.querySelector('.badge--ad');

        if (isAd) {
            continue;
        }

        const linkNode = resultNode.querySelector('.result__a');

        const protocolRegex = /\/\/duckduckgo\.com\/l\/\?uddg=(https|http)/;
        const [ , protocol = 'https' ] = protocolRegex.exec(linkNode.getAttribute('href') || '') || [ undefined ];

        const linkTitle = decode(linkNode.childNodes[0].text.trim());
        const link = decode(resultNode.querySelector('.result__url').childNodes[0].text.trim());
        const snippetNode = resultNode.querySelector('.result__snippet');

        /* sometimes we just have a url with no snippet */
        if (!snippetNode || !snippetNode.childNodes) {
            continue;
        }

        const snippet = snippetNode.childNodes.map((n) => decode(n.text)).join('');
        const linkURL = `${protocol}://${link}`;

        if (linkTitle === '' || link === '' || snippet === '') {
            errors.push(`Failed to parse HTML, linkTitle: ${linkTitle} link: ${link} snippet: ${snippet}`);
            continue;
        }

        results.push({
            linkTitle,
            linkURL,
            snippet,
        });
    }

    if (results.length > 0) {
        const embed = new MessageEmbed();

        const pages = new Paginate({
            sourceMessage: msg,
            itemsPerPage: 3,
            displayFunction: (result: any) => {
                return {
                    name: `${result.linkTitle} - ${result.linkURL}`,
                    value: result.snippet,
                    inline: false,
                };
            },
            displayType: DisplayType.EmbedFieldData,
            data: results,
            embed,
        });

        pages.sendMessage();
    } else {
        msg.reply(`Failed to find any results: ${errors.join(', ')}!`);
    }
}

async function getInstantAnswerResults(query: string) {
    const params = {
        q: query.toLowerCase(),
        format: 'json',
        t: 'Dave the Discord Bot', // identify ourselves to their servers
        no_html: 1,
        no_redirect: 1, // don't follow redirects in bang queries
        skip_disambig: 1,
        kp: -2,
        kl: 'us-en', // US location
    };

    const url = `https://api.duckduckgo.com/?${stringify(params)}`;

    let data: any;

    try {
        const response = await fetch(url);
        data = await response.json();
    } catch (err) {
        console.log(err);
        return false;
    }

    if (!data || (!data.Heading && !data.Redirect)) {
        return false;
    }

    return data;
}

async function displayInstantAnswerResult(data: any, msg: Message) {
    if (data.Redirect) {
        msg.reply(data.Redirect);
        return;
    }

    const embed = new MessageEmbed()
        .setTitle(data.Heading);

    if (data.Image) {
        embed.setImage(`https://duckduckgo.com${data.Image}`);
    }

    if (data.AbstractURL) {
        embed.setURL(data.AbstractURL);
    }

    if (data.Answer) {
        embed.setDescription(data.Answer);
    } else if (data.AbstractText) {
        embed.setDescription(data.AbstractText);
    }

    const results = data.Results.length > 0
        ? data.Results
        : data.RelatedTopics;

    if (!embed.description) {
        const pages = new Paginate({
            sourceMessage: msg,
            itemsPerPage: 3,
            displayFunction: (topic: any) => {
                const regex = /<a href="https:\/\/duckduckgo\.com\/.+">(.+)<\/a>(.+)/;

                const innerTopic = topic.Text
                    ? topic
                    : topic.Topics[0];

                let description = innerTopic.Text;

                const regexMatch = regex.exec(innerTopic.Result);

                const [, header=undefined, result=undefined ] = (regexMatch || [ undefined, undefined, undefined ]);

                if (result) {
                    description = result;
                }

                let title = '';

                if (innerTopic.Name) {
                    title += `(${innerTopic.Name}) `;
                }

                if (header) {
                    title += header + ' - ';
                }

                title += innerTopic.FirstURL;

                return {
                    name: title,
                    value: description,
                    inline: false,
                };
            },
            displayType: DisplayType.EmbedFieldData,
            data: results,
            embed,
        });

        pages.sendMessage();
    } else {
        msg.channel.send(embed);
    }
}

export async function handleQuery(msg: Message, args: string): Promise<void> {
    if (args.trim() === '') {
        msg.reply('No query given');
        return;
    }

    try {
        /* Fire off both requests asynchronously */
        const instantAnswerPromise = getInstantAnswerResults(args);
        const queryPromise = getQueryResults(args);

        /* Wait for instant answer result to complete and use that if present */
        const data = await instantAnswerPromise;

        if (data) {
            displayInstantAnswerResult(data, msg);
        } else {
            /* If not then use HTML scrape result */
            const html = await queryPromise;

            if (!html) {
                throw new Error();
            }

            displayQueryResults(html, msg);
        }
    } catch (err) {
        msg.reply(`Error getting query results: ${err.toString()}`);
    }
}

export async function handleExchange(msg: Message, args: string): Promise<void> {
    const regex = /(\d+(?:\.\d{1,2})?) ([A-Za-z]{3}) (?:[tT][oO] )?([A-Za-z]{3})/;

    const result = regex.exec(args);

    if (!result) {
        msg.reply(`Failed to parse input. It should be in the form \`$exchange 100 ABC to XYZ\`. \`$exchange help\` to view currencies.`);
        return;
    }

    let [, amountToConvert, from, to ] = result;

    from = from.toUpperCase();
    to = to.toUpperCase();

    const asNum = Number(amountToConvert);

    if (Number.isNaN(asNum)) {
        msg.reply(`Failed to parse amount: ${amountToConvert}`);
        return;
    }

    const {
        success,
        error,
        amount,
        amountInUsd,
        fromCurrency,
        toCurrency,
    } = exchangeService.exchange(from, to, asNum);

    if (!success) {
        msg.reply(error);
        return;
    }

    const embed = new MessageEmbed()
        .setTitle(`${amountToConvert} ${fromCurrency} is ${amount} ${toCurrency}`)
        .setFooter('Exchange rates are updated every 8 hours');

    msg.channel.send(embed);
}

export async function handleAvatar(msg: Message): Promise<void> {
    const mentionedUsers = [...msg.mentions.users.values()];

    let user = msg.author;

    if (mentionedUsers.length > 0) {
        user = mentionedUsers[0];
    }

    msg.channel.send(user.displayAvatarURL({
        format: 'png',
        dynamic: true,
        size: 4096,
    }));
}

export function handleNikocado(msg: Message): void {
    const nikocados = [
        "ORLINS BACK!",
        "Orlins leaving!",
        "I'm a vegan again!",
        "I sharted the bed!",
    ];

    msg.reply(pickRandomItem(nikocados));
}

export async function handleYoutube(msg: Message, args: string): Promise<void> {
    const data = await handleYoutubeApi(msg, args);

    if (!data) {
        return;
    }

    const embed = new MessageEmbed();

    const pages = new Paginate({
        sourceMessage: msg,
        displayFunction: displayYoutube,
        displayType: DisplayType.MessageData,
        data,
        embed,
    });

    pages.sendMessage();
}

function displayYoutube (this: Paginate<any>, items: any[], message: Message) {
    return `${items[0].url} - ${this.getPageFooter()}`;
}

export async function handleImage(msg: Message, args: string): Promise<void> {
    const data = await handleImageImpl(msg, args);

    if (!data) {
        return;
    }

    const displayImage = (duckduckgoItem: any, embed: MessageEmbed) => {
        embed.setTitle(duckduckgoItem.title);
        embed.setImage(duckduckgoItem.image);
        embed.setDescription(duckduckgoItem.url);
    };

    const determineDisplayType = (duckduckgoItems: any[]) => {
        const item = duckduckgoItems[0];

        if (/https?:\/\/.*(?:youtube\.com|youtu\.be)\/\S+/.test(item.url)) {
            return {
                displayType: DisplayType.MessageData,
                displayFunction: displayYoutube,
            }
        }

        return {
            displayType: DisplayType.EmbedData,
            displayFunction: displayImage,
        };
    };

    const embed = new MessageEmbed();

    const pages = new Paginate({
        sourceMessage: msg,
        displayFunction: displayImage,
        determineDisplayTypeFunction: determineDisplayType,
        displayType: DisplayType.EmbedData,
        data,
        embed,
    });

    pages.sendMessage();
}

export async function handleImageImpl(msg: Message, args: string, site?: string): Promise<undefined | any[]> {
    if (args.trim() === '') {
        msg.reply('No query given');
        return;
    }

    let query = args;

    /* Search a specific site */
    if (site) {
        query += ` site:${site}`;
    }

    const tokenParams = {
        q: query,
        kl: 'us-en', // US location
        kp: -2, // safe search off
        kac: -1, // auto suggest off
        kav: 1, // load all results
    };

    const tokenOptions = {
        headers: {
            'cookie': 'p=-2',
        },
    };

    // gotta get our magic token to perform an image search
    const tokenURL = `https://duckduckgo.com/?${stringify(tokenParams)}`;

    let data: any;

    try {
        const response = await fetch(tokenURL, tokenOptions);
        data = await response.text();
    } catch (err) {
        msg.reply(err);
        return;
    }

    // gimme that token...
    const regex = /vqd='([\d-]+)'/gm;

    const [, token ] = regex.exec(data) || [ undefined, undefined ];

    if (!token) {
        msg.reply('Failed to get token!');
        return;
    }

    const imageParams = {
        q: query,
        l: 'us-en', // US location
        ac: -1, // auto suggest off
        av: 1, // load all results
        p: -1,  // safe search off - for some reason this needs to be -1, not -2, not sure why
        vqd: token, // magic token!
        f: ',,,',
        v7exp: 'a',
        o: 'json',
    };

    const options = {
        headers: {
            'authority': 'duckduckgo.com',
            'accept': 'application/json, text/javascript, */*; q=0.01',
            'sec-fetch-dest': 'empty',
            'x-requested-with': 'XMLHttpRequest',
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.163 Safari/537.36',
            'sec-fetch-site': 'same-origin',
            'sec-fetch-mode': 'cors',
            'referer': 'https://duckduckgo.com/',
            'accept-language': 'en-US,en;q=0.9',
            'cookie': 'p=-2',
        },
    };

    const imageURL = `https://duckduckgo.com/i.js?${stringify(imageParams)}`;

    let imageData: any;

    try {
        const response = await fetch(imageURL, options);
        imageData = await response.json();
    } catch (err) {
        msg.reply(err);
        return;
    }

    if (!imageData.results || imageData.results.length === 0) {
        msg.reply('No results found!');
        return;
    }

    const validExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webm', 'mp4'];

    const isValidExtension = (img: any) => {
        const url = new URL(img.image);

        if (url.protocol === 'http:') {
            return false;
        }

        const file = url.pathname;

        return validExtensions.some((ext) => file.endsWith(`.${ext}`));
    };

    const blacklistedDomains: string[] = [
    ];

    const isBlacklistedDomain = (img: any) => {
        const url = new URL(img.image);

        return blacklistedDomains.includes(url.hostname);
    };

    const images = new Set<string>();

    const filtered = imageData.results.filter((img: any, position: number) => {
        /* Verify the image doesn't appear in the results multiple times */
        if (images.has(img.image)) {
            return false;
        }

        /* Skip known bad domains */
        if (isBlacklistedDomain(img)) {
            return false;
        }

        /* Verify it has a valid extension, discord will not display a preview without one */
        if (!isValidExtension(img)) {
            return false;
        }

        /* Add to url cache */
        images.add(img.image);

        return true;
    });

    if (filtered.length === 0) {
        msg.reply('No results found!');
        return;
    }

    return filtered;
}

export async function handleStats(msg: Message, args: string, db: Database): Promise<void> {
    const commands = await selectQuery(
        `SELECT
            command AS command,
            COUNT(*) AS usage
        FROM
            logs
        WHERE
            channel_id = ?
        GROUP BY
            command
        ORDER BY
            usage DESC`,
        db,
        [ msg.channel.id ]
    );

    const embed = new MessageEmbed()
        .setTitle('Bot usage statistics')
        .setDescription('Number of times a command has been used');

    for (const command of commands) {
        embed.addField(`${config.prefix}${command.command}`, command.usage, true);
    }

    msg.channel.send(embed);
}

export async function handleYoutubeScrape(msg: Message, args: string): Promise<undefined | any[]> {
    if (args.trim() === '') {
        msg.reply('No query given');
        return;
    }

    const params = {
        search_query: args,
    };

    const url = `https://youtube.com/results?${stringify(params)}`;

    let data: any;

    try {
        const response = await fetch(url);
        data = await response.text();
    } catch (err) {
        msg.reply(err);
        return;
    }

    /* Pull out the response json */
    const regex = /<script nonce=".*">var ytInitialData = ({.*});<\/script>/;

    const [, jsonStr ] = regex.exec(data) || [];

    if (!jsonStr) {
        console.error(data);
        msg.reply('Failed to extract youtube results from HTML!');
        return;
    }

    let json = {} as any;

    try {
        json = JSON.parse(jsonStr);
    } catch (err) {
        console.error(err);
        msg.reply('Failed to extract youtube results from HTML!');
        return;
    }

    const videoData = json
        .contents
        .twoColumnSearchResultsRenderer
        .primaryContents
        .sectionListRenderer
        .contents[0]
        .itemSectionRenderer
        .contents;

    console.log(videoData);

    const videos = videoData.filter((x: any) => x.videoRenderer).map((x: any) => {
        return {
            url: `https://www.youtube.com/watch?v=${x.videoRenderer.videoId}`,
        }
    });

    if (videos.length === 0) {
        msg.reply('No results found!');
        return;
    }

    return videos;
}

export async function handleYoutubeApi(msg: Message, args: string): Promise<undefined | any[]> {
    if (args.trim() === '') {
        msg.reply('No query given');
        return;
    }

    const params = {
        q: args,
        part: 'snippet',
        key: config.youtubeApiKey,
        maxResults: 50,
        type: 'video',
        regionCode: 'US',
        relevanceLanguage: 'en',
        safeSearch: 'none',
    };

    const url = `https://youtube.googleapis.com/youtube/v3/search/?${stringify(params)}`;

    let data: any;

    try {
        const response = await fetch(url);
        data = await response.json();
    } catch (err) {
        msg.reply(err);
        return;
    }

    const videos = data.items.map((x: any) => {
        return {
            url: `https://www.youtube.com/watch?v=${x.id.videoId}`,
        }
    });

    if (videos.length === 0) {
        msg.reply('No results found!');
        return;
    }

    return videos;
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
            AND expire_time > STRFTIME('%Y-%m-%d %H:%M:%S', 'NOW')
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

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 7,
        displayFunction: (timer: any) => {
            const fields = [];

            fields.push({
                name: `ID: ${timer.id}`,
                value: timer.message || 'N/A',
                inline: true,
            });

            fields.push(
                {
                    name: 'Time',
                    value: `${capitalize(moment(timer.expire_time).fromNow())}, ${moment(timer.expire_time).utcOffset(-6).format('HH:mm')} CST`,

                    inline: true,
                },
                {
                    name: 'Requester',
                    value: getUsername(timer.user_id, msg.guild),
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

async function deleteTimer(msg: Message, args: string[], db: Database) {
    if (args.length === 0) {
        msg.reply('No timer ID given');
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
        msg.reply(`Successfully deleted timer #${args[0]}.`);
    } else {
        msg.reply(`Failed to delete, unknown ID or not your timer.`);
    }
}
