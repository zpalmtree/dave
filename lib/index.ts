import * as fs from 'fs';
import * as path from 'path';

import { Message, Client } from 'discord.js';

import { config } from './Config';

import { promisify } from 'util';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

const fit = '579918539830460417';

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
            case 'fortune': {
                handleFortune(msg);
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
        'Your fortune: Godly Luck ',
    ];

    var fortune = fortunes[Math.floor(Math.random() * fortunes.length)];

    msg.reply(`Your fortune: ${fortune}`);
}

function handleRoll(msg: Message): void {
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
