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
const discord_js_1 = require("discord.js");
const Config_1 = require("./Config");
const util_1 = require("util");
const readFile = util_1.promisify(fs.readFile);
const writeFile = util_1.promisify(fs.writeFile);
const fit = '579918539830460417';
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
                handleRoll(msg);
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
        }
    });
    client.on('error', console.error);
    client.login(Config_1.config.token)
        .catch((err) => {
        console.error(err);
        main();
    });
}
function handleRoll(msg) {
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
