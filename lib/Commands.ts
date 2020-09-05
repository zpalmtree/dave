import * as fs from 'fs';
import * as path from 'path';
import * as moment from 'moment';
import * as convert from 'xml-js';

import request = require('request-promise-native');
import translate = require('@vitalets/google-translate-api');

import { stringify } from 'querystring';

import {
    Message,
    Client,
    TextChannel,
    User,
    MessageEmbed,
    MessageAttachment
} from 'discord.js';

import { promisify } from 'util';
import { evaluate } from 'mathjs';


import { config } from './Config';
import { catBreeds } from './Cats';
import { dogBreeds } from './Dogs';
import { fortunes } from './Fortunes';
import { dubTypes } from './Dubs';
import { handleWatchHelp } from './Help';

import {
    renderDotGraph,
    renderDot,
} from './Dot';

import {
    readJSON,
    writeJSON,
    addReaction,
    chunk,
    capitalize,
    sleep,
    haveRole,
} from './Utilities';

import {
    TimeUnits,
    Quote,
    ScheduledWatch
} from './Types';

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
    var fortune = fortunes[Math.floor(Math.random() * fortunes.length)];

    msg.reply(`Your fortune: ${fortune}`);
}

export function handleMath(msg: Message, args: string): void {
    const niggers: string[] = [];

    if (niggers.includes(msg.author.id)) {
        msg.reply('FUCK YOU YOU STUPID NIGGER');
        return;
    }

    if (args.includes('isPrime')) {
        msg.reply(Math.random() < 0.5 ? 'true' : 'false');
        return;
    }

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
        const firstNum: number = Number(initial);
        const secondNum: number = Number(roll[1]);

        if (Math.max(firstNum + 1, 0) % 10 === secondNum ||
            Math.max(firstNum - 1, 0) % 10 === secondNum) {
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

export async function handleQuote(msg: Message): Promise<void> {
    const { err, data: quotes } = await readJSON<Quote>('./quotes.json');

    if (err) {
        msg.reply(`Failed to read quotes :( [ ${err.toString()} ]`);
        return;
    }

    const { quote, timestamp } = quotes[Math.floor(Math.random() * quotes.length)];

    if (timestamp !== 0) {
        msg.channel.send(`${quote} - ${new Date(timestamp).toISOString().slice(0, 10)}`);
    } else {
        msg.channel.send(quote);
    }
}

export async function handleSuggest(msg: Message, suggestion: string | undefined): Promise<void> {
    if (!suggestion || suggestion.length <= 1) {
        msg.reply('Enter a fucking suggestion you wank stain');
        return;
    }

    const { err, data: quotes } = await readJSON<Quote>('./quotes.json');

    if (err) {
        msg.reply(`Failed to read quotes :( [ ${err.toString()} ]`);
        return;
    }

    const newQuote: Quote = {
        quote: suggestion,
        timestamp: Date.now(),
    };

    quotes.push(newQuote);

    await writeJSON('quotes.json', quotes);

    addReaction('579921155578658837', msg);
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
        const data = await request({
            method: 'GET',
            timeout: 10 * 1000,
            url,
            json: true,
        });

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
        const data = await request({
            method: 'GET',
            timeout: 10 * 1000,
            url,
            json: true,
        });

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
        const data = await request({
            method: 'GET',
            timeout: 10 * 1000,
            url: host + '/v2/all',
            json: true,
        });

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
        const countryData = await request({
            method: 'GET',
            timeout: 10 * 1000,
            url: `${host}/v2/countries/${country}`,
            json: true,
        });

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
        const data = await request({
            method: 'GET',
            timeout: 10 * 1000,
            url: `${host}/v2/states`,
            json: true,
        });

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
        const data = await request({
            method: 'GET',
            timeout: 10 * 1000,
            url: host + '/v2/countries',
            json: true,
        });

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
    let currentDotValue = 0;
    let dot;

    try {
        [ [ , dotGraph ], [ currentDotValue, dot ] ] = await Promise.all([
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

    const embed = new MessageEmbed()
        .setColor('#C8102E')
        .attachFiles([dotAttachment, dotGraphAttachment])
        .setTitle('Global Consciousness Project Dot')
        .setThumbnail('attachment://dot.png')
        .setImage('attachment://dot-graph.png')
        .addFields(
            {
                name: 'Network Variance',
                value: `${Math.floor(currentDotValue * 100)}%`,
                inline: true
            },
            {
                name: 'Timespan',
                value: timeString.toString().replace(/^0+/, ''),
                inline: true
            },
            {
                name: 'Description',
                value: description,
                inline: false
            }
        );

    msg.channel.send(embed);
}


export async function handleImgur(gallery: string, msg: Message): Promise<void> {
    try {
        // seems to loop around to page 0 if given a page > final page
        const finalPage = ({
            'r/pizza': 9,
            'r/turtle': 7,
        } as any)[gallery];

        const index = Math.floor(Math.random() * (finalPage + 1));
        const data = await request({
            method: 'GET',
            timeout: 10 * 1000,
            url: `https://api.imgur.com/3/gallery/${gallery}/top/all/${index}`,
            json: true,
            headers: {
                'Authorization': 'Client-ID de8a61d6a484c39',
            }
        });

        const images = data.data.filter((img: any) => img.size > 0);

        const image = images[Math.floor(Math.random() * images.length)];

        if (image == undefined) {
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
        } else {
            embed.setFooter(url);
        }

        msg.channel.send(embed);
    } catch (err) {
        msg.reply(`Failed to get ${gallery} pic :( [ ${err.toString()} ]`);
    }
}

async function readWatchJSON(update: boolean = false): Promise<{ err: string | undefined, data: ScheduledWatch[] }> {
    let { err, data } = await readJSON<ScheduledWatch>('watch.json');

    if (err) {
        return {
            err,
            data: [],
        };
    }

    const newData = data.map((watch) => {
        /* Has more than 3 hours passed since the scheduled watch time? */
        watch.complete = !moment(watch.time).add(3, 'hours').isAfter(moment());
        return watch;
    });

    if (update) {
        writeJSON('watch.json', newData);
    }

    return {
        err: undefined,
        data: newData
    };
}

async function displayScheduledWatches(msg: Message): Promise<void> {
    let { err, data } = await readWatchJSON(true);

    if (err) {
        msg.reply(`Failed to read watch list :( [ ${err.toString()} ]`);
        return;
    }

    data = data.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

    if (data.length === 0) {
        msg.reply('Nothing has been scheduled to be watched yet! Use `$watch help` for more info');
        return;
    }

    const embed = new MessageEmbed()
        .setTitle('Scheduled Movies/Series To Watch')
        .setFooter('Use $watch <movie id> to view more info and sign up to watch');

    for (const watch of data) {
        if (watch.complete) {
            continue;
        }

        embed.addFields(
            {
                name: `ID: ${watch.id}`,
                value: `[${watch.title}](${watch.link})`,
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
                value: watch.attending.map((user) => {
                    const userObj = msg.guild!.members.cache.get(user)

                    if (userObj !== undefined) {
                        return userObj.displayName;
                    }

                    return `Unknown User <@${user}>`;
                }).join(', '),
                inline: true,
            },
        );
    }

    msg.channel.send(embed);
}

async function displayAllWatches(msg: Message): Promise<void> {
    let { err, data } = await readWatchJSON(true);

    if (err) {
        msg.reply(`Failed to read watch list :( [ ${err.toString()} ]`);
        return;
    }

    data = data.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

    if (data.length === 0) {
        msg.reply('Nothing has been watched before!');
        return;
    }

    const embed = new MessageEmbed()
        .setTitle('Previously Watched Movies/Series');

    for (const watch of data) {
        if (!watch.complete) {
            continue;
        }

        embed.addFields(
            {
                name: moment(watch.time).utcOffset(-6).format('YYYY/MM/DD'),
                value: `[${watch.title}](${watch.link})`,
                inline: false,
            },
        );
    }

    msg.channel.send(embed);
}

async function addMagnet(msg: Message, args: string[]): Promise<void> {
    if (args.length < 2) {
        handleWatchHelp(msg, 'Sorry, your input was invalid. Please try one of the following options.');
        return;
    }

    const id = Number(args[0]);

    if (Number.isNaN(id)) {
        handleWatchHelp(msg, 'Sorry, your input was invalid. Please try one of the following options.');
        return;
    }

    if (!/magnet:\?.+/.test(args[1])) {
        handleWatchHelp(msg, 'Input does not look like a magnet link. Please try one of the following options.');
        return;
    }

    const watch = await updateWatchById(Number(id), {
        magnet: args[1],
    });

    if (typeof watch === 'string') {
        msg.reply(watch);
    } else {
        msg.reply(`Successfully added/updated magnet for ${watch.title}`);
    }
}

async function updateTime(msg: Message, args: string[]): Promise<void> {
    const regex = /(\d+) (\d\d\d\d\/\d\d?\/\d\d? \d?\d:\d\d(?: ?[+-]\d\d?:?\d\d))/;

    const results = regex.exec(args.join(' '));

    if (results) {
        const [ , id, time ] = results;

        if (!moment(time, 'YYYY/MM/DD hh:mm ZZ').isValid()) {
            msg.reply(`Failed to parse date/time "${time}"`);
            return;
        }

        const watch = await updateWatchById(Number(id), {
            time: moment(time, 'YYYY/MM/DD hh:mm ZZ'),
        });

        if (typeof watch === 'string') {
            msg.reply(watch);
        } else {
            msg.reply(`Successfully updated time for ${watch.title}`);
        }
    } else {
        handleWatchHelp(msg, 'Sorry, your input was invalid. Please try one of the following options.');
    }
}

async function getWatchById(id: number): Promise<{ data: ScheduledWatch[], index: number } | string> {
    let { err, data } = await readWatchJSON();

    if (err) {
        return `Failed to read watch list: ${err.toString()}`;
    }

    const index = data.findIndex((watch) => watch.id === id);

    if (index === -1) {
        return `Could not find movie ID "${id}".`;
    }

    return {
        data,
        index,
    };
}

async function updateWatchById(id: number, fields: any): Promise<string | ScheduledWatch> {
    const watch = await getWatchById(id);

    if (typeof watch === 'string') {
        return watch;
    }

    const newWatch = {
        ...watch.data[watch.index],
        ...fields,
    };

    watch.data[watch.index] = newWatch;

    writeJSON('watch.json', watch.data);

    return newWatch;
}

async function deleteWatch(msg: Message, args: string[]): Promise<void> {
    if (args.length === 0) {
        handleWatchHelp(msg, 'Sorry, your input was invalid. Please try one of the following options.');
        return;
    }

    const id = Number(args[0]);

    if (Number.isNaN(id)) {
        handleWatchHelp(msg, 'Sorry, your input was invalid. Please try one of the following options.');
        return;
    }

    const watch = await getWatchById(id);

    if (typeof watch === 'string') {
        msg.reply(watch);
        return;
    }

    const movie = watch.data[watch.index];

    const areOnlyAttendee = movie.attending.length === 1 && movie.attending[0] === msg.author.id;

    if (!areOnlyAttendee && !haveRole(msg, 'Mod')) {
        msg.reply('You must be the only watch attendee, or be a mod, to remove a movie');
        return;
    }

    const title = movie.title;

    /* Remove watch */
    watch.data.splice(watch.index, 1);

    writeJSON('watch.json', watch.data);

    msg.reply(`Successfully deleted scheduled watch ${title}`);
}

async function removeWatchById(id: number): Promise<string> {
    const watch = await getWatchById(id);

    if (typeof watch === 'string') {
        return watch;
    }

    const title = watch.data[watch.index].title;

    /* Remove watch */
    watch.data.splice(watch.index, 1);

    writeJSON('watch.json', watch.data);

    return `Successfully deleted scheduled watch ${title}`;
}

async function displayWatchById(msg: Message, id: number): Promise<void> {
    const watchData = await getWatchById(Number(id));

    if (typeof watchData === 'string') {
        msg.reply(watchData);
        return;
    }

    const watch = watchData.data[watchData.index];

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
        {
            name: 'IMDB Link',
            value: watch.link,
        },
    );

    if (watch.magnet) {
        embed.addField('Magnet', watch.magnet);
    }

    const sentMessage = await msg.channel.send(embed);

    awaitWatchReactions(sentMessage, watch.title, id, new Set(watch.attending), 1);
}

export async function scheduleWatch(msg: Message, title: string, imdbLink: string, time: string, magnet?: string) {
    let { err, data } = await readWatchJSON();

    if (err) {
        msg.reply(`Failed to read watch list :( [ ${err.toString()} ]`);
        return;
    }

    const maxID = data.map((x) => x.id).sort((a, b) => b - a)[0] || 0;

    data.push({
        id: maxID + 1,
        title,
        link: imdbLink,
        time: moment(time, 'YYYY/MM/DD hh:mm ZZ').toDate(),
        attending: [msg.author.id],
        magnet,
        complete: false,
    });

    writeJSON('watch.json', data);

    const embed = new MessageEmbed()
        .setTitle(title)
        .setDescription(`${title} has been successfully scheduled for ${moment(time, 'YYYY/MM/DD hh:mm ZZ').utcOffset(-6).format('dddd, MMMM Do, HH:mm')} CST!`)
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

    awaitWatchReactions(sentMessage, title, maxID + 1, new Set([msg.author.id]), 0);
}

async function awaitWatchReactions(
    msg: Message,
    title: string,
    id: number,
    attending: Set<string>,
    attendingFieldIndex: number) {

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
            const watchDeletionResponse = await removeWatchById(id);
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

        msg.edit(embed);

        const err = await updateWatchById(id, {
            attending: [...attending],
        });

        if (typeof err === 'string') {
            msg.reply(err);
        }
    });
}

export async function handleWatch(msg: Message, args: string[]): Promise<void> {
    /* No args, display scheduled things to watch */
    if (args.length === 0) {
        await displayScheduledWatches(msg);
        return;
    }

    if (args.length >= 1) {
        switch (args[0]) {
            case 'history': {
                displayAllWatches(msg);
                return;
            }
            case 'addmagnet': {
                addMagnet(msg, args.slice(1));
                return;
            }
            case 'delete': {
                deleteWatch(msg, args.slice(1));
                return;
            }
            case 'updatetime': {
                updateTime(msg, args.slice(1));
                return;
            }
        }
    }

    if (args.length === 1) {
        displayWatchById(msg, Number(args[0]));
        return;
    }

    const regex = /(.+) (https:\/\/.*imdb\.com\/\S+) (\d\d\d\d\/\d\d?\/\d\d? \d?\d:\d\d(?: ?[+-]\d\d?:?\d\d)) ?(magnet:\?.+)?/;

    const results = regex.exec(args.join(' '));

    if (results) {
        const [ , title, imdbLink, time, magnet ] = results;

        if (!moment(time, 'YYYY/MM/DD hh:mm ZZ').isValid()) {
            msg.reply(`Failed to parse date/time "${time}"`);
            return;
        }

        await scheduleWatch(msg, title, imdbLink, time, magnet);
        return;
    }

    handleWatchHelp(msg, 'Sorry, your input was invalid. Please try one of the following options.');
}

export function handleTime(msg: Message, args: string) {
    let offset: string | number = 0;

    if (args.length > 0) {
        offset = args;
    }

    msg.reply(`The current time is ${moment().utcOffset(offset).format('HH:mm Z')}`);
}

export async function handleTimer(msg: Message, args: string[]) {
    const regex = /^(?:([0-9\.]+)h)?(?:([0-9\.]+)m)?(?:([0-9\.]+)s)?(?: (.+))?$/;

    const results = regex.exec(args.join(' '));

    if (!results) {
        msg.reply('Failed to parse input, try `$timer 5m coffee` or `$timer 5h10m`. Max 24h timers.');
        return;
    }

    const [, hours=0, minutes=0, seconds=0, description ] = results;

    const totalTimeSeconds = Number(seconds)
                           + Number(minutes) * 60
                           + Number(hours) * 60;

    if (totalTimeSeconds > 60 * 60 * 24) {
        msg.reply('Timers longer than 24 hours are not supported.');
        return;
    }

    setTimeout(() => {
        if (description) {
            msg.reply(`Your ${description} timer has elapsed.`);
        } else {
            msg.reply(`Your timer has elapsed.`);
        }
    }, totalTimeSeconds * 1000);

    await msg.react('👍');
}

export async function handleCountdown(msg: Message, args: string) {
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
            ? 'Lets jam!'
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

export async function handleTranslate(msg: Message, args: string): Promise<void> {
    try {
        const res = await translate(args, {
            to: 'en',
            client: 'gtx',
        });

        const embed = new MessageEmbed()
            .setDescription(`${translate.languages[res.from.language.iso as any]} to English`)
            .setTitle(res.text);

        if (res.from.text.value !== '') {
            embed.setFooter(`Did you mean "${res.from.text.value}"?`);
        }

        msg.channel.send(embed);

    } catch (err) {
        msg.reply(`Failed to translate: ${err}`);
    }
}
