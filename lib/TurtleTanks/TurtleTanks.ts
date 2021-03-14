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
    'body1.png',
];

const faces = [
    't_boomer.png',
    't_cry.png',
    't_derp.png',
    't_gun.png',
    't_intrigue.png',
    't_jooooe_biden.png',
    't_kissy.png',
    't_lmao.png',
    't_mad.png',
    't_mono.png',
    't_nervous.png',
    't_ooh.png',
    't_sad.png',
    't_salute.png',
    't_scared.png',
    't_shrug.png',
    't_smile.png',
    't_sweat.png',
    't_think.png',
    't_xD.png',
    't_yawn.png',
];

async function randomTurtle(canvas: fabric.StaticCanvas) {
    const body = await loadImage('bodies/10%/' + pickRandomItem(bodies));
    const face = await loadImage('faces/10%/' + pickRandomItem(faces));

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
