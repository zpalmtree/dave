import { fabric } from 'fabric';

import { Coordinate } from './Types';

import {
    PREVIEW_ARROW_COLOR,
    PREVIEW_ARROW_WIDTH,
} from './Constants';

export class Arrow {
    private arrowBody: fabric.Line;
    private arrowHead: fabric.Triangle;

    constructor(startCoords: Coordinate, endCoords: Coordinate) {
        const arrowBody = new fabric.Line(
            [
                startCoords.x,
                startCoords.y,
                endCoords.x,
                endCoords.y,
            ],
            {
                stroke: PREVIEW_ARROW_COLOR,
                strokeWidth: PREVIEW_ARROW_WIDTH,
                originX: 'center',
                originY: 'center',
            },
        );

        const arrowHead = new fabric.Triangle({
            left: arrowBody.x2!
                + arrowBody.left!
                - ((arrowBody.x1! + arrowBody.x2!) / 2),
            top: arrowBody.y2!
               + arrowBody.top!
               - ((arrowBody.y1! + arrowBody.y2!) / 2),
            originX: 'center',
            originY: 'center',
            height: 20,
            width: 20,
            fill: PREVIEW_ARROW_COLOR,
        });

        const angle = this.calcArrowAngle(
            arrowBody.x1!,
            arrowBody.y1!,
            arrowBody.x2!,
            arrowBody.y2!,
        );

        arrowHead.set('angle', angle + 90);

        this.arrowBody = arrowBody;
        this.arrowHead = arrowHead;
    }

    public async render(canvas: fabric.StaticCanvas) {
        canvas.add(this.arrowBody);
        canvas.add(this.arrowHead);
    }

    private calcArrowAngle(x1: number, y1: number, x2: number, y2: number) {
        let angle = 0;

        const x = (x2 - x1);
        const y = (y2 - y1);

        if (x === 0) {
            angle = (y === 0) 
                ? 0 
                : (y > 0)
                    ? Math.PI / 2
                    : Math.PI * 3 / 2;
        } else if (y === 0) {
            angle = (x > 0)
                ? 0
                : Math.PI;
        } else {
            angle = (x < 0)
                ? Math.atan(y / x) + Math.PI
                : (y < 0)
                    ? Math.atan(y / x) + (2 * Math.PI)
                : Math.atan(y / x);
        }

        return (angle * 180 / Math.PI);
    }

    public remove(canvas: fabric.StaticCanvas) {
        if (this.arrowBody) {
            canvas.remove(this.arrowBody);
        }

        if (this.arrowHead) {
            canvas.remove(this.arrowHead);
        }
    }
}
