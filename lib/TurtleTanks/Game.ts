import {
    Message,
    MessageAttachment,
    MessageEmbed,
} from 'discord.js';

import { fabric } from 'fabric';

import { Database } from 'sqlite3';

import { Map } from './Map';
import { MapTile } from './MapTile';

export class Game {
    private canvas: fabric.StaticCanvas;

    private map: Map;

    constructor() {
        const canvas = new fabric.StaticCanvas(null, {});

        this.map = new Map(15, 15);

        const { width, height } = this.map.dimensionsOnCanvas();

        canvas.setWidth(width);
        canvas.setHeight(height);
        
        /* We only need to render the map once, since it should never change. */
        this.map.render(canvas, 0, 0);

        this.canvas = canvas;
    }

    public render(): void {
        this.canvas.renderAll();
    }

    /* Note: Note re-rendering here. Only need to re-render when game state
     * changes, not on every request to view the game state. */
    public getGameImage(): ReadableStream {
        return (this.canvas as any).createPNGStream();
    }

    public getGameImageAttachment(): MessageAttachment {
        return new MessageAttachment((this.canvas as any).createPNGStream(), 'turtle-tanks.png');
    }
}
