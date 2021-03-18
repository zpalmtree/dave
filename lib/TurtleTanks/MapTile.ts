import { fabric } from 'fabric';

import { IRenderable } from './IRenderable';
import { loadImage } from './Utilities';

import {
    Coordinate,
} from './Types';

import {
    PIXELS_PER_TILE,
    DEFAULT_TILE_COLOR,
    DEFAULT_TILE_OPACITY,
} from './Constants';

export interface MapTileSpecification {
    /* Is this tile utilized? Tiles are stored in a 2d array, but maps do not
     * necessarily have to be a rectangle. If this is true, this tile is
     * blank. */
    sparse?: boolean;

    /* What color is this tile? Should be a hex code. */
    color?: string;

    /* Tile can have a background image. Location of image on disk. */
    image?: string;

    /* Opacity. Should be between 0 and 1. */
    opacity?: number;
}

export class MapTile implements IRenderable {
    private tile: fabric.Rect | fabric.Image | null = null;

    private color?: string;

    private image?: string;

    private opacity: number;

    private width: number;

    private height: number;

    /* Either occupied by a userid, or no-one */
    public occupied: string | undefined;

    public sparse: boolean;

    public coords: Coordinate;

    constructor(
        tileSpecification: MapTileSpecification,
        coords: Coordinate,
    ) {
        const {
            sparse = false,
            color = DEFAULT_TILE_COLOR,
            image,
            opacity = DEFAULT_TILE_OPACITY,
        } = tileSpecification;

        this.sparse = sparse;
        this.color = color;
        this.image = image;
        this.opacity = opacity;
        this.width = PIXELS_PER_TILE;
        this.height = PIXELS_PER_TILE;
        this.coords = coords;
        this.occupied = undefined;
    }

    public async render(
        canvas: fabric.StaticCanvas,
        widthOffset: number,
        heightOffset: number) {

        if (this.sparse) {
            return;
        }

        /* Only need to add the tile to the canvas once - tile should not
         * change in any way after initial draw. */
        if (!this.tile) {
            if (this.image) {
                this.tile = await loadImage(this.image);

                if (this.tile.width !== this.width || this.tile.height !== this.height) {
                    this.tile.scaleToWidth(this.width);
                    this.tile.scaleToHeight(this.height);
                }

                this.tile.set({
                    left: widthOffset,
                    top: heightOffset,
                });
            } else {
                this.tile = new fabric.Rect({
                    width: this.width,
                    height: this.height,
                    opacity: this.opacity,
                    fill: this.color,
                    left: widthOffset,
                    top: heightOffset,
                    strokeWidth: 0,
                });
            }

            canvas.add(this.tile);
        }
    }

    public dimensionsOnCanvas() {
        return {
            width: this.width,
            height: this.height,
        }
    }
}
