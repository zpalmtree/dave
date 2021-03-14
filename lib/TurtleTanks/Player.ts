import { fabric } from 'fabric';

import { loadImage } from './Utilities';
import { pickRandomItem } from '../Utilities';
import { faces, bodies } from './Avatar';
import { PIXELS_PER_TILE } from './MapTile';
import { IRenderable } from './IRenderable';

export class Player implements IRenderable {
    public userId: string;

    public x: number;
    public y: number;

    constructor(
        userId: string,
        x: number = 0,
        y: number = 0) {

        this.userId = userId;
        this.x = x;
        this.y = y;
    }

    public async render(
        canvas: fabric.StaticCanvas,
        widthOffset: number,
        heightOffset: number) {

        const bodyPromise = loadImage('bodies/1.5%/' + pickRandomItem(bodies));
        const facePromise = loadImage('faces/1.5%/' + pickRandomItem(faces));

        const [body, face] = await Promise.all([bodyPromise, facePromise]);

        body.set({
            left: widthOffset,
            top: heightOffset + (PIXELS_PER_TILE * 0.2),
        });

        face.set({
            left: widthOffset,
            top: heightOffset + (PIXELS_PER_TILE * 0.2),
        });

        canvas.add(body);
        canvas.add(face);
    }

    public dimensionsOnCanvas() {
        return {
            width: PIXELS_PER_TILE,
            height: PIXELS_PER_TILE,
        }
    }
}
