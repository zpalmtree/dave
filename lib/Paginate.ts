import {
    Message,
    MessageEmbed,
    User,
    MessageReaction,
    EmbedFieldData,
    ReactionCollector,
    GuildMember,
} from 'discord.js';

import {
    getUsername,
    tryReactMessage,
    tryDeleteMessage,
    tryDeleteReaction,
} from './Utilities';

import { config } from './Config';

export enum DisplayType {
    EmbedFieldData = 1,
    EmbedData = 2,
    MessageData = 3,
}

type Asyncable<T> = T | Promise<T>

export type DisplayItem<T> = (
    this: Paginate<T>,
    item: T,
) => Asyncable<EmbedFieldData | Array<EmbedFieldData>>;

export type ModifyEmbed<T> = (
    this: Paginate<T>,
    item: T,
    embed: MessageEmbed,
) => any;

export type ModifyMessage<T> = (
    this: Paginate<T>,
    items: T[],
    message: Message,
) => Asyncable<string>;

export type CustomReactionEmbedCallback<T> = (
    this: Paginate<T>,
    pageItems: T[],
    embed: MessageEmbed,
    reaction: MessageReaction,
    user: User,
) => Asyncable<MessageEmbed | undefined>;

export type CustomReactionCallback<T> = (
    this: Paginate<T>,
    pageItems: T[],
    message: Message,
    reaction: MessageReaction,
    user: User,
) => Asyncable<string>;

export type PaginateFunction<T> = DisplayItem<T>
                                | ModifyEmbed<T>
                                | ModifyMessage<T>;

export type CustomReactionFunction<T> = CustomReactionEmbedCallback<T>
                                      | CustomReactionCallback<T>;

export type DetermineDisplayType<T> = (items: T[]) => {
    displayType: DisplayType,
    displayFunction: PaginateFunction<T>,
};

export interface PaginateOptions<T> {
    sourceMessage: Message;

    itemsPerPage?: number;

    displayType: DisplayType;

    displayFunction: PaginateFunction<T>;

    determineDisplayTypeFunction?: DetermineDisplayType<T>;

    data: T[];

    embed?: MessageEmbed;

    hideFooter?: boolean;

    customReactions?: string[];

    customReactionFunction?: CustomReactionFunction<T>;
}

export class Paginate<T> {

    public currentPage: number = 0;

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

    private customReactions: string[] | undefined;

    private customReactionFunction: CustomReactionFunction<T> | undefined;

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
            customReactions,
            customReactionFunction,
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
        this.customReactionFunction = customReactionFunction;
        this.customReactions = customReactions;

        if (customReactions && !customReactionFunction) {
            throw new Error('Must provide custom reaction function with custom reactions!');
        }
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

    private async setPageFooter(editMessage: boolean = false) {
        if (!this.displayFooter) {
            return;
        }

        if (this.displayType !== DisplayType.MessageData) {
            if (this.embed) {
                const footer = await this.getPageFooter();
                this.embed.setFooter(footer);

                if (editMessage) {
                    this.editMessage(this.embed);
                }
            }
        }
    }

    public async deleteMessage() {
        await tryDeleteMessage(this.sentMessage!);
    }

    public async getPageFooter() {
        if (!this.displayFooter) {
            return '';
        }

        let lockMessage = '';

        if (this.locked) {
            const user = await getUsername(this.lockID, this.sourceMessage.guild);
            lockMessage = `. Locked by ${user}.`;
        }

        return `Page ${this.currentPage + 1} of ${this.totalPages}${lockMessage}`;
    }

    private async getPageContent() {
        const startIndex = this.currentPage * this.itemsPerPage;
        const endIndex = (this.currentPage + 1) * this.itemsPerPage;

        const items = this.data.slice(startIndex, endIndex);

        if (this.determineDisplayTypeFunction) {
            const {
                displayType,
                displayFunction
            } = this.determineDisplayTypeFunction(items);

            this.displayType = displayType;
            this.displayFunction = displayFunction;
        }
        
        await this.setPageFooter();

        switch (this.displayType) {
            case DisplayType.EmbedFieldData: {
                this.embed!.fields = [];

                const f = (this.displayFunction as DisplayItem<T>).bind(this);

                for (const item of items) {
                    const newFields = await f(item);

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
                    await f(item, this.embed!);
                }

                return this.embed;
            }
            case DisplayType.MessageData: {
                const f = (this.displayFunction as ModifyMessage<T>).bind(this);
                return await f(items, this.sentMessage!);
            }
        }
    }

    public swapDisplayType(newDisplayType: DisplayType) {
        this.displayType = newDisplayType;
    }

    public async sendMessage(): Promise<Message> {
        const shouldPaginate = this.data.length > this.itemsPerPage;

        const content = await this.getPageContent();

        this.sentMessage = await this.sourceMessage.channel.send(content!);

        let reactions = ['❌'].concat(this.customReactions || []);

        /* Only enable pagination and locking if we need multiple pages. */
        if (shouldPaginate) {
            reactions = reactions.concat(['⬅️', '➡️', '🔒']);
        }

        this.collector = this.sentMessage.createReactionCollector((reaction, user) => {
            return reactions.includes(reaction.emoji.name) && !user.bot;
        }, { time: 60 * 15 * 1000, dispose: true });

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
                    if (this.customReactions && this.customReactions.includes(reaction.emoji.name)) {
                        this.dispatchCustomReaction(reaction, user);
                    } else {
                        console.log('default case in paginate');
                    }

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

        for (const reaction of this.customReactions || []) {
            await tryReactMessage(this.sentMessage, reaction);
        }

        if (shouldPaginate) {
            await tryReactMessage(this.sentMessage, '⬅️');
            await tryReactMessage(this.sentMessage, '➡️');

            /* Not essential to be ordered or to block execution, lets do these non async */
            tryReactMessage(this.sentMessage, '🔒');
        }

        tryReactMessage(this.sentMessage, '❌');

        return this.sentMessage;
    }

    private async lockEmbed(reaction: MessageReaction, user: User) {
        const guildUser = await this.sourceMessage.guild?.members.fetch(user.id);

        if (!this.havePermission(guildUser, user)) {
            tryDeleteReaction(reaction, user.id);
            return;
        }

        /* Embed is unlocked, lock it, leave lock reaction */
        if (!this.locked) {
            this.locked = true;
            this.lockID = user.id;

            const content = await this.getPageContent();
            this.editMessage(content);

            return;
        }

        tryDeleteReaction(reaction, user.id);

        /* Locker is the current user, remove the lock */
        if (this.lockID === user.id) {
            this.locked = false;
            this.lockID = '';

            const content = await this.getPageContent();
            this.editMessage(content);
        }
    }

    private async removeEmbed(reaction: MessageReaction, user: User) {
        const guildUser = await this.sourceMessage.guild?.members.fetch(user.id);

        if (this.havePermission(guildUser, user)) {
            tryDeleteMessage(this.sentMessage!);
            return;
        }

        tryDeleteReaction(reaction, user.id);
    }

    private async changePage(
        amount: number,
        reaction: MessageReaction,
        user: User) {

        tryDeleteReaction(reaction, user.id);

        if (this.locked && user.id !== this.lockID) {
            return;
        }

        const mod = (n: number, m: number) => {
            return ((n % m) + m) % m;
        }

        this.currentPage = mod(this.currentPage + amount, this.totalPages);

        const content = await this.getPageContent();

        this.editMessage(content);
    }

    private async getCustomReactionContent(reaction: MessageReaction, user: User) {
        const startIndex = (this.currentPage) * this.itemsPerPage;
        const endIndex = (this.currentPage + 1) * this.itemsPerPage;

        const items = this.data.slice(startIndex, endIndex);

        switch (this.displayType) {
            case DisplayType.EmbedFieldData:
            case DisplayType.EmbedData: {
                const f = (this.customReactionFunction as CustomReactionEmbedCallback<T>).bind(this);

                return f(items, this.embed!, reaction, user);
            }
            case DisplayType.MessageData: {
                const f = (this.customReactionFunction as CustomReactionCallback<T>).bind(this);

                return f(items, this.sentMessage!, reaction, user);
            }
        }
    }

    private async dispatchCustomReaction(reaction: MessageReaction, user: User) {
        const content = await this.getCustomReactionContent(reaction, user);

        if (content) {
            this.editMessage(content);
        }
    }

    private havePermission(guildUser: GuildMember | undefined, user: User) {
        if (user.id === config.god) {
            return true;
        }

        if (this.sourceMessage.author.id === user.id) {
            return true;
        }

        if (guildUser) {
            for (const role of this.allowedRoles) {
                if (guildUser.roles.cache.some((r) => r.name === role)) {
                    return true;
                }
            }
        }

        return false;
    }
}
