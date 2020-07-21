import * as fs from 'fs';
import * as path from 'path';
import * as moment from 'moment';

import { stringify } from 'querystring';

import request = require('request-promise-native');

import { Message, Client, TextChannel, User, MessageEmbed, MessageAttachment } from 'discord.js';

import { promisify } from 'util';

import { evaluate } from 'mathjs';

import { config } from './Config';

import { catBreeds } from './Cats';
import { dogBreeds } from './Dogs';
import { fortunes } from './Fortunes';
import { dubTypes } from './Dubs';

import { renderDotGraph, renderDot } from './Dot';

import * as convert from 'xml-js';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

/* Optional number of rolls (for example 5d20), 'd', (to indicate a roll),
   one or more numbers - the dice to roll - then zero or more chars for an
   optional mathematical expression (for example, d20 + 3) */
const rollRegex: RegExp = new RegExp(/^(\d+)?d(\d+)(.*)$/, 'i');

/* Optional timespan for dot graph (for example 30m, 5s, 20h) */
const timeRegex: RegExp = new RegExp(/^([0-9]+)([YMWdhms])/);

interface TimeUnits {
    Y: number;  // year
    M: number;  // month
    W: number;  // week
    d: number;  // day
    h: number;  // hour
    m: number;  // minute
    s: number;  // second
};

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

interface Quote {
    quote: string;
    timestamp: number;
}

function handleMessage(msg: Message) {
    if (!msg.content.startsWith(config.prefix)) {
        return;
    }

    if (msg.author.bot) {
        return;
    }

    /* Get the command with prefix, and any args */
    const [ tmp, ...args ] = msg.content.split(' ');

    /* Get the actual command after the prefix is removed */
    const command: string = tmp.substring(tmp.indexOf(config.prefix) + 1, tmp.length);

    switch (command) {
        case 'roll':
        case 'reroll': {
            handleRoll(msg, args.join(' '));
            break;
        }
        case 'quote': {
            handleQuote(msg);
            break;
        }
        case 'suggest': {
            handleSuggest(msg, args.join(' '));
            break;
        }
        case 'fortune': {
            handleFortune(msg);
            break;
        }
        case 'math': {
            handleMath(msg, args.join(' '));
            break;
        }
        case 'doggo': {
            handleDoggo(msg, args);
            break;
        }
        case 'kitty': {
            handleKitty(msg, args.join(' '));
            break;
        }
        case 'help': {
            handleHelp(msg);
            break;
        }
        case 'archive': {
            archive(msg.channel as TextChannel, msg.author);
            break;
        }
        case 'chinaids':
        case 'kungflu':
        case 'corona':
        case 'coronavirus':
        case 'covid-19':
        case 'chinesevirus':
        case 'chinavirus':
        case 'chinked': {
            chinked(msg, args.join(' '));
            break;
        }
        case 'dot': {
            dotpost(msg, args.join(' '));
            break;
        }
        case 'pizza': {
            handleImgur(msg, 'r/pizza');
            break;
        }
        case 'turtle': {
            handleImgur(msg, 'r/turtle');
            break;
        }
    }
}

function main() {
    const client = new Client();

    client.on('ready', () => {
        console.log('Logged in');
    });

    client.on('message', (msg) => {
        try {
            handleMessage(msg as Message);
        /* Usually discord permissions errors */
        } catch (err) {
            console.error('Caught error: ' + err.toString());
        }
    });

    client.on('error', console.error);

    client.login(config.token)
          .catch((err) => {
              console.error(err);
              main();
    });
}

function handleFortune(msg: Message): void {
    var fortune = fortunes[Math.floor(Math.random() * fortunes.length)];

    msg.reply(`Your fortune: ${fortune}`);
}

function handleMath(msg: Message, args: string): void {
    // xaz, extra
    const niggers = ['100607191337164800', '388037798772473859'];

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

function handleDiceRoll(msg: Message, args: string): void {
    const badRoll: string = 'Invalid roll. Examples: 5d20, d8 + 3, 10d10 * 2'

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

function handleHelp(msg: Message): void {
    msg.reply(`
\`\`\`
$roll:      Gets your post number and its repeating digits
$reroll:    Alias of $roll for convenience
$fortune:   Gets your fortune
$doggo:     Gets a random dog pic
$kitty:     Gets a random cat pic
$help:      Displays this help
$chinked:   Displays coronavirus statistics
$dot:       Dot bot post dot
\`\`\`
    `);
}

function handleRoll(msg: Message, args: string): void {
    if (msg.member) {
        if (msg.member.roles.cache.find((role) => role.name === 'Lil bitch')) {
            msg.reply('little bitches are NOT allowed to use the roll bot. Obey the rolls, faggot!');
            return;
        }
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

async function readQuotes(filepath: string): Promise<[boolean, Quote[]]> {
    try {
        const data: string = await readFile(path.join(__dirname, filepath), { encoding: 'utf8' });
        const quotes: Quote[] = JSON.parse(data);

        return [true, quotes];
    } catch (err) {
        console.log(err);
        return [false, []];
    }
}

async function writeQuotes(filepath: string, quotes: string): Promise<void> {
    try {
        await writeFile(path.join(__dirname, filepath), quotes);
    } catch (err) {
        console.log(err);
    }
}

async function handleQuote(msg: Message): Promise<void> {
    if (msg.channel.id !== config.fit) {
        return;
    }

    const [success, quotes] = await readQuotes('./quotes.json');

    if (!success) {
        msg.reply('Crap, couldn\'t open the quotes file :(');
        return;
    }

    const { quote, timestamp } = quotes[Math.floor(Math.random() * quotes.length)];

    if (timestamp !== 0) {
        msg.channel.send(`${quote} - ${new Date(timestamp).toISOString().slice(0, 10)}`);
    } else {
        msg.channel.send(quote);
    }
}

async function handleSuggest(msg: Message, suggestion: string | undefined): Promise<void> {
    if (msg.channel.id !== config.fit) {
        return;
    }

    if (msg.author.bot) {
        msg.reply('FUUUUUUUUUUUUUUU');
        return;
    }

    if (!suggestion || suggestion.length <= 1) {
        msg.reply('Enter a fucking suggestion you wank stain');
        return;
    }

    const [success, quotes] = await readQuotes('./quotes.json');

    if (!success) {
        msg.reply('Crap, couldn\'t open the quotes file :(');
        return;
    }

    const newQuote: Quote = {
        quote: suggestion,
        timestamp: Date.now(),
    };

    quotes.push(newQuote);

    await writeQuotes('quotes.json', JSON.stringify(quotes, null, 4));

    addReaction('579921155578658837', msg);
}

async function handleKitty(msg: Message, args: string): Promise<void> {
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

async function handleDoggo(msg: Message, breed: string[]): Promise<void> {
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

function addReaction(emoji: string, message: Message): void {
    /* Find the reaction */
    const reaction = message.guild!.emojis.resolve(emoji);

    /* Couldn't find the reaction */
    if (!reaction) {
        console.error(`Failed to find emoji: ${emoji} on the server!`);
        return;
    }

    /* Add the reaction */
    message.react(reaction).catch(console.error);
}

async function archive(channel: TextChannel, author: User): Promise<void> {
    if (author.id !== '354701063955152898') {
        author.send('nice try sweaty this is for admins only');
        return;
    }

    channel.send('Archiving post history. I\'ll let you know when I\'ve finished!');

    let messageInfo = [];

    let messages: Message[] = [];

    try {
        do {
            const firstMessage = messages.length === 0 ? undefined : messages[0].id;

            /* Fetch messages, convert to array and sort by timestamp, oldest first */
            messages = (await channel.messages.fetch({ before: firstMessage })).array().sort((a, b) => a.createdTimestamp - b.createdTimestamp);

            console.log(`[${new Date(messages.length > 0 ? messages[0].createdTimestamp : 0).toUTCString()}] Collected ${messageInfo.length} messages`);

            for (const message of messages) {
                messageInfo.unshift({
                    timestamp: message.createdTimestamp,
                    authorID: message.author.id,
                    authorName: message.author.username,
                    content: message.content,
                    image: message.attachments.size > 0 ? message.attachments.array().map((x) => x.url).join(', ') : '',
                });
            }
        } while (messages.length > 0);
    } catch (err) {
        console.log('err: ' + err.toString());
    }

    messageInfo = messageInfo.sort((a, b) => a.timestamp - b.timestamp);

    const channelName = channel.guild.name + '_' + channel.name;
    const filename = `${channelName}_archive_${new Date().toLocaleString()}`.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.json';

    await writeFile(path.join(__dirname, filename), JSON.stringify(messageInfo, null, 4));

    console.log('Finished collecting messages.');

    channel.send(`Finished archiving post history, saved to ${filename} :ok_hand:`);
}

function chunk(arr: string, len: number) {
    const chunks = [];
    let i = 0;
    const n = arr.length;

    while (i < n) {
        chunks.push(arr.slice(i, i += len));
    }

    return chunks;
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

async function chinked(msg: Message, country: string): Promise<void> {
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

async function dotpost(msg: Message, arg: string): Promise<void> {
    if (arg.toLowerCase() === 'help') {
        printDotHelp(msg);
        return;
    }

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

function printDotHelp(msg: Message): void {
    msg.reply(
        'The Global Consciousness Project collects random numbers from ' +
        'around the world. These numbers are available on the GCP website. ' +
        'This website downloads those numbers once a minute and performs ' +
        'sophisticated analysis on these random numbers to see how coherent ' +
        'they are. That is, we compute how random the random numbers coming ' +
        'from the eggs really are. The theory is that the Global Consciousness ' +
        'of all Beings of the Planet affect these random numbers... Maybe ' +
        'they aren\'t quite as random as we thought.\n\nThe probability time ' +
        'window is one and two hours; with the display showing the more ' +
        'coherent of the two. For more information on the algorithm you can ' +
        'read about it on the GCP Basic Science page ' +
        '(<http://global-mind.org/science2.html#hypothesis>)');
}

async function handleImgur(msg: Message, gallery: string): Promise<void> {
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

main();
