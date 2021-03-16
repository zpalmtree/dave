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

export interface PlayerStatus {
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

    /* Body filepath to use */
    body: string;

    /* Face filepath to use */
    face: string;

    team?: Team;
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
