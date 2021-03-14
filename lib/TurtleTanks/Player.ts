import { fabric } from 'fabric';

import { loadImage } from './Utilities';
import { pickRandomItem } from '../Utilities';
import { faces, bodies } from './Avatar';
import { PIXELS_PER_TILE } from './MapTile';

export class Player {
    public userId: string;

    public x: number;
    public y: number;

    private body: fabric.Image | undefined;
    private face: fabric.Image | undefined;
    private highlight: fabric.Circle | undefined;

    constructor(
        userId: string,
        x: number = 0,
        y: number = 0) {

        this.userId = userId;
        this.x = x;
        this.y = y;
    }

    private async init(canvas: fabric.StaticCanvas) {
        if (this.body && this.face && this.highlight) {
            return;
        }

        const bodyPromise = loadImage('bodies/2%/' + pickRandomItem(bodies));
        const facePromise = loadImage('faces/2%/' + pickRandomItem(faces));

        this.body = await bodyPromise;
        this.face = await facePromise;
        this.highlight = new fabric.Circle({
            radius: (PIXELS_PER_TILE / 2) * 0.8,
            stroke: '#ff0000',
            strokeWidth: 5,
            fill: 'rgba(0,0,0,0)',
        });

        canvas.add(this.highlight);
        canvas.add(this.body);
        canvas.add(this.face);
    }

    public async render(
        canvas: fabric.StaticCanvas,
        widthOffset: number,
        heightOffset: number,
        highlightPlayer: boolean) {

        await this.init(canvas);

        this.body!.set({
            left: widthOffset,
            top: heightOffset + (PIXELS_PER_TILE * 0.2),
        });

        this.face!.set({
            left: widthOffset,
            top: heightOffset + (PIXELS_PER_TILE * 0.2),
        });

        if (highlightPlayer) {
            this.highlight!.set({
                left: widthOffset + (PIXELS_PER_TILE * 0.06),
                top: heightOffset + (PIXELS_PER_TILE * 0.06),
            });
        }

        this.highlight!.visible = highlightPlayer;
    }

    public dimensionsOnCanvas() {
        return {
            width: PIXELS_PER_TILE,
            height: PIXELS_PER_TILE,
        }
    }
}
