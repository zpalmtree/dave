import {
    Message,
    MessageAttachment,
    MessageEmbed,
} from 'discord.js';

import { fabric } from 'fabric';

import { Database } from 'sqlite3';

import { loadImage } from './Utilities';
import { pickRandomItem } from '../Utilities';
import { Game } from './Game';

const bodies = [
    'bodies/body1.png',
];

const faces = [
    'faces/t_boomer.png',
    'faces/t_cry.png',
    'faces/t_derp.png',
    'faces/t_gun.png',
    'faces/t_intrigue.png',
    'faces/t_kissy.png',
    'faces/t_lmao.png',
    'faces/t_mad.png',
    'faces/t_mono.png',
    'faces/t_nervous.png',
    'faces/t_ooh.png',
    'faces/t_sad.png',
    'faces/t_salute.png',
    'faces/t_scared.png',
    'faces/t_shrug.png',
    'faces/t_smile.png',
    'faces/t_sweat.png',
    'faces/t_think.png',
    'faces/t_xD.png',
    'faces/t_yawn.png',
];

async function randomTurtle(canvas: fabric.StaticCanvas) {
    const body = await loadImage(pickRandomItem(bodies));
    const face = await loadImage(pickRandomItem(faces));

    canvas.setWidth(body.width!);
    canvas.setHeight(body.height!);

    canvas.add(body);
    canvas.add(face);
}

export async function handleTurtle(msg: Message) {
    const canvas = new fabric.StaticCanvas(null, {});

    await randomTurtle(canvas);

    canvas.renderAll();

    const attachment = new MessageAttachment((canvas as any).createPNGStream(), 'turtle.png');

    msg.reply(attachment);
}

export async function handleTurtleTanks(msg: Message, args: string[], db: Database) {
    const game = new Game();

    const gameImage = await game.render();

    const attachment = game.getGameImageAttachment();

    msg.reply(attachment);
}
