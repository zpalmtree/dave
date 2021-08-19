import {
    Message,
    MessageAttachment,
    MessageEmbed,
    TextChannel,
} from 'discord.js';

import * as moment from 'moment';

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
    haveRole,
} from '../Utilities';

import {
    Team,
    LogMessage,
    ImageType,
} from './Types';

import {
    Paginate,
    DisplayType,
} from '../Paginate';

import {
    perks,
    PerkType,
} from './Perks';

import { Game } from './Game';
import { map1 } from './Maps';
import { config } from '../Config';

export async function handleTurtle(msg: Message, face: string) {
    const canvas = new fabric.StaticCanvas(null, {});

    const filepath = face
        ? face + '.png'
        : '';

    const outputFileName = filepath === ''
        ? 'turtle.png'
        : filepath;

    if (faces.includes(filepath)) {
        const avatar = [{
            zIndex: 1,
            imageType: ImageType.Face,
            filepath,
        }];

        await specificTurtle(canvas, avatar);
    } else {
        await randomTurtle(canvas);
    }

    canvas.renderAll();

    const attachment = new MessageAttachment((canvas as any).createPNGStream(), outputFileName);

    msg.reply({
        files: [attachment],
    });
}

let storedGames: Map<string, Game> = new Map();

async function createAndJoinGameIfNeeded(msg: Message, db: Database): Promise<[Game, string]> {
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

        const game = new Game(
            msg.channel as TextChannel,
            db,
            map1,
            (msg.guild || undefined),
            {},
        );

        await game.init();

        const loaded = await game.loadFromDB();

        if (config.devEnv) {
            game.join('498258111572738048');
            game.join('446154284514541579');
        }

        storedGames.set(msg.channel.id, game);

        if (!loaded) {
            content = 'Created new game! ';
        }
    }

    const game = storedGames.get(msg.channel.id)!;

    if (!game.hasPlayer(msg.author.id)) {
        const result = await game.join(msg.author.id);

        if (result.err) {
            content += result.err;
        } else if (result.player) {
            if (result.player.team) {
                content += `You have successfully joined the game and team ${result.player.team.name}!`;
            } else {
                content += 'You have successfully joined the game!';
            }
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

    const [game, content] = await createAndJoinGameIfNeeded(msg, db);
    const attachment = await game.renderAndGetAttachment(msg.author.id);

    let sentMessage;

    if (content !== '') {
        sentMessage = await msg.reply({
            content,
            files: [attachment],
        });
    } else {
        sentMessage = await msg.reply({
            files: [attachment],
        });
    }

    await addMoveReactions(sentMessage, game);
}

export async function handleTankMove(msg: Message, coordStr: string, db: Database) {
    const [game, content] = await createAndJoinGameIfNeeded(msg, db);

    const currentCoords = game.fetchPlayerLocation(msg.author.id);

    if (!currentCoords) {
        if (game.isDead(msg.author.id)) {
            msg.reply('User is dead');
        } else {
            msg.reply('User is not in game');
        }

        return;
    }

    const coords = parseCoordinate(coordStr, currentCoords);

    if (!coords) {
        msg.reply(`Failed to parse coordinates. Try \`${config.prefix}tanks help\``);
        return;
    }

    const result = await game.canMove(msg.author.id, coords);

    if (result.err !== undefined) {
        msg.reply(result.err);
        return;
    }

    await game.confirmMove(msg.author.id, msg, coords, result.tilesTraversed, result.pointsRequired);
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
    const [game, content] = await createAndJoinGameIfNeeded(msg, db);

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

    const player = await game.getPlayerOrDead(id);

    if (!player) {
        msg.reply('User has not joined the game!');
        return;
    }

    const canvas = new fabric.StaticCanvas(null, {});

    await specificTurtle(canvas, player.avatar);

    canvas.renderAll();

    const attachment = new MessageAttachment((canvas as any).createPNGStream(), 'status.png');

    const username = await getUsername(id, msg.guild);

    const embed = new MessageEmbed()
        .setTitle(`${capitalize(username)}'s Stats`)
        .setImage('attachment://status.png')
        .addFields([
            {
                name: 'HP',
                value: player.hp.toString(),
                inline: true,
            },
            {
                name: 'Points',
                value: player.points.toString(),
                inline: true,
            },
            {
                name: 'Coordinates',
                value: formatCoordinate(player.coords),
                inline: true,
            },
            {
                name: 'Perk',
                value: perks.find((x) => x.perkType === player.perk)!.name,
                inline: true,
            },
            {
                name: 'Weapon',
                value: player.weapon.name,
                inline: true,
            },
            {
                name: 'Weapon Range',
                value: player.weapon.range + ' tiles',
                inline: true,
            },
            {
                name: 'Weapon Damage',
                value: player.weapon.damage + ' HP',
                inline: true,
            },
            {
                name: 'Weapon AoE',
                value: Math.pow((player.weapon.radius * 2) - 1, 2) + ' tiles',
                inline: true,
            },
            {
                name: 'Cost To Move One Tile',
                value: player.pointsPerMove + ' points',
                inline: true,
            },
            {
                name: 'Cost To Fire Weapon',
                value: player.pointsPerShot + ' points',
                inline: true,
            },
            {
                name: 'Points On Kill',
                value: player.pointsPerKill.toString(),
                inline: true,
            },
            {
                name: 'Points On Game Tick',
                value: player.pointsPerTick.toString(),
                inline: true,
            },
        ]);

    if (player.team) {
        embed.addFields({
            name: 'Team',
            value: player.team.name,
            inline: true,
        });
    }

    msg.channel.send({
        embeds: [embed],
        files: [attachment],
    });
}

export async function handleTankLogs(msg: Message, db: Database) {
    const [game, content] = await createAndJoinGameIfNeeded(msg, db);

    /* Newer logs are at the end */
    const logs = [...game.getLogs()].sort((a: LogMessage, b: LogMessage) => b.timestamp.valueOf() - a.timestamp.valueOf())

    const embed = new MessageEmbed()
        .setTitle('Game Logs');

    const pages = new Paginate({
        sourceMessage: msg,
        itemsPerPage: 5,
        displayFunction: (log: LogMessage) => {
            return [
                {
                    name: 'Message',
                    value: log.message,
                    inline: true,
                },
                {
                    name: 'User',
                    value: log.actionInitiator,
                    inline: true,
                },
                {
                    name: 'Time',
                    value: moment.utc(log.timestamp).fromNow(),
                    inline: true,
                },
            ];
        },
        displayType: DisplayType.EmbedFieldData,
        data: logs,
        embed,
    });

    pages.sendMessage();
}

export async function handleTankShoot(msg: Message, args: string, db: Database) {
    const mentionedUsers = [...msg.mentions.users.keys()];

    const [game, content] = await createAndJoinGameIfNeeded(msg, db);

    const player = game.getPlayer(msg.author.id);

    if (!player) {
        if (game.isDead(msg.author.id)) {
            msg.reply('User is dead');
        } else {
            msg.reply('User is not in the game');
        }

        return;
    }

    let coord = parseCoordinate(args, player.coords);

    if (mentionedUsers.length > 0) {
        coord = game.fetchPlayerLocation(mentionedUsers[0]);
    }

    if (coord === undefined) {
        msg.reply(`You must provide a coordinate or player to shoot. Try \`${config.prefix}tanks help\``);
        return;
    }

    const result = await game.canAttack(msg.author.id, coord);

    if (result.err !== undefined) {
        msg.reply(result.err);
        return;
    }

    const { ended } = await game.confirmAttack(
        msg.author.id,
        msg,
        coord,
        result,
    );

    if (ended) {
        storedGames.delete(msg.channel.id);

        msg.channel.send(`Game concluded. Type \`${config.prefix}tanks\` to launch a new game!`);
    }
}

export async function handleTankDestroy(msg: Message) {
    if (msg.author.id === config.god || haveRole(msg, 'Mod')) {
        const game = storedGames.get(msg.channel.id);

        if (!game) {
            msg.reply('No game is currently running in this channel.')
            return;
        }

        await game.cleanup();

        storedGames.delete(msg.channel.id);

        msg.reply('Game successfully destroyed.');
    } else {
        msg.reply('You don\'t have permission to do that.');
    }
}
