import * as fs from 'fs';
import * as path from 'path';

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

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

/* Optional number of rolls (for example 5d20), 'd', (to indicate a roll),
   one or more numbers - the dice to roll - then zero or more chars for an
   optional mathematical expression (for example, d20 + 3) */
const rollRegex: RegExp = new RegExp(/^(\d+)?d(\d+)(.*)$/, 'i');

interface Quote {
    quote: string;
    timestamp: number;
}

function handleMessage(msg: Message) {
    if (!msg.content.startsWith(config.prefix)) {
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
        case 'chinese virus':
        case 'chinked': {
            chinked(msg, args.join(' '));
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
\`\`\`
    `);
}

function handleRoll(msg: Message, args: string): void {
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

    addReaction('t_ok', msg);
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
    const reaction = message.guild!.emojis.resolveIdentifier(emoji);

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

async function chinked(msg: Message, country: string): Promise<void> {
    country = country.trim().toLowerCase();

    if (country !== '') {
        try {
            const data = await request({
                method: 'GET',
                timeout: 10 * 1000,
                url: 'https://coronavirus-19-api.herokuapp.com/countries',
                json: true,
            });

            for (const countryData of data) {
                if (countryData.country.toLowerCase() === country) {
                    const embed = new MessageEmbed()
                        .setColor('#C8102E')
                        .setTitle('Coronavirus statistics, ' + countryData.country)
                        .setThumbnail('https://i.imgur.com/FnbQwqQ.png')
                        .addFields(
                            { name: 'Cases', value: countryData.cases, inline: true },
                            { name: 'Deaths', value: countryData.deaths, inline: true, },
                            { name: 'Active', value: countryData.active, inline: true, },
                            { name: 'Cases Today', value: countryData.todayCases, inline: true },
                            { name: 'Deaths Today', value: countryData.todayDeaths, inline: true },
                            { name: 'Recovered', value: countryData.recovered, inline: true },
                        )
                        .setFooter('Data source: https://www.worldometers.info/coronavirus/');

                    msg.channel.send(embed);

                    return;
                }
            }

            msg.reply('Unknown country, try one of the following: ' + data.map((x: any) => x.country).sort((a: string, b: string) => a.localeCompare(b)).join(', '));
        } catch (err) {
            msg.reply(`Failed to get stats :( [ ${err.toString()} ]`);
        }
    } else {
        try {
            const data = await request({
                method: 'GET',
                timeout: 10 * 1000,
                url: 'https://coronavirus-19-api.herokuapp.com/all',
                json: true,
            });

            const embed = new MessageEmbed()
                .setColor('#C8102E')
                .setTitle('Coronavirus statistics')
                .setThumbnail('https://i.imgur.com/FnbQwqQ.png')
                .addFields(
                    { name: 'Cases', value: data.cases },
                    { name: 'Deaths', value: data.deaths },
                    { name: 'Recovered', value: data.recovered },
                )
                .setFooter('Data source: https://www.worldometers.info/coronavirus/');

            msg.channel.send(embed);
        } catch (err) {
            msg.reply(`Failed to get stats :( [ ${err.toString()} ]`);
        }
    }
}

main();
