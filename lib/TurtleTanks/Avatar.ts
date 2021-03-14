import { fabric } from 'fabric';

import { loadImage } from './Utilities';
import { pickRandomItem } from '../Utilities';

export const bodies = [
    'body1.png',
];

export const faces = [
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

export async function randomTurtle(canvas: fabric.StaticCanvas) {
    const bodyPromise = loadImage('bodies/10%/' + pickRandomItem(bodies));
    const facePromise = loadImage('faces/10%/' + pickRandomItem(faces));

    const [body, face] = await Promise.all([bodyPromise, facePromise]);

    canvas.setWidth(body.width!);
    canvas.setHeight(body.height!);

    canvas.add(body);
    canvas.add(face);
}
