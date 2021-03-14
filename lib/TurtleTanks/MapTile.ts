import { fabric } from 'fabric';

import { IRenderable } from './IRenderable';
import { loadImage } from './Utilities';

export const PIXELS_PER_TILE = 64;

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

    /* What color is the outline of this tile? */
    outlineColor?: string;

    /* Width of outline. Default of 0 */
    strokeWidth?: number;
}

export class MapTile implements IRenderable {
    private tile: fabric.Rect | fabric.Image | null = null;

    private color?: string;

    private image?: string;

    private opacity: number;

    private outlineColor: string;

    private strokeWidth: number;

    private width: number;

    private height: number;

    public occupied: undefined | string;

    public sparse: boolean;

    public x: number;

    public y: number;

    constructor(
        tileSpecification: MapTileSpecification,
        coords: { x: number, y: number },
    ) {
        const {
            sparse = false,
            color = 'rgba(0, 0, 0, 0)',
            image,
            opacity = 1,
            outlineColor = 'black',
            strokeWidth = 0,
        } = tileSpecification;

        this.sparse = sparse;
        this.color = color;
        this.image = image;
        this.opacity = opacity;
        this.outlineColor = outlineColor;
        this.strokeWidth = strokeWidth;
        this.width = PIXELS_PER_TILE;
        this.height = PIXELS_PER_TILE;
        this.x = coords.x;
        this.y = coords.y;
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

                if (this.tile.width !== PIXELS_PER_TILE || this.tile.height !== PIXELS_PER_TILE) {
                    this.tile.scaleToWidth(PIXELS_PER_TILE);
                    this.tile.scaleToHeight(PIXELS_PER_TILE);
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
                    stroke: this.outlineColor,
                    strokeWidth: this.strokeWidth,
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
