"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const path = require("path");
const request = require("request-promise-native");
const discord_js_1 = require("discord.js");
const util_1 = require("util");
const mathjs_1 = require("mathjs");
const Config_1 = require("./Config");
const readFile = util_1.promisify(fs.readFile);
const writeFile = util_1.promisify(fs.writeFile);
const fit = '579918539830460417';
/* Optional number of rolls (for example 5d20), 'd', (to indicate a roll),
   one or more numbers - the dice to roll - then zero or more chars for an
   optional mathematical expression (for example, d20 + 3) */
const rollRegex = new RegExp(/^(\d+)?d(\d+)(.*)$/, 'i');
const breeds = {
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
    const client = new discord_js_1.Client();
    client.on('ready', () => {
        console.log('Logged in');
    });
    client.on('message', (msg) => {
        if (!msg.content.startsWith(Config_1.config.prefix)) {
            return;
        }
        /* Get the command with prefix, and any args */
        const [tmp, ...args] = msg.content.split(' ');
        /* Get the actual command after the prefix is removed */
        const command = tmp.substring(tmp.indexOf(Config_1.config.prefix) + 1, tmp.length);
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
    client.login(Config_1.config.token)
        .catch((err) => {
        console.error(err);
        main();
    });
}
function handleFortune(msg) {
    const fortunes = [
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
function handleMath(msg, args) {
    try {
        msg.reply(mathjs_1.evaluate(args).toString());
    }
    catch (err) {
        msg.reply('Bad mathematical expression: ' + err.toString());
    }
}
/* Rolls the die given. E.g. diceRoll(6) gives a number from 1-6 */
function diceRoll(die) {
    return Math.ceil(Math.random() * die);
}
function handleDiceRoll(msg, args) {
    const badRoll = 'Invalid roll. Examples: 5d20, d8 + 3, 10d10 * 2';
    let [, numDiceStr, dieStr, mathExpression] = rollRegex.exec(args) || [undefined, undefined, undefined, undefined];
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
    let response = `Roll ${args}: ${mathExpression === undefined ? '' : '('}`;
    let result = 0;
    for (let i = 0; i < numDice; i++) {
        const rollResult = diceRoll(die);
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
            const expression = result.toString() + mathExpression;
            response += mathExpression;
            result = mathjs_1.evaluate(expression);
        }
        catch (err) {
            msg.reply('Bad mathematical expression: ' + err.toString());
            return;
        }
    }
    if (numDice !== 1 || mathExpression !== undefined) {
        response += ' = ' + result.toString();
    }
    msg.reply(response);
}
function handleRoll(msg, args) {
    args = args.trim();
    /* Is it a dice roll - d + number, for example, d20, 5d20, d6 + 3 */
    if (/d\d/.test(args)) {
        handleDiceRoll(msg, args);
        return;
    }
    const dubsReaction = dubsType(msg.id);
    msg.reply(`Your post number is: ${msg.id} ${dubsReaction}`);
}
function dubsType(roll) {
    /* Reverse */
    roll = roll.split('').reverse().join('');
    const initial = roll[0];
    let dubsStripped = roll;
    while (dubsStripped[0] === initial) {
        dubsStripped = dubsStripped.substr(1);
    }
    /* Find the amount of repeating digits of the roll */
    const numRepeatingDigits = roll.length - dubsStripped.length;
    /* No dubs :( */
    if (numRepeatingDigits === 1) {
        const firstNum = Number(initial);
        const secondNum = Number(roll[1]);
        if (Math.max(firstNum + 1, 0) % 10 === secondNum ||
            Math.max(firstNum - 1, 0) % 10 === secondNum) {
            return '- Off by one :(';
        }
        return '';
    }
    const dubTypes = [
        '\\~\\~ nice dubs \\~\\~',
        '\\*\\* sick trips \\*\\*',
        '## !QUADS! ##',
        '\\\\ !!QUINTS!! //',
        '!!!! SEXTUPLES !!!!',
        '!!!!! SEPTUPLES !!!!!',
        '!!!!!!!! BLESSED OCTS !!!!!!!!',
    ];
    /* Start at dubs */
    const index = numRepeatingDigits - 2;
    if (index >= dubTypes.length) {
        return 'OFF THE FUCKING CHARTS';
    }
    return dubTypes[index];
}
function readQuotes(filepath) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const data = yield readFile(path.join(__dirname, filepath), { encoding: 'utf8' });
            const quotes = JSON.parse(data);
            return [true, quotes];
        }
        catch (err) {
            console.log(err);
            return [false, []];
        }
    });
}
function writeQuotes(filepath, quotes) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            yield writeFile(path.join(__dirname, filepath), quotes);
        }
        catch (err) {
            console.log(err);
        }
    });
}
function handleQuote(msg) {
    return __awaiter(this, void 0, void 0, function* () {
        if (msg.channel.id !== fit) {
            return;
        }
        const [success, quotes] = yield readQuotes('./quotes.json');
        if (!success) {
            msg.reply('Crap, couldn\'t open the quotes file :(');
            return;
        }
        const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
        msg.channel.send(randomQuote);
    });
}
function handleSuggest(msg, suggestion) {
    return __awaiter(this, void 0, void 0, function* () {
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
        const [success, quotes] = yield readQuotes('./quotes.json');
        if (!success) {
            msg.reply('Crap, couldn\'t open the quotes file :(');
            return;
        }
        quotes.push(suggestion);
        yield writeQuotes('quotes.json', JSON.stringify(quotes, null, 4));
        addReaction('t_ok', msg);
    });
}
function handleDoggo(msg, breed) {
    return __awaiter(this, void 0, void 0, function* () {
        let mainBreed = '';
        let subBreed = '';
        if (breed.length === 2) {
            let [x, y] = breed;
            x = x.trim().toLowerCase();
            y = y.trim().toLowerCase();
            if (breeds.hasOwnProperty(x)) {
                mainBreed = x;
            }
            else if (breeds.hasOwnProperty(y)) {
                mainBreed = y;
            }
            else {
                msg.reply('Unknown breed/sub-breed: ' + x + ' ' + y);
            }
            if (breeds[mainBreed].includes(x)) {
                subBreed = x;
            }
            else if (breeds[mainBreed].includes(y)) {
                subBreed = y;
            }
            else {
                msg.reply('Unknown breed/sub-breed: ' + x + ' ' + y);
            }
        }
        else if (breed.length === 1) {
            let [x] = breed;
            x = x.trim().toLowerCase();
            if (breeds.hasOwnProperty(x)) {
                mainBreed = x;
            }
            else {
                msg.reply('Unknown breed: ' + x);
            }
        }
        console.log('Breed: ' + mainBreed);
        console.log('Subbreed: ' + subBreed);
        const url = mainBreed !== '' && subBreed !== ''
            ? `https://dog.ceo/api/breed/${mainBreed}/${subBreed}/images/random`
            : mainBreed !== ''
                ? `https://dog.ceo/api/breed/${mainBreed}/images/random`
                : 'https://dog.ceo/api/breeds/image/random';
        try {
            const data = yield request({
                method: 'GET',
                timeout: 10 * 1000,
                url,
                json: true,
            });
            if (data.status !== 'success' || !data.message) {
                msg.reply(`Failed to get doggo pic :( [ ${JSON.stringify(data)} ]`);
                return;
            }
            const attachment = new discord_js_1.Attachment(data.message);
            msg.channel.send(attachment);
        }
        catch (err) {
            msg.reply(`Failed to get doggo pic :( [ ${err.toString()} ]`);
        }
    });
}
function addReaction(emoji, message) {
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
