import { fabric } from 'fabric';

import { loadImage } from './Utilities';
import { pickRandomItem } from '../Utilities';
import { faces, bodies } from './Avatar';

import {
    Coordinate,
    PlayerStatus,
    Team,
    Weapon,
} from './Types';

import {
    PIXELS_PER_TILE,
    AVATAR_SIZES,
    HIGHLIGHT_COLOR,
    HIGHLIGHT_OUTLINE_WIDTH,
} from './Constants';

export class Player {
    /* Users discord ID */
    public userId: string;

    /* Coordinates of the player on the grid */
    public coords: Coordinate;

    /* File path of the body image to use */
    public bodyFilePath: string;

    /* File path of the face image to use */
    public faceFilePath: string;

    /* Game points. Need points to make actions. */
    public points: number;

    /* Optionally member of a team */
    public team: Team | undefined;

    /* Health points. Die when it reaches zero. */
    public hp: number;

    /* The amount of points it takes to move one tile */
    public pointsPerMove: number;

    /* The amount of points it takes to perform a shot */
    public pointsPerShot: number;

    /* Points gained when a game tick passes */
    public pointsPerTick: number;

    /* Points awarded for killing a player */
    public pointsPerKill: number;

    /* Players weapon */
    public weapon: Weapon;

    /* Loaded body image */
    private body: fabric.Image | undefined;

    /* Loaded face image */
    private face: fabric.Image | undefined;

    /* Loaded player highlight */
    private highlight: fabric.Circle | undefined;

    constructor(playerInfo: PlayerStatus) {
        this.userId = playerInfo.userId;
        this.coords = playerInfo.coords;

        this.bodyFilePath = playerInfo.body;
        this.faceFilePath = playerInfo.face;

        this.points = playerInfo.points;
        this.hp = playerInfo.hp;

        this.pointsPerMove = playerInfo.pointsPerMove;
        this.pointsPerShot = playerInfo.pointsPerShot;
        this.pointsPerTick = playerInfo.pointsPerTick;
        this.pointsPerKill = playerInfo.pointsPerKill;

        this.team = playerInfo.team;

        this.weapon = playerInfo.weapon;
    }

    private async init(canvas: fabric.StaticCanvas) {
        if (this.body && this.face && this.highlight) {
            return;
        }

        if (!this.faceFilePath) {
            this.faceFilePath = pickRandomItem(faces);
        }

        const bodyPromise = loadImage(`bodies/${AVATAR_SIZES}/${this.bodyFilePath}`);
        const facePromise = loadImage(`faces/${AVATAR_SIZES}/${this.faceFilePath}`);

        this.body = await bodyPromise;
        this.face = await facePromise;
        this.highlight = new fabric.Circle({
            radius: (PIXELS_PER_TILE / 2) * 0.8,
            stroke: HIGHLIGHT_COLOR,
            strokeWidth: HIGHLIGHT_OUTLINE_WIDTH,
            fill: 'rgba(0,0,0,0)',
            originX: 'center',
            originY: 'center',
        });

        canvas.add(this.highlight);
        canvas.add(this.body);
        canvas.add(this.face);
    }

    public async render(
        canvas: fabric.StaticCanvas,
        widthOffset: number,
        heightOffset: number,
        highlightPlayer: boolean) {

        await this.init(canvas);

        this.body!.set({
            left: widthOffset + (PIXELS_PER_TILE * 0.5),
            top: heightOffset + (PIXELS_PER_TILE * 0.5),
            originX: 'center',
            originY: 'center',
        });

        this.face!.set({
            left: widthOffset + (PIXELS_PER_TILE * 0.5),
            top: heightOffset + (PIXELS_PER_TILE * 0.5),
            originX: 'center',
            originY: 'center',
        });

        if (highlightPlayer) {
            this.highlight!.set({
                left: widthOffset + (PIXELS_PER_TILE * 0.5),
                top: heightOffset + (PIXELS_PER_TILE * 0.5),
            });
        }

        this.highlight!.visible = highlightPlayer;
    }

    public dimensionsOnCanvas() {
        return {
            width: PIXELS_PER_TILE,
            height: PIXELS_PER_TILE,
        }
    }

    public remove(canvas: fabric.StaticCanvas) {
        if (this.face) {
            canvas.remove(this.face);
        }
        
        if (this.body) {
            canvas.remove(this.body);
        }

        if (this.highlight) {
            canvas.remove(this.highlight);
        }
    }

    public getStatus(): PlayerStatus {
        return {
            coords: this.coords,
            userId: this.userId,
            body: this.bodyFilePath,
            face: this.faceFilePath,
            points: this.points,
            hp: this.hp,
            pointsPerMove: this.pointsPerMove,
            pointsPerShot: this.pointsPerShot,
            pointsPerTick: this.pointsPerTick,
            pointsPerKill: this.pointsPerKill,
            team: this.team,
            weapon: this.weapon,
        };
    }
}
