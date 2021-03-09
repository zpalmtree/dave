import { fabric } from 'fabric';

import { MapTile } from './MapTile';
import { IRenderable } from './IRenderable';

export class Map implements IRenderable {
    private map: MapTile[][];

    /* The width of the map in tiles */
    public width: number;

    /* The height of the map in tiles */
    public height: number;

    /* The width of the map in pixels */
    private mapWidth: number;

    /* The height of the map in pixels */
    private mapHeight: number;

    /* The height of tiles in pixels */
    private tileHeight: number;

    /* The width of tiles in pixels */
    private tileWidth: number;

    constructor(
        width: number,
        height: number,
    ) {
        if (width < 1 || Math.floor(width) !== width) {
            throw new Error('Invalid width');
        }

        if (height < 1 || Math.floor(height) !== height) {
            throw new Error('Invalid height');
        }

        const map: MapTile[][] = [];

        for (let i = 0; i < width; i++) {
            map[i] = [];

            for (let j = 0; j < height; j++) {
                map[i][j] = new MapTile(false);
            }
        }

        this.map = map;
        this.width = width;
        this.height = height;

        const tileDimensions = this.map[0][0].dimensionsOnCanvas();
        
        this.tileWidth = tileDimensions.width;
        this.tileHeight = tileDimensions.height;

        this.mapWidth = this.tileWidth * this.width;
        this.mapHeight = this.tileHeight * this.height;
    }

    public render(
        canvas: fabric.StaticCanvas,
        widthOffset: number,
        heightOffset: number) {

        for (let i = 0; i < this.width; i++) {
            for (let j = 0; j < this.height; j++) {
                this.map[i][j].render(
                    canvas,
                    widthOffset + (i * this.tileWidth),
                    heightOffset + (j * this.tileHeight),
                );
            }
        }
    }

    public dimensionsOnCanvas() {
        return {
            width: this.mapWidth,
            height: this.mapHeight,
        };
    }
}
