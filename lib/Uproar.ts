import WebSocket from 'ws';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { EventEmitter } from 'events';
import { Database } from 'sqlite3';

import { config } from './Config.js';
import { canAccessCommand } from './Utilities.js';
import { Args, Command, CommandFunc } from './Types.js';
import { Commands, handleHelp } from './CommandDeclarations.js';

/* Uproar (uproar.chat) integration.
 *
 * dave talks to Uproar over the plain bot HTTP API with a single bearer token:
 *   - receive: a dial-out WebSocket at GET /api/bots/{id}/stream delivers
 *     message_create + reaction events in realtime (mirrors the Discord gateway).
 *   - act:     POST /api/bots/{id}/{token} with {action, ...} to send/edit/
 *     delete/react/typing.
 *   - upload:  multipart POST /api/bots/{id}/attachments?channel_id=… (bearer),
 *     then reference the returned /uploads/ url(s) in a send action's attachments.
 *   - read:    GET /api/bots/{id}/{messages|members|…} with Authorization: Bearer.
 *
 * Each inbound message is wrapped in an object presenting the slice of the
 * discord.js Message surface the commands use, so the existing command
 * implementations run unchanged. */

interface UproarUser {
    id: string;
    bot: boolean;
    username: string;
    displayName: string;
    displayAvatarURL: (opts?: any) => string;
}

interface UproarMessageData {
    id: string;
    channel_id: string;
    server_id?: string;
    user_id: string;
    content: string;
    reply_to: string | null;
    mentions_everyone?: boolean;
    created_at: string;
    edited_at: string | null;
    username: string;
    display_name: string;
    avatar_url: string | null;
    is_bot: boolean;
    attachments?: any;
    embeds?: any;
    mentions?: Array<{ user_id: string; username?: string; display_name?: string }>;
}

interface UploadedAttachment {
    url: string;
    thumb_url?: string;
}

type SendPayload = string | { content?: string; embeds?: any[]; files?: any[] };

function toUproarEmbeds(embeds?: any[]): any[] | undefined {
    if (!embeds || embeds.length === 0) {
        return undefined;
    }
    return embeds.map((e) => (e && typeof e.toJSON === 'function' ? e.toJSON() : e));
}

function normalizeSend(payload: SendPayload): { content: string; embeds?: any[]; files?: any[] } {
    if (typeof payload === 'string') {
        return { content: payload };
    }
    return {
        content: payload.content ?? '',
        embeds: toUproarEmbeds(payload.embeds),
        files: Array.isArray(payload.files) ? payload.files : undefined,
    };
}

function absoluteURL(baseUrl: string, url: string | null | undefined): string {
    if (!url) {
        return '';
    }
    return /^https?:\/\//i.test(url) ? url : baseUrl + url;
}

/* discord.js exposes message.attachments as a Collection; the commands use
 * .forEach / .size / .values, all of which a Map provides. Each value carries
 * the `url`, `contentType`, `name` fields the image extractor reads. */
function buildAttachments(baseUrl: string, raw: any): Map<string, any> {
    const map = new Map<string, any>();
    if (Array.isArray(raw)) {
        raw.forEach((a, i) => {
            map.set(String(i), {
                url: absoluteURL(baseUrl, a?.url),
                contentType: a?.content_type ?? null,
                name: a?.filename ?? '',
            });
        });
    }
    return map;
}

function buildMentions(raw: UproarMessageData['mentions']): Map<string, UproarUser> {
    const map = new Map<string, UproarUser>();
    if (Array.isArray(raw)) {
        for (const m of raw) {
            map.set(m.user_id, {
                id: m.user_id,
                bot: false,
                username: m.username ?? '',
                displayName: m.display_name || m.username || '',
                displayAvatarURL: () => '',
            });
        }
    }
    return map;
}

function makeAuthor(baseUrl: string, data: UproarMessageData): UproarUser {
    return {
        id: data.user_id,
        bot: data.is_bot,
        username: data.username,
        displayName: data.display_name || data.username,
        displayAvatarURL: () => absoluteURL(baseUrl, data.avatar_url),
    };
}

export class UproarClient {
    private readonly baseUrl: string;
    private readonly botId: string;
    private readonly token: string;
    private readonly db: Database;

    private ws: WebSocket | null = null;
    private reconnectAttempt = 0;
    private botUserId: string | null = null;

    private reactionCollectors = new Map<string, Set<UproarReactionCollector>>();
    private memberCache = new Map<string, Promise<any[]>>();

    constructor(db: Database) {
        this.baseUrl = config.uproarBaseUrl.replace(/\/$/, '');
        this.botId = config.uproarBotId;
        this.token = config.uproarBotToken;
        this.db = db;
    }

    public getBaseUrl(): string {
        return this.baseUrl;
    }

    /* --- transport --- */

    public connect(): void {
        const wsUrl = this.baseUrl.replace(/^http/, 'ws') + `/api/bots/${this.botId}/stream`;

        const ws = new WebSocket(wsUrl, {
            headers: { Authorization: `Bearer ${this.token}` },
        });
        this.ws = ws;

        ws.on('open', () => {
            this.reconnectAttempt = 0;
            console.log('[Uproar] Stream connected');
            ws.send(JSON.stringify({
                type: 'subscribe',
                data: { events: ['message_create', 'reaction_add', 'reaction_remove'] },
            }));
        });

        ws.on('message', (raw: any) => {
            let evt: any;
            try {
                evt = JSON.parse(raw.toString());
            } catch {
                return;
            }

            switch (evt.type) {
                case 'ready':
                    console.log(`[Uproar] Ready (bot ${evt.data?.bot_id})`);
                    break;
                case 'message_create':
                    if (evt.data) {
                        this.handleMessage(evt.data as UproarMessageData).catch((err) => {
                            console.error(`[Uproar] Error handling message: ${err?.stack ?? err}`);
                        });
                    }
                    break;
                case 'reaction_add':
                case 'reaction_remove':
                    if (evt.data) {
                        this.handleReaction(evt.type, evt.data);
                    }
                    break;
            }
        });

        ws.on('close', () => this.scheduleReconnect('closed'));
        ws.on('error', (err: Error) => {
            console.error(`[Uproar] Socket error: ${err.message}`);
        });
    }

    private scheduleReconnect(reason: string): void {
        const delay = Math.min(60000, 5000 * Math.pow(2, this.reconnectAttempt));
        this.reconnectAttempt += 1;
        console.log(`[Uproar] Stream ${reason}; reconnecting in ${delay / 1000}s`);
        setTimeout(() => this.connect(), delay);
    }

    /* --- act (execute endpoint) --- */

    public async exec(body: Record<string, unknown>): Promise<any> {
        const url = `${this.baseUrl}/api/bots/${this.botId}/${this.token}`;

        for (let attempt = 0; attempt < 2; attempt++) {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (res.status === 429) {
                const retry = Number(res.headers.get('retry-after') ?? '1');
                await new Promise((r) => setTimeout(r, (retry + 1) * 1000));
                continue;
            }

            const text = await res.text();
            if (!res.ok) {
                throw new Error(`Uproar ${body.action ?? 'send'} failed (${res.status}): ${text}`);
            }
            const result = text ? JSON.parse(text) : {};
            if (!this.botUserId && result && result.is_bot && result.user_id) {
                this.botUserId = result.user_id;
            }
            return result;
        }

        throw new Error(`Uproar ${body.action ?? 'send'} rate limited`);
    }

    /* --- read API --- */

    public async readGet(path: string): Promise<any> {
        const res = await fetch(`${this.baseUrl}/api/bots/${this.botId}${path}`, {
            headers: { Authorization: `Bearer ${this.token}` },
        });
        if (!res.ok) {
            throw new Error(`Uproar read ${path} failed (${res.status})`);
        }
        return res.json();
    }

    /* --- uploads (attachments) --- */
    public async uploadFiles(channelId: string, files: any[]): Promise<UploadedAttachment[]> {
        const form = new FormData();
        let count = 0;

        for (const file of files.slice(0, 4)) {
            const resolved = await resolveFileData(file);
            if (!resolved) {
                continue;
            }
            form.append('files', resolved.data, { filename: resolved.name });
            count += 1;
        }
        if (count === 0) {
            return [];
        }

        const res = await fetch(`${this.baseUrl}/api/bots/${this.botId}/attachments?channel_id=${encodeURIComponent(channelId)}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.token}`, ...form.getHeaders() },
            body: form as any,
        });
        if (!res.ok) {
            throw new Error(`Uproar upload failed (${res.status}): ${await res.text()}`);
        }

        const arr = (await res.json()) as any[];
        return arr.map((a) => ({ url: a.url, thumb_url: a.thumb_url }));
    }

    /* --- members / guild resolution --- */

    private serverMembers(serverId: string): Promise<any[]> {
        let cached = this.memberCache.get(serverId);
        if (!cached) {
            cached = this.readGet(`/members?server_id=${encodeURIComponent(serverId)}`)
                .then((m) => (Array.isArray(m) ? m : []))
                .catch(() => []);
            this.memberCache.set(serverId, cached);
        }
        return cached;
    }

    public async fetchMember(serverId: string, userId: string): Promise<any | undefined> {
        const members = await this.serverMembers(serverId);
        const m = members.find((x) => (x.user_id ?? x.id) === userId);
        if (!m) {
            return undefined;
        }
        const displayName = m.display_name || m.nickname || m.username || '';
        const avatar = absoluteURL(this.baseUrl, m.avatar_url);
        return {
            id: userId,
            displayName,
            displayAvatarURL: () => avatar,
            roles: { cache: { some: () => false, has: () => false } },
        };
    }

    public makeGuild(serverId: string | undefined): any | null {
        if (!serverId) {
            return null;
        }
        return {
            id: serverId,
            members: { fetch: (userId: string) => this.fetchMember(serverId, userId) },
        };
    }

    /* --- reaction collectors --- */

    public registerCollector(messageId: string, c: UproarReactionCollector): void {
        let set = this.reactionCollectors.get(messageId);
        if (!set) {
            set = new Set();
            this.reactionCollectors.set(messageId, set);
        }
        set.add(c);
    }

    public unregisterCollector(messageId: string, c: UproarReactionCollector): void {
        const set = this.reactionCollectors.get(messageId);
        if (set) {
            set.delete(c);
            if (set.size === 0) {
                this.reactionCollectors.delete(messageId);
            }
        }
    }

    private handleReaction(type: string, data: any): void {
        const set = this.reactionCollectors.get(data.message_id);
        if (!set || set.size === 0) {
            return;
        }
        if (this.botUserId && data.user_id === this.botUserId) {
            return;
        }

        const user = { id: data.user_id, bot: false };
        const reaction = {
            emoji: { name: data.emoji },
            users: { remove: async () => { /* bot API can't remove others' reactions */ } },
        };

        for (const c of Array.from(set)) {
            if (type === 'reaction_add') {
                c.handleAdd(reaction, user);
            } else {
                c.handleRemove(reaction, user);
            }
        }
    }

    /* --- read helpers --- */

    public async fetchMessage(messageId: string): Promise<UproarFetchedMessage> {
        const m = await this.readGet(`/messages/${messageId}`);
        return new UproarFetchedMessage(this, m as UproarMessageData);
    }

    public async fetchHistory(channelId: string, before?: string): Promise<Map<string, UproarFetchedMessage>> {
        let path = `/messages?channel_id=${encodeURIComponent(channelId)}&limit=100`;
        if (before) {
            path += `&before=${encodeURIComponent(before)}`;
        }
        const arr = await this.readGet(path);
        const map = new Map<string, UproarFetchedMessage>();
        if (Array.isArray(arr)) {
            for (const m of arr) {
                map.set(m.id, new UproarFetchedMessage(this, m as UproarMessageData));
            }
        }
        return map;
    }

    /* --- dispatch --- */

    private async handleMessage(data: UproarMessageData): Promise<void> {
        if (data.is_bot) {
            return;
        }
        if (this.botUserId && data.user_id === this.botUserId) {
            return;
        }
        if (!data.content || !data.content.startsWith(config.prefix)) {
            return;
        }

        const msg = new UproarMessage(this, data);

        const [tmp, ...args] = data.content.trim().split(/\s+/);
        const command = tmp.substring(tmp.indexOf(config.prefix) + 1).toLowerCase();

        try {
            await dispatchByCommand(msg, command, args, this.db);
        } catch (err) {
            console.error(`[Uproar] Command '${command}' threw: ${(err as any)?.stack ?? err}`);
            try {
                await msg.react('🔥');
                await msg.reply(`Error: ${(err as any).toString()}`);
            } catch {
                /* best effort */
            }
        }
    }
}

async function dispatchByCommand(
    msg: UproarMessage,
    command: string,
    args: string[],
    db: Database,
): Promise<void> {
    for (const c of Commands as Command[]) {
        if (!c.aliases.includes(command)) {
            continue;
        }

        if (c.hidden && !canAccessCommand(msg as any, true)) {
            return;
        }

        if (args.length === 1 && args[0] === 'help') {
            handleHelp(msg as any, c.aliases[0]);
            return;
        }

        if (c.commandGates) {
            for (const gate of c.commandGates) {
                const { canAccess, error } = gate(msg as any);
                if (!canAccess) {
                    await msg.reply(error!);
                    return;
                }
            }
        }

        if (args.length > 0 && c.subCommands && c.subCommands.length > 0) {
            for (const subCommand of c.subCommands) {
                if (subCommand.aliases && subCommand.aliases.includes(args[0])) {
                    if (!subCommand.disabled) {
                        await runCommand(subCommand, msg, db, args.slice(1));
                    }
                    return;
                }
            }
        }

        if (!c.primaryCommand.disabled) {
            await runCommand(c.primaryCommand, msg, db, args);
        }
        return;
    }
}

async function runCommand(command: CommandFunc, msg: UproarMessage, db: Database, args: string[]): Promise<void> {
    const impl = command.implementation as any;
    switch (command.argsFormat) {
        case Args.DontNeed:
            await (command.needDb ? impl(msg, db) : impl(msg));
            break;
        case Args.Split:
            await (command.needDb ? impl(msg, args, db) : impl(msg, args));
            break;
        case Args.Combined:
            await (command.needDb ? impl(msg, args.join(' '), db) : impl(msg, args.join(' ')));
            break;
    }
}

async function resolveFileData(file: any): Promise<{ data: Buffer; name: string } | null> {
    const raw = file && file.attachment !== undefined ? file.attachment : file;
    const name: string = (file && file.name) || 'file';

    if (Buffer.isBuffer(raw)) {
        return { data: raw, name };
    }
    if (typeof raw === 'string') {
        if (/^https?:\/\//i.test(raw)) {
            const res = await fetch(raw);
            return { data: await res.buffer(), name };
        }
        const fs = await import('fs/promises');
        return { data: await fs.readFile(raw), name };
    }
    if (raw && typeof raw.pipe === 'function') {
        const chunks: Buffer[] = [];
        for await (const chunk of raw as any) {
            chunks.push(Buffer.from(chunk));
        }
        return { data: Buffer.concat(chunks), name };
    }
    return null;
}

/* --- message shims --- */

export class UproarMessage {
    public readonly id: string;
    public readonly content: string;
    public readonly author: UproarUser;
    public readonly guild: any | null;
    public readonly member: null = null;
    public readonly reference: { messageId: string } | null;
    public readonly mentions: { users: Map<string, UproarUser>; channels: Map<string, unknown> };
    public readonly attachments: Map<string, any>;
    public readonly embeds: any[];
    public readonly createdTimestamp: number;
    public readonly channel: UproarChannel;
    public readonly client: { user: { id: string | null } };

    constructor(private readonly bot: UproarClient, data: UproarMessageData) {
        const baseUrl = bot.getBaseUrl();
        this.id = data.id;
        this.content = data.content;
        this.author = makeAuthor(baseUrl, data);
        this.guild = bot.makeGuild(data.server_id);
        this.reference = data.reply_to ? { messageId: data.reply_to } : null;
        this.mentions = { users: buildMentions(data.mentions), channels: new Map() };
        this.attachments = buildAttachments(baseUrl, data.attachments);
        this.embeds = Array.isArray(data.embeds) ? data.embeds : [];
        this.createdTimestamp = Date.parse(data.created_at) || 0;
        this.channel = new UproarChannel(bot, data.channel_id);
        this.client = { user: { id: null } };
    }

    public reply(payload: SendPayload): Promise<UproarSentMessage> {
        return this.channel.sendInternal(payload, this.id);
    }

    public async react(emoji: string): Promise<void> {
        await this.bot.exec({ action: 'react', message_id: this.id, emoji });
    }

    public async delete(): Promise<void> {
        await this.bot.exec({ action: 'delete', message_id: this.id });
    }

    public async suppressEmbeds(): Promise<void> {
        /* not settable on another user's message via the bot API; no-op */
    }
}

/* A message read back from the API (reply context, purge history): read fields
 * plus delete/react so the deletion + image-extraction paths work on it. */
export class UproarFetchedMessage {
    public readonly id: string;
    public readonly content: string;
    public readonly author: UproarUser;
    public readonly guild: any | null;
    public readonly reference: { messageId: string } | null;
    public readonly mentions: { users: Map<string, UproarUser>; channels: Map<string, unknown> };
    public readonly attachments: Map<string, any>;
    public readonly embeds: any[];
    public readonly createdTimestamp: number;
    public readonly channel: UproarChannel;

    constructor(private readonly bot: UproarClient, data: UproarMessageData) {
        const baseUrl = bot.getBaseUrl();
        this.id = data.id;
        this.content = data.content;
        this.author = makeAuthor(baseUrl, data);
        this.guild = bot.makeGuild(data.server_id);
        this.reference = data.reply_to ? { messageId: data.reply_to } : null;
        this.mentions = { users: buildMentions(data.mentions), channels: new Map() };
        this.attachments = buildAttachments(baseUrl, data.attachments);
        this.embeds = Array.isArray(data.embeds) ? data.embeds : [];
        this.createdTimestamp = Date.parse(data.created_at) || 0;
        this.channel = new UproarChannel(bot, data.channel_id);
    }

    public async delete(): Promise<void> {
        await this.bot.exec({ action: 'delete', message_id: this.id });
    }

    public async react(emoji: string): Promise<void> {
        await this.bot.exec({ action: 'react', message_id: this.id, emoji });
    }
}

export class UproarChannel {
    public readonly messages: { fetch: (idOrOptions: any) => Promise<any> };

    constructor(private readonly bot: UproarClient, public readonly id: string) {
        this.messages = {
            fetch: (idOrOptions: any) => {
                if (typeof idOrOptions === 'string') {
                    return this.bot.fetchMessage(idOrOptions);
                }
                const before = idOrOptions && idOrOptions.before ? idOrOptions.before : undefined;
                return this.bot.fetchHistory(this.id, before);
            },
        };
    }

    public send(payload: SendPayload): Promise<UproarSentMessage> {
        return this.sendInternal(payload, null);
    }

    public async sendTyping(): Promise<void> {
        await this.bot.exec({ action: 'typing', channel_id: this.id });
    }

    public async sendInternal(payload: SendPayload, replyTo: string | null): Promise<UproarSentMessage> {
        const { content, embeds, files } = normalizeSend(payload);

        const body: Record<string, unknown> = { action: 'send', channel_id: this.id, content };
        if (embeds) {
            body.embeds = embeds;
        }
        if (replyTo) {
            body.reply_to = replyTo;
        }
        if (files && files.length > 0) {
            try {
                const attachments = await this.bot.uploadFiles(this.id, files);
                if (attachments.length > 0) {
                    body.attachments = attachments;
                }
            } catch (err) {
                console.error(`[Uproar] Attachment upload failed: ${(err as any)?.message ?? err}`);
            }
        }

        const created = await this.bot.exec(body);
        return new UproarSentMessage(this.bot, created.id, this.id);
    }
}

export class UproarSentMessage {
    constructor(private readonly bot: UproarClient, public readonly id: string, public readonly channelId: string) {}

    public async edit(payload: SendPayload): Promise<UproarSentMessage> {
        const { content, embeds } = normalizeSend(payload);
        const body: Record<string, unknown> = { action: 'edit', message_id: this.id, content };
        if (embeds) {
            body.embeds = embeds;
        }
        await this.bot.exec(body);
        return this;
    }

    public async delete(): Promise<void> {
        await this.bot.exec({ action: 'delete', message_id: this.id });
    }

    public async react(emoji: string): Promise<void> {
        await this.bot.exec({ action: 'react', message_id: this.id, emoji });
    }

    public createReactionCollector(options: any): UproarReactionCollector {
        const collector = new UproarReactionCollector(this.bot, this.id, options);
        this.bot.registerCollector(this.id, collector);
        return collector;
    }
}

/* Emulates discord.js ReactionCollector over Uproar's reaction_add/remove
 * events: filter + time window, emitting 'collect'/'remove'/'end' with the same
 * (reaction, user) shape Paginate and the poll commands expect. */
export class UproarReactionCollector extends EventEmitter {
    private collected = new Map<string, any>();
    private timer: any = null;
    private ended = false;

    constructor(private readonly bot: UproarClient, private readonly messageId: string, private readonly options: any) {
        super();
        const time = options?.time;
        if (time) {
            this.timer = setTimeout(() => this.stop('time'), time);
        }
    }

    public handleAdd(reaction: any, user: any): void {
        if (this.ended) {
            return;
        }
        const filter = this.options?.filter;
        if (filter && !filter(reaction, user)) {
            return;
        }
        this.collected.set(`${reaction.emoji.name}:${user.id}`, reaction);
        this.emit('collect', reaction, user);
        if (this.options?.max && this.collected.size >= this.options.max) {
            this.stop('limit');
        }
    }

    public handleRemove(reaction: any, user: any): void {
        if (this.ended || !this.options?.dispose) {
            return;
        }
        this.emit('remove', reaction, user);
    }

    public stop(reason: string = 'user'): void {
        if (this.ended) {
            return;
        }
        this.ended = true;
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.bot.unregisterCollector(this.messageId, this);
        this.emit('end', this.collected, reason);
    }
}

export function startUproar(db: Database): void {
    if (!config.uproarBotId || !config.uproarBotToken) {
        console.log('[Uproar] Not configured; skipping');
        return;
    }
    const client = new UproarClient(db);
    client.connect();
}
