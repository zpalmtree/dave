import {
    Message,
    User,
    MessageReaction,
} from 'discord.js';

import { fabric } from 'fabric';

import { Game } from './Game';

import {
    Coordinate,
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

    if (coord === 'up') {
        const { x, y } = currentCoord;

        return {
            x,
            y: y - 1,
        };
    }

    if (coord === 'down') {
        const { x, y } = currentCoord;

        return {
            x,
            y: y + 1,
        };
    }

    if (coord === 'left') {
        const { x, y } = currentCoord;

        return {
            x: x - 1,
            y,
        };
    }

    if (coord === 'right') {
        const { x, y } = currentCoord;

        return {
            x: x + 1,
            y,
        };
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

export async function addMoveReactions(msg: Message, game: Game) {
    const collector = msg.createReactionCollector((reaction, user) => {
        return ['⬆️', '⬇️', '⬅️', '➡️'].includes(reaction.emoji.name) && !user.bot;
    });

    const directions =  {
        '⬆️': 'up',
        '⬇️': 'down',
        '⬅️': 'left',
        '➡️': 'right',
    };

    collector.on('collect', async (reaction: MessageReaction, user: User) => {
        reaction.users.remove(user.id);
        
        const currentCoords = game.fetchPlayerLocation(user.id);

        if (!currentCoords) {
            return;
        }

        const direction: string = directions[reaction.emoji.name as keyof typeof directions];

        const newCoords = parseCoordinate(direction, currentCoords) as Coordinate;

        const [allowed] = await game.canMove(user.id, newCoords);

        if (allowed) {
            await game.confirmMove(user.id, msg, newCoords);
        }
    });

    await msg.react('⬆️');
    await msg.react('⬇️');
    await msg.react('⬅️');
    await msg.react('➡️');
}
