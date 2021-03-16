import {
    Message,
    MessageAttachment,
    MessageEmbed,
} from 'discord.js';

import { fabric } from 'fabric';

import { Database } from 'sqlite3';

import {
    randomTurtle,
    faces,
    specificTurtle,
} from './Avatar';

import {
    parseCoordinate,
    addMoveReactions,
    formatCoordinate,
} from './Utilities';

import {
    capitalize,
    getUsername,
} from '../Utilities';

import {
    Team,
} from './Types';

import { Game } from './Game';
import { map1 } from './Maps';
import { config } from '../Config';

export async function handleTurtle(msg: Message, face: string) {
    const canvas = new fabric.StaticCanvas(null, {});

    const filePath = face
        ? face + '.png'
        : '';

    const outputFileName = filePath === ''
        ? 'turtle.png'
        : filePath;

    if (faces.includes(filePath)) {
        await specificTurtle(canvas, filePath);
    } else {
        await randomTurtle(canvas);
    }

    canvas.renderAll();

    const attachment = new MessageAttachment((canvas as any).createPNGStream(), outputFileName);

    msg.reply(attachment);
}

let storedGames: Map<string, Game> = new Map();

function createAndJoinGameIfNeeded(msg: Message): [Game, string] {
    let content = '';

    if (!storedGames.has(msg.channel.id)) {
        const gameConfig = {
            teams: [
                {
                    body: 'red.png',
                    name: 'RED',
                },
                {
                    body: 'blu.png',
                    name: 'BLU',
                },
            ],
        };

        const game = new Game(map1, (msg.guild || undefined), gameConfig);

        if (config.devEnv) {
            game.join('498258111572738048');
            game.join('446154284514541579');
        }

        storedGames.set(msg.channel.id, game);

        content = 'Created new game! ';
    }

    const game = storedGames.get(msg.channel.id)!;

    if (!game.hasPlayer(msg.author.id)) {
        const err = game.join(msg.author.id);

        if (err) {
            content += err;
        } else {
            content += 'You have successfully joined the game!';
        }
    }

    return [game, content];
}

export async function handleTurtleTanks(msg: Message, args: string[], db: Database) {
    const mentionedUsers = [...msg.mentions.users.keys()];

    if (mentionedUsers.length > 0) {
        await handleTankStatus(msg, args.join(' '), db);
        return;
    }

    const [game, content] = createAndJoinGameIfNeeded(msg);
    const attachment = await game.renderAndGetAttachment(msg.author.id);

    let sentMessage;

    if (content !== '') {
        sentMessage = await msg.reply(content, attachment);
    } else {
        sentMessage = await msg.reply(attachment);
    }

    await addMoveReactions(sentMessage, game);
}

export async function handleTankMove(msg: Message, coordStr: string, db: Database) {
    const [game, content] = createAndJoinGameIfNeeded(msg);

    const currentCoords = game.fetchPlayerLocation(msg.author.id);

    if (!currentCoords) {
        msg.reply('User is not in game');
        return;
    }

    const coords = parseCoordinate(coordStr, currentCoords);

    if (!coords) {
        msg.reply(`Failed to parse coordinates. Try \`${config.prefix}tanks help\``);
        return;
    }

    const [canMove, moveErr] = await game.canMove(msg.author.id, coords);

    if (!canMove) {
        msg.reply(moveErr);
        return;
    }

    await game.confirmMove(msg.author.id, msg, coords);
}

function getUserIdFromCoordinate(coordStr: string, author: string, game: Game): [boolean, string] {
    const currentCoordinate = game.fetchPlayerLocation(author);

    if (!currentCoordinate) {
        return [false, 'You need to join the game first.'];
    }

    const coordinate = parseCoordinate(coordStr, currentCoordinate);

    if (!coordinate) {
        return [false, `Failed to parse coordinate "${coordStr}".`];
    }

    if (!game.coordinateExists(coordinate)) {
        return [false, 'Tile does not exist.'];
    }

    const player = game.getPlayerAtLocation(coordinate);

    if (player) {
        return [true, player.userId];
    }

    return [false, `Tile ${formatCoordinate(coordinate)} is unoccupied.`];
}

export async function handleTankStatus(msg: Message, args: string, db: Database) {
    const [game, content] = createAndJoinGameIfNeeded(msg);

    const mentionedUsers = [...msg.mentions.users.keys()];

    let id = msg.author.id;

    if (mentionedUsers.length > 0) {
        id = mentionedUsers[0];
    } else if (args !== '') {
        const [success, idOrErr] = getUserIdFromCoordinate(args, msg.author.id, game);

        if (!success) {
            msg.reply(idOrErr);
            return;
        }

        id = idOrErr;
    }

    const player = await game.getPlayerStatus(id);

    if (!player) {
        msg.reply('User has not joined the game!');
        return;
    }

    const canvas = new fabric.StaticCanvas(null, {});

    await specificTurtle(canvas, player.face, player.body);

    canvas.renderAll();

    const attachment = new MessageAttachment((canvas as any).createPNGStream(), 'status.png');

    const username = await getUsername(id, msg.guild);

    const embed = new MessageEmbed()
        .setTitle(`${capitalize(username)}'s Stats`)
        .attachFiles([attachment])
        .setImage('attachment://status.png')
        .addFields(
            {
                name: 'Coordinates',
                value: formatCoordinate(player.coords),
                inline: true,
            },
            {
                name: 'Points',
                value: player.points,
                inline: true,
            },
        );

    if (player.team) {
        embed.addFields({
            name: 'Team',
            value: player.team.name,
            inline: true,
        });
    }

    msg.channel.send(embed);
}
