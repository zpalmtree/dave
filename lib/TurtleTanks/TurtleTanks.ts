import {
    Message,
    MessageAttachment,
    MessageEmbed,
} from 'discord.js';

import { fabric } from 'fabric';

import { Database } from 'sqlite3';

import { Game } from './Game';
import { randomTurtle } from './Avatar';

export async function handleTurtle(msg: Message) {
    const canvas = new fabric.StaticCanvas(null, {});

    await randomTurtle(canvas);

    canvas.renderAll();

    const attachment = new MessageAttachment((canvas as any).createPNGStream(), 'turtle.png');

    msg.reply(attachment);
}

export async function handleTurtleTanks(msg: Message, args: string[], db: Database) {
    const game = new Game();

    game.addTestPlayers();

    const gameImage = await game.render();

    const attachment = game.getGameImageAttachment();

    msg.reply(attachment);
}
