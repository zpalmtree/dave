import {
    Message,
    User,
    MessageReaction,
} from 'discord.js';

import { fabric } from 'fabric';

import { Game } from './Game';

import {
    Coordinate,
    Direction,
} from './Types';

export async function loadImage(filename: string): Promise<fabric.Image> {
    return new Promise((resolve, reject) => {
        try {
            fabric.Image.fromURL(`file://${__dirname}/../../images/turtle-tanks/${filename}`, (img) => {
                resolve(img);
            });
        } catch (err) {
            reject(err);
        }
    });
}

export function formatCoordinate(coord: Coordinate) {
    const num = (coord.y + 1).toString();
    /* 0 => A, 1 => B, etc */
    const letter = String.fromCharCode(65 + coord.x);

    return letter + num;
}

export function parseCoordinate(coord: string, currentCoord: Coordinate): Coordinate | undefined {
    coord = coord.toLowerCase();

    const direction = parseDirection(coord);

    if (direction !== undefined) {
        const { x, y } = currentCoord;

        switch(+direction) {
            case Direction.North: {
                return {
                    x,
                    y: y - 1,
                };
            }
            case Direction.NorthEast: {
                return {
                    x: x + 1,
                    y: y - 1,
                };
            }
            case Direction.East: {
                return {
                    x: x + 1,
                    y,
                }
            }
            case Direction.SouthEast: {
                return {
                    x: x + 1,
                    y: y + 1,
                }
            }
            case Direction.South: {
                return {
                    x,
                    y: y + 1,
                }
            }
            case Direction.SouthWest: {
                return {
                    x: x - 1,
                    y: y + 1,
                }
            }
            case Direction.West: {
                return {
                    x: x - 1,
                    y,
                }
            }
            case Direction.NorthWest: {
                return {
                    x: x - 1,
                    y: y - 1,
                }
            }
        }
    }

    const regex = /^(?:([A-Za-z]) ?(\d+))|(?:(\d+) ?([A-Za-z]))$/;

    const results = regex.exec(coord);

    if (!results) {
        return undefined;
    }

    const [ , x1, y1, y2, x2 ] = results;

    if (!(x1 && y1) && !(x2 && y2)) {
        return undefined;
    }

    const x = (x1 || x2).codePointAt(0)! - 97;
    const y = Number(y1 || y2) - 1;

    return { x, y };
}

export function parseDirection(direction: string): Direction | undefined {
    direction = direction.toLowerCase().replace(/[- ]/g, '');

    switch (direction) {
        case 'up':
        case 'north':
        case '⬆️': {
            return Direction.North;
        }
        case 'upright':
        case 'rightup':
        case 'northeast':
        case '↗️': {
            return Direction.NorthEast;
        }
        case 'right':
        case 'east':
        case '➡️': {
            return Direction.East;
        }
        case 'downright':
        case 'rightdown':
        case 'southeast':
        case '↘️': {
            return Direction.SouthEast;
        }
        case 'down':
        case 'south':
        case '⬇️': {
            return Direction.South;
        }
        case 'downleft':
        case 'leftdown':
        case 'southwest':
        case '↙️': {
            return Direction.SouthWest;
        }
        case 'left':
        case 'west':
        case '⬅️': {
            return Direction.West;
        }
        case 'upleft':
        case 'leftup':
        case 'northwest':
        case '↖️': {
            return Direction.NorthWest;
        }
    }

    return undefined;
}

export async function addMoveReactions(msg: Message, game: Game) {
    const reactions = [
        '⬆️',
        '⬇️',
        '⬅️',
        '➡️',
        '↗️',
        '↙️',
        '↖️',
        '↘️',
    ];

    const collector = msg.createReactionCollector((reaction, user) => {
        return reactions.includes(reaction.emoji.name) && !user.bot;
    }, { time: 60 * 15 * 1000 });

    collector.on('collect', async (reaction: MessageReaction, user: User) => {
        try {
            reaction.users.remove(user.id);
        } catch (err) {
            console.log(err);
        }
        
        const currentCoords = game.fetchPlayerLocation(user.id);

        if (!currentCoords) {
            return;
        }

        const newCoords = parseCoordinate(reaction.emoji.name, currentCoords) as Coordinate;

        const result = await game.canMove(user.id, newCoords);

        if (result.err === undefined) {
            await game.confirmMove(user.id, msg, newCoords, result.tilesTraversed, result.pointsRequired);
        }
    });

    for (const reaction of reactions) {
        await msg.react(reaction);
    }
}
