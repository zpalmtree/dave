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

import { dot_w, dot_h, shadowSvg, dotColors } from './Dot';

import * as convert from 'xml-js';
import { Image, createCanvas } from 'canvas';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

/* Optional number of rolls (for example 5d20), 'd', (to indicate a roll),
   one or more numbers - the dice to roll - then zero or more chars for an
   optional mathematical expression (for example, d20 + 3) */
const rollRegex: RegExp = new RegExp(/^(\d+)?d(\d+)(.*)$/, 'i');

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

async function dotpost(msg: Message, timespan: string): Promise<void> {
    try {
        await renderDotGraph(-86400);
        await renderDot()
        .then((dot) => {
            const embed = new MessageEmbed()
                .setColor('#C8102E')
                .attachFiles(['./dot.png', './dotGraph.png'])
                .setTitle('Global Conciousness Project Dot')
                .setThumbnail('attachment://dot.png')
                .setImage('attachment://dotGraph.png')
                .addFields(
                    { 
                        name: 'Current Network Variance',
                        value: `${Math.floor(dot * 100)}%`,
                        inline: true,
                    }
                );

            msg.channel.send(embed);
        });

    } catch (err) {
        msg.reply(`Failed to get dot data :( [ ${err.toString()} ]`);
    }
}

async function renderDot(): Promise<number> {
    let dotVal: number;
    const dotData = JSON.parse(convert.xml2json(await request({
        method: 'GET',
        timeout: 10000,
        url: 'http://gcpdot.com/gcpindex.php',
        json: false,
    }))).elements[0].elements;

    // the server sends back a full minute of data
    // we only need the current second
    let serverTime = dotData[0].elements[0].text;
    let currentDot = async () => {
        for (let item of dotData[1].elements) {
            if (item.attributes.t === serverTime) {
                dotVal = parseFloat(item.elements[0].text);
                return dotVal;
            }
        }
    }
    currentDot().then((dotData) => {
        // create dot canvas
        let dotCanvas = createCanvas(dot_w, dot_h);
        let dotContext = dotCanvas.getContext('2d');

        // create drop shadow svg
        let shadowImage = new Image();
        shadowImage.width = dot_w;
        shadowImage.height = dot_h;
        shadowImage.src = `data:image/svg+xml;base64,${Buffer.from(shadowSvg).toString('base64')}`;

        dotContext.fillStyle = 'rgba(255, 255, 255, 0)';
        dotContext.globalAlpha = 1.0;
        dotContext.drawImage(shadowImage, 0, 0);

        for (let j = 0; j < dotColors.length - 1; j++) {
            var opacity = (dotData! - dotColors[j].tail) / (dotColors[j + 1].tail - dotColors[j].tail);

            if (0 <= opacity && opacity <= 1) {
                dotContext.drawImage(dotColors[j].mc, 0, 0);
                if (dotColors[j].mc != dotColors[j + 1].mc) {
                    dotContext.globalAlpha = opacity;
                    dotContext.drawImage(dotColors[j + 1].mc, 0, 0);
                }
                break;
            }
        }
        return dotCanvas;
    })
    .then(async(dotCanvas) => {
        await writeFile('./dot.png', dotCanvas.toDataURL().replace(/^data:image\/png;base64,/, ""), 'base64');
    });
    return dotVal!;
};

async function renderDotGraph(timespan: number): Promise<void> {
    const cw = 325;
    const ch = 120;
    const inv_ch = 1.0 / ch;
    const shadowOffset = 10;

    var canvasShadow = createCanvas(cw, ch+shadowOffset*2);
    var canvas = createCanvas(cw, ch);
    var contextShadow = canvasShadow.getContext('2d');
    var context = canvas.getContext('2d');
    var outCanvas = createCanvas(cw, ch+shadowOffset*2);
    var outContext = outCanvas.getContext("2d");

    const graphData = JSON.parse(convert.xml2json(await request({
        method: 'GET',
        timeout: 10000,
        url: `http://global-mind.org/gcpdot/gcpgraph.php?pixels=${cw}&seconds=${timespan}`,
        json: false,
    }))).elements[0].elements;

    var svg = `<svg xmlns='http://www.w3.org/2000/svg' preserveAspectRatio='xMidYMid meet' width='${cw}' height='${ch}'>
        <defs>
            <linearGradient id='g' x1='0%' y1='0%' x2='0%' y2='100%'>
                <stop offset='0%' style='stop-color:#FF00FF;stop-opacity:1'/>
                <stop offset='1%' style='stop-color:#FF0000;stop-opacity:1'/>
                <stop offset='3.5%' style='stop-color:#FF4000;stop-opacity:1'/>
                <stop offset='6%' style='stop-color:#FF7500;stop-opacity:1'/>
                <stop offset='11%' style='stop-color:#FFB000;stop-opacity:1'/>
                <stop offset='22%' style='stop-color:#FFFF00;stop-opacity:1'/>
                <stop offset='50%' style='stop-color:#00df00;stop-opacity:1'/>
                <stop offset='90%' style='stop-color:#00df00;stop-opacity:1'/>
                <stop offset='94%' style='stop-color:#00EEFF;stop-opacity:1'/>
                <stop offset='99%' style='stop-color:#0034F4;stop-opacity:1'/>
                <stop offset='100%' style='stop-color:#440088;stop-opacity:1'/>
            </linearGradient>
        </defs>
        <rect width='100%' height='100%' fill='url(#g)'/>
    </svg>`;

    let bgImage = new Image();
    bgImage.onload = () => context.drawImage(bgImage, 0, 0);
    bgImage.src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    let imgBuffer = context.getImageData(0, 0, cw, ch);
    for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
            imgBuffer.data[(y * cw + x) * 4 + 3] = 0;
        }
    }

    let imgShadowBuffer = contextShadow.createImageData(bgImage.width + shadowOffset * 2, bgImage.height + shadowOffset * 2);

    for (let i = 0; i < graphData.length; i++) {
        graphData[i].top = parseFloat(graphData[i].attributes.t);
        graphData[i].bottom = parseFloat(graphData[i].attributes.b);
        graphData[i].q1 = parseFloat(graphData[i].attributes.q1);
        graphData[i].q3 = parseFloat(graphData[i].attributes.q3);

        if ((graphData[i].bottom - graphData[i].top) < inv_ch) {
            if (graphData[i].top > 0.5) {
                graphData[i].top -= inv_ch;
            }
        }
        for (let y = Math.floor(graphData[i].top * ch); y < graphData[i].bottom * ch; y++) {
            let ys = y / ch;
            let a = 0;
            if (ys > graphData[i].q1 && ys <= graphData[i].q3 || (graphData[i].bottom - graphData[i].top) < inv_ch * 1.5) {
                a = 1;
            } else if (ys > graphData[i].top && ys <= graphData[i].q1) {
                a = (ys - graphData[i].top) / (graphData[i].q1 - graphData[i].top);
            } else if (ys > graphData[i].q3 && ys <= graphData[i].bottom) {
                a = (graphData[i].bottom - ys) / (graphData[i].bottom - graphData[i].q3);
            }
            imgBuffer.data[(i + y * bgImage.width) * 4 + 3] = 255 * a;
            imgShadowBuffer.data[(i + (y + shadowOffset * 2) * (bgImage.width + shadowOffset * 2)) * 4 + 3] = Math.pow(a, 0.75) * 255;
        }
    }

    // blur the shadow
    stackBlurCanvasAlpha(imgShadowBuffer.data, bgImage.width + shadowOffset * 2, bgImage.height + shadowOffset * 2, 6);

    contextShadow.globalAlpha = 1.0;
    contextShadow.putImageData(imgShadowBuffer, shadowOffset, shadowOffset);

    context.globalAlpha = 1.0;
    context.putImageData(imgBuffer, 0, 0);

    outContext.fillStyle = '#525252';
    outContext.fillRect(0, 0, outCanvas.width, outCanvas.height);
    outContext.drawImage(canvasShadow, 0, 0);
    outContext.drawImage(canvas, 0, shadowOffset);

    writeFile('./dotGraph.png', outCanvas.toDataURL().replace(/^data:image\/png;base64,/, ""), 'base64');
}

main();

// the following code is a bunch of util garbo for doing gaussian blur
var mul_table = [
        512,512,456,512,328,456,335,512,405,328,271,456,388,335,292,512,
        454,405,364,328,298,271,496,456,420,388,360,335,312,292,273,512,
        482,454,428,405,383,364,345,328,312,298,284,271,259,496,475,456,
        437,420,404,388,374,360,347,335,323,312,302,292,282,273,265,512,
        497,482,468,454,441,428,417,405,394,383,373,364,354,345,337,328,
        320,312,305,298,291,284,278,271,265,259,507,496,485,475,465,456,
        446,437,428,420,412,404,396,388,381,374,367,360,354,347,341,335,
        329,323,318,312,307,302,297,292,287,282,278,273,269,265,261,512,
        505,497,489,482,475,468,461,454,447,441,435,428,422,417,411,405,
        399,394,389,383,378,373,368,364,359,354,350,345,341,337,332,328,
        324,320,316,312,309,305,301,298,294,291,287,284,281,278,274,271,
        268,265,262,259,257,507,501,496,491,485,480,475,470,465,460,456,
        451,446,442,437,433,428,424,420,416,412,408,404,400,396,392,388,
        385,381,377,374,370,367,363,360,357,354,350,347,344,341,338,335,
        332,329,326,323,320,318,315,312,310,307,304,302,299,297,294,292,
        289,287,285,282,280,278,275,273,271,269,267,265,263,261,259];
        
   
var shg_table = [
         9, 11, 12, 13, 13, 14, 14, 15, 15, 15, 15, 16, 16, 16, 16, 17, 
        17, 17, 17, 17, 17, 17, 18, 18, 18, 18, 18, 18, 18, 18, 18, 19, 
        19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 20, 20, 20,
        20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 21,
        21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
        21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 22, 22, 22, 22, 22, 22, 
        22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22,
        22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 23, 
        23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23,
        23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23,
        23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 
        23, 23, 23, 23, 23, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 
        24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
        24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
        24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
        24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24 ];

class BlurStack {
    public a: number
    public next: any
    constructor() {
        //this.r = 0;
        //this.g = 0;
        //this.b = 0;
        //var that = this;
        this.a = 0;
        this.next = null; 
    }
}

function stackBlurCanvasAlpha(pixels: any, width: number, height: number, radius: number) {
    if ( isNaN(radius) || radius < 1 ) return;
    radius |= 0;
    
            
    var x, y, i, p, yp, yi, yw, r_sum, g_sum, b_sum, a_sum, 
    r_out_sum, g_out_sum, b_out_sum, a_out_sum,
    r_in_sum, g_in_sum, b_in_sum, a_in_sum, 
    pr, pg, pb, pa, rbs;
            
    var div = radius + radius + 1;
    var w4 = width << 2;
    var widthMinus1  = width - 1;
    var heightMinus1 = height - 1;
    var radiusPlus1  = radius + 1;
    var sumFactor = radiusPlus1 * ( radiusPlus1 + 1 ) / 2;
    
    var stackStart = new BlurStack();
    var stack = stackStart;
    var stackEnd: any;
    for ( i = 1; i < div; i++ ) {
        stack = stack.next = new BlurStack();
        if ( i == radiusPlus1 ) stackEnd = stack;
    }
    stack.next = stackStart;
    var stackIn = null;
    var stackOut = null;
    
    yw = yi = 0;
    
    var mul_sum = mul_table[radius];
    var shg_sum = shg_table[radius];
    
    for ( y = 0; y < height; y++ ) {
        r_in_sum = g_in_sum = b_in_sum = a_in_sum = r_sum = g_sum = b_sum = a_sum = 0;
        
        //r_out_sum = radiusPlus1 * ( pr = pixels[yi] );
        //g_out_sum = radiusPlus1 * ( pg = pixels[yi+1] );
        //b_out_sum = radiusPlus1 * ( pb = pixels[yi+2] );
        a_out_sum = radiusPlus1 * ( pa = pixels[yi+3] );
        
        //r_sum += sumFactor * pr;
        //g_sum += sumFactor * pg;
        //b_sum += sumFactor * pb;
        a_sum += sumFactor * pa;
        
        stack = stackStart;
        
        for( i = 0; i < radiusPlus1; i++ ) {
            //stack.r = pr;
            //stack.g = pg;
            //stack.b = pb;
            stack.a = pa;
            stack = stack.next;
        }
        
        for( i = 1; i < radiusPlus1; i++ ) {
            p = yi + (( widthMinus1 < i ? widthMinus1 : i ) << 2 );
            //r_sum += ( stack.r = ( pr = pixels[p])) * ( rbs = radiusPlus1 - i );
            //g_sum += ( stack.g = ( pg = pixels[p+1])) * rbs;
            //b_sum += ( stack.b = ( pb = pixels[p+2])) * rbs;
            a_sum += ( stack.a = ( pa = pixels[p+3])) * (radiusPlus1 - i);
            
            //r_in_sum += pr;
            //g_in_sum += pg;
            //b_in_sum += pb;
            a_in_sum += pa;
            
            stack = stack.next;
        }
        
        stackIn = stackStart;
        stackOut = stackEnd;
        for ( x = 0; x < width; x++ ) {
            pixels[yi+3] = pa = (a_sum * mul_sum) >> shg_sum;
            if ( pa != 0 ) {
                //pa = 255 / pa;
                //pixels[yi]   = ((r_sum * mul_sum) >> shg_sum) * pa;
                //pixels[yi+1] = ((g_sum * mul_sum) >> shg_sum) * pa;
                //pixels[yi+2] = ((b_sum * mul_sum) >> shg_sum) * pa;
            } else {
                //pixels[yi] = pixels[yi+1] = pixels[yi+2] = 0;
            }
            
            //r_sum -= r_out_sum;
            //g_sum -= g_out_sum;
            //b_sum -= b_out_sum;
            a_sum -= a_out_sum;
            
            //r_out_sum -= stackIn.r;
            //g_out_sum -= stackIn.g;
            //b_out_sum -= stackIn.b;
            a_out_sum -= stackIn.a;
            
            p =  ( yw + ( ( p = x + radius + 1 ) < widthMinus1 ? p : widthMinus1 ) ) << 2;
            
            //r_in_sum += ( stackIn.r = pixels[p]);
            //g_in_sum += ( stackIn.g = pixels[p+1]);
            //b_in_sum += ( stackIn.b = pixels[p+2]);
            a_in_sum += ( stackIn.a = pixels[p+3]);
            
            //r_sum += r_in_sum;
            //g_sum += g_in_sum;
            //b_sum += b_in_sum;
            a_sum += a_in_sum;
            
            stackIn = stackIn.next;
            
            //r_out_sum += ( pr = stackOut.r );
            //g_out_sum += ( pg = stackOut.g );
            //b_out_sum += ( pb = stackOut.b );
            a_out_sum += ( pa = stackOut.a );
            
            //r_in_sum -= pr;
            //g_in_sum -= pg;
            //b_in_sum -= pb;
            a_in_sum -= pa;
            
            stackOut = stackOut.next;

            yi += 4;
        }
        yw += width;
    }

    
    for ( x = 0; x < width; x++ ) {
        g_in_sum = b_in_sum = a_in_sum = r_in_sum = g_sum = b_sum = a_sum = r_sum = 0;
        
        yi = x << 2;
        //r_out_sum = radiusPlus1 * ( pr = pixels[yi]);
        //g_out_sum = radiusPlus1 * ( pg = pixels[yi+1]);
        //b_out_sum = radiusPlus1 * ( pb = pixels[yi+2]);
        a_out_sum = radiusPlus1 * ( pa = pixels[yi+3]);
        
        //r_sum += sumFactor * pr;
        //g_sum += sumFactor * pg;
        //b_sum += sumFactor * pb;
        a_sum += sumFactor * pa;
        
        stack = stackStart;
        
        for( i = 0; i < radiusPlus1; i++ ) {
            //stack.r = pr;
            //stack.g = pg;
            //stack.b = pb;
            stack.a = pa;
            stack = stack.next;
        }
        
        yp = width;
        
        for( i = 1; i <= radius; i++ ) {
            yi = ( yp + x ) << 2;
            
            //r_sum += ( stack.r = ( pr = pixels[yi])) * ( rbs = radiusPlus1 - i );
            //g_sum += ( stack.g = ( pg = pixels[yi+1])) * rbs;
            //b_sum += ( stack.b = ( pb = pixels[yi+2])) * rbs;
            a_sum += ( stack.a = ( pa = pixels[yi+3])) * (radiusPlus1 - i);
           
            //r_in_sum += pr;
            //g_in_sum += pg;
            //b_in_sum += pb;
            a_in_sum += pa;
            
            stack = stack.next;
        
            if( i < heightMinus1 )
            {
                yp += width;
            }
        }
        
        yi = x;
        stackIn = stackStart;
        stackOut = stackEnd;
        for ( y = 0; y < height; y++ ) {
            p = yi << 2;
            pixels[p+3] = pa = (a_sum * mul_sum) >> shg_sum;
            if ( pa > 0 )
            {
                pa = 255 / pa;
                //pixels[p]   = ((r_sum * mul_sum) >> shg_sum ) * pa;
                //pixels[p+1] = ((g_sum * mul_sum) >> shg_sum ) * pa;
                //pixels[p+2] = ((b_sum * mul_sum) >> shg_sum ) * pa;
            } else {
                //pixels[p] = pixels[p+1] = pixels[p+2] = 0;
            }
            
            //r_sum -= r_out_sum;
            //g_sum -= g_out_sum;
            //b_sum -= b_out_sum;
            a_sum -= a_out_sum;
           
            //r_out_sum -= stackIn.r;
            //g_out_sum -= stackIn.g;
            //b_out_sum -= stackIn.b;
            a_out_sum -= stackIn.a;
            
            p = ( x + (( ( p = y + radiusPlus1) < heightMinus1 ? p : heightMinus1 ) * width )) << 2;
            
            //r_sum += ( r_in_sum += ( stackIn.r = pixels[p]));
            //g_sum += ( g_in_sum += ( stackIn.g = pixels[p+1]));
            //b_sum += ( b_in_sum += ( stackIn.b = pixels[p+2]));
            a_sum += ( a_in_sum += ( stackIn.a = pixels[p+3]));
           
            stackIn = stackIn.next;
            
            //r_out_sum += ( pr = stackOut.r );
            //g_out_sum += ( pg = stackOut.g );
            //b_out_sum += ( pb = stackOut.b );
            a_out_sum += ( pa = stackOut.a );
            
            //r_in_sum -= pr;
            //g_in_sum -= pg;
            //b_in_sum -= pb;
            a_in_sum -= pa;
            
            stackOut = stackOut.next;
            
            yi += width;
        }
    }
    
}
