import * as fs from 'fs';
import * as path from 'path';
import moment from 'moment';

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
    GuildMember,
    ColorResolvable,
    PermissionFlagsBits,
    AttachmentBuilder,
    EmbedBuilder,
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
    renderDotGraph,
    renderDot,
    initDot,
} from './Dot.js';

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
    isValidSolAddress,
    escapeDiscordMarkdown,
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
    Command,
} from './Types.js';

import {
    exchangeService
} from './Exchange.js';

import {
    Paginate,
    DisplayType,
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


export async function replyWithMention(msg: Message, reply: string): Promise<void> {
    if (msg.mentions.users.size > 0)   {
        const usersMentioned = [...msg.mentions.users.keys()].map((id) => `<@${id}>`).join(' ');
        await msg.reply(`${usersMentioned} ${reply}`);
    } else {
        await msg.channel.send(reply);
    }
}

export async function handleGen3Count(msg: Message): Promise<void> {
    await replyWithMention(msg, `Generation 3 slugs can be found by filtering for Shipwreck, Submarine, Fish Tank, Underwater Cult, and Night Shift backgrounds. They are part of the same slugs collection, with new, rarer, underwater themed traits. They were awarded to users who burnt three slugs.`);
}

export async function handleGen4Count(msg: Message, args: string): Promise<void> {
    const url = "https://letsalllovelain.com/slugs/";
    const res = await fetch(url);

    const address = args.trim();

    if (address !== '' && !isValidSolAddress(address)) {
        await replyWithMention(msg, `That does not appear to be a valid Solana wallet address (${address})`);
        return;
    }

    if (!res.ok) {
        await msg.reply('Failed to fetch Gen3 count from API!');
        return;
    }

    const data = await res.json();

    const gen3Date = new Date('2022-11-14');
    const gen4Date = new Date('2030-11-14');

    let gen3Count = 0;
    let burns = 0;

    for (const user of data.burnStats.users) {
        if (address !== '' && user.address !== address) {
            continue;
        }

        let eligibleBurns = 0;

        for (const burn of user.transactions) {
            if (new Date(burn.timestamp) >= gen3Date && new Date(burn.timestamp) <= gen4Date) {
                eligibleBurns += burn.slugsBurnt.length;
            }
        }

        gen3Count += Math.floor(eligibleBurns / 4);
        burns += eligibleBurns;
    }

    if (address !== '') {
        const burnsForNextSlug = 4 - (burns % 4);
        const slugStr = burnsForNextSlug === 1 ? 'slug' : 'slugs';

        if (gen3Count === 0) {
            await replyWithMention(
                msg,
                `You have ${burns} eligible burn${burns === 1 ? '' : 's'}. Every four slugs burnt will get you one generation 4 slug. Burn ${burnsForNextSlug} ${burns > 0 ? 'more ' : ''}${slugStr} to be eligible for your first generation 4 slug.`
            );
        } else {
            await replyWithMention(
                msg,
                `You are currently set to receive ${gen3Count} generation 4 slug${gen3Count > 1 ? 's' : ''}! You have ${burns} eligible burns. Burn ${burnsForNextSlug} more ${slugStr} to be eligible for another generation 4 slug.`,
            );
        }
    } else {
        await replyWithMention(msg, `The current projected Generation 4 slug supply is ${gen3Count}`);
    }
}


export async function handleBurnt(msg: Message, args: string): Promise<void> {
    const address = args.trim();

    if (address !== '' && !isValidSolAddress(address)) {
        await replyWithMention(msg, `That does not appear to be a valid Solana wallet address (${address})`);
        return;
    }

    const url = "https://letsalllovelain.com/slugs/";
    const res = await fetch(url);

    if (!res.ok) {
        await msg.reply('Failed to fetch burnt count from API!');
        return;
    }
    
    const data = await res.json();

    if (address === '') {
        await replyWithMention(msg, `${data.slugs.burnt.length} slugs have been burnt!`);
    } else {
        let burns = 0;

        for (const user of data.burnStats.users) {
            if (user.address !== address) {
                continue;
            }

            for (const burn of user.transactions) {
                burns += burn.slugsBurnt.length;
            }
        }

        if (burns === 0) {
            await msg.reply(`${address} hasn't burnt any slugs yet. What are they playing at?`);
        } else {
            await msg.reply(`${address} has burnt ${burns} slug${burns === 1 ? '' : 's'}. Good job!`);
        }
    }
}

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
        await msg.reply('Bad mathematical expression: ' + (err as any).toString());
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
            await msg.reply('Bad mathematical expression: ' + (err as any).toString());
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
    
            const embed = new EmbedBuilder();
            for (const price of prices) {
                embed.addFields({
                    name: capitalize(price.name),
                    value: `$${numberWithCommas(price.usd.toString())} (${roundToNPlaces(price.usd_24h_change, 2)}%)`,
                    inline: true,
                });
            }
    
            msg.channel.send({
                embeds: [embed],
            });
        } else {
            try {
                const err = await data.text();
                await msg.reply(`Failed to fetch data from coingecko: ${data.status}, ${err}`);
            } catch (err) {
                await msg.reply(`Failed to fetch data from coingecko: ${data.status}`);
            }
        }
    } catch(err) {
        await msg.reply(`Failed to get data: ${(err as any).toString()}`);
    }
}

export async function handleQuote(msg: Message, db: Database): Promise<void> {
    const { quote, timestamp } = await selectOneQuery<any>(
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

        const attachment = new AttachmentBuilder(data[0].url);

        await msg.channel.send({
            files: [attachment],
        });
    } catch (err) {
        await msg.reply(`Failed to get kitty pic :( [ ${(err as any).toString()} ]`);
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

        const attachment = new AttachmentBuilder(data.message);

        await msg.channel.send({
            files: [attachment],
        });
    } catch (err) {
        await msg.reply(`Failed to get data: ${(err as any).toString()}`);
    }
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

        const embed = new EmbedBuilder()
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

        const embed = new EmbedBuilder();

        const pages = new Paginate({
            sourceMessage: msg,
            embed,
            data: images,
            displayType: DisplayType.EmbedData,
            displayFunction: (item: any, embed: EmbedBuilder) => {
                embed.setTitle(item.title);
                embed.setImage(item.link);
            }
        })

        await pages.sendMessage();
    } catch (err) {
        await msg.reply(`Failed to get ${gallery} pic :( [ ${(err as any).toString()} ]`);
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

let inProgress = false;

export async function handlePurge(msg: Message) {
    await tryDeleteMessage(msg);

    const allowed = [
        '354701063955152898',
        '901540415176597534',
    ];

    if (inProgress) {
        return;
    }

    inProgress = true;

    if (!allowed.includes(msg.author.id)) {
        await msg.reply('fuck off');
        return;
    }

    const target = '901540415176597534';

    console.log(`Deletion started by ${msg.author.id}`);

    let messages: Message[] = [];

    let i = 0;

    try {
        do {
            try {
                const firstMessage = messages.length === 0 ? undefined : messages[0].id;

                console.log(`Fetching messages...`);

                /* Fetch messages, convert to array and sort by timestamp, oldest first */
                messages = [...(await msg.channel.messages.fetch({ before: firstMessage })).values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

                await sleep(2000);

                for (const message of messages) {
                    if (message.author.id === target) {
                        try {
                            await tryDeleteMessage(message);
                            await sleep(2000);
                            console.log(`Deleted message ${i} for ${msg.author.id}`);
                        } catch (err) {
                            console.log(err);
                        }

                        i++;
                    }
                }
            } catch (err) {
                console.log('err: ' + (err as any).toString());
            }
        } while (messages.length > 0);

        console.log('Message deletion complete.');
    } catch (err) {
        console.log('err: ' + (err as any).toString());
    }

    inProgress = false;
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

async function displayQueryResults(html: HTMLElement, msg: Message): Promise<void> {
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

        if (protocol === 'http') {
            continue;
        }

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

        try {
            new URL(linkURL);
        } catch (err) {
            console.log(`Skipping invalid url ${linkURL}`);
            continue;
        }

        results.push({
            linkTitle,
            linkURL,
            snippet,
        });
    }

    if (results.length > 0) {
        const embed = new EmbedBuilder();

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

async function displayInstantAnswerResult(data: any, msg: Message): Promise<void> {
    if (data.Redirect) {
        await msg.reply(data.Redirect);
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle(data.Heading);

    if (data.Image) {
        embed.setImage(`https://duckduckgo.com${data.Image}`);
    }

    if (data.AbstractURL) {
        embed.setURL(data.AbstractURL);
    }

    let haveDescription = false;

    if (data.Answer) {
        embed.setDescription(data.Answer);
        haveDescription = true;
    } else if (data.AbstractText) {
        embed.setDescription(data.AbstractText);
        haveDescription = true;
    }

    const results = data.Results.length > 0
        ? data.Results
        : data.RelatedTopics;

    if (!haveDescription) {
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
    }

    await msg.channel.send({
        embeds: [embed],
    });
}

export async function handleQuery(msg: Message, args: string): Promise<void> {
    if (args.trim() === '') {
        await msg.reply('No query given');
        return;
    }

    try {
        getInstantAnswerResults(args).then((res) => res ? displayInstantAnswerResult(res!, msg) : {});
        getQueryResults(args).then((res) => res ? displayQueryResults(res as HTMLElement, msg) : {});
    } catch (err) {
        await msg.reply(`Error getting query results: ${(err as any).toString()}`);
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

    const embed = new EmbedBuilder()
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
            await msg.channel.send(guildUser.displayAvatarURL({
                extension: 'png',
                forceStatic: false,
                size: 4096,
            }));
        } else {
            await msg.channel.send(user.displayAvatarURL({
                extension: 'png',
                forceStatic: false,
                size: 4096,
            }));
        }
    } else {
        await msg.channel.send(user.displayAvatarURL({
            extension: 'png',
            forceStatic: false,
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

    const embed = new EmbedBuilder();

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

    const displayImage = (duckduckgoItem: any, embed: EmbedBuilder) => {
        embed.setTitle(duckduckgoItem.title);
        embed.setImage(duckduckgoItem.image);
        embed.setDescription(duckduckgoItem.url);
    };

    const embed = new EmbedBuilder();

    const pages = new Paginate({
        sourceMessage: msg,
        displayFunction: displayImage,
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
        await msg.reply((err as any));
        return;
    }

    // gimme that token...
    const regex = /vqd=([\d-]+)\&/;

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
        await msg.reply((err as any));
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

        try {
            new URL(img.image);
        } catch (err) {
            console.log(`Skipping invalid image url ${img.image}`);
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
            channel_id = ?
        GROUP BY
            user_id
        ORDER BY
            usage DESC`,
        db,
        [ msg.channel.id ]
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
            channel_id = ?
            AND command = ?
        GROUP BY
            user_id
        ORDER BY
            usage DESC`,
        db,
        [ msg.channel.id, command ]
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
        await msg.reply((err as any));
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

let previousReady: undefined | any = undefined;

export async function handleReady(msg: Message, args: string, db: Database) {
    let notReadyUsers = new Set<string>([...msg.mentions.users.keys()]);
    let readyUsers = new Set<string>([]);

    let title = 'Are you ready?';

    if (args === 'last') {
        if (!previousReady) {
            await msg.reply(`No previous ready, bot may have recently restarted.`);
            return;
        }

        // Make the invoking user ready and all other users not ready
        notReadyUsers = new Set<string>(previousReady.readyUsers);
        readyUsers = new Set<string>([msg.author.id]);

        for (const user of previousReady.notReadyUsers) {
            notReadyUsers.add(user);
        }

        notReadyUsers.delete(msg.author.id);

    } else {
        if (notReadyUsers.size === 0) {
            notReadyUsers.add(msg.author.id);
        } else if (!notReadyUsers.has(msg.author.id)) {
            readyUsers.add(msg.author.id);
        }
    }

    if (notReadyUsers.size === 0 && readyUsers.size <= 1) {
        await msg.reply(`At least one user other than yourself must be mentioned or attending the movie ID. See \`${config.prefix}help ready\``);
        return;
    }

    previousReady = {
        notReadyUsers,
        readyUsers,
    };

    const mention = Array.from(notReadyUsers).map((x) => `<@${x}>`).join(' ');

    const description = 'React with 👍 when you are ready and 👎 if you want to unready. Once everyone is ready, ' + 
        'a countdown will automatically start! The countdown will be cancelled after 15 ' +
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

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .addFields(fields);

    const sentMessage = await msg.channel.send({
        embeds: [embed],
    });

    await tryReactMessage(sentMessage, '👍');
    await tryReactMessage(sentMessage, '👎');

    const collector = sentMessage.createReactionCollector({
        filter: (reaction, user) => {
            return reaction.emoji.name !== null && ['👍', '👎'].includes(reaction.emoji.name) && !user.bot;
        },
        time: 60 * 15 * 1000,
    });

    collector.on('collect', async (reaction, user) => {
        tryDeleteReaction(reaction, user.id);

        if (reaction.emoji.name === '👍') {
            if (!notReadyUsers.has(user.id)) {
                return;
            }

            notReadyUsers.delete(user.id);
            readyUsers.add(user.id);
        } else if (reaction.emoji.name === '👎') {
            if (!readyUsers.has(user.id)) {
                return;
            }

            readyUsers.delete(user.id);
            notReadyUsers.add(user.id);
        }

        if (notReadyUsers.size === 0) {
            collector.stop('messageDelete');
            tryDeleteMessage(sentMessage);
            const ping = [...readyUsers].map((x) => `<@${x}>`).join(' ');
            await msg.channel.send({
                content: `${ping} Everyone is ready, let's go!`,
            });
            await handleCountdown("Let's jam!", msg, '7');
        } else {
            const newFields = await f();
            embed.spliceFields(0, 2, ...newFields);
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

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setFooter({ text: 'React with 👍 or 👎 to vote' });

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

        embed.spliceFields(0, 2, ...newFields);

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

    const embed = new EmbedBuilder()
        .setTitle(title)
        .addFields(fields)
        .setFooter({ text: 'React with the emoji indicated to cast your vote' });

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

        embed.spliceFields(0, 11, ...newFields);

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

    const embed = new EmbedBuilder();

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

    const bannedChannels = [
        '891080925163704352',
    ];

    if (bannedChannels.includes(channel.id)) {
        await msg.reply(`Cannot send messages to that channel.`);
        return;
    }

    const hasPermissionInChannel = channel
        .permissionsFor(msg.member!)
        .has(PermissionFlagsBits.SendMessages, false);

    if (!hasPermissionInChannel) {
        await msg.reply(`You do not have permission to send messages to that channel.`);
        return;
    }

    let text = escapeDiscordMarkdown(args.replace(/<#\d{16,20}>/g, '')).toUpperCase().trim();

    if (text === '') {
        await channel.send({
            files: [
                new AttachmentBuilder(`./images/${gif}`)
                    .setName(gif)
            ],
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

    const attachment = new AttachmentBuilder(minified)
        .setName(gif);

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

export async function handleBurn(msg: Message): Promise<void> {
    await replyWithMention(msg, `A lot of slug utility comes from burning a slug.
**Why burn a slug?**
* Help be part of the most deflationary collection on Solana - with over 4100 slugs burnt!
* Access to alpha, whitelist, and other burner only channels.
* Alpha bots - Find trending magiceden collections, new twitter accounts, and just created mints.
* Free stuff - Sometimes we will raffle 1/1s, airdrops, or other valuable items. Burners come first whenever this happens.
* Merch - This is still in the works, but slug burners will have the first access to slug merch.
* Future slug generations - As part of the slugs deflationary mechanism, burning enough slugs entitles you to a mint from the next slug generation. The current rate is 4:1, for generation four.`);
}

export async function handleUtility(msg: Message): Promise<void> {
    await replyWithMention(msg, `**Why buy a slug?**
* Gain benefits on our sleek portfolio tracker, slime: <https://slime.cx/>
* Enjoy the slug supply constantly decreasing. It's already shrunk from 10,000 to 7,200!
* Try out the slug AI image generator and chat bots
* Burn your slug for more benefits! Try \`${config.prefix}burn\` for more info.
* Chill in one of the most active chats in Solana. No more gm spam!
* Help support the <https://sol-incinerator.com/>'s free operation.`);
}

export async function handle3d(msg: Message): Promise<void> {
    await replyWithMention(msg, `3D slugs or Slugs Regenesis are a separate collection by the same team but the supply is much lower. As a free mint for rug victims, they don't have any defined utility yet, but they've got rocket launchers and katanas, they're cool as fuck. <https://magiceden.io/marketplace/slugs_regenesis>`);
}

export async function handleGen2(msg: Message): Promise<void> {
    await replyWithMention(msg, `Generation 2 slugs can be found by filtering for Arena, Temple, and Pyramid backgrounds. They are part of the same slugs collection, with new, rarer, god of death themed traits. They were awarded to users who burnt two slugs.`);
}

export async function handleBuy(msg: Message): Promise<void> {
    await replyWithMention(msg, `<https://magiceden.io/marketplace/sol_slugs>`);
}

export async function handleVerify(msg: Message): Promise<void> {
    await replyWithMention(msg, `Get your holder and burner roles here: <https://solslugs.com/#/verify>`);
}

export async function handleIncinerator(msg: Message): Promise<void> {
    await replyWithMention(msg, `Burn your slugs, rugs, or scams here: <https://sol-incinerator.com/>`);
}

export async function handleTrending(msg: Message): Promise<void> {
    await replyWithMention(msg, `The trending bot is separated into 6 different channels, by window of time. The 1m channel, for example, will show the hottest collections within a 1 minute interval. A hot collection is defined as having the greatest NUMBER of sales within that interval.

So a collection that sells 100 units in 1 minute would be hotter than one that sold 50 units in 1 minute.

The colors indicate the sold to listed balance.

Green: Sold > Listed
Yellow: Sold = Listed
Red: Sold < Listed

Volume is the total amount of Solana transacted within the interval. Low is the lowest sale price, High is the highest sale price, and Average is the average sale price.

It is useful to look at how these collections are trending - is the number of sold going up each interval, for example? Is there a high average, indicating people are sniping rares? There's a strategy to develop using the trending bot, but if use effectively, can lead to great trading success.`);
}

export async function handleSign(msg: Message): Promise<void> {
    await replyWithMention(msg, 'https://media.discordapp.net/attachments/483470443001413675/1064019335955365918/sign.png');
}

export async function handleFrozen(msg: Message): Promise<void> {
    await replyWithMention(msg, `Some scam tokens are freezing the token accounts so you can’t get burn or transfer them. Our dev has posted about the issue on Solana’s GitHub in hopes they fix it, but we will be pushing an update soon with our redesign that makes it more obvious the token is frozen and cannot be burnt.\n\nIf you have a GitHub account, you could let the Solana devs know you would like to see this fixed - <https://github.com/solana-labs/solana-program-library/issues/3295>`);
}

export async function handleIncineratorFAQ(msg: Message): Promise<void> {
    await replyWithMention(msg, `Q. Where is the money coming from?
A. Its liberating a small storage fee 

Q. I only got 0.002 for an NFT. What gives!?
A. The MAJORITY of NFTs give 0.01. Non-master editions(non unique) tokens, like scams, still give 0.002

Q. Theres an NFT in my wallet that wont burn. Why?
A. Some nfts, scams in particular, abuse the freeze instruction - you cant send them out or burn them.

Q. I burned and it doesnt seem like I got anything. What happened?
A. The amount you get is very small, unless youre burning a lot of NFTs. You need to burn at least 100 to get 1 sol!`);
}

export async function handleItsOver(msg: Message, args: string): Promise<void> {
    const files = [
        'https://cdn.discordapp.com/attachments/483470443001413675/1047016075017072640/1.mp4',
        'https://cdn.discordapp.com/attachments/483470443001413675/1047016076057247764/2.mp4',
        'https://cdn.discordapp.com/attachments/483470443001413675/1047016076594139266/3.mp4',
        'https://cdn.discordapp.com/attachments/483470443001413675/1047016077697232917/4.mp4',
        'https://cdn.discordapp.com/attachments/483470443001413675/1047016078468972554/5.mp4',
        'https://cdn.discordapp.com/attachments/483470443001413675/1047016078741622804/6.mp4',
        'https://cdn.discordapp.com/attachments/483470443001413675/1047016079077159003/7.mp4',
        'https://cdn.discordapp.com/attachments/483470443001413675/1066569981787119747/8.mp4',
        'https://cdn.discordapp.com/attachments/483470443001413675/1076309851786989718/9.mp4',
        'https://cdn.discordapp.com/attachments/483470443001413675/1096251152405893130/10.mp4',
        'https://media.discordapp.net/attachments/483470443001413675/1171312724970590299/11.mp4',
        'https://media.discordapp.net/attachments/483470443001413675/1171312725419368478/12.mp4',
        'https://media.discordapp.net/attachments/483470443001413675/1171312725973012481/13.mp4',
        'https://cdn.discordapp.com/attachments/483470443001413675/1174551948691783740/14.mp4',
        'https://cdn.discordapp.com/attachments/483470443001413675/1198848411684847686/15.mp4',
        'https://cdn.discordapp.com/attachments/483470443001413675/1198852789405749339/16.mp4',
    ];

    const index = Number(args.trim());

    let file = pickRandomItem(files);

    if (!Number.isNaN(index)) {
        const offset = index - 1;

        if (offset >= 0 && offset < files.length) {
            file = files[offset];
        }
    }

    await msg.channel.send(file);
}

export async function handleSlime(msg: Message): Promise<void> {
    await replyWithMention(msg, 'https://slime.cx/');
}

export async function handleGitbook(msg: Message): Promise<void> {
    await replyWithMention(msg, 'https://solana-slugs.gitbook.io/solana-slugs/');
}

export async function handleAIInfo(msg: Message): Promise<void> {
    await replyWithMention(msg, 'https://media.discordapp.net/attachments/891081746186113024/1074511672401731724/image.png');
}

export async function handleChickenFried(msg: Message): Promise<void> {
    await replyWithMention(msg, 'https://cdn.discordapp.com/attachments/483470443001413675/1088687349497597982/repost.mov');
}

export async function handleDot(msg: Message, arg: string): Promise<void> {
    await initDot();

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
        await msg.reply(`Failed to get dot data :( [ ${(err as any).toString()} ]`);
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

    const dotGraphAttachment = new AttachmentBuilder(dotGraph.toBuffer())
        .setName('dot-graph.png');

    const dotAttachment = new AttachmentBuilder(dot.toBuffer())
        .setName('dot.png');

    const percentage = Math.floor(currentDotValue * 100);

    const embed = new EmbedBuilder()
        .setColor(currentDotColor as ColorResolvable)
        .setTitle(`${percentage}% Network Variance`)
        .setThumbnail('attachment://dot.png')
        .setImage('attachment://dot-graph.png')
        .setDescription(description);

    await msg.channel.send({
        embeds: [embed],
        files: [dotAttachment, dotGraphAttachment],
    });
}

export async function handleGen4Leaderboard(msg: Message): Promise<void> {
    const url = "https://letsalllovelain.com/slugs/";
    const res = await fetch(url);

    if (!res.ok) {
        await msg.reply('Failed to fetch burn stats from API!');
        return;
    }

    const data = await res.json();
    const gen3Date = new Date('2022-11-14');
    const gen4Date = new Date('2030-11-14');

    // Create a map to store Gen4 eligibility for each user
    const userGen4Eligibility = new Map<string, number>();

    for (const user of data.burnStats.users) {
        if (excludedGen4.includes(user.address)) {
            continue;
        }

        let eligibleBurns = 0;
        for (const burn of user.transactions) {
            const burnDate = new Date(burn.timestamp);
            if (burnDate >= gen3Date && burnDate <= gen4Date) {
                eligibleBurns += burn.slugsBurnt.length;
            }
        }
        userGen4Eligibility.set(user.address, Math.floor(eligibleBurns / 4));
    }

    // Sort users by Gen4 eligibility and get top 10
    const topUsers = Array.from(userGen4Eligibility.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    // Create embed
    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Top 10 Gen4 Eligibility');

    const leaderboardFields = topUsers.map((user, index) => {
        const address = user[0];
        const gen4Eligibility = user[1];
        return `${index + 1}. ${address}\n   Eligible: ${gen4Eligibility}`;
    });

    embed.setDescription(leaderboardFields.join('\n\n'));

    await msg.channel.send({ embeds: [embed] });
}

function getRandomInt(min: number, max: number) {
    return Math.floor(Math.random() * (max - min) + min); // The maximum is exclusive and the minimum is inclusive
}

export async function handleMilton(msg: Message) {
    const bust = getRandomInt(0, Number.MAX_SAFE_INTEGER);
    await msg.channel.send(`https://cdn.star.nesdis.noaa.gov/FLOATER/AL142024/Sandwich/500x500.jpg?cachebuster=${bust}`);
}
