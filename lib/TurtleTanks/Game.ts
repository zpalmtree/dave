import {
    Message,
    MessageAttachment,
    MessageEmbed,
    Guild,
    User,
    MessageReaction,
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
    PlayerStatus,
} from './Types';

import {
    DEFAULT_MAP_HEIGHT,
    DEFAULT_MAP_WIDTH,
    COORDINATES_HEIGHT,
    COORDINATES_WIDTH,
    PREVIEW_ARROW_COLOR,
    PREVIEW_ARROW_WIDTH,
} from './Constants';

import {
    formatCoordinate,
    addMoveReactions,
} from './Utilities';

import {
    getUsername,
    capitalize,
} from '../Utilities';

export class Game {
    private canvas: fabric.StaticCanvas;

    private map: MapManager;

    private initialRenderComplete: boolean = false;

    private players: Map<string, Player> = new Map();

    private canvasWidth: number;
    private canvasHeight: number;
    
    private tileWidth: number;
    private tileHeight: number;

    private guild: Guild | undefined;

    constructor(map?: MapSpecification, guild?: Guild) {
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

        const previewPlayer = new Player(id, coords, player.bodyFilePath, player.faceFilePath);

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

    public join(userId: string): string | undefined {
        if (this.players.has(userId)) {
            return 'You are already in the game!';
        }

        const square = this.map.getUnoccupiedSquare();

        if (square === undefined) {
            return 'Game is full, sorry.';
        }

        this.players.set(userId, new Player(userId, square.coords));
        square.occupied = userId;

        return;
    }

    public hasPlayer(userId: string) {
        return this.players.has(userId);
    }

    public async confirmMove(
        userId: string,
        msg: Message,
        coords: Coordinate) {

        const preview = await this.generateMovePreview(userId, coords);

        const player = this.players.get(userId)!;

        const oldCoordsPretty = formatCoordinate(player.coords);
        const newCoordsPretty = formatCoordinate(coords);

        const username = await getUsername(userId, this.guild);

        const embed = new MessageEmbed()
            .setTitle(`${capitalize(username)}, are you sure you want to move from ${oldCoordsPretty} to ${newCoordsPretty}?`)
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
                const sentMessage = await msg.channel.send(`<@${userId}> Successfully moved from ${oldCoordsPretty} to ${newCoordsPretty}.`, attachment);

                await addMoveReactions(sentMessage, this);
            } else {
                await msg.channel.send(`<@${userId}> Failed to perform move: ${err}`);
            }
        });

        await sentMessage.react('👍');
        await sentMessage.react('👎');
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

    public async canMove(userId: string, coords: Coordinate): Promise<[boolean, string]> {
        const player = this.players.get(userId);

        if (!player) {
            return [false, 'User is not in the game'];
        }

        const [success, err] = await this.map.canMoveTo(coords, userId);

        if (!success) {
            return [false, err];
        }

        return [true, ''];
    }

    public async moveToCoord(userId: string, coords: Coordinate): Promise<[boolean, string]> {
        const [success, err] = await this.canMove(userId, coords);

        if (!success) {
            return [false, err];
        }

        const player = this.players.get(userId)!;

        /* Square they moved from is no longer occupied */
        this.map.getTile(player.coords).occupied = undefined;

        /* Square they moved to is now occupied */
        this.map.getTile(coords).occupied = userId;

        /* And update the players position. */
        player.coords = coords;

        return [true, ''];
    }

    public fetchPlayerLocation(userId: string): Coordinate | undefined {
        const player = this.players.get(userId);

        if (!player) {
            return undefined;
        }

        return player.coords;
    }

    public getPlayerStatus(userId: string): PlayerStatus | undefined {
        const player = this.players.get(userId);

        if (!player) {
            return undefined;
        }

        return player.getStatus();
    }
}
