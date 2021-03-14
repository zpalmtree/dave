import { fabric } from 'fabric';

import { IRenderable } from './IRenderable';
import { pickRandomItem } from '../Utilities';

import {
    MapTile,
    MapTileSpecification,
} from './MapTile';

export interface MapSpecification {
    /* To create a map, either specify the width and height */
    width?: number;
    height?: number;

    /* Or provide an array defining the map shape and features. */
    map?: MapTileSpecification[][];
}

export class MapManager implements IRenderable {
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

    constructor(specification: MapSpecification) {
        let {
            width,
            height,
            map,
        } = specification;

        const newMap: MapTile[][] = [];

        if (map) {
            if (map.length < 1) {
                throw new Error('Invalid map');
            }

            width = map.length;

            for (let i = 0; i < map.length; i++) {
                if (!map[i]) {
                    throw new Error('Invalid map');
                }

                if (height && height !== map[i].length) {
                    throw new Error('Map must be a rectangle');
                } else {
                    height = map[i].length;
                }

                newMap[i] = [];

                for (let j = 0; j < map[i].length; j++) {
                    const tile = newMap[i][j];
                    
                    if (tile === undefined) {
                        newMap[i][j] = new MapTile({ sparse: true }, i, j);
                    } else {
                        newMap[i][j] = new MapTile(map[i][j], i, j);
                    }
                }
            }
        } else {
            if (!width || width < 1 || Math.floor(width) !== width) {
                throw new Error('Invalid width');
            }

            if (!height || height < 1 || Math.floor(height) !== height) {
                throw new Error('Invalid height');
            }

            for (let i = 0; i < width; i++) {
                newMap[i] = [];

                for (let j = 0; j < height; j++) {
                    newMap[i][j] = new MapTile({ color: '#e6e6e6', }, i, j);
                }
            }
        }

        this.map = newMap;
        this.width = width;
        this.height = height as number;

        const tileDimensions = this.map[0][0].dimensionsOnCanvas();
        
        this.tileWidth = tileDimensions.width;
        this.tileHeight = tileDimensions.height;

        this.mapWidth = this.tileWidth * this.width;
        this.mapHeight = this.tileHeight * this.height;
    }

    public async render(
        canvas: fabric.StaticCanvas,
        widthOffset: number,
        heightOffset: number) {

        const promises = [];

        for (let i = 0; i < this.width; i++) {
            for (let j = 0; j < this.height; j++) {
                const p = this.map[i][j].render(
                    canvas,
                    widthOffset + (i * this.tileWidth),
                    heightOffset + (j * this.tileHeight),
                );

                promises.push(p);
            }
        }

        await Promise.all(promises);
    }

    public dimensionsOnCanvas() {
        return {
            width: this.mapWidth,
            height: this.mapHeight,
            tileWidth: this.tileWidth,
            tileHeight: this.tileHeight,
        };
    }

    public getUnoccupiedSquare(): MapTile | undefined {
        const squares = this.getUnoccupiedSquares();

        if (squares.length === 0) {
            return undefined;
        }

        return pickRandomItem(squares);
    }

    public getUnoccupiedSquares(): Array<MapTile> {
        const unoccupiedSquares: MapTile[] = [];

        for (let i = 0; i < this.width; i++) {
            for (let j = 0; j < this.height; j++) {
                const tile = this.map[i][j];

                if (!tile.sparse && !tile.occupied) {
                    unoccupiedSquares.push(tile);
                }
            }
        }

        return unoccupiedSquares;
    }
} 
