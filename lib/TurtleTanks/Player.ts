import { Database } from 'sqlite3';
import { fabric } from 'fabric';

import { loadImage } from './Utilities';

import {
    Coordinate,
    Team,
    Weapon,
    PlayerConfig,
    ShotEffect,
    ShotResult,
    PlayerShot,
    ImageType,
    AvatarComponent,
} from './Types';

import {
    PIXELS_PER_TILE,
    AVATAR_SIZES,
    HIGHLIGHT_COLOR,
    HIGHLIGHT_OUTLINE_WIDTH,
    ACCURACY_RAMP_UP_TIME,
} from './Constants';

import {
    insertQuery,
} from '../Database';

export class Player {
    /* Users discord ID */
    public userId: string;

    /* Coordinates of the player on the grid */
    public coords: Coordinate;

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

    /* Has the player reached 0hp and died */
    public dead: boolean = false;

    public avatar: AvatarComponent[];

    /* Loaded player highlight */
    private highlight: fabric.Circle | undefined;

    private loadedAvatar: fabric.Image[] | undefined;

    private shotHistory: PlayerShot[] = [];

    constructor(playerInfo: PlayerConfig) {
        this.userId = playerInfo.userId;
        this.coords = playerInfo.coords;

        this.avatar = playerInfo.avatar;

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
        if (this.highlight && this.loadedAvatar) {
            return;
        }

        const images = [];

        const sortedItems = this.avatar.sort((a: AvatarComponent, b: AvatarComponent) => a.zIndex - b.zIndex); 

        for (const item of sortedItems) {
            let folderPath = 'bodies';

            if (item.imageType === ImageType.Face) {
                folderPath = 'faces';
            }

            images.push(loadImage(`${folderPath}/${AVATAR_SIZES}/${item.filepath}`));
        }

        const loadedImages = await Promise.all(images);

        this.loadedAvatar = loadedImages;

        this.highlight = new fabric.Circle({
            radius: (PIXELS_PER_TILE / 2) * 0.8,
            stroke: HIGHLIGHT_COLOR,
            strokeWidth: HIGHLIGHT_OUTLINE_WIDTH,
            fill: 'rgba(0,0,0,0)',
            originX: 'center',
            originY: 'center',
        });

        for (const image of this.loadedAvatar) {
            canvas.add(image);
        }

        canvas.add(this.highlight);
    }

    public async render(
        canvas: fabric.StaticCanvas,
        widthOffset: number,
        heightOffset: number,
        highlightPlayer: boolean) {

        await this.init(canvas);

        if (this.loadedAvatar) {
            for (const image of this.loadedAvatar) {
                image.set({
                    left: widthOffset + (PIXELS_PER_TILE * 0.5),
                    top: heightOffset + (PIXELS_PER_TILE * 0.5),
                    originX: 'center',
                    originY: 'center',
                });
            }
        }

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
        if (this.loadedAvatar) {
            for (const image of this.loadedAvatar) {
                canvas.remove(image);
            }
        }

        if (this.highlight) {
            canvas.remove(this.highlight);
        }
    }

    public receiveDamage(damage: number) {
        const newHP = Math.max(this.hp - damage, 0);

        this.hp = newHP;
        
        if (this.hp === 0) {
            this.dead = true;
        }

        return this.hp;
    }

    public attack(coordinates: Coordinate, shotEffects: ShotEffect) {
        const shotResult = this.getNextShotPercentage(coordinates) > Math.random()
            ? ShotResult.Hit
            : ShotResult.Miss;

        this.points -= this.pointsPerShot;

        if (shotResult === ShotResult.Hit) {
            this.points += shotEffects.killedPlayers.length * this.pointsPerKill;
        }

        this.shotHistory.push({
            userId: this.userId,
            coordinates,
            weapon: this.weapon,
            shotEffects,
            shotResult,
        });

        return shotResult;
    }

    public getNextShotPercentage(coordinates: Coordinate) {
        let baseAccuracy = this.weapon.startingAccuracy;

        /* How much to increase the accuracy per shot */
        const step = (this.weapon.maxAccuracy - this.weapon.startingAccuracy) / ACCURACY_RAMP_UP_TIME;

        let count = 0;

        for (let i = this.shotHistory.length - 1; i >= 0 && count < ACCURACY_RAMP_UP_TIME; i--) {
            const shot = this.shotHistory[i];

            /* Keep increasing the accuracy while the shots are on the same
             * coordinates */
            if (coordinates.x === shot.coordinates.x
             && coordinates.y === shot.coordinates.y) {
                baseAccuracy += step;
            } else {
                break;
            }

            count++;
        }

        /* Just to be sure */
        return Math.min(baseAccuracy, this.weapon.maxAccuracy);
    }

    public async storeInDB(db: Database, channel: string) {
        await insertQuery(
            `INSERT INTO tank_games (
                user_id,
                channel_id,
                coord_x,
                coord_y,
                hp,
                points,
                team
            ) VALUES (
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?
            ) ON CONFLICT (
                user_id,
                channel_id
            )
            DO UPDATE
            SET
                coord_x = excluded.coord_x,
                coord_y = excluded.coord_y,
                hp = excluded.hp,
                points = excluded.points,
                team = excluded.team`,
            db,
            [
                this.userId,
                channel,
                this.coords.x,
                this.coords.y,
                this.hp,
                this.points,
                this.team === undefined
                    ? undefined
                    : this.team.name
            ]
        );
    }
}
