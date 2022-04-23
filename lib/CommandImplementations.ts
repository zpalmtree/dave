import * as fs from 'fs';
import * as path from 'path';
import moment from 'moment';

import translate from '@vitalets/google-translate-api';

import fetch from 'node-fetch';

import imageminGifsicle from 'imagemin-gifsicle';
import TextOnGif from 'text-on-gif';

import { stringify, unescape } from 'querystring';
import { evaluate } from 'mathjs';
import he from 'he';
import { Database } from 'sqlite3';

import {
    Message,
    Client,
    TextChannel,
    User,
    MessageEmbed,
    MessageAttachment,
    GuildMember,
    ColorResolvable,
    Util,
} from 'discord.js';

import {
    parse,
    HTMLElement
} from 'node-html-parser';

import { config } from './Config.js';
import { catBreeds } from './Cats.js';
import { dogBreeds } from './Dogs.js';
import { fortunes } from './Fortunes.js';
import { dubTypes } from './Dubs.js';

import {
    chunk,
    capitalize,
    sleep,
    haveRole,
    pickRandomItem,
    canAccessCommand,
    getUsername,
    shuffleArray,
    formatLargeNumber,
    roundToNPlaces,
    numberWithCommas,
    tryDeleteMessage,
    tryDeleteReaction,
    tryReactMessage,
} from './Utilities.js';

import {
    insertQuery,
    selectQuery,
    selectOneQuery,
    deleteQuery,
} from './Database.js';

import {
    TimeUnits,
    Quote,
    ScheduledWatch,
    Command,
} from './Types.js';

import {
    exchangeService
} from './Exchange.js';

import {
    getWatchDetailsById,
} from './Watch.js';

import {
    Paginate,
    DisplayType,
    ModifyMessage,
} from './Paginate.js';

import {
    Commands,
} from './CommandDeclarations.js';

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

export async function handleFortune(msg: Message): Promise<void> {
    await msg.reply(`Your fortune: ${pickRandomItem(fortunes)}`);
}

export async function handleMath(msg: Message, args: string): Promise<void> {
    if (args === '') {
        await msg.reply(`Invalid input, try \`${config.prefix}help math\``);
        return;
    }

    try {
        await msg.reply(evaluate(args).toString());
    } catch (err) {
        await msg.reply('Bad mathematical expression: ' + err.toString());
    }
}

/* Rolls the die given. E.g. diceRoll(6) gives a number from 1-6 */
function diceRoll(die: number): number {
    return Math.ceil(Math.random() * die);
}

export async function handleDiceRoll(msg: Message, args: string): Promise<void> {
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
        await msg.reply("Can't roll more than 100 dice!");
        return;
    }

    if (dieStr === undefined || Number.isNaN(numDice) || Number.isNaN(die)) {
        await msg.reply(badRoll);
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
            await msg.reply('Bad mathematical expression: ' + err.toString());
            return;
        }
    }

    if (numDice !== 1 || mathExpression !== undefined) {
        response += ' = ' + result.toString();
    }

    await msg.reply(response);
}

export async function handleRoll(msg: Message, args: string): Promise<void> {
    if (haveRole(msg, 'Baby Boy')) {
        await msg.reply('little bitches are NOT allowed to use the roll bot. Obey the rolls, faggot!');
        return;
    }

    args = args.trim();

    /* Is it a dice roll - d + number, for example, d20, 5d20, d6 + 3 */
    if (/d\d/.test(args)) {
        await handleDiceRoll(msg, args);
        return;
    }

    const dubsReaction: string = dubsType(msg.id);
    await msg.reply(`Your post number is: ${msg.id} ${dubsReaction}`);
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

export async function handlePrice(msg: Message) {
    const currencies = config.coins;
    const toFetch = currencies.map((c) => c.id).join('%2C');

    const lookupMap = new Map(currencies.map(({ id, label }) => [id, label]));

    try {
        const data = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${toFetch}&vs_currencies=usd&include_market_cap=true&include_24hr_change=true`)
        if (data.status === 200) {
            const values = await data.json();
            const prices = Object.keys(values).map((key) => {
                return {
                    name: lookupMap.get(key),
                    ...values[key]
                }
            }).sort((a, b) => {
                return b.usd_market_cap - a.usd_market_cap;
            });
    
            const embed = new MessageEmbed();
            for (const price of prices) {
                embed.addField(capitalize(price.name), `$${numberWithCommas(price.usd.toString())} (${roundToNPlaces(price.usd_24h_change, 2)}%)`, true);
            }
    
            msg.channel.send({
                embeds: [embed],
            });
        } else {
            throw new Error("Fetch threw an exception")
        }
    } catch(err) {
        await msg.reply(`Failed to get data: ${err.toString()}`);
    }
}

export async function handleQuote(msg: Message, db: Database): Promise<void> {
    const { quote, timestamp } = await selectOneQuery(
        `SELECT
            quote,
            timestamp
        FROM
            quote
        WHERE
            channel_id = ?
        ORDER BY RANDOM()
        LIMIT 1`,
        db,
        [ msg.channel.id ],
    ) || {};

    if (!quote) {
        await msg.reply(`No quotes in the database! Use ${config.prefix}addquote to suggest one.`);
        return;
    }

    if (timestamp) {
        await msg.channel.send(`${quote} - ${moment.utc(timestamp).format('YYYY-MM-DD')}`);
    } else {
        await msg.channel.send(quote);
    }
}

export async function handleSuggest(msg: Message, suggestion: string, db: Database): Promise<void> {
    if (!suggestion || suggestion.length <= 1) {
        await msg.reply('Please enter a suggestion.');
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

    await tryReactMessage(msg, '👍');
}

export async function handleKitty(msg: Message, args: string): Promise<void> {
    const breed: string = args.trim().toLowerCase();

    const breedId = catBreeds.find((x) => x.name.toLowerCase() === breed);

    if (breed !== '' && breedId === undefined) {
        await msg.reply(`Unknown breed. Available breeds: <${config.kittyBreedLink}>`);
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
            await msg.reply(`Failed to get kitty pic :( [ ${JSON.stringify(data)} ]`);
            return;
        }

        const attachment = new MessageAttachment(data[0].url);

        await msg.channel.send({
            files: [attachment],
        });
    } catch (err) {
        await msg.reply(`Failed to get kitty pic :( [ ${err.toString()} ]`);
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
            await msg.reply(`Unknown breed. Available breeds: <${config.doggoBreedLink}>`);
        }
    }

    if (mainBreed !== '' && y) {
        if (dogBreeds[mainBreed].includes(x)) {
            subBreed = x;
        } else if (dogBreeds[mainBreed].includes(y)) {
            subBreed = y;
        } else {
            await msg.reply(`Unknown breed. Available breeds: <${config.doggoBreedLink}>`);
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
            await msg.reply(`Failed to get doggo pic :( [ ${JSON.stringify(data)} ]`);
            return;
        }

        const attachment = new MessageAttachment(data.message);

        await msg.channel.send({
            files: [attachment],
        });
    } catch (err) {
        await msg.reply(`Failed to get data: ${err.toString()}`);
    }
}

function formatChinkedData(data: any, location?: string): MessageEmbed {
    /* Alias for conciseness */
    const f = formatLargeNumber;

    const title = location
        ? `Coronavirus statistics, ${location}`
        : 'Coronavirus statistics';

    const embed = new MessageEmbed()
        .setColor('#C8102E')
        .setTitle(title)
        .setThumbnail('https://i.imgur.com/FnbQwqQ.png')
        .addFields(
            {
                name: 'Cases',
                value: `${f(data.cases)} (+${f(data.todayCases)})`,
                inline: true,
            },
            {
                name: 'Deaths',
                value: `${f(data.deaths)} (+${f(data.todayDeaths)})`,
                inline: true,
            },
            {
                name: 'Active',
                value: f(data.active),
                inline: true,
            },
            {
                name: 'Recovered',
                value: f(data.recovered),
                inline: true,
            },
            {
                name: 'Percentage Infected',
                value: (100 * (data.casesPerOneMillion / 1_000_000)).toFixed(2) + '%',
                inline: true,
            },
            {
                name: 'Last Updated',
                value: moment.utc(data.updated).fromNow(),
                inline: true,
            },
        );

    return embed;
}

function formatVaccineData(data: any, population: number, embed: MessageEmbed) {
    /* No vaccine data */
    if (!data || data.message) {
        embed.addFields(
            {
                name: 'Vaccinations',
                value: '0',
                inline: true,
            },
            {
                name: 'Doses/100 people',
                value: '0',
                inline: true,
            },
            {
                name: 'Approx Vaccinated',
                value: '0%',
                inline: true,
            },
        );

        return;
    }
    
    const [yesterday, today] = Object.values(data);

    const change = today - yesterday;

    const dosesPer100 = (100 * (today / population));

    const percentageVaccinated = `${roundToNPlaces(dosesPer100 / 2, 2)}% - ${roundToNPlaces(Math.min(dosesPer100 * 0.95, 100), 2)}%`;

    /* Alias for conciseness */
    const f = formatLargeNumber;

    embed.addFields(
        {
            name: 'Vaccinations',
            value: `${f(today)} (+${f(change)})`,
            inline: true,
        },
        {
            name: 'Doses/100 people',
            value: dosesPer100.toFixed(2),
            inline: true,
        },
        {
            name: 'Approx Vaccinated',
            value: percentageVaccinated,
            inline: true,
        },
    );
}

export async function handleStock(msg: Message, args: string[]) {
    if (args.length === 0) {
        await msg.channel.send(`You need to include a ticker. Example: \`${config.prefix}stock IBM\``);
        return;
    }

    const [ ticker ] = args;

    const res = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(ticker.toUpperCase())}&apikey=${config.stockApiKey}`);

    if (res.status === 200) {
        const stockData = await res.json();

        if (Object.entries(stockData['Global Quote']).length === 0) {
            await msg.channel.send("No ticker " + ticker.toUpperCase());
            return;
        }

        const f = (s: string) => numberWithCommas(String(roundToNPlaces(Number(s), 2)))

        const embed = new MessageEmbed()
        .setColor(Number(stockData['Global Quote']['09. change']) < 0 ? '#C8102E' : '#00853D')
        .setTitle(ticker.toUpperCase())
        .addFields(
            {
                name: 'Price',
                value: `$${f(stockData['Global Quote']['05. price'])}`,
                inline: true,
            },
            {
                name: 'Change',
                value: `${f(stockData['Global Quote']['10. change percent'].replace("%", ""))}%`,
                inline: true,
            },
            {
                name: 'Volume',
                value: `${f(stockData['Global Quote']['06. volume'])}`,
                inline: true,
            },
            {
                name: 'Open',
                value: `$${f(stockData['Global Quote']['02. open'])}`,
                inline: true,
            },
            {
                name: 'Low',
                value: `$${f(stockData['Global Quote']['04. low'])}`,
                inline: true,
            },
            {
                name: 'High',
                value: `$${f(stockData['Global Quote']['03. high'])}`,
                inline: true,
            },
        );
    
    
        await msg.channel.send({
            embeds: [embed],
        });
    } else {
        await msg.channel.send("Something went wrong fetching stock info for " + ticker.toUpperCase());
    }
}

async function getChinkedWorldData(msg: Message): Promise<void> {
    try {
        /* Launch the two requests in parallel */
        const worldPromise = fetch('https://disease.sh/v3/covid-19/all');
        const vaccinePromise = fetch(`https://disease.sh/v3/covid-19/vaccine/coverage?lastdays=2`);

        /* Wait for the request to complete as we need this data to proceed. */
        const worldResponse = await worldPromise;
        const worldData = await worldResponse.json();

        const embed = formatChinkedData(worldData);

        const vaccineResponse = await vaccinePromise;
        const vaccineData = await vaccineResponse.json();

        formatVaccineData(vaccineData, worldData.population, embed);

        await msg.channel.send({
            embeds: [embed],
        });

    } catch (err) {
        await msg.reply(`Failed to get data: ${err.toString()}`);
    }
}

async function getChinkedCountryData(msg: Message, country: string): Promise<void> {
    try {
        /* Launch the two requests in parallel */
        const countryPromise = fetch(`https://disease.sh/v3/covid-19/countries/${country}`);
        const vaccinePromise = fetch(`https://disease.sh/v3/covid-19/vaccine/coverage/countries/${country}?lastdays=2`);

        /* Wait for the country request to complete as we need this data to proceed. */
        const countryResponse = await countryPromise;
        const countryData = await countryResponse.json();

        if (countryData.message) {
            await msg.reply(`Unknown country "${country}", run \`${config.prefix}chinked countries\` to list all countries and \`${config.prefix}chinked states\` to list all states.`);
            return;
        }

        const embed = formatChinkedData(countryData, countryData.country);
        embed.setThumbnail(countryData.countryInfo.flag);

        const vaccineResponse = await vaccinePromise;
        const vaccineData = await vaccineResponse.json();

        formatVaccineData(vaccineData.timeline, countryData.population, embed);

        await msg.channel.send({
            embeds: [embed],
        });
    } catch (err) {
        await msg.reply(`Failed to get data: ${err.toString()}`);
    }
}

async function getChinkedStateData(msg: Message, state: string): Promise<void> {
    try {
        const response = await fetch(`https://disease.sh/v3/covid-19/states/${state}`);

        const data = await response.json();

        const embed = formatChinkedData(data, data.state);

        await msg.channel.send({
            embeds: [embed],
        });
    } catch (err) {
        if (err.statusCode === 404) {
            await msg.reply(`Unknown state "${state}", run \`${config.prefix}chinked countries\` to list all countries and \`${config.prefix}chinked states\` to list all states.`);
        } else {
            await msg.reply(`Failed to get data: ${err.toString()}`);
        }
    }
}

async function getChinkedCountries(msg: Message): Promise<void> {
    try {
        const response = await fetch('https://disease.sh/v3/covid-19/countries');

        const data = await response.json();

        const countries = 'Known countries/areas: ' + data.map((x: any) => x.country).sort((a: string, b: string) => a.localeCompare(b)).join(', ');

        /* Discord message limit */
        if (countries.length > 2000) {
            /* This splits in the middle of words, but we don't give a shit */
            for (const message of chunk(countries, 1700)) {
                await msg.channel.send(message);
            }
        } else {
            await msg.reply(countries);
        }
    } catch (err) {
        await msg.reply(`Failed to get data: ${err.toString()}`);
    }
}

async function getChinkedStates(msg: Message): Promise<void> {
    const stateData = 'Known states: ' + states.sort((a: string, b: string) => a.localeCompare(b)).join(', ');

    if (stateData.length > 2000) {
        for (const message of chunk(stateData, 1700)) {
            await msg.channel.send(message);
        }
    } else {
        await msg.reply(stateData);
    }
}

export async function handleChinked(msg: Message, country: string): Promise<void> {
    country = country.trim().toLowerCase();

    switch(country) {
        case '': {
            await getChinkedWorldData(msg);
            break;
        }
        case 'countries': {
            await getChinkedCountries(msg);
            break;
        }
        case 'states': {
            await getChinkedStates(msg);
            break;
        }
        default: {
            if (states.map((x) => x.toLowerCase()).includes(country)) {
                await getChinkedStateData(msg, country);
            } else {
                await getChinkedCountryData(msg, country);
            }

            break;
        }
    }
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
                'Authorization': `Client-ID ${config.imgurClientId}`,
            },
        });

        const data = await response.json();

        const images = data.data.filter((img: any) => img.size > 0 && !img.is_album && img.link.startsWith('https://'));

        shuffleArray(images);

        const embed = new MessageEmbed();

        const pages = new Paginate({
            sourceMessage: msg,
            embed,
            data: images,
            displayType: DisplayType.EmbedData,
            displayFunction: (item: any, embed: MessageEmbed) => {
                embed.setTitle(item.title);
                embed.setImage(item.link);
            }
        })

        await pages.sendMessage();
    } catch (err) {
        await msg.reply(`Failed to get ${gallery} pic :( [ ${err.toString()} ]`);
    }
}

export async function handleTime(msg: Message, args: string) {
    let offset: string | number = 0;

    if (args.length > 0) {
        offset = args;
    }

    await msg.reply(`The current time is ${moment.utc().utcOffset(offset).format('HH:mm Z')}`);
}

export async function handleDate(msg: Message, args: string) {
    let offset: string | number = 0;

    if (args.length > 0) {
        offset = args;
    }

    await msg.reply(`The current date is ${moment.utc().utcOffset(offset).format('dddd, MMMM Do YYYY')}`);
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
        await msg.reply(`Invalid input, try \`${config.prefix}help countdown\``);
        return;
    }

    if (secs > 120) {
        await msg.reply('Countdowns longer than 120 are not supported.');
        return;
    }

    if (secs < 1) {
        await msg.reply('Countdowns less than 1 are not supported.');
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

        await sentMessage.edit(message);
    }
}

export async function handlePurge(msg: Message) {
    const allowed = ['389071148421218330'];

    if (!haveRole(msg, 'Mod') && !allowed.includes(msg.author.id)) {
        await msg.reply('fuck off');
        return;
    }

    const embed = new MessageEmbed()
        .setTitle('Message Deletion')
        .setDescription('This will delete every single message you have made in this channel. Are you sure? The process will take several hours.')
        .setFooter('React with 👍 to confirm the deletion');

    const sentMessage = await msg.channel.send({
        embeds: [embed],
    });

    await tryReactMessage(sentMessage, '👍');

    const collector = sentMessage.createReactionCollector({
        filter: (reaction, user) => {
            return reaction.emoji.name === '👍' && user.id === msg.author.id
        },
        time: 60 * 15 * 1000,
    });

    let inProgress = false;

    collector.on('collect', async (reaction, user) => {
        tryDeleteReaction(reaction, user.id);

        if (inProgress) {
            return;
        }

        if (user.id !== msg.author.id) {
            return;
        }

        inProgress = true;

        embed.setDescription('Deletion started. You will be notified when it is complete.');
        sentMessage.edit({
            embeds: [embed],
        });

        let messages: Message[] = [];

        let i = 0;

        try {
            do {
                const firstMessage = messages.length === 0 ? undefined : messages[0].id;

                /* Fetch messages, convert to array and sort by timestamp, oldest first */
                messages = [...(await msg.channel.messages.fetch({ before: firstMessage })).values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

                for (const message of messages) {
                    if (message.author.id === msg.author.id) {
                        try {
                            await tryDeleteMessage(message);
                            console.log(`Deleted message ${i} for ${msg.author.id}`);
                        } catch (err) {
                            console.log(err);
                        }

                        i++;
                    }
                }
            } while (messages.length > 0);

            await msg.reply(`Message deletion complete.`);
        } catch (err) {
            console.log('err: ' + err.toString());
        }
    });
}

function getLanguage(x: string) {
    for (const key of Object.keys(translate.languages)) {
        if (typeof translate.languages[key] !== 'string') {
            continue;
        }

        if (translate.languages[key].toLowerCase() === x.toLowerCase()) {
            return key;
        }
    }

    return undefined;
}

async function handleTranslateImpl(
    msg: Message,
    toLanguage: string,
    fromLanguage: string | undefined,
    translateString: string) {

    try {
        const res = await translate(translateString, {
            to: toLanguage,
            from: fromLanguage,
            client: 'gtx',
        });

        const description = `${translate.languages[res.from.language.iso as any]} to ${translate.languages[toLanguage as any]}`;
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

        await msg.channel.send({
            embeds: [embed],
        });

    } catch (err) {
        await msg.reply(`Failed to translate: ${err}`);
    }
}

export async function handleTranslateFrom(msg: Message, args: string[]): Promise<void> {
    if (args.length < 2) {
        await msg.reply(`No language or translate string given. Try \`${config.prefix}help translatefrom\` to see available languages.`);
        return;
    }

    const fromLanguage = getLanguage(args[0]);
    let toLanguage = getLanguage(args[1]);

    if (fromLanguage === undefined) {
        await msg.reply(`Unknown language "${args[0]}". Try \`${config.prefix}help translatefrom\` to see available languages.`);
        return;
    }

    let translateString = args.slice(1).join(' ');

    if (toLanguage !== undefined) {
        translateString = args.slice(2).join(' ');
    } else {
        toLanguage = 'en';
    }

    await handleTranslateImpl(msg, toLanguage, fromLanguage, translateString);
}

export async function handleTranslate(msg: Message, args: string[]): Promise<void> {
    if (args.length === 0) {
        await msg.reply(`No translate string given. Try \`${config.prefix}help translatefrom\` to see available languages.`);
        return;
    }

    let toLanguage = getLanguage(args[0]);

    let translateString = args.join(' ');

    if (toLanguage !== undefined) {
        translateString = args.slice(1).join(' ');
    } else {
        toLanguage = 'en';
    }

    await handleTranslateImpl(msg, toLanguage, undefined, translateString);
}

async function getQueryResults(query: string): Promise<false | HTMLElement> {
    const params = {
        q: query,
        kl: 'us-en', // US location
        kp: 1, // safe search on
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

        const linkTitle = he.decode(linkNode.childNodes[0].text.trim());
        const link = he.decode(resultNode.querySelector('.result__url').childNodes[0].text.trim());
        const snippetNode = resultNode.querySelector('.result__snippet');

        /* sometimes we just have a url with no snippet */
        if (!snippetNode || !snippetNode.childNodes) {
            continue;
        }

        const snippet = snippetNode.childNodes.map((n) => he.decode(n.text)).join('');
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
        await msg.reply(data.Redirect);
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
        await msg.channel.send({
            embeds: [embed],
        });
    }
}

export async function handleQuery(msg: Message, args: string): Promise<void> {
    if (args.trim() === '') {
        await msg.reply('No query given');
        return;
    }

    try {
        /* Fire off both requests asynchronously */
        const instantAnswerPromise = getInstantAnswerResults(args);
        const queryPromise = getQueryResults(args);

        /* Wait for instant answer result to complete and use that if present */
        const data = await instantAnswerPromise;

        if (data) {
            await displayInstantAnswerResult(data, msg);
        } else {
            /* If not then use HTML scrape result */
            const html = await queryPromise;

            if (!html) {
                throw new Error();
            }

            await displayQueryResults(html, msg);
        }
    } catch (err) {
        await msg.reply(`Error getting query results: ${err.toString()}`);
    }
}

export async function handleExchange(msg: Message, args: string): Promise<void> {
    const regex = /(\d+(?:\.\d{1,2})?) ([A-Za-z]{3}) (?:[tT][oO] )?([A-Za-z]{3})/;

    const result = regex.exec(args);

    if (!result) {
        await msg.reply(`Failed to parse input. It should be in the form \`${config.prefix}exchange 100 ABC to XYZ\`. \`${config.prefix}help exchange\` to view currencies.`);
        return;
    }

    let [, amountToConvert, from, to ] = result;

    from = from.toUpperCase();
    to = to.toUpperCase();

    const asNum = Number(amountToConvert);

    if (Number.isNaN(asNum)) {
        await msg.reply(`Failed to parse amount: ${amountToConvert}`);
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
        await msg.reply(error as string);
        return;
    }

    const embed = new MessageEmbed()
        .setTitle(`${amountToConvert} ${fromCurrency} is ${roundToNPlaces(amount as number, 2)} ${toCurrency}`);

    await msg.channel.send({
        embeds: [embed],
    });
}

export async function handleAvatar(msg: Message): Promise<void> {
    const mentionedUsers = [...msg.mentions.users.values()];

    let user = msg.author;
    
    if (mentionedUsers.length > 0) {
        user = mentionedUsers[0];
    }

    if (msg.guild) {
        let guildUser = await msg.guild.members.fetch(user.id);

        if (guildUser) {
            await msg.channel.send(user.displayAvatarURL({
                format: 'png',
                dynamic: true,
                size: 4096,
            }));
        } else {
            await msg.channel.send(user.displayAvatarURL({
                format: 'png',
                dynamic: true,
                size: 4096,
            }));
        }
    } else {
        await msg.channel.send(user.displayAvatarURL({
            format: 'png',
            dynamic: true,
            size: 4096,
        }));
    }
}

export async function handleNikocado(msg: Message): Promise<void> {
    const nikocados = [
        "ORLINS BACK!",
        "Orlins leaving!",
        "I'm a vegan again!",
        "I sharted the bed!",
    ];

    await msg.reply(pickRandomItem(nikocados));
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

    await pages.sendMessage();
}

async function displayYoutube (this: Paginate<any>, items: any[], message: Message) {
    const footer = await this.getPageFooter();

    return `${items[0].url} - ${footer}`;
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

        if (/https:\/\/.*(?:youtube\.com|youtu\.be)\/\S+/.test(item.url)) {
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

    await pages.sendMessage();
}

export async function handleImageImpl(msg: Message, args: string, site?: string): Promise<undefined | any[]> {
    if (args.trim() === '') {
        await msg.reply('No query given');
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
        kp: 1, // safe search off
        kac: -1, // auto suggest off
        kav: 1, // load all results
    };

    const tokenOptions = {
        headers: {
            'cookie': 'p=-2',
        },
    };

    // gotta get our magic token to perform an image search
    const tokenURL = `https://safe.duckduckgo.com/?${stringify(tokenParams)}`;

    let data: any;

    try {
        const response = await fetch(tokenURL, tokenOptions);
        data = await response.text();
    } catch (err) {
        await msg.reply(err);
        return;
    }

    // gimme that token...
    const regex = /vqd='([\d-]+)'/gm;

    const [, token ] = regex.exec(data) || [ undefined, undefined ];

    if (!token) {
        await msg.reply('Failed to get token!');
        return;
    }

    const imageParams = {
        q: query,
        l: 'us-en', // US location
        ac: -1, // auto suggest off
        av: 1, // load all results
        p: 1,  // safe search off - for some reason this needs to be -1, not -2, not sure why
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

    const imageURL = `https://safe.duckduckgo.com/i.js?${stringify(imageParams)}`;

    let imageData: any;

    try {
        const response = await fetch(imageURL, options);
        imageData = await response.json();
    } catch (err) {
        await msg.reply(err);
        return;
    }

    if (!imageData.results || imageData.results.length === 0) {
        await msg.reply('No results found!');
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
        await msg.reply('No results found!');
        return;
    }

    return filtered;
}

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
            channel_id = ?
            AND user_id = ?
        GROUP BY
            command
        ORDER BY
            usage DESC`,
        db,
        [ msg.channel.id, user ]
    );

    if (commands.length === 0) {
        await msg.reply('User has never used the bot!');
        return;
    }

    const embed = new MessageEmbed()
        .setTitle(`${username}'s bot usage statistics`)
        .setDescription('Number of times a command has been used');

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 9,
        displayFunction: (command: any) => {
            return {
                name: command.command,
                value: command.usage,
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
            channel_id = ?
        GROUP BY
            user_id
        ORDER BY
            usage DESC`,
        db,
        [ msg.channel.id ]
    );

    const embed = new MessageEmbed()
        .setTitle('Bot user usage statistics')
        .setDescription('Number of times a user has used the bot');

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 9,
        displayFunction: async (user: any) => {
            return {
                name: await getUsername(user.user, msg.guild),
                value: user.usage,
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
            channel_id = ?
            AND command = ?
        GROUP BY
            user_id
        ORDER BY
            usage DESC`,
        db,
        [ msg.channel.id, command ]
    );

    const embed = new MessageEmbed()
        .setTitle(`Bot user usage statistics`)
        .setDescription(`Number of times a user has used \`${config.prefix}${command}\``);

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 9,
        displayFunction: async (user: any) => {
            return {
                name: await getUsername(user.user, msg.guild),
                value: user.usage,
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
            CAST(COUNT(*) AS TEXT) AS usage
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

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 9,
        displayFunction: (command: any) => {
            return {
                name: command.command,
                value: command.usage,
                inline: true,
            };
        },
        displayType: DisplayType.EmbedFieldData,
        data: commands,
        embed,
    });

    await pages.sendMessage();
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
        await msg.reply('No query given');
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
        await msg.reply(err);
        return;
    }

    const videos = data.items.map((x: any) => {
        return {
            url: `https://www.youtube.com/watch?v=${x.id.videoId}`,
        }
    });

    if (videos.length === 0) {
        await msg.reply('No results found!');
        return;
    }

    return videos;
}

export async function handleReady(msg: Message, args: string[], db: Database) {
    const notReadyUsers = new Set<string>([...msg.mentions.users.keys()]);
    const readyUsers = new Set<string>([]);

    let title = 'Are you ready?';

    if (args.length > 0) {
        const id = Number(args[0]);
        const watch = await getWatchDetailsById(id, msg.channel.id, db);

        if (watch) {
            title = `Are you ready for "${watch.title}"?`;

            for (const user of watch.attending) {
                if (msg.author.id !== user) {
                    notReadyUsers.add(user);
                }
            }
        }
    }

    /* They didn't mention anyone, lets make them unready so we can allow
     * sending the message */
    if (notReadyUsers.size === 0) {
        notReadyUsers.add(msg.author.id);
    /* If the user doesn't mention themselves and there are other attendents, make them ready automatically. */
    } else if (!notReadyUsers.has(msg.author.id)) {
        readyUsers.add(msg.author.id);
    }

    if (notReadyUsers.size === 0) {
        await msg.reply(`At least one user other than yourself must be mentioned or attending the movie ID. See \`${config.prefix}help ready\``);
        return;
    }

    const mention = Array.from(notReadyUsers).map((x) => `<@${x}>`).join(' ');

    const description = 'React with 👍 when you are ready. Once everyone is ready, ' + 
        'a countdown will automatically start! The countdown will be cancelled after 5 ' +
        'minutes if not all users are ready.';

    const f = async () => {
        const notReadyNames = await Promise.all([...notReadyUsers].map((user) => getUsername(user, msg.guild)));
        const readyNames = await Promise.all([...readyUsers].map((user) => getUsername(user, msg.guild)));

        return [
            {
                name: 'Not Ready',
                value: notReadyNames.length > 0
                    ? notReadyNames.join(', ')
                    : 'None',
            },
            {
                name: 'Ready',
                value: readyNames.length > 0
                    ? readyNames.join(', ')
                    : 'None',
            },
        ];
    }

    const fields = await f();

    const embed = new MessageEmbed()
        .setTitle(title)
        .setDescription(description)
        .addFields(fields);

    const sentMessage = await msg.channel.send({
        embeds: [embed],
    });

    await tryReactMessage(sentMessage, '👍');

    const collector = sentMessage.createReactionCollector({
        filter: (reaction, user) => {
            return reaction.emoji.name === '👍' && !user.bot;
        },
        time: 60 * 15 * 1000,
    });

    collector.on('collect', async (reaction, user) => {
        tryDeleteReaction(reaction, user.id);

        if (!notReadyUsers.has(user.id)) {
            return;
        }

        notReadyUsers.delete(user.id);
        readyUsers.add(user.id);

        if (notReadyUsers.size === 0) {
            collector.stop('messageDelete');
            tryDeleteMessage(sentMessage);
            const ping = [...readyUsers].map((x) => `<@${x}>`).join(' ');
            await msg.channel.send({
                content: `${ping} Everyone is ready, lets go!`,
            });
            await handleCountdown("Let's jam!", msg, '7');
        } else {
            const newFields = await f();
            embed.spliceFields(0, 2, newFields);
            await sentMessage.edit({
                embeds: [embed],
            });
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason !== 'messageDelete') {
            const notReadyNames = await Promise.all([...notReadyUsers].map((user) => getUsername(user, msg.guild)));
            embed.setDescription(`Countdown cancelled! ${notReadyNames.join(', ')} did not ready up in time.`);
            await sentMessage.edit({
                embeds: [embed],
            });
        }
    });
}

export async function handlePoll(msg: Message, args: string) {
    const yesUsers = new Set<string>();
    const noUsers = new Set<string>();

    const f = async () => {
        const yesNames = await Promise.all([...yesUsers].map((user) => getUsername(user, msg.guild)));
        const noNames = await Promise.all([...noUsers].map((user) => getUsername(user, msg.guild)));

        const fields = [];

        if (yesNames.length > 0) {
            fields.push({
                name: `Yes: ${yesNames.length}`,
                value: yesNames.join(', '),
            })
        }

        if (noNames.length > 0) {
            fields.push({
                name: `No: ${noNames.length}`,
                value: noNames.join(', '),
            })
        }

        return fields;
    }

    let title = capitalize(args.trim());

    if (!title.endsWith('?')) {
        title += '?';
    }

    const embed = new MessageEmbed()
        .setTitle(title)
        .setFooter('React with 👍 or 👎 to vote');

    const sentMessage = await msg.channel.send({
        embeds: [embed],
    });

    const collector = sentMessage.createReactionCollector({
        filter: (reaction, user) => {
            if (!reaction.emoji.name) {
                return false;
            }

            return ['👍', '👎'].includes(reaction.emoji.name) && !user.bot;
        },
        time: 60 * 15 * 1000,
    });

    collector.on('collect', async (reaction, user) => {
        tryDeleteReaction(reaction, user.id);

        if (reaction.emoji.name === '👍') {
            yesUsers.add(user.id);
            noUsers.delete(user.id);
        } else {
            noUsers.add(user.id);
            yesUsers.delete(user.id);
        }

        const newFields = await f();

        embed.spliceFields(0, 2, newFields);

        sentMessage.edit({
            embeds: [embed],
        });
    });

    await tryReactMessage(sentMessage, '👍');
    await tryReactMessage(sentMessage, '👎');
}

export async function handleMultiPoll(msg: Message, args: string) {
    args = args.trim();

    /* Remove an extra / if they accidently put one there to make the splitting
     * work correctly */
    if (args.endsWith('/')) {
        args = args.slice(0, -1);
    }

    const responseMapping = new Map<number, Set<string>>();

    const emojiToIndexMap = new Map([
        ['0️⃣', 0],
        ['1⃣', 1],
        ['2️⃣', 2],
        ['3️⃣', 3],
        ['4️⃣', 4],
        ['5️⃣', 5],
        ['6️⃣', 6],
        ['7️⃣', 7],
        ['8️⃣', 8],
        ['9️⃣', 9],
        ['🔟', 10],
    ])

    const emojis = [...emojiToIndexMap.keys()];

        const questionEndIndex = args.indexOf('/');

    if (questionEndIndex === -1) {
        await msg.reply(`Multipoll query is malformed. Try \`${config.prefix}multipoll help\``);
        return;
    }

    const options = args.slice(questionEndIndex + 1).split('/').map((x) => x.trim());

    if (options.length > 11) {
        await msg.reply('Multipoll only supports up to 11 different options.');
        return;
    }

    if (options.length <= 1) {
        await msg.reply('Multipoll requires at least 2 different options.');
        return;
    }

    let i = 0;

    for (let i = 0; i < options.length; i++) {
        responseMapping.set(i, new Set());
    }

    let title = capitalize(args.slice(0, questionEndIndex)).trim();

    if (!title.endsWith('?')) {
        title += '?';
    }

    const f = async () => {
        const fields = [];

        let i = 0;

        for (const option of options) {
            const users = responseMapping.get(i);

            if (!users) {
                i++;
                continue;
            }

            const names = await Promise.all([...users].map((user) => getUsername(user, msg.guild)));

            fields.push({
                name: `${emojis[i]} ${option}: ${users.size}`,
                value: names.join(', ') || 'None',
            })

            i++;
        }

        return fields;
    }

    const fields = await f();

    const embed = new MessageEmbed()
        .setTitle(title)
        .addFields(fields)
        .setFooter('React with the emoji indicated to cast your vote');

    const sentMessage = await msg.channel.send({
        embeds: [embed]
    });
    
    const usedEmojis = emojis.slice(0, options.length);

    async function toggleSelect(reaction: any, user: any) {
        const index = emojiToIndexMap.get(reaction.emoji.name as string) || 0;

        const users = responseMapping.get(index);

        if (!users) {
            return;
        }

        if (users.has(user.id)) {
            users.delete(user.id);
        } else {
            users.add(user.id);
        }

        const newFields = await f();

        embed.spliceFields(0, 11, newFields);

        sentMessage.edit({
            embeds: [embed],
        });
    }
    
    const collector = sentMessage.createReactionCollector({
        filter: (reaction, user) => {
            if (!reaction.emoji.name) {
                return false;
            }

            return usedEmojis.includes(reaction.emoji.name) && !user.bot;
        },
        time: 60 * 60 * 8 * 1000,
        dispose: true,
    });

    collector.on('collect', async (reaction, user) => {
        tryDeleteReaction(reaction, user.id);
        toggleSelect(reaction, user);
    });

    for (const emoji of usedEmojis) {
        await tryReactMessage(sentMessage, emoji);
    }
}

export async function handleQuotes(msg: Message, db: Database): Promise<void> {
    const quotes = await selectQuery(
        `SELECT
            quote,
            timestamp
        FROM
            quote
        WHERE
            channel_id = ?
        ORDER BY RANDOM()`,
        db,
        [ msg.channel.id ],
    );

    if (quotes.length === 0) {
        await msg.reply(`No quotes in the database! Use ${config.prefix}addquote to suggest one.`);
        return;
    }

    const embed = new MessageEmbed();

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 3,
        displayFunction: (quote: any) => {
            return {
                name: quote.timestamp
                    ? moment.utc(quote.timestamp).format('YYYY-MM-DD')
                    : 'The Before Times',
                value: quote.quote,
                inline: false,
            };
        },
        displayType: DisplayType.EmbedFieldData,
        data: quotes,
        embed,
    });

    pages.sendMessage();
}

async function handleBing(
    msg: Message,
    queries: string[],
    count: number,
) {
    const maxOffset = 100 - count;

    const randomOffset = Math.round(Math.random() * maxOffset);

    const params = {
        q: pickRandomItem(queries),
        safeSearch: 'Strict',
        offset: randomOffset,
        count,
    };

    const url = `https://api.bing.microsoft.com/v7.0/images/search?${stringify(params)}`;

    try {
        const response = await fetch(url, {
            headers: {
                'Ocp-Apim-Subscription-Key': config.bingApiKey,
            },
        });

        const data = await response.json();

        return data.value.map((i: any) => ({
            thumbnail: i.thumbnailUrl,
            fullsizeImage: i.contentUrl,
            pageURL: i.hostPageUrl,
            description: i.name,
        }));
    } catch (err) {
        console.log(err.toString());
        return undefined;
    }
}

export async function handleSlug(msg: Message): Promise<void> {
    const queries = [
        'slug',
        'slug animal',
        'cute slug',
        'sexy slug',
        'slug reproduction',
        'garden slug',
        'slug parasite',
        'leopard slug',
        'sea slug',
        'cartoon slug',
        'pixel slug',
    ];

    const images = await handleBing(msg, queries, 1);

    if (!images) {
        msg.reply('Failed to fetch image, sorry!');
        return;
    }

    const { thumbnail, fullsizeImage, pageURL, description } = images[0];

    const embed = new MessageEmbed()
        .setTitle(description)
        .setDescription(pageURL)
        .setImage(thumbnail);

    msg.reply({
        embeds: [embed],
    });
}

async function handleGif(
    msg: Message,
    args: string,
    gif: string,
    colors: number = 128,
    fontMultiplier: number = 1,
    flipPalette: boolean = false): Promise<void> {

    const mentionedChannels = [...msg.mentions.channels.values()];

    let channel: TextChannel = mentionedChannels.length > 0
        ? mentionedChannels[0] as TextChannel
        : msg.channel as TextChannel;

    let text = Util.cleanContent(args.replace(/<#\d{16,20}>/g, ''), msg.channel).toUpperCase().trim();

    if (text === '') {
        await msg.channel.send({
            files: [new MessageAttachment(`./images/${gif}`, gif)],
        });

        return;
    }

    if (!text.endsWith('!')) {
        text += '!';
    }

    const words = text.split(' ');

    let fixedWords: string[] = [];

    for (const word of words) {
        if (word.length >= 16) {
            fixedWords = fixedWords.concat(chunk(word, 16));
        } else {
            fixedWords.push(word);
        }
    }
    let finalText = fixedWords.join(' ');

    let fontPixels = 48;

    if (text.length >= 1000) {
        fontPixels = 6;
    } else if (text.length >= 500) {
        fontPixels = 8;
    } else if (text.length >= 250) {
        fontPixels = 12;
    } else if (text.length >= 100) {
        fontPixels = 18;
    } else if (text.length >= 50) {
        fontPixels = 24;
    } else if (text.length >= 20) {
        fontPixels = 40;
    }

    let primaryColour = flipPalette ? 'black' : 'white';
    let secondaryColour = flipPalette ? 'white' : 'black';

    const fontSize = `${fontPixels * fontMultiplier}px`;

    const gifObject = new TextOnGif({
        file_path: `./images/${gif}`,
        font_size: fontSize,
        font_color: primaryColour,
        stroke_color: secondaryColour,
        stroke_width: 3,
    });

    const newGif = await gifObject.textOnGif({
        text: finalText,
        get_as_buffer: true,
    });

    console.log(`Original file size: ${(newGif.length / 1024 / 1024).toFixed(2)} MB`);

    const minified = await imageminGifsicle({
        optimizationLevel: 1,
        colors,
    })(newGif);

    const attachment = new MessageAttachment(minified, gif);

    console.log(`Compressed file size: ${(minified.length / 1024 / 1024).toFixed(2)} MB`);

    await channel.send({
        files: [attachment],
    });
}

export async function handleGroundhog(msg: Message, args: string): Promise<void> {
    await handleGif(msg, args, 'hog.gif');
}

export async function handleGroove(msg: Message, args: string): Promise<void> {
    await handleGif(msg, args, 'dance.gif', 200);
}

export async function handleKek(msg: Message, args: string): Promise<void> {
    await handleGif(msg, args, 'kek.gif', 16, 2);
}

export async function handleNut(msg: Message, args: string): Promise<void> {
    await handleGif(msg, args, 'nut.gif', 16, 2);
}

export async function handleMoney(msg: Message, args: string): Promise<void> {
    await handleGif(msg, args, 'money.gif', 256);
}

export async function handleViper(msg: Message, args: string): Promise<void> {
    await handleGif(msg, args, 'viper.gif', 256, 0.8);
}

export async function handleCock(msg: Message): Promise<void> {
    const guwap = '238350296093294592';

    if (msg.author.id === guwap) {
        msg.reply(`Nice balls!`);
    } else {
        msg.reply(`Nice cock!`);
    }
}
