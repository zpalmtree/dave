import { fabric } from 'fabric';

import { IRenderable } from './IRenderable';
import { pickRandomItem } from '../Utilities';
import { loadImage } from './Utilities';

import {
    MapTile,
    MapTileSpecification,
} from './MapTile';

import {
    COORDINATES_HEIGHT,
    COORDINATES_WIDTH,
    COORDINATES_FILL,
    COORDINATES_OUTLINE,
    COORDINATES_OUTLINE_WIDTH,
    COORDINATES_FONT,
    GRIDLINES_COLOR,
    DEFAULT_TILE_COLOR,
} from './Constants';

export interface MapSpecification {
    /* Width of map in tiles */
    width: number;

    /* Height of map in tiles */
    height: number;

    backgroundImage?: string;

    /* How to draw every single tile */
    tileSpecification?: MapTileSpecification;

    /* How to draw specific tiles */
    map?: Array<Array<MapTileSpecification | undefined>>;
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

    /* Loaded in background image in memory */
    private backgroundImage: fabric.Image | undefined;
    
    /* Location of map background image */
    private backgroundImagePath: string | undefined;

    /* Stores the lines drawing the map grid */
    private gridLines: Array<fabric.Line> | undefined;

    /* Stores the map 'coordinates', a-z, 0-26 */
    private mapCoordinates: Array<fabric.Text> | undefined;

    constructor(mapSpecification: MapSpecification) {
        let {
            width,
            height,
            backgroundImage,
            tileSpecification,
            map,
        } = mapSpecification;

        const newMap: MapTile[][] = [];

        if (map) {
            if (map.length < 1) {
                throw new Error('Invalid map');
            }

            for (let i = 0; i < width; i++) {
                for (let j = 0; j < height; j++) {
                    if (!map[j]) {
                        throw new Error('Invalid map');
                    }

                    if (!newMap[j]) {
                        newMap[j] = [];
                    }

                    const tile = map[j][i];

                    if (tile === undefined) {
                        newMap[j][i] = new MapTile(
                            {
                                sparse: true,
                            },
                            { x: i, y: j, },
                        );
                    } else {
                        newMap[j][i] = new MapTile(
                            {
                                ...tileSpecification,
                                ...tile,
                            },
                            { x: i, y: j, },
                        );
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
                    newMap[i][j] = new MapTile(
                        {
                            color: DEFAULT_TILE_COLOR,
                            ...tileSpecification,
                        },
                        { x: i, y: j },
                    );
                }
            }
        }

        this.map = newMap;
        this.width = width;
        this.height = height as number;

        /* Labelled A-Z */
        if (this.width >= 26) {
            throw new Error('Map can only be 26 tiles wide!');
        }

        const tileDimensions = this.map[0][0].dimensionsOnCanvas();
        
        this.tileWidth = tileDimensions.width;
        this.tileHeight = tileDimensions.height;

        this.mapWidth = this.tileWidth * this.width;
        this.mapHeight = this.tileHeight * this.height;

        this.backgroundImagePath = backgroundImage;
    }

    private async renderMapBackground(canvas: fabric.StaticCanvas) {
        if (this.backgroundImagePath) {
            if (!this.backgroundImage) {
                this.backgroundImage = await loadImage(this.backgroundImagePath);

                this.backgroundImage.set({
                    left: COORDINATES_WIDTH,
                    top: COORDINATES_HEIGHT,
                });

                canvas.add(this.backgroundImage);
            }
        }
    }

    private async renderMapGrid(canvas: fabric.StaticCanvas) {
        if (this.gridLines) {
            return;
        } 

        this.gridLines = [];

        for (let i = 0; i < this.mapHeight; i += this.tileHeight) {
            const path = new fabric.Line(
                [
                    i + COORDINATES_WIDTH,
                    0 + COORDINATES_HEIGHT,
                    i + COORDINATES_WIDTH,
                    this.mapHeight + COORDINATES_HEIGHT
                ],
                {
                    stroke: GRIDLINES_COLOR,
                }
            );

            this.gridLines.push(path);
            canvas.add(path);
        }

        for (let i = 0; i < this.mapWidth; i += this.tileWidth) {
            const path = new fabric.Line(
                [
                    0 + COORDINATES_WIDTH,
                    i + COORDINATES_HEIGHT,
                    this.mapWidth + COORDINATES_WIDTH,
                    i + COORDINATES_HEIGHT
                ],
                {
                    stroke: GRIDLINES_COLOR,
                }
            );

            this.gridLines.push(path);
            canvas.add(path);
        }
    }

    private async renderMapCoordinates(canvas: fabric.StaticCanvas) {
        if (this.mapCoordinates) {
            return;
        }

        this.mapCoordinates = [];

        for (let i = 0; i < this.height; i++) {
            const label = new fabric.Text((i + 1).toString(), {
                top: COORDINATES_HEIGHT + (i * this.tileHeight) + (this.tileHeight * 0.15),
                left: this.tileWidth * 0.5,
                strokeWidth: COORDINATES_OUTLINE_WIDTH,
                stroke: COORDINATES_OUTLINE,
                fontFamily: COORDINATES_FONT,
                fill: COORDINATES_FILL,
                originX: 'center',
            });

            this.mapCoordinates.push(label);
            canvas.add(label);
        }

        for (let i = 0; i < this.width; i++) {
            /* 0 => A, 1 => B, etc */
            const chr = String.fromCharCode(65 + i);

            const label = new fabric.Text(chr, {
                top: this.tileHeight * 0.5,
                left: COORDINATES_WIDTH + (i * this.tileHeight) + (this.tileHeight * 0.27),
                strokeWidth: COORDINATES_OUTLINE_WIDTH,
                stroke: COORDINATES_OUTLINE,
                fontFamily: COORDINATES_FONT,
                fill: COORDINATES_FILL,
                originY: 'center',
            });

            this.mapCoordinates.push(label);
            canvas.add(label);
        }
    }

    public async render(
        canvas: fabric.StaticCanvas,
        widthOffset: number,
        heightOffset: number) {

        await this.renderMapBackground(canvas);
        await this.renderMapGrid(canvas);

        const promises = [];

        promises.push(this.renderMapCoordinates(canvas));

        for (let i = 0; i < this.width; i++) {
            for (let j = 0; j < this.height; j++) {
                const p = this.map[j][i].render(
                    canvas,
                    widthOffset + (i * this.tileWidth) + COORDINATES_WIDTH,
                    heightOffset + (j * this.tileHeight) + COORDINATES_HEIGHT,
                );

                promises.push(p);
            }
        }

        await Promise.all(promises);
    }

    public dimensionsOnCanvas() {
        return {
            width: this.mapWidth + COORDINATES_WIDTH,
            height: this.mapHeight + COORDINATES_HEIGHT,
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
                const tile = this.map[j][i];

                if (!tile.sparse && !tile.occupied) {
                    unoccupiedSquares.push(tile);
                }
            }
        }

        return unoccupiedSquares;
    }
} 
