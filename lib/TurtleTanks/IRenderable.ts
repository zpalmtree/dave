import { fabric } from 'fabric';

export interface IRenderable {
    render(
        canvas: fabric.StaticCanvas,
        widthOffset: number,
        heightOffset: number,
    ): void;

    dimensionsOnCanvas(): { width: number, height: number };
}
