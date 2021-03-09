import { fabric } from 'fabric';

import { IRenderable } from './IRenderable';

export const PIXELS_PER_TILE = 30;

export class MapTile implements IRenderable {
    private tile: fabric.Rect | null = null;

    constructor(
        /* Is this tile utilized? Tiles are stored in a 2d array, but maps do not
         * necessarily have to be a rectangle. If this is true, this tile is
         * blank. */
        public sparse: boolean,

        /* Width of a tile in pixels */
        public width: number = PIXELS_PER_TILE,

        /* Height of a tile in pixels */
        public height: number = PIXELS_PER_TILE,
    ) {
    }

    public render(
        canvas: fabric.StaticCanvas,
        widthOffset: number,
        heightOffset: number) {

        if (this.sparse) {
            return;
        }

        /* Only need to add the tile to the canvas once - tile should not
         * change in any way after initial draw. */
        if (!this.tile) {
            this.tile = new fabric.Rect({
                width: this.width,
                height: this.height,
                opacity: 1,
                fill: '#ff8533',
                left: widthOffset,
                top: heightOffset,
                stroke: 'black',
            });

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
