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

    /* Players discord user id */
    userId: string;

    /* Body filepath to use */
    body: string;

    /* Face filepath to use */
    face: string;
}
