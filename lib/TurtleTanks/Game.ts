import {
    Message,
    MessageAttachment,
    MessageEmbed,
} from 'discord.js';

import { fabric } from 'fabric';

import { Database } from 'sqlite3';

import { map1 } from './CustomMaps';
import { Map } from './Map';
import { MapTile } from './MapTile';
import { Player } from './Player';

export class Game {
    private canvas: fabric.StaticCanvas;

    private map: Map;

    private initialRenderComplete: boolean = false;

    private players: Player[] = [];

    constructor() {
        const canvas = new fabric.StaticCanvas(null, {});

        this.map = new Map({ height: 10, width: 10 });

        const { width, height } = this.map.dimensionsOnCanvas();

        canvas.setWidth(width);
        canvas.setHeight(height);

        this.canvas = canvas;
    }

    public async render(): Promise<void> {
        /* We only need to render the map once, since it should never change. */
        if (!this.initialRenderComplete) {
            await this.map.render(this.canvas, 0, 0);
            this.initialRenderComplete = true;
        }

        const { tileWidth, tileHeight } = this.map.dimensionsOnCanvas();

        const promises = [];

        for (const player of this.players) {
            promises.push(
                player.render(
                    this.canvas,
                    player.x * tileWidth,
                    player.y * tileHeight
                ),
            );
        }

        await Promise.all(promises);

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

    public addPlayer(userId: string) {
        this.players.push(new Player(userId));
    }

    public addTestPlayers() {
        for (let width = 0; width < this.map.width; width++) {
            for (let height = 0; height < this.map.height; height++) {
                this.players.push(new Player('', width, height));
            }
        }
    }
}
