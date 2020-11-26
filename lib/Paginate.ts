import {
    Message,
    MessageEmbed,
    User,
    MessageReaction,
    EmbedFieldData,
    ReactionCollector,
} from 'discord.js';

import { config } from './Config';

export enum DisplayType {
    EmbedFieldData = 1,
    EmbedData = 2,
    MessageData = 3,
}

export type DisplayItem<T> = (item: T) => EmbedFieldData | Array<EmbedFieldData>;
export type ModifyEmbed<T> = (item: T, embed: MessageEmbed) => void;
export type ModifyMessage<T> = (items: T[]) => string;

export class Paginate<T> {

    private currentPage: number = 1;

    private itemsPerPage: number;

    private locked: boolean = false;

    private lockID: string = '';

    private totalPages: number;

    private allowedRoles: string[] = [
        'Mod',
        'Los de Indendencia',
    ];

    private data: T[];

    private embed: MessageEmbed | undefined;

    private sourceMessage: Message;

    private sentMessage: Message | undefined;

    private displayFooter: boolean = true;

    private displayFunction: DisplayItem<T>
                           | ModifyEmbed<T>
                           | ModifyMessage<T>;

    private displayType: DisplayType;

    private collector: ReactionCollector | undefined;

    public constructor(
        sourceMessage: Message,
        itemsPerPage: number,
        displayFunction: DisplayItem<T> | ModifyEmbed<T> | ModifyMessage<T>,
        displayType: DisplayType,
        data: T[],
        embed: MessageEmbed | undefined,
        addFooter: boolean = true) {

        this.sourceMessage = sourceMessage;

        this.itemsPerPage = itemsPerPage;

        this.displayFunction = displayFunction;

        this.displayType = displayType;

        this.data = data;

        this.embed = embed;

        this.displayFooter = addFooter;

        this.totalPages = Math.floor(data.length / this.itemsPerPage)
                         + (data.length % this.itemsPerPage ? 1 : 0);
    }

    private getPageContent() {
        const startIndex = (this.currentPage - 1) * this.itemsPerPage;
        const endIndex = (this.currentPage) * this.itemsPerPage;

        switch (this.displayType) {
            case DisplayType.EmbedFieldData: {
                this.embed!.fields = [];

                if (this.displayFooter) {
                    this.embed!.setFooter(`Page ${this.currentPage} of ${this.totalPages}`);
                }

                for (const item of this.data.slice(startIndex, endIndex)) {
                    const newFields = (this.displayFunction as DisplayItem<T>)(item);

                    if (Array.isArray(newFields)) {
                        this.embed!.addFields(newFields);
                    } else {
                        this.embed!.addFields([newFields]);
                    }
                }

                return this.embed;
            }
            case DisplayType.EmbedData: {
                if (this.displayFooter) {
                    this.embed!.setFooter(`Page ${this.currentPage} of ${this.totalPages}`);
                }

                for (const item of this.data.slice(startIndex, endIndex)) {
                    (this.displayFunction as ModifyEmbed<T>)(item, this.embed!);
                }

                return this.embed;
            }
            case DisplayType.MessageData: {
                return (this.displayFunction as ModifyMessage<T>)(this.data.slice(startIndex, endIndex));
            }
        }
    }

    public async sendMessage(): Promise<Message> {
        const shouldPaginate = this.data.length > this.itemsPerPage;

        this.sentMessage = await this.sourceMessage.channel.send(this.getPageContent());

        if (!shouldPaginate) {
            return this.sentMessage;
        }

        await this.sentMessage.react('⬅️');
        await this.sentMessage.react('➡️');

        /* Not essential to be ordered or to block execution, lets do these non async */
        this.sentMessage.react('🔒');
        this.sentMessage.react('❌');

        this.collector = this.sentMessage.createReactionCollector((reaction, user) => {
            return ['⬅️', '➡️', '🔒', '❌'].includes(reaction.emoji.name) && !user.bot;
        }, { time: 600000, dispose: true }); // 10 minutes

        this.collector.on('collect', async (reaction: MessageReaction, user: User) => {
            switch (reaction.emoji.name) {
                case '⬅️': {
                    this.changePage(-1, reaction, user);
                    break;
                }
                case '➡️': {
                    this.changePage(1, reaction, user);
                    break;
                }
                case '🔒': {
                    this.lockEmbed(reaction, user);
                    break;
                }
                case '❌': {
                    this.removeEmbed(reaction, user);
                    break;
                }
                default: {
                    console.log('default case in paginate');
                    break;
                }
            }
         });

        this.collector.on('remove', async (reaction: MessageReaction, user: User) => {
            switch (reaction.emoji.name) {
                case '🔒': {
                    this.lockEmbed(reaction, user);
                    break;
                }
                default: {
                    break;
                }
            }
         });

        return this.sentMessage;
    }

    private lockEmbed(reaction: MessageReaction, user: User) {
        const guildUser = this.sourceMessage.guild!.members.cache.get(user.id);

        if (!guildUser) {
            reaction.users.remove(user.id);
            return;
        }

        for (let role of this.allowedRoles) {
            /* User has permission to perform action */
            if (guildUser.roles.cache.some((r) => r.name === role) || this.sourceMessage.author.id === user.id || user.id === config.god) {
                /* Embed is currently locked */
                if (this.locked) {
                    reaction.users.remove(user.id);

                    /* Locker is the current user, remove the lock */
                    if (this.lockID === user.id) {
                        this.locked = false;
                        this.lockID = '';
                    /* Locker is not the current user, do nothing, it's locked */
                    } else {
                        reaction.users.remove(user.id);
                    }
                /* Embed is unlocked, lock it */
                } else {
                    this.locked = true;
                    this.lockID = user.id;
                }

                return;
            }
        }

        reaction.users.remove(user.id);
    }

    private removeEmbed(reaction: MessageReaction, user: User) {
        const guildUser = this.sourceMessage.guild!.members.cache.get(user.id);

        if (!guildUser) {
            reaction.users.remove(user.id);
            return;
        }

        for (let role of this.allowedRoles) {
            if (guildUser.roles.cache.some((r) => r.name === role) || user.id === config.god) {
                this.sentMessage!.delete();
                return;
            }
        }

        reaction.users.remove(user.id);
    }

    private changePage(
        amount: number,
        reaction: MessageReaction,
        user: User) {

        reaction.users.remove(user.id);

        if (this.locked && user.id !== this.lockID) {
            return;
        }

        /* Check we can move this many pages */
        if (this.currentPage + amount >= 1 && this.currentPage + amount <= this.totalPages) {
            this.currentPage += amount;
        } else {
            return;
        }

        this.sentMessage!.edit(this.getPageContent());
    }
}
