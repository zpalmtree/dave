import * as moment from 'moment';

import { MapTile } from './MapTile';
import { Player } from './Player';

export interface Coordinate {
    x: number;
    y: number;
}

export enum Direction {
    North = 0,
    NorthEast,
    East,
    SouthEast,
    South,
    SouthWest,
    West,
    NorthWest,
}

export interface PlayerConfig {
    /* Coordinates of the player */
    coords: Coordinate;

    /* Players points */
    points: number;

    /* Player hp */
    hp: number;

    /* Number of points it takes to move one tile */
    pointsPerMove: number;

    /* Number of points it takes to perform a shot */
    pointsPerShot: number;

    /* Number of points gained on a game tick */
    pointsPerTick: number;

    /* Number of points gained on a kill */
    pointsPerKill: number;

    /* Players discord user id */
    userId: string;

    /* Users avatar */
    avatar: AvatarComponent[];

    team?: Team;

    /* The tanks weapon */
    weapon: Weapon;
}

export interface Team {
    /* Template body this team uses */
    body: string;

    /* Name of the team */
    name: string;
}

export interface GameRules {
    /* Does this game support teams. If provided, should be at least 2 teams included. */
    teams?: Team[];

    /* How often to run a game tick and give users points */
    millisecondsPerTick: number;

    /* The amount of hp to start tanks with, minus any modifiers */
    defaultStartingHp: number;

    /* The amount of points to start tanks with, minus any modifiers */
    defaultStartingPoints: number;

    /* The amount of points it takes to move one tile, minus any modifiers */
    defaultPointsPerMove: number;

    /* The amount of points it takes to perform a shot, minus any modifiers */
    defaultPointsPerShot: number;

    /* The default amount of points awarded to the player when a game tick
     * passes. */
    defaultPointsPerTick: number;

    /* The default amount of points awarded for killing a player */
    defaultPointsPerKill: number;
}

export interface Weapon {
    /* How many tiles away can the center of the blast be fired */
    range: number;

    /* How much damage does this weapon inflict */
    damage: number;

    /* How big is the radius of the explosion? Value is squared to create
     * area of effect.
     * 1 => 1 tile,
     * 2 => 4 tiles,
     * 3 => 9 tiles */
    radius: number;

    /* Name of this weapon */
    name: string;

    /* Chance of a shot landing, on the first shot */
    startingAccuracy: number;

    /* Chance of a shot landing, after the max buildup */
    maxAccuracy: number;
}

export interface LogMessage {
    /* The log message */
    message: string;

    /* Whose action triggered this log message */
    actionInitiator: string;

    /* When was the log message created */
    timestamp: moment.Moment;
}

export enum ShotResult {
    Hit = 0,
    Miss,
}

export interface PlayerShot {
    /* Who fired the shot? */
    userId: string;

    /* Where were they aiming? */
    coordinates: Coordinate;

    /* What weapon were they using? */
    weapon: Weapon;

    /* What will the shot do if it lands? */
    shotEffects: ShotEffect;

    /* Did the shot land? */
    shotResult: ShotResult;
}

export interface PlayerShotEffect {
    player: Player;

    oldHP: number;

    newHP: number;

    damageTaken: number;
}

export interface ShotEffect {
    /* Tiles that will be hit by the shot */
    affectedTiles: MapTile[];

    /* Players that will be effected by the shot */
    affectedPlayers: PlayerShotEffect[];

    /* Players that will be killed by the shot */
    killedPlayers: Player[];

    /* Points required to fire this shot */
    pointsRequired: number;

    /* Total damage caused to players by this shot */
    totalDamage: number;
}

export interface AvatarComponent {
    filepath: string;

    zIndex: number;

    imageType: ImageType;
}

export enum ImageType {
    Face = 0,
    Body = 1,
}
