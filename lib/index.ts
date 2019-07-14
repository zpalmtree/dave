import * as fs from 'fs';
import * as path from 'path';

import request = require('request-promise-native');

import { Message, Client, Attachment } from 'discord.js';

import { promisify } from 'util';

import { evaluate } from 'mathjs';

import { config } from './Config';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

const fit = '579918539830460417';

/* Optional number of rolls (for example 5d20), 'd', (to indicate a roll),
   one or more numbers - the dice to roll - then zero or more chars for an
   optional mathematical expression (for example, d20 + 3) */
const rollRegex: RegExp = new RegExp(/^(\d+)?d(\d+)(.*)$/, 'i');

const breeds: any = {
  "affenpinscher": [],
  "african": [],
  "airedale": [],
  "akita": [],
  "appenzeller": [],
  "basenji": [],
  "beagle": [],
  "bluetick": [],
  "borzoi": [],
  "bouvier": [],
  "boxer": [],
  "brabancon": [],
  "briard": [],
  "bulldog": [
    "boston",
    "english",
    "french"
  ],
  "bullterrier": [
    "staffordshire"
  ],
  "cairn": [],
  "cattledog": [
    "australian"
  ],
  "chihuahua": [],
  "chow": [],
  "clumber": [],
  "cockapoo": [],
  "collie": [
    "border"
  ],
  "coonhound": [],
  "corgi": [
    "cardigan"
  ],
  "cotondetulear": [],
  "dachshund": [],
  "dalmatian": [],
  "dane": [
    "great"
  ],
  "deerhound": [
    "scottish"
  ],
  "dhole": [],
  "dingo": [],
  "doberman": [],
  "elkhound": [
    "norwegian"
  ],
  "entlebucher": [],
  "eskimo": [],
  "frise": [
    "bichon"
  ],
  "germanshepherd": [],
  "greyhound": [
    "italian"
  ],
  "groenendael": [],
  "hound": [
    "afghan",
    "basset",
    "blood",
    "english",
    "ibizan",
    "walker"
  ],
  "husky": [],
  "keeshond": [],
  "kelpie": [],
  "komondor": [],
  "kuvasz": [],
  "labrador": [],
  "leonberg": [],
  "lhasa": [],
  "malamute": [],
  "malinois": [],
  "maltese": [],
  "mastiff": [
    "bull",
    "english",
    "tibetan"
  ],
  "mexicanhairless": [],
  "mix": [],
  "mountain": [
    "bernese",
    "swiss"
  ],
  "newfoundland": [],
  "otterhound": [],
  "papillon": [],
  "pekinese": [],
  "pembroke": [],
  "pinscher": [
    "miniature"
  ],
  "pointer": [
    "german",
    "germanlonghair"
  ],
  "pomeranian": [],
  "poodle": [
    "miniature",
    "standard",
    "toy"
  ],
  "pug": [],
  "puggle": [],
  "pyrenees": [],
  "redbone": [],
  "retriever": [
    "chesapeake",
    "curly",
    "flatcoated",
    "golden"
  ],
  "ridgeback": [
    "rhodesian"
  ],
  "rottweiler": [],
  "saluki": [],
  "samoyed": [],
  "schipperke": [],
  "schnauzer": [
    "giant",
    "miniature"
  ],
  "setter": [
    "english",
    "gordon",
    "irish"
  ],
  "sheepdog": [
    "english",
    "shetland"
  ],
  "shiba": [],
  "shihtzu": [],
  "spaniel": [
    "blenheim",
    "brittany",
    "cocker",
    "irish",
    "japanese",
    "sussex",
    "welsh"
  ],
  "springer": [
    "english"
  ],
  "stbernard": [],
  "terrier": [
    "american",
    "australian",
    "bedlington",
    "border",
    "dandie",
    "fox",
    "irish",
    "kerryblue",
    "lakeland",
    "norfolk",
    "norwich",
    "patterdale",
    "russell",
    "scottish",
    "sealyham",
    "silky",
    "tibetan",
    "toy",
    "westhighland",
    "wheaten",
    "yorkshire"
  ],
  "vizsla": [],
  "weimaraner": [],
  "whippet": [],
  "wolfhound": [
    "irish"
  ]
};

function main() {
    const client = new Client();

    client.on('ready', () => {
        console.log('Logged in');
    });

    client.on('message', (msg: Message) => {
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
    const fortunes: string[] = [
        'Reply hazy, try again',
        'Excellent Luck',
        'Good Luck',
        'Average Luck',
        'Bad Luck',
        'Good news will come to you by mail',
        '（　´_ゝ`）ﾌｰﾝ',
        'ｷﾀ━━━━━━(ﾟ∀ﾟ)━━━━━━ !!!!',
        'You will meet a dark handsome stranger',
        'Better not tell you now',
        'Outlook good',
        'Very Bad Luck',
        'Godly Luck ',
    ];

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

    const dubTypes: string[] = [
        '\\~\\~ nice dubs \\~\\~',
        '\\*\\* sick trips \\*\\*',
        '## !QUADS! ##',
        '\\\\ !!QUINTS!! //',
        '!!!! SEXTUPLES !!!!',
        '!!!!! SEPTUPLES !!!!!',
        '!!!!!!!! BLESSED OCTS !!!!!!!!',
    ];

    /* Start at dubs */
    const index: number = numRepeatingDigits - 2;

    if (index >= dubTypes.length) {
        return 'OFF THE FUCKING CHARTS';
    }

    return dubTypes[index];
}

async function readQuotes(filepath: string): Promise<[boolean, string[]]> {
    try {
        const data: string = await readFile(path.join(__dirname, filepath), { encoding: 'utf8' });
        const quotes: string[] = JSON.parse(data);

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
    if (msg.channel.id !== fit) {
        return;
    }

    const [success, quotes] = await readQuotes('./quotes.json');

    if (!success) {
        msg.reply('Crap, couldn\'t open the quotes file :(');
        return;
    }

    const randomQuote: string = quotes[Math.floor(Math.random() * quotes.length)];

    msg.channel.send(randomQuote);
}

async function handleSuggest(msg: Message, suggestion: string | undefined): Promise<void> {
    if (msg.channel.id !== fit) {
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

    quotes.push(suggestion);

    await writeQuotes('quotes.json', JSON.stringify(quotes, null, 4));

    addReaction('t_ok', msg);
}

async function handleDoggo(msg: Message, breed: string[]): Promise<void> {
    let mainBreed: string = '';
    let subBreed: string = '';

    if (breed.length === 2) {
        let [ x, y ] = breed;

        x = x.trim().toLowerCase();
        y = y.trim().toLowerCase();

        if (breeds.hasOwnProperty(x)) {
            mainBreed = x;
        } else if (breeds.hasOwnProperty(y)) {
            mainBreed = y;
        } else {
            msg.reply('Unknown breed/sub-breed: ' + x + ' ' + y);
        }

        if (breeds[mainBreed].includes(x)) {
            subBreed = x;
        } else if (breeds[mainBreed].includes(y)) {
            subBreed = y;
        } else {
            msg.reply('Unknown breed/sub-breed: ' + x + ' ' + y);
        }
    } else if (breed.length === 1) {
        let [ x ] = breed;

        x = x.trim().toLowerCase();

        if (breeds.hasOwnProperty(x)) {
            mainBreed = x;
        }  else {
            msg.reply('Unknown breed: ' + x);
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

        const attachment = new Attachment(data.message);

        msg.channel.send(attachment);
    } catch (err) {
        msg.reply(`Failed to get doggo pic :( [ ${err.toString()} ]`);
    }
}

function addReaction(emoji: string, message: Message): void {
    /* Find the reaction */
    const reaction = message.guild.emojis.find((val) => val.name === emoji);

    /* Couldn't find the reaction */
    if (!reaction) {
        console.error(`Failed to find emoji: ${emoji} on the server!`);
        return;
    }

    /* Add the reaction */
    message.react(reaction).catch(console.error);
}

main();
