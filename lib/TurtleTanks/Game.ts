import {
    Message,
    MessageAttachment,
    MessageEmbed,
    Guild,
    User,
    MessageReaction,
    TextChannel,
} from 'discord.js';

import { fabric } from 'fabric';
import { Database } from 'sqlite3';

import { MapTile } from './MapTile';
import { Player } from './Player';
import { Arrow } from './Arrow';

import {
    MapManager,
    MapSpecification,
} from './Map';

import {
    Coordinate,
    Direction,
    GameRules,
    Team,
    LogMessage,
    ShotResult,
    PlayerShotEffect,
} from './Types';

import {
    DEFAULT_MAP_HEIGHT,
    DEFAULT_MAP_WIDTH,
    COORDINATES_HEIGHT,
    COORDINATES_WIDTH,
    PREVIEW_ARROW_COLOR,
    PREVIEW_ARROW_WIDTH,
    DEFAULT_STARTING_HP,
    DEFAULT_STARTING_POINTS,
    POINTS_PER_MOVE,
    POINTS_PER_SHOT,
    POINTS_PER_KILL,
    POINTS_PER_TICK,
    MILLISECONDS_PER_TICK,
} from './Constants';

import {
    formatCoordinate,
    addMoveReactions,
    pointAndRadiusToSquare,
} from './Utilities';

import {
    getUsername,
    capitalize,
    pickRandomItem,
} from '../Utilities';

import {
    bodies,
    faces,
} from './Avatar';

import {
    SmallMissile,
} from './Weapons';

export class Game {
    private canvas: fabric.StaticCanvas;

    private map: MapManager;

    private initialRenderComplete: boolean = false;

    private players: Map<string, Player> = new Map();

    private deadPlayers: Map<string, Player> = new Map();

    private canvasWidth: number;
    private canvasHeight: number;
    
    private tileWidth: number;
    private tileHeight: number;

    private guild: Guild | undefined;

    private rules: GameRules;

    private log: LogMessage[] = [];

    private channel: TextChannel;

    private timer: ReturnType<typeof setTimeout>;

    constructor(
        channel: TextChannel,
        map?: MapSpecification,
        guild?: Guild,
        rules: Partial<GameRules> = {}) {

        if (rules.teams !== undefined) {
            if (rules.teams.length < 2) {
                throw new Error('Must provide at least two teams!');
            }
        }

        const gameRules: GameRules = {
            teams: rules.teams,
            millisecondsPerTick: rules.millisecondsPerTick || MILLISECONDS_PER_TICK,
            defaultStartingHp: rules.defaultStartingHp || DEFAULT_STARTING_HP,
            defaultStartingPoints: rules.defaultStartingPoints || DEFAULT_STARTING_POINTS,
            defaultPointsPerMove: rules.defaultPointsPerMove || POINTS_PER_MOVE,
            defaultPointsPerShot: rules.defaultPointsPerShot || POINTS_PER_SHOT,
            defaultPointsPerTick: rules.defaultPointsPerTick || POINTS_PER_TICK,
            defaultPointsPerKill: rules.defaultPointsPerKill || POINTS_PER_KILL,
        };

        this.rules = gameRules;

        const canvas = new fabric.StaticCanvas(null, {});

        if (map) {
            this.map = new MapManager(map, guild);
        } else {
            this.map = new MapManager({
                height: DEFAULT_MAP_HEIGHT,
                width: DEFAULT_MAP_WIDTH,
            }, guild);
        }

        const {
            width,
            height,
            tileWidth,
            tileHeight,
        } = this.map.dimensionsOnCanvas();

        canvas.setWidth(width);
        canvas.setHeight(height);

        this.canvas = canvas;
        this.canvasWidth = width;
        this.canvasHeight = height;
        this.tileHeight = tileHeight;
        this.tileWidth = tileWidth;
        this.guild = guild;
        this.channel = channel;

        this.log.push({
            message: 'Game was created',
            timestamp: new Date(),
            actionInitiator: 'System',
        });

        this.timer = setTimeout(() => this.handleGameTick(), MILLISECONDS_PER_TICK);
    }

    /* Game ticks award users points every time they run. */
    private async handleGameTick() {
        /* TextChannels we can spam in */
        const noisyChannels = [
            '820837312551714846',
            '483470443001413675',
        ];

        let pointMessage = '';

        for (const [id, player] of this.players) {
            player.points += player.pointsPerTick;

            const username = await getUsername(id, this.guild);

            this.log.push({
                message: `${username} was awarded ${player.pointsPerTick} points`,
                actionInitiator: 'System',
                timestamp: new Date(),
            });

            pointMessage += `<@${id}> You were awarded ${player.pointsPerTick} points. You now have ${player.points} points\n`;
        }

        if (noisyChannels.includes(this.channel.id)) {
            this.channel.send(pointMessage);
        }

        this.timer = setTimeout(() => this.handleGameTick(), MILLISECONDS_PER_TICK);
    }

    private async renderMap() {
        /* We only need to render the map once, since it should never change. */
        if (!this.initialRenderComplete) {
            await this.map.render(this.canvas, 0, 0);
            this.initialRenderComplete = true;
        }
    }

    private async renderPlayer(player: Player, highlight: boolean) {
        return player.render(
            this.canvas,
            (player.coords.x * this.tileWidth) + COORDINATES_WIDTH,
            (player.coords.y * this.tileHeight) + COORDINATES_HEIGHT,
            highlight,
        );
    }

    private async renderPlayers(id?: string) {
        const { tileWidth, tileHeight } = this.map.dimensionsOnCanvas();

        const promises = [];

        for (const [playerID, player] of this.players) {
            const highlight: boolean = id !== undefined && id === playerID;

            promises.push(this.renderPlayer(player, highlight));
        }

        await Promise.all(promises);
    }

    public async renderAndGetAttachment(userId?: string): Promise<MessageAttachment> {
        await this.render(userId);
        return this.getGameImageAttachment();
    }

    public async render(userId?: string): Promise<void> {
        await this.renderMap();
        await this.renderPlayers(userId);
        this.canvas.renderAll();
    }

    public async renderPlayerPreview(id: string, coords: Coordinate) {
        const player = this.players.get(id)!;

        const previewPlayer = new Player({
            ...player,
            coords,
            body: player.bodyFilePath,
            face: player.faceFilePath,
        });

        await this.renderPlayer(previewPlayer, true);

        const arrow = new Arrow(
            { 
                x: (player.coords.x * this.tileWidth) + COORDINATES_WIDTH + (this.tileWidth * 0.5),
                y: (player.coords.y * this.tileHeight) + COORDINATES_HEIGHT + (this.tileHeight * 0.5),
            },
            {
                x: (previewPlayer.coords.x * this.tileWidth) + COORDINATES_WIDTH + (this.tileWidth * 0.5),
                y: (previewPlayer.coords.y * this.tileHeight) + COORDINATES_HEIGHT + (this.tileWidth * 0.5),
            },
        );

        await arrow.render(this.canvas);

        return [previewPlayer, arrow];
    }

    /* Note: Note re-rendering here. Only need to re-render when game state
     * changes, not on every request to view the game state. */
    public getGameImage(): ReadableStream {
        return (this.canvas as any).createPNGStream();
    }

    public getGameImageAttachment(): MessageAttachment {
        return new MessageAttachment((this.canvas as any).createPNGStream(), 'turtle-tanks.png');
    }

    private chooseTeam(): Team {
        if (!this.rules.teams) {
            throw new Error('Cannot chose team, no teams given!');
        }

        const teamUserCount: Map<Team, number> = new Map();

        for (const team of this.rules.teams) {
            teamUserCount.set(team, 0);
        }

        for (const [id, player] of this.players) {
            if (player.team) {
                const n = teamUserCount.get(player.team)! + 1;
                teamUserCount.set(player.team, n);
            }
        }

        let minimumAmount = Number.MAX_SAFE_INTEGER;
        let minimumTeam;

        for (const [team, count] of teamUserCount) {
            if (count <= minimumAmount) {
                minimumTeam = team;
                minimumAmount = count;
            }
        }

        return minimumTeam as Team;
    }

    public async join(userId: string) {
        if (this.players.has(userId)) {
            return {
                err: 'You are already in the game!',
            };
        }

        if (this.deadPlayers.has(userId)) {
            return {
                err: 'Cannot perform action, you are dead.',
            };
        }

        const square = this.map.getUnoccupiedSquare();

        if (square === undefined) {
            return {
                err: 'Game is full, sorry.',
            };
        }

        const team = this.rules.teams
            ? this.chooseTeam()
            : undefined;

        const player = new Player({
            userId,
            points: this.rules.defaultStartingPoints,
            hp: this.rules.defaultStartingHp,
            pointsPerMove: this.rules.defaultPointsPerMove,
            pointsPerShot: this.rules.defaultPointsPerShot,
            pointsPerTick: this.rules.defaultPointsPerTick,
            pointsPerKill: this.rules.defaultPointsPerKill,
            coords: square.coords,
            team,
            body: team
                ? team.body
                : pickRandomItem(bodies),
            face: pickRandomItem(faces),
            weapon: SmallMissile,
        });

        this.players.set(userId, player);
        square.occupied = userId;

        const username = await getUsername(userId, this.guild);

        let message = `${username} joined the game`;

        if (player.team) {
            message += ` and was assigned to team ${player.team.name}`;
        }

        this.log.push({
            message,
            timestamp: new Date(),
            actionInitiator: username,
        });

        return {
            player,
        };
    }

    public hasPlayer(userId: string) {
        return this.players.has(userId);
    }

    public async confirmMove(
        userId: string,
        msg: Message,
        coords: Coordinate,
        tilesTraversed: number,
        pointsRequired: number) {

        const preview = await this.generateMovePreview(userId, coords);

        const player = this.players.get(userId)!;

        const oldCoordsPretty = formatCoordinate(player.coords);
        const newCoordsPretty = formatCoordinate(coords);

        const username = await getUsername(userId, this.guild);

        const embed = new MessageEmbed()
            .setTitle(`${capitalize(username)}, are you sure you want to move from ${oldCoordsPretty} to ${newCoordsPretty}?`)
            .setDescription(`This will cost ${pointsRequired} points. (${tilesTraversed} tile${tilesTraversed > 1 ? 's' : ''})`)
            .setFooter('React with 👍 to confirm the move')
            .attachFiles([preview])
            .setImage('attachment://turtle-tanks.png');

        const sentMessage = await msg.channel.send(embed);
        
        const collector = sentMessage.createReactionCollector((reaction: MessageReaction, user: User) => {
            return ['👍', '👎'].includes(reaction.emoji.name) && user.id === userId
        }, { time: 60 * 15 * 1000 });

        collector.on('collect', async (reaction: MessageReaction) => {
            collector.stop();

            if (reaction.emoji.name === '👎') {
                sentMessage.delete();
                return;
            }

            const [success, err] = await this.moveToCoord(userId, coords);

            sentMessage.delete();

            if (success) {
                const attachment = await this.renderAndGetAttachment(userId);

                const movedMessage = await msg.channel.send(
                    `<@${userId}> Successfully moved from ${oldCoordsPretty} to ${newCoordsPretty}. ` +
                    `You now have ${player.points} points.`,
                    attachment,
                );

                await addMoveReactions(movedMessage, this);
            } else {
                await msg.channel.send(`<@${userId}> Failed to perform move: ${err}`);
            }
        });

        try {
            await sentMessage.react('👍');
            await sentMessage.react('👎');
        } catch (err) {
        }
    }

    public async generateMovePreview(
        userId: string,
        newCoords: Coordinate): Promise<MessageAttachment> {
        
        await this.renderMap();
        await this.renderPlayers(userId);

        const [playerPreview, arrow] = await this.renderPlayerPreview(userId, newCoords);

        this.canvas.renderAll();

        const attachment = this.getGameImageAttachment();

        playerPreview.remove(this.canvas);
        arrow.remove(this.canvas);

        return attachment;
    }

    public async generateAttackPreview(
        player: Player,
        coord: Coordinate,
        tilesAffected: MapTile[]): Promise<MessageAttachment> {
        
        await this.renderMap();
        await this.renderPlayers(player.userId);

        const tileMarkers = await this.map.renderAttackPreview(this.canvas, tilesAffected);

        this.canvas.renderAll();

        const attachment = this.getGameImageAttachment();

        for (const marker of tileMarkers) {
            this.canvas.remove(marker);
        }

        return attachment;
    }

    public async canMove(userId: string, coords: Coordinate) {
        const player = this.players.get(userId);

        if (!player) {
            return {
                err: 'User is not in the game',
            };
        }

        return await this.map.canMoveTo(coords, player);
    }

    public async moveToCoord(userId: string, coords: Coordinate): Promise<[boolean, string]> {
        const result = await this.canMove(userId, coords);

        if (result.err !== undefined) {
            return [false, result.err];
        }

        const player = this.players.get(userId)!;

        if (player.points >= result.pointsRequired) {
            player.points -= result.pointsRequired;
        } else {
            return [
                false,
                `You don't have enough points required to move ${result.tilesTraversed} tiles. ` +
                `You need ${result.pointsRequired} points, but have ${player.points} points.`,
            ];
        }

        if (player.points < 0) {
            console.log('Error, players points went negative');
        }

        const oldPosition = player.coords;

        /* Square they moved from is no longer occupied */
        this.map.getTile(oldPosition).occupied = undefined;

        /* Square they moved to is now occupied */
        this.map.getTile(coords).occupied = userId;

        /* And update the players position. */
        player.coords = coords;

        const username = await getUsername(userId, this.guild);

        this.log.push({
            message: `${username} moved from ${formatCoordinate(oldPosition)} to ${formatCoordinate(coords)}, ` +
                `consuming ${result.pointsRequired} points`,
            actionInitiator: username,
            timestamp: new Date(),
        });

        return [true, ''];
    }

    public fetchPlayerLocation(userId: string): Coordinate | undefined {
        const player = this.players.get(userId);

        if (!player) {
            return undefined;
        }

        return player.coords;
    }

    public getPlayerOrDead(userId: string): Player | undefined {
        return this.players.get(userId) || this.deadPlayers.get(userId);
    }

    public getPlayer(userId: string): Player | undefined {
        return this.players.get(userId);
    }

    public isDead(userId: string): boolean {
        return this.deadPlayers.get(userId) !== undefined;
    }

    public getPlayerAtLocation(coords: Coordinate): Player | undefined {
        const tile = this.map.tryGetTile(coords);

        if (tile && tile.occupied !== undefined) {
            return this.players.get(tile.occupied);
        }

        return undefined;
    }

    public coordinateExists(coords: Coordinate): boolean {
        const tile = this.map.tryGetTile(coords);

        return tile !== undefined;
    }

    public getLogs(): LogMessage[] {
        return this.log;
    }

    public getPlayersInRadius(coord: Coordinate, radius: number) {
        const [start, end] = pointAndRadiusToSquare(coord, radius);

        return this.getPlayersBetween(start, end);
    }

    public getPlayersBetween(start: Coordinate, end: Coordinate): Player[] {
        const tiles = this.map.getTilesBetween(start, end, false);

        const players = [];

        for (const tile of tiles) {
            if (tile.occupied !== undefined) {
                const player = this.players.get(tile.occupied);

                if (player !== undefined) {
                    players.push(player);
                }
            }
        }

        return players;
    }

    public async canAttack(userId: string, coords: Coordinate) {
        const player = this.players.get(userId);

        if (player === undefined) {
            return {
                err: `Player is not in the game`,
            };
        }

        const tile = this.map.tryGetTile(coords);

        const coordPretty = formatCoordinate(coords);

        if (tile === undefined) {
            return {
                err: `Cannot attack ${coordPretty}, tile does not exist`,
            };
        }

        if (tile.sparse) {
            return {
                err: `Cannot attack ${coordPretty}, it is out of bounds`,
            };
        }

        const shotDistance = this.map.distanceBetweenStraightLine(player.coords, coords);

        if (shotDistance > player.weapon.range) {
            return {
                err: `Cannot attack ${coordPretty}, your weapon has a range of ` +
                    `${player.weapon.range} tiles, but ${coordPretty} is ${shotDistance} tiles away`,
            };
        }

        if (player.points < player.pointsPerShot) {
            return {
                err: `Cannot attack ${coordPretty}, you need ${player.pointsPerShot} ` +
                    `points, but have ${player.points} points`,
            };
        }

        const tilesInRadius = this.map.getTilesInRadius(coords, player.weapon.radius, false);

        const affectedPlayers = [];
        const affectedTiles = [];
        const killedPlayers = [];

        let totalDamage = 0;

        for (const tile of tilesInRadius) {
            if (tile.occupied !== undefined) {
                const tilePlayer = this.players.get(tile.occupied);

                if (tilePlayer !== undefined) {
                    /* Shooting yourself will still take damage! */
                    if (tilePlayer.userId !== player.userId) {
                        /* Player is shooting teammate, no damage */
                        if (tilePlayer.team && player.team && tilePlayer.team.name === player.team.name) {
                            continue;
                        }
                    }

                    const newHP = Math.max(tilePlayer.hp - player.weapon.damage, 0);
                    const damageTaken = tilePlayer.hp - newHP;

                    totalDamage += damageTaken;

                    affectedPlayers.push({
                        player: tilePlayer,
                        oldHP: tilePlayer.hp,
                        newHP,
                        damageTaken,
                    });

                    if (newHP === 0) {
                        killedPlayers.push(tilePlayer);
                    }
                }
            }

            affectedTiles.push(tile);
        }

        return {
            affectedTiles,
            affectedPlayers,
            killedPlayers,
            pointsRequired: player.pointsPerShot,
            totalDamage,
        };
    }

    private async checkForEndOfGame() {
        const alivePlayers = [];

        const teams: Set<string> = new Set([]);

        for (const [id, player] of this.players) {
            if (!player.dead) {
                alivePlayers.push(player);

                if (player.team) {
                    teams.add(player.team.name);
                }
            }
        }

        if (alivePlayers.length === 0) {
            throw new Error('Zero alive players remaining!');
        }

        /* Only one player or team left standing */
        if (alivePlayers.length === 1 || teams.size === 1) {
            clearTimeout(this.timer);
            return [true, alivePlayers];
        }

        return [false, undefined];
    }

    public async doAttack(userId: string, coords: Coordinate) {
        const result = await this.canAttack(userId, coords);

        if (result.err !== undefined) {
            return result;
        }

        const attacker = this.players.get(userId)!;
        const attackerName = await getUsername(userId, this.guild);

        this.log.push({
            message: `${attackerName} fired a ${attacker.weapon.name} at ` +
                `${result.affectedPlayers.length} players for a total of ${result.totalDamage} damage, ` +
                `consuming ${attacker.pointsPerShot} points`,
            timestamp: new Date(),
            actionInitiator: attackerName,
        });

        attacker.points -= attacker.pointsPerShot;

        for (const player of result.affectedPlayers) {
            const newHP = player.player.receiveDamage(player.damageTaken);

            if (newHP === 0) {
                this.deadPlayers.set(player.player.userId, player.player);
                player.player.remove(this.canvas);
                this.players.delete(player.player.userId);
            }

            const receiver = await getUsername(player.player.userId, this.guild);

            let message = `${receiver} received ${player.damageTaken} damage from ` +
                    `${attackerName}'s ${attacker.weapon.name}`;

            if (newHP === 0) {
                message += ` and was killed!`;

                this.log.push({
                    message: `${attackerName} was awarded ${attacker.pointsPerKill} points for killing a player.`,
                    timestamp: new Date(),
                    actionInitiator: attackerName,
                });

                attacker.points += attacker.pointsPerKill;
            } else {
                message += `. They now have ${newHP} HP`;
            }

            this.log.push({
                message,
                timestamp: new Date(),
                actionInitiator: attackerName,
            });
        }

        const [ended, winners] = await this.checkForEndOfGame();

        return {
            ...result,
            ended,
            winners,
        }
    }

    private async buildAffectedPlayersMsg(affectedPlayers: PlayerShotEffect[]) {
        let msg = '';

        if (affectedPlayers.length > 0) {
            let i = 0;

            for (const player of affectedPlayers) {
                const finalIteration = i === affectedPlayers.length - 1;

                const username = await getUsername(player.player.userId, this.guild);

                msg += `, `;

                if (finalIteration) {
                    msg += `and `;
                }

                msg += `${player.damageTaken} HP in damage to ${username}`;

                if (player.newHP === 0) {
                    msg += `, killing them`
                }

                i++;
            }
        }

        return msg;
    }

    public async confirmAttack(
        userId: string,
        msg: Message,
        coords: Coordinate,
        shotResult: ShotResult): Promise<{ ended: boolean }> {
        return new Promise(async (resolve) => {
            const player = this.players.get(userId)!;

            const preview = await this.generateAttackPreview(player, coords, shotResult.affectedTiles);

            const coordPretty = formatCoordinate(coords);

            const username = await getUsername(userId, this.guild);

            let description = `Your ${player.weapon.name} will cause ${shotResult.totalDamage} HP in total damage`;

            description += await this.buildAffectedPlayersMsg(shotResult.affectedPlayers);

            const embed = new MessageEmbed()
                .setTitle(`${capitalize(username)}, are you sure want to attack ${coordPretty}?`)
                .setDescription(`${description}. This will cost ${shotResult.pointsRequired} points.`)
                .setFooter('React with 👍 to confirm the attack')
                .attachFiles([preview])
                .setImage('attachment://turtle-tanks.png');

            const sentMessage = await msg.channel.send(embed);

            const collector = sentMessage.createReactionCollector((reaction: MessageReaction, user: User) => {
                return ['👍', '👎'].includes(reaction.emoji.name) && user.id === userId
            }, { time: 60 * 15 * 1000 });

            collector.on('collect', async (reaction: MessageReaction) => {
                collector.stop();

                if (reaction.emoji.name === '👎') {
                    sentMessage.delete();
                    resolve({ ended: false });
                    return;
                }

                const result = await this.doAttack(userId, coords);

                sentMessage.delete();

                if (result.err === undefined) {
                    const attachment = await this.renderAndGetAttachment(userId);

                    let damageDescription = `Your ${player.weapon.name} caused ${result.totalDamage} HP in total damage`;

                    damageDescription += await this.buildAffectedPlayersMsg(result.affectedPlayers);

                    const attackMessage = await msg.channel.send(
                        `<@${userId}> Successfully attacked ${coordPretty}. ${damageDescription}`,
                        attachment,
                    );

                    for (const deadPlayer of result.killedPlayers) {
                        if (deadPlayer.userId === player.userId) {
                            msg.channel.send(
                                `<@${deadPlayer.userId}> You killed yourself with your own ` +
                                `${player.weapon.name}! Good job!`,
                            );
                        } else {
                            msg.channel.send(
                                `<@${deadPlayer.userId}> You were killed by ${username}'s ` +
                                `${player.weapon.name}! Better luck next time!`,
                            );
                        }
                    }

                    if (result.ended) {
                        const winner = (result.winners as Player[])[0];

                        if (winner.team) {
                            msg.channel.send(`Congratulations, team ${winner.team.name}, you won the game!`);
                        } else {
                            msg.channel.send(`Congratulations, <@${winner.userId}>, you won the game!`);
                        }

                        resolve({ ended: true });
                    } else {
                        await addMoveReactions(attackMessage, this);
                        resolve({ ended: false });
                    }
                } else {
                    await msg.channel.send(`<@${userId}> Failed to perform attack: ${result.err}`);
                    resolve({ ended: false });
                }
            });

            try {
                await sentMessage.react('👍');
                await sentMessage.react('👎');
            } catch (err) {
            }
        });
    }
}
