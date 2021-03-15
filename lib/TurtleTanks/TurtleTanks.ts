import {
    Message,
    MessageAttachment,
    MessageEmbed,
} from 'discord.js';

import { fabric } from 'fabric';

import { Database } from 'sqlite3';

import {
    randomTurtle,
    faces,
    specificTurtle,
} from './Avatar';

import {
    parseCoordinate,
    addMoveReactions,
} from './Utilities';

import { Game } from './Game';
import { map1 } from './Maps';
import { config } from '../Config';


export async function handleTurtle(msg: Message, face: string) {
    const canvas = new fabric.StaticCanvas(null, {});

    const filePath = face
        ? face + '.png'
        : '';

    const outputFileName = filePath === ''
        ? 'turtle.png'
        : filePath;

    if (faces.includes(filePath)) {
        await specificTurtle(canvas, filePath);
    } else {
        await randomTurtle(canvas);
    }

    canvas.renderAll();

    const attachment = new MessageAttachment((canvas as any).createPNGStream(), outputFileName);

    msg.reply(attachment);
}

let storedGames: Map<string, Game> = new Map();

function createAndJoinGameIfNeeded(msg: Message): [Game, string] {
    let content = '';

    if (!storedGames.has(msg.channel.id)) {
        storedGames.set(msg.channel.id, new Game(map1, msg.guild || undefined));
        content = 'Created new game! ';
    }

    const game = storedGames.get(msg.channel.id)!;

    if (!game.hasPlayer(msg.author.id)) {
        const err = game.join(msg.author.id);

        if (err) {
            content += err;
        } else {
            content += 'You have successfully joined the game!';
        }
    }

    return [game, content];
}

export async function handleTurtleTanks(msg: Message, args: string[], db: Database) {
    const [game, content] = createAndJoinGameIfNeeded(msg);
    const attachment = await game.renderAndGetAttachment();

    let sentMessage;

    if (content !== '') {
        sentMessage = await msg.reply(content, attachment);
    } else {
        sentMessage = await msg.reply(attachment);
    }

    await addMoveReactions(sentMessage, game);
}

export async function handleTankMove(msg: Message, coordStr: string) {
    const [game, content] = createAndJoinGameIfNeeded(msg);

    const currentCoords = game.fetchPlayerLocation(msg.author.id);

    if (!currentCoords) {
        msg.reply('User is not in game');
        return;
    }

    const coords = parseCoordinate(coordStr, currentCoords);

    if (!coords) {
        msg.reply(`Failed to parse coordinates. Try \`${config.prefix}tanks help\``);
        return;
    }

    const [canMove, moveErr] = await game.canMove(msg.author.id, coords);

    if (!canMove) {
        msg.reply(moveErr);
        return;
    }

    await game.confirmMove(msg.author.id, msg, coords);
}
