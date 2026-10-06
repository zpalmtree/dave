import moment from 'moment';

import fetch from 'node-fetch';

import imageminGifsicle from 'imagemin-gifsicle';
import TextOnGif from 'text-on-gif';

import { stringify } from 'querystring';
import { evaluate } from 'mathjs';
import { Database } from 'sqlite3';

import {
    Message,
    TextChannel,
    User,
    ColorResolvable,
    PermissionFlagsBits,
    AttachmentBuilder,
    EmbedBuilder,
    MessageReaction,
    Collection,
} from 'discord.js';

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
import { fetchGcp2Snapshot, Gcp2RateLimitError, Gcp2Snapshot } from './Gcp2.js';

import {
    chunk,
    capitalize,
    sleep,
    haveRole,
    pickRandomItem,
    getUsername,
    shuffleArray,
    roundToNPlaces,
    numberWithCommas,
    tryDeleteMessage,
    tryDeleteReaction,
    tryReactMessage,
    replyWithMention,
    escapeDiscordMarkdown,
} from './Utilities.js';

import {
    insertQuery,
    selectQuery,
    selectOneQuery,
} from './Database.js';

import {
    TimeUnits,
} from './Types.js';

import {
    exchangeService
} from './Exchange.js';

import {
    Paginate,
    DisplayType,
} from './Paginate.js';

import {
    downloadSearchResultImage,
    isUsableImageResult,
} from './ImageSearch.js';


const timeUnits: TimeUnits = {
    Y: 31536000,
    M: 2592000,
    W: 604800,
    d: 86400,
    h: 3600,
    m: 60,
    s: 1
};

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

interface PriceTrend {
    marker: string;
    change: string;
}

function formatUsdPrice(price: number): string {
    return `$${numberWithCommas(price.toString())}`;
}

function formatPriceTrend(change: number | undefined): PriceTrend {
    if (change === undefined || !Number.isFinite(change)) {
        return {
            marker: '⚪',
            change: 'n/a',
        };
    }

    const roundedChange = roundToNPlaces(change, 2);

    if (roundedChange > 0) {
        return {
            marker: '🟢',
            change: `+${roundedChange}%`,
        };
    }

    if (roundedChange < 0) {
        return {
            marker: '🔴',
            change: `${roundedChange}%`,
        };
    }

    return {
        marker: '⚪',
        change: '0%',
    };
}

export async function handlePrice(msg: Message) {
    const currencies = config.coins;
    const toFetch = currencies.map((c) => c.id).join('%2C');

    const lookupMap = new Map(currencies.map(({ id, label }) => [id, label]));

    /* CoinGecko's firewall rejects keyless requests with a CloudFront 403, so
     * send the free demo key when one is configured. */
    const { coingeckoApiKey } = config as typeof config & { coingeckoApiKey?: string };
    const headers: Record<string, string> = coingeckoApiKey
        ? { 'x-cg-demo-api-key': coingeckoApiKey }
        : {};

    try {
        const data = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${toFetch}&vs_currencies=usd&include_market_cap=true&include_24hr_change=true`, { headers });
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

            const pages = new Paginate({
                sourceMessage: msg,
                itemsPerPage: 9,
                displayFunction: (price: any) => {
                    const trend = formatPriceTrend(price.usd_24h_change);

                    return {
                        name: capitalize(price.name),
                        value: `${formatUsdPrice(price.usd)} ${trend.marker} ${trend.change}`,
                        inline: true,
                    };
                },
                displayType: DisplayType.EmbedFieldData,
                data: prices,
                embed,
            });

            await pages.sendMessage();
        } else {
            const body = await data.text().catch(() => '');
            console.log(`CoinGecko price request failed: ${data.status} ${body.slice(0, 500)}`);

            /* Error bodies are often a full CloudFront HTML page, so only relay a JSON error message. */
            let detail = '';

            try {
                const parsed = JSON.parse(body);
                detail = parsed?.status?.error_message ?? parsed?.error ?? '';
            } catch {
                /* Not JSON */
            }

            const hint = data.status === 403 && !coingeckoApiKey
                ? ' (coingecko now blocks requests without an API key; set coingeckoApiKey in the config)'
                : '';

            await msg.reply(`Failed to fetch data from coingecko: ${data.status}${detail ? `, ${String(detail).slice(0, 200)}` : ''}${hint}`);
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
        await (msg.channel as TextChannel).send(`${quote} - ${moment.utc(timestamp).format('YYYY-MM-DD')}`);
    } else {
        await (msg.channel as TextChannel).send(quote);
    }
}

export async function handleSuggest(msg: Message, suggestion: string, db: Database): Promise<void> {
    if (!suggestion || suggestion.length <= 1) {
        await msg.reply('Please enter a suggestion.');
        return;
    }

    if (msg.author.id === '492200446044274697') {
        await msg.reply('fuck off');
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

        await (msg.channel as TextChannel).send({
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

        await (msg.channel as TextChannel).send({
            files: [attachment],
        });
    } catch (err) {
        await msg.reply(`Failed to get data: ${(err as any).toString()}`);
    }
}

export async function handleStock(msg: Message, args: string[]) {
    if (args.length === 0) {
        await (msg.channel as TextChannel).send(`You need to include a ticker. Example: \`${config.prefix}stock IBM\``);
        return;
    }

    const [ ticker ] = args;

    const res = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(ticker.toUpperCase())}&apikey=${config.stockApiKey}`);

    if (res.status === 200) {
        const stockData = await res.json();

        if (Object.entries(stockData['Global Quote']).length === 0) {
            await (msg.channel as TextChannel).send("No ticker " + ticker.toUpperCase());
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
    
    
        await (msg.channel as TextChannel).send({
            embeds: [embed],
        });
    } else {
        await (msg.channel as TextChannel).send("Something went wrong fetching stock info for " + ticker.toUpperCase());
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

function formatCurrentDiscordTimestamp(style: 't' | 'F'): string {
    const timestamp = Math.floor(Date.now() / 1000);

    return `<t:${timestamp}:${style}>`;
}

export async function handleTime(msg: Message) {
    await msg.reply(`The current time is ${formatCurrentDiscordTimestamp('t')}`);
}

export async function handleDate(msg: Message) {
    await msg.reply(`The current date is ${formatCurrentDiscordTimestamp('F')}`);
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

    const sentMessage = await (msg.channel as TextChannel).send(secs.toString());

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
        '1231731968064880692',
    ];

    if (inProgress) {
        console.log('Purge already in progress');
        return;
    }

    if (!allowed.includes(msg.author.id)) {
        console.log(`User ${msg.author.id} cannot access purge bot`);
        return;
    }

    inProgress = true;

    const target = msg.author.id;

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

export async function handleQuery(msg: Message, args: string): Promise<void> {
    if (args.trim() === '') {
        await msg.reply('No query given');
        return;
    }

    try {
        const results = await getGoogleSearchResults(args);

        if (!results || results.length === 0) {
            await msg.reply('No results found!');
            return;
        }

        const embed = new EmbedBuilder();

        const pages = new Paginate({
            sourceMessage: msg,
            itemsPerPage: 3,
            displayFunction: (result: any) => {
                return {
                    name: `${result.title} - ${result.link}`,
                    value: result.snippet || 'No description available',
                    inline: false,
                };
            },
            displayType: DisplayType.EmbedFieldData,
            data: results,
            embed,
        });

        await pages.sendMessage();
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
        fromCurrency,
        toCurrency,
    } = exchangeService.exchange(from, to, asNum);

    if (!success) {
        await msg.reply(error as string);
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle(`${amountToConvert} ${fromCurrency} is ${roundToNPlaces(amount as number, 2)} ${toCurrency}`);

    await (msg.channel as TextChannel).send({
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
            await (msg.channel as TextChannel).send(guildUser.displayAvatarURL({
                extension: 'png',
                forceStatic: false,
                size: 4096,
            }));
        } else {
            await (msg.channel as TextChannel).send(user.displayAvatarURL({
                extension: 'png',
                forceStatic: false,
                size: 4096,
            }));
        }
    } else {
        await (msg.channel as TextChannel).send(user.displayAvatarURL({
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

    const displayImage = async (googleItem: any, embed: EmbedBuilder) => {
        embed.setTitle(googleItem.title);
        embed.setURL(googleItem.url);
        embed.setDescription(googleItem.displayLink);

        const image = await downloadSearchResultImage(googleItem);
        if (!image) {
            embed.setImage(googleItem.thumbnailLink);
            return { attachments: [] };
        }

        const filename = `image-search.${image.extension}`;
        embed.setImage(`attachment://${filename}`);

        return {
            attachments: [],
            files: [new AttachmentBuilder(image.data, { name: filename })],
        };
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

// Updated handleImageImpl function
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

    try {
        const results = await getGoogleImageResults(query);
        
        if (!results || results.length === 0) {
            await msg.reply('No results found!');
            return;
        }

        return results;
    } catch (err) {
        await msg.reply(`Error getting image results: ${(err as any).toString()}`);
        return;
    }
}

// Helper function for Google web search
async function getGoogleSearchResults(query: string): Promise<any[]> {
    const params = {
        key: config.googleApiKey,
        cx: config.googleSearchEngineId,
        q: query,
        num: '10',
        safe: 'off',
        lr: 'lang_en',
        gl: 'us',
    };

    const url = `https://www.googleapis.com/customsearch/v1?${stringify(params)}`;

    const response = await fetch(url);
    
    if (!response.ok) {
        throw new Error(`Google API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.items) {
        return [];
    }

    return data.items.map((item: any) => ({
        title: item.title,
        link: item.link,
        snippet: item.snippet,
        displayLink: item.displayLink,
    }));
}

// Helper function for Google image search
async function getGoogleImageResults(query: string): Promise<any[]> {
    const params = {
        key: config.googleApiKey,
        cx: config.googleSearchEngineId,
        q: query,
        searchType: 'image',
        num: '10',
        safe: 'off',
        lr: 'lang_en',
        gl: 'us',
        imgSize: 'large',
        imgType: 'photo',
    };

    const url = `https://www.googleapis.com/customsearch/v1?${stringify(params)}`;

    const response = await fetch(url);
    
    if (!response.ok) {
        throw new Error(`Google API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.items) {
        return [];
    }

    // Keep Google's thumbnail as a fast fallback when the source blocks hotlinks.
    return data.items
        .filter(isUsableImageResult)
        .map((item: any) => ({
            title: item.title,
            link: item.link,
            image: item.link,
            url: item.image?.contextLink || item.link,
            displayLink: item.displayLink,
            thumbnailLink: item.image.thumbnailLink,
            byteSize: item.image.byteSize,
        }));
}

export async function handleYoutubeApi(msg: Message, args: string): Promise<undefined | any[]> {
    let query = args.trim();
    const replyMessageId = msg.reference?.messageId;

    if (replyMessageId) {
        try {
            const repliedMessage = await msg.channel.messages.fetch(replyMessageId);
            const repliedText = repliedMessage.content.trim();

            if (repliedText) {
                query = query ? `${repliedText}\n${query}` : repliedText;
            }
        } catch (err) {
            console.error(`Failed to fetch replied message for YouTube context:`, err);
        }
    }

    if (query === '') {
        await msg.reply('No query given');
        return;
    }

    const params = {
        q: query,
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

export async function handleReady(msg: Message, args: string[], db: Database) {
    const notReadyUsers = new Set<string>([...msg.mentions.users.keys()]);
    const readyUsers = new Set<string>([]);

    let title = 'Are you ready?';

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

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .addFields(fields);

    const sentMessage = await (msg.channel as TextChannel).send({
        embeds: [embed],
    });

    await tryReactMessage(sentMessage, '👍');

    const collector = sentMessage.createReactionCollector({
        filter: (reaction: MessageReaction, user: User) => {
            return reaction.emoji.name !== null && ['👍', '👎'].includes(reaction.emoji.name) && !user.bot;
        },
        time: 60 * 15 * 1000,
    });

    collector.on('collect', async (reaction: MessageReaction, user: User) => {
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
            await (msg.channel as TextChannel).send({
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

    collector.on('end', async (collected: Collection<string, MessageReaction>, reason: string) => {
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

    const sentMessage = await (msg.channel as TextChannel).send({
        embeds: [embed],
    });

    const collector = sentMessage.createReactionCollector({
        filter: (reaction: MessageReaction, user: User) => {
            if (!reaction.emoji.name) {
                return false;
            }

            return ['👍', '👎'].includes(reaction.emoji.name) && !user.bot;
        },
        time: 60 * 15 * 1000,
    });

    collector.on('collect', async (reaction: MessageReaction, user: User) => {
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

    const sentMessage = await (msg.channel as TextChannel).send({
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
        filter: (reaction: MessageReaction, user: User) => {
            if (!reaction.emoji.name) {
                return false;
            }

            return usedEmojis.includes(reaction.emoji.name) && !user.bot;
        },
        time: 60 * 60 * 8 * 1000,
        dispose: true,
    });

    collector.on('collect', async (reaction: MessageReaction, user: User) => {
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

    await (msg.channel as TextChannel).send(file);
}

export async function handleChickenFried(msg: Message): Promise<void> {
    await replyWithMention(msg, 'https://cdn.discordapp.com/attachments/483470443001413675/1088687349497597982/repost.mov');
}

export async function handleGooning(msg: Message): Promise<void> {
    await (msg.channel as TextChannel).send({
        files: [
            new AttachmentBuilder('./images/gooning.mp4')
                .setName('gooning.mp4'),
        ],
    });
}

export async function handleDot(msg: Message, arg: string): Promise<void> {
    await initDot();

    /* Optional timespan for dot graph (for example 30m, 5s, 20h) */
    const timeRegex = /^([0-9]+)([YMWdhms])/;

    const [ , num, unit ] = timeRegex.exec(arg) || [ '24h', 24, 'h' ];
    let timeSpan: number = Number(num) * timeUnits[unit as keyof TimeUnits];

    /* Timespan cannot be larger than 498 days */
    /* Default timespan is 24h */
    if (timeSpan > 86400 * 498) {
        timeSpan = 86400 * 498;
    } else if (timeSpan <= 0) {
        timeSpan = 86400;
    }

    let dotGraph;
    let currentDotColor = '#000000';
    let currentDotValue = 0;
    let dot;
    let snapshot: Gcp2Snapshot;

    try {
        snapshot = await fetchGcp2Snapshot();
        [ [ , dotGraph ], [ currentDotColor, currentDotValue, dot ] ] = await Promise.all([
            renderDotGraph(timeSpan * -1, snapshot),
            renderDot(snapshot),
        ]);
    } catch (err) {
        if (err instanceof Gcp2RateLimitError) {
            const seconds = Math.max(1, Math.ceil((err.retryAt - Date.now()) / 1000));
            await msg.reply(`The dot provider is busy right now. Please try again in ${seconds} seconds.`);
            return;
        }
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

    const dotGraphAttachment = new AttachmentBuilder(dotGraph.toBuffer('image/png'))
        .setName('dot-graph.png');

    const dotAttachment = new AttachmentBuilder(dot.toBuffer('image/png'))
        .setName('dot.png');

    const percentage = Math.floor(currentDotValue * 100);

    const embed = new EmbedBuilder()
        .setColor(currentDotColor as ColorResolvable)
        .setTitle(`${percentage}% Network Variance`)
        .setThumbnail('attachment://dot.png')
        .setImage('attachment://dot-graph.png')
        .setDescription(description);

    if (snapshot.stale) {
        embed.setFooter({ text: 'Provider rate limited · Showing a cached reading from' })
            .setTimestamp(snapshot.fetchedAt);
    }

    await (msg.channel as TextChannel).send({
        embeds: [embed],
        files: [dotAttachment, dotGraphAttachment],
    });
}

function getRandomInt(min: number, max: number) {
    return Math.floor(Math.random() * (max - min) + min); // The maximum is exclusive and the minimum is inclusive
}

export async function handleMilton(msg: Message) {
    const bust = getRandomInt(0, Number.MAX_SAFE_INTEGER);
    await (msg.channel as TextChannel).send(`https://cdn.star.nesdis.noaa.gov/FLOATER/AL142024/Sandwich/500x500.jpg?cachebuster=${bust}`);
}
