import {
    Message,
    AttachmentBuilder,
    EmbedBuilder,
    User,
    MessageReaction,
    ReactionCollector,
    GuildMember,
    TextChannel,
} from 'discord.js';

import {
    getUsername,
    tryReactMessage,
    tryDeleteMessage,
    tryDeleteReaction,
} from './Utilities.js';

import { config } from './Config.js';

export enum DisplayType {
    EmbedFieldData = 1,
    EmbedData = 2,
    MessageData = 3,
}

export interface PaginateOptions<T> {
    sourceMessage: Message;

    itemsPerPage?: number;

    displayType: DisplayType;

    displayFunction: any;

    determineDisplayTypeFunction?: any;

    data: T[];

    embed?: EmbedBuilder;

    hideFooter?: boolean;

    customReactions?: string[];

    customReactionFunction?: any;

    permittedUsers?: string[];
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

    private embed: EmbedBuilder | undefined;

    private sourceMessage: Message;

    private sentMessage: Message | undefined;

    private displayFooter: boolean = true;

    private displayFunction: any;

    private determineDisplayTypeFunction?: any;

    private displayType: DisplayType;

    private collector: ReactionCollector | undefined;

    private customReactions: string[] | undefined;

    private customReactionFunction: any | undefined;

    private permittedUsers: string[] | undefined;

    private isUproar(): boolean {
        return (this.sourceMessage as Message & { platform?: string }).platform === 'uproar';
    }

    private getUproarEmbedContent(): string {
        const embed = this.embed!.toJSON();
        const parts: string[] = [];

        if (embed.author?.name) {
            parts.push(`**${embed.author.name}**`);
        }

        if (embed.title) {
            parts.push(embed.url ? `**[${embed.title}](${embed.url})**` : `**${embed.title}**`);
        }

        if (embed.description) {
            parts.push(embed.description);
        }

        for (const field of embed.fields || []) {
            parts.push(`**${field.name}**\n${field.value}`);
        }

        if (embed.image?.url && !embed.image.url.startsWith('attachment://')) {
            parts.push(embed.image.url);
        }

        if (embed.footer?.text) {
            parts.push(`_${embed.footer.text}_`);
        }

        return parts.join('\n\n');
    }

    public constructor(options: any) {
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
            permittedUsers,
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
        this.permittedUsers = permittedUsers;

        if (customReactions && !customReactionFunction) {
            throw new Error('Must provide custom reaction function with custom reactions!');
        }
    }

    private async editMessage(data: any) {
        try {
            await this.sentMessage!.edit(data);
        } catch (err) {
            console.log(err);
        }
    }

    private async setPageFooter(editMessage: boolean = false) {
        if (!this.displayFooter) {
            return;
        }

        if (this.displayType !== DisplayType.MessageData) {
            if (this.embed) {
                const footer = await this.getPageFooter();
                this.embed.setFooter({ text: footer });

                if (editMessage) {
                    this.editMessage({ embeds: [this.embed] });
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

    private async getPageContent(): Promise<({ embeds: EmbedBuilder[] } | { content: string })> {
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
                this.embed!.setFields([]);

                const f = this.displayFunction.bind(this);

                for (const item of items) {
                    const newFields = await f(item, this.embed!);

                    if (Array.isArray(newFields)) {
                        this.embed!.addFields(newFields);
                    } else {
                        this.embed!.addFields([newFields]);
                    }
                }

                return this.isUproar()
                    ? { content: this.getUproarEmbedContent() }
                    : { embeds: [this.embed!] };
            }
            case DisplayType.EmbedData: {
                let extraPayload: Record<string, unknown> = {};

                for (const item of items) {
                    const f = this.displayFunction.bind(this);
                    const displayResult = await f(item, this.embed!);

                    if (displayResult && typeof displayResult === 'object') {
                        extraPayload = { ...extraPayload, ...displayResult };
                    }
                }

                return this.isUproar()
                    ? { content: this.getUproarEmbedContent(), ...extraPayload }
                    : { embeds: [this.embed!], ...extraPayload };
            }
            case DisplayType.MessageData: {
                const f = this.displayFunction.bind(this);
                return {
                    content: await f(items, this.sentMessage!),
                };
            }
        }
    }

    public swapDisplayType(newDisplayType: DisplayType) {
        this.displayType = newDisplayType;
    }

    public async sendMessage(): Promise<Message> {
        const shouldPaginate = this.data.length > this.itemsPerPage;
        const controls = this.isUproar()
            ? { remove: '🗑️', previous: '◀️', next: '➡️', lock: '🔒' }
            : { remove: '❌', previous: '⬅️', next: '➡️', lock: '🔒' };

        this.sentMessage = await (this.sourceMessage.channel as TextChannel).send({
            ...await this.getPageContent(),
        });

        let reactions = [controls.remove].concat(this.customReactions || []);

        /* Only enable pagination and locking if we need multiple pages. */
        if (shouldPaginate) {
            reactions = reactions.concat([controls.previous, controls.next, controls.lock]);
        }

        this.collector = this.sentMessage!.createReactionCollector({
            filter: (reaction: MessageReaction, user: User) => {
                if (!reaction.emoji.name) {
                    return false;
                }

                return reactions.includes(reaction.emoji.name) && !user.bot;
            },
            time: 60 * 15 * 1000,
            dispose: true,
        });

        this.collector.on('collect', async (reaction: MessageReaction, user: User) => {
            if (!reaction.emoji.name) {
                return;
            }

            if (this.permittedUsers && !this.permittedUsers.includes(user.id)) {
                return;
            }

            switch (reaction.emoji.name) {
                case controls.previous: {
                    this.changePage(-1, reaction, user);
                    break;
                }
                case controls.next: {
                    this.changePage(1, reaction, user);
                    break;
                }
                case controls.lock: {
                    this.lockEmbed(reaction, user);
                    break;
                }
                case controls.remove: {
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
            if (this.permittedUsers && !this.permittedUsers.includes(user.id)) {
                return;
            }

            switch (reaction.emoji.name) {
                case controls.lock: {
                    this.lockEmbed(reaction, user);
                    break;
                }
                default: {
                    break;
                }
            }
        });

        for (const reaction of this.customReactions || []) {
            await tryReactMessage(this.sentMessage!, reaction);
        }

        if (shouldPaginate) {
            await tryReactMessage(this.sentMessage!, controls.previous);
            await tryReactMessage(this.sentMessage!, controls.next);
            await tryReactMessage(this.sentMessage!, controls.lock);
        }

        await tryReactMessage(this.sentMessage!, controls.remove);

        return this.sentMessage!;
    }

    public setPage(page: number) {
        if (page < 0 || page >= this.totalPages) {
            throw new Error(`Invalid set page value: ${page}`);
        }

        this.currentPage = page;
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

            this.editMessage(await this.getPageContent());

            return;
        }

        tryDeleteReaction(reaction, user.id);

        /* Locker is the current user, remove the lock */
        if (this.lockID === user.id) {
            this.locked = false;
            this.lockID = '';

            this.editMessage(await this.getPageContent());
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

        this.editMessage(await this.getPageContent());
    }

    private async getCustomReactionContent(reaction: MessageReaction, user: User) {
        const startIndex = (this.currentPage) * this.itemsPerPage;
        const endIndex = (this.currentPage + 1) * this.itemsPerPage;

        const items = this.data.slice(startIndex, endIndex);

        switch (this.displayType) {
            case DisplayType.EmbedFieldData:
            case DisplayType.EmbedData: {
                const f = this.customReactionFunction.bind(this);

                return f(items, this.embed!, reaction, user);
            }
            case DisplayType.MessageData: {
                const f = this.customReactionFunction.bind(this);

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
        try {
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
        } catch (err) {
            return false;
        }
    }
}
