import {
    Message,
    MessageAttachment,
    MessageEmbed,
} from 'discord.js';

import { fabric } from 'fabric';
import { Database } from 'sqlite3';

import { map1 } from './CustomMaps';
import { MapTile } from './MapTile';
import { Player } from './Player';

import {
    MapManager,
    MapSpecification,
    COORDINATES_HEIGHT,
    COORDINATES_WIDTH,
} from './Map';

export class Game {
    private canvas: fabric.StaticCanvas;

    private map: MapManager;

    private initialRenderComplete: boolean = false;

    private players: Map<string, Player> = new Map();

    private canvasWidth: number;
    private canvasHeight: number;
    
    private tileWidth: number;
    private tileHeight: number;

    constructor(map?: MapSpecification) {
        const canvas = new fabric.StaticCanvas(null, {});

        if (map) {
            this.map = new MapManager(map);
        } else {
            this.map = new MapManager({
                height: 10,
                width: 10,
            });
        }

        const {
            width,
            height,
            tileWidth,
            tileHeight,
        } = this.map.dimensionsOnCanvas();

        canvas.setWidth(width);
        canvas.setHeight(height);

        this.canvas = canvas;
        this.canvasWidth = width;
        this.canvasHeight = height;
        this.tileHeight = tileHeight;
        this.tileWidth = tileWidth;
    }

    private async renderMap() {
        /* We only need to render the map once, since it should never change. */
        if (!this.initialRenderComplete) {
            await this.map.render(this.canvas, 0, 0);
            this.initialRenderComplete = true;
        }
    }

    private async renderPlayers(id?: string) {
        const { tileWidth, tileHeight } = this.map.dimensionsOnCanvas();

        const promises = [];

        for (const [playerID, player] of this.players) {
            const highlight: boolean = id !== undefined && id === playerID;

            promises.push(
                player.render(
                    this.canvas,
                    (player.x * tileWidth) + COORDINATES_WIDTH,
                    (player.y * tileHeight) + COORDINATES_HEIGHT,
                    highlight,
                ),
            );
        }

        await Promise.all(promises);
    }

    public async render(id?: string): Promise<void> {
        await this.renderMap();
        await this.renderPlayers(id);
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

    public join(userId: string) {
        if (this.players.has(userId)) {
            return 'You are already in the game!';
        }

        const square = this.map.getUnoccupiedSquare();

        if (square === undefined) {
            return 'Game is full, sorry.';
        }

        this.players.set(userId, new Player(userId, square.x, square.y));

        return;
    }

    public hasPlayer(userId: string) {
        return this.players.has(userId);
    }
}
