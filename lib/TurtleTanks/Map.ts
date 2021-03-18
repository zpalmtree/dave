import {
    Guild,
} from 'discord.js';

import { fabric } from 'fabric';

import { IRenderable } from './IRenderable';

import {
    pickRandomItem,
    getUsername,
} from '../Utilities';

import {
    Coordinate,
} from './Types';

import { Player } from './Player';

import {
    loadImage,
    formatCoordinate,
    pointAndRadiusToSquare,
} from './Utilities';

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
    COORDINATES_FONT_WEIGHT,
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

    private guild: Guild | undefined;

    constructor(mapSpecification: MapSpecification, guild?: Guild) {
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

        this.guild = guild;
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
                fontWeight: COORDINATES_FONT_WEIGHT,
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
                fontWeight: COORDINATES_FONT_WEIGHT,
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

    public async canMoveTo(coords: Coordinate, player: Player) {
        const coordPretty = formatCoordinate(coords);

        if (coords.x >= this.width || coords.y >= this.height || coords.x < 0 || coords.y < 0) {
            return {
                err: `Cannot move to ${coordPretty}, tile does not exist`,
            };
        }

        const tile = this.map[coords.y][coords.x];

        if (tile.occupied) {
            const username = await getUsername(tile.occupied, this.guild);
            return {
                err: `Cannot move to ${coordPretty}, it is occupied by ${username}`,
            };
        }

        if (tile.sparse) {
            return {
                err: `Cannot move to ${coordPretty}, it is out of bounds`,
            };
        }

        const tilesTraversed = this.distanceBetweenValidPath(player.coords, coords);

        const pointsRequired = tilesTraversed * player.pointsPerMove;

        if (player.points < pointsRequired) {
            return {
                err: `You don't have enough points required to move ${tilesTraversed} tiles. ` +
                     `You need ${pointsRequired} points, but have ${player.points} points.`,
            };
        }

        return {
            pointsRequired,
            tilesTraversed,
        };
    }

    public distanceBetweenStraightLine(start: Coordinate, end: Coordinate) {
        const diagonalX = Math.abs(end.x - start.x);
        const diagonalY = Math.abs(end.y - start.y);

        return Math.max(diagonalX, diagonalY);
    }

    private reconstructPath(cameFrom: Map<Coordinate, Coordinate>, current: Coordinate) {
        const path = [ current ];

        while (cameFrom.has(current)) {
            current = cameFrom.get(current)!;
            path.unshift(current);
        }

        return path;
    }

    public distanceBetweenValidPath(start: Coordinate, end: Coordinate) {
        const path = this.aStar(start, end);

        if (path.length === 0) {
            throw new Error(`Cannot find path between ${formatCoordinate(start)} and ${formatCoordinate(end)}`);
        }

        return path.length - 1;
    }

    private aStar(start: Coordinate, end: Coordinate) {
        /* Nodes that we need to visit */
        const toVisit = new Set([start]);

        /* The node preceeding a node n on the cheapest known path */
        const cameFrom: Map<Coordinate, Coordinate> = new Map();

        /* Cheapest known path from the start to a coordinate n */
        const cheapestPathFromStart: Map<Coordinate, number> = new Map();

        /* The cheapest path length from start to end, if we use coordinate n */
        const cheapestPathLengthUsing: Map<Coordinate, number> = new Map();

        /* Distance from start to start is 0 */
        cheapestPathFromStart.set(start, 0);

        cheapestPathLengthUsing.set(start, this.distanceBetweenStraightLine(start, end));

        while (toVisit.size > 0) {
            let currentNode;
            let currentScore = Number.MAX_SAFE_INTEGER;

            /* Find the node with the lowest cheapestPathLengthUsing value */
            for (const node of toVisit) {
                const distance = cheapestPathLengthUsing.get(node);

                if (distance !== undefined && distance <= currentScore) {
                    currentNode = node;
                    currentScore = distance;
                }
            }

            if (!currentNode) {
                throw new Error('Failed to acquire node');
            }

            if (currentNode.x === end.x && currentNode.y === end.y) {
                return this.reconstructPath(cameFrom, currentNode);
            }

            toVisit.delete(currentNode);

            const { x, y } = currentNode;

            const neighbours = [
                this.tryGetTile({ x, y: y - 1 }),
                this.tryGetTile({ x: x + 1, y: y - 1 }),
                this.tryGetTile({ x: x + 1, y }),
                this.tryGetTile({ x: x + 1, y: y + 1 }),
                this.tryGetTile({ x, y: y + 1 }),
                this.tryGetTile({ x: x - 1, y: y + 1 }),
                this.tryGetTile({ x: x - 1, y }),
                this.tryGetTile({ x: x - 1, y: y - 1 }),
            ];

            for (const neighbour of neighbours) {
                /* Out of map boundary */
                if (!neighbour) {
                    continue;
                }

                /* Cannot pass through this cell */
                if (neighbour.sparse) {
                    continue;
                }

                const cheapestPathToCurrent = cheapestPathFromStart.get(currentNode);
                const cheapestPathToNeighbour = cheapestPathFromStart.get(neighbour.coords);

                if (cheapestPathToCurrent === undefined) {
                    continue;
                }

                const possibleShortestPath = cheapestPathToCurrent + 1;

                if (cheapestPathToNeighbour === undefined || possibleShortestPath < cheapestPathToNeighbour) {
                    cameFrom.set(neighbour.coords, currentNode);

                    cheapestPathFromStart.set(neighbour.coords, possibleShortestPath);

                    cheapestPathLengthUsing.set(
                        neighbour.coords,
                        possibleShortestPath + this.distanceBetweenStraightLine(neighbour.coords, end),
                    );

                    if (!toVisit.has(neighbour.coords)) {
                        toVisit.add(neighbour.coords);
                    }
                }
            }
        }

        return [];
    }

    public isOccupied(coords: Coordinate): boolean {
        return this.getTile(coords).occupied !== undefined;
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

    public getTile(coords: Coordinate): MapTile {
        return this.map[coords.y][coords.x];
    }

    public tryGetTile(coords: Coordinate) {
        if (coords.x >= this.width || coords.y >= this.height || coords.x < 0 || coords.y < 0) {
            return undefined;
        }

        return this.getTile(coords);
    }

    public getTilesInRadius(coord: Coordinate, radius: number, includeSparse: boolean) {
        const tile = this.tryGetTile(coord);

        if (!tile) {
            throw new Error('Coordinate is not on map');
        }

        const [start, end] = pointAndRadiusToSquare(coord, radius);

        return this.getTilesBetween(start, end, includeSparse);
    }

    /* Get the tiles contained in the square described by start, end */
    public getTilesBetween(start: Coordinate, end: Coordinate, includeSparse: boolean): MapTile[] {
        const startX = Math.min(start.x, end.x);
        const endX = Math.max(start.x, end.x);

        const startY = Math.min(start.y, end.y);
        const endY = Math.max(start.y, end.y);

        const tiles = [];

        for (let i = startX; i <= endX; i++) {
            for (let j = startY; j <= endY; j++) {
                const tile = this.tryGetTile({ y: j, x: i });

                if (tile === undefined) {
                    continue;
                }

                if (!includeSparse && tile.sparse) {
                    continue;
                }

                tiles.push(tile);
            }
        }

        return tiles;
    }

    public async renderAttackPreview(
        canvas: fabric.StaticCanvas,
        tilesAffected: MapTile[]): Promise<fabric.Image[]> {

        const hatches = [];

        for (const tile of tilesAffected) {
            const hatch = await loadImage('utility/tile_effected.png');

            if (hatch.width !== this.tileWidth || hatch.height !== this.tileHeight) {
                hatch.scaleToWidth(this.tileWidth);
                hatch.scaleToHeight(this.tileHeight);
            }

            hatch.set({
                left: COORDINATES_WIDTH + (tile.coords.x * this.tileWidth),
                top: COORDINATES_HEIGHT + (tile.coords.y * this.tileHeight),
            });

            canvas.add(hatch);
            hatches.push(hatch);
        }

        return hatches;
    }
} 
