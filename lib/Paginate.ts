import {
    Message,
    MessageEmbed,
    User,
    MessageReaction,
    EmbedFieldData,
    ReactionCollector,
    GuildMember,
} from 'discord.js';

import { config } from './Config';

export enum DisplayType {
    EmbedFieldData = 1,
    EmbedData = 2,
    MessageData = 3,
}

export type DisplayItem<T> = (this: Paginate<T>, item: T, page?: number) => EmbedFieldData | Array<EmbedFieldData>;
export type ModifyEmbed<T> = (this: Paginate<T>, item: T, embed: MessageEmbed) => void;
export type ModifyMessage<T> = (this: Paginate<T>, items: T[], message: Message) => string;

export type PaginateFunction<T> = DisplayItem<T>
                                | ModifyEmbed<T>
                                | ModifyMessage<T>;

export type DetermineDisplayType<T> = (items: T[]) => { displayType: DisplayType, displayFunction: PaginateFunction<T> };

export interface PaginateOptions<T> {
    sourceMessage: Message;

    itemsPerPage?: number;

    displayType: DisplayType;

    displayFunction: PaginateFunction<T>;

    determineDisplayTypeFunction?: DetermineDisplayType<T>;

    data: T[];

    embed?: MessageEmbed;

    hideFooter?: boolean;
}

export class Paginate<T> {

    public currentPage: number = 1;

    public totalPages: number;

    private itemsPerPage: number;

    private locked: boolean = false;

    private lockID: string = '';

    private allowedRoles: string[] = [
        'Mod',
        'Los de Indendencia',
    ];

    private data: T[];

    private embed: MessageEmbed | undefined;

    private sourceMessage: Message;

    private sentMessage: Message | undefined;

    private displayFooter: boolean = true;

    private displayFunction: PaginateFunction<T>;

    private determineDisplayTypeFunction?: DetermineDisplayType<T>;

    private displayType: DisplayType;

    private collector: ReactionCollector | undefined;

    public constructor(options: PaginateOptions<T>) {
        const {
            sourceMessage,
            itemsPerPage = 1,
            displayType,
            displayFunction,
            data,
            embed,
            hideFooter = false,
            determineDisplayTypeFunction,
        } = options;

        this.sourceMessage = sourceMessage;
        this.itemsPerPage = itemsPerPage;
        this.displayType = displayType;
        this.displayFunction = displayFunction;
        this.data = data;
        this.embed = embed;
        this.displayFooter = !hideFooter;
        this.determineDisplayTypeFunction = determineDisplayTypeFunction;
        this.totalPages = Math.floor(data.length / this.itemsPerPage)
                         + (data.length % this.itemsPerPage ? 1 : 0);
    }

    private editMessage(data: any) {
        const embed = this.displayType === DisplayType.MessageData
            ? null
            : data;

        const content = this.displayType === DisplayType.MessageData
            ? data
            : null;

        this.sentMessage!.edit({
            embed,
            content,
        });
    }

    private setPageFooter(editMessage: boolean = false) {
        if (!this.displayFooter) {
            return;
        }

        if (this.displayType !== DisplayType.MessageData) {
            if (this.embed) {
                this.embed.setFooter(this.getPageFooter());

                if (editMessage) {
                    this.editMessage(this.embed);
                }
            }
        }
    }

    public getPageFooter() {
        if (!this.displayFooter) {
            return '';
        }

        let lockMessage = '';

        if (this.locked) {
            const user = this.sourceMessage.guild!.members.cache.get(this.lockID);

            if (user) {
                lockMessage = `. Locked by ${user.displayName}.`;
            }
        }

        return `Page ${this.currentPage} of ${this.totalPages}${lockMessage}`;
    }

    private getPageContent() {
        const startIndex = (this.currentPage - 1) * this.itemsPerPage;
        const endIndex = (this.currentPage) * this.itemsPerPage;

        const items = this.data.slice(startIndex, endIndex);

        if (this.determineDisplayTypeFunction) {
            const {
                displayType,
                displayFunction
            } = this.determineDisplayTypeFunction(items);

            this.displayType = displayType;
            this.displayFunction = displayFunction;
        }

        this.setPageFooter();

        switch (this.displayType) {
            case DisplayType.EmbedFieldData: {
                this.embed!.fields = [];

                const f = (this.displayFunction as DisplayItem<T>).bind(this);

                for (const item of items) {
                    const newFields = f(item);

                    if (Array.isArray(newFields)) {
                        this.embed!.addFields(newFields);
                    } else {
                        this.embed!.addFields([newFields]);
                    }
                }

                return this.embed;
            }
            case DisplayType.EmbedData: {
                for (const item of items) {
                    const f = (this.displayFunction as ModifyEmbed<T>).bind(this);
                    f(item, this.embed!);
                }

                return this.embed;
            }
            case DisplayType.MessageData: {
                const f = (this.displayFunction as ModifyMessage<T>).bind(this);
                return f(items, this.sentMessage!);
            }
        }
    }

    public swapDisplayType(newDisplayType: DisplayType) {
        this.displayType = newDisplayType;
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

        if (!this.havePermission(guildUser, user)) {
            reaction.users.remove(user.id);
            return;
        }

        /* Embed is unlocked, lock it, leave lock reaction */
        if (!this.locked) {
            this.locked = true;
            this.lockID = user.id;
            this.editMessage(this.getPageContent());
            return;
        }

        reaction.users.remove(user.id);

        /* Locker is the current user, remove the lock */
        if (this.lockID === user.id) {
            this.locked = false;
            this.lockID = '';
            this.editMessage(this.getPageContent());
        }
    }

    private removeEmbed(reaction: MessageReaction, user: User) {
        const guildUser = this.sourceMessage.guild!.members.cache.get(user.id);

        if (!guildUser) {
            reaction.users.remove(user.id);
            return;
        }

        if (this.havePermission(guildUser, user)) {
            this.sentMessage!.delete();
            return;
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

        this.editMessage(this.getPageContent());
    }

    private havePermission(guildUser: GuildMember, user: User) {
        if (user.id === config.god) {
            return true;
        }

        if (this.sourceMessage.author.id === user.id) {
            return true;
        }

        for (const role of this.allowedRoles) {
            if (guildUser.roles.cache.some((r) => r.name === role)) {
                return true;
            }
        }

        return false;
    }
}
