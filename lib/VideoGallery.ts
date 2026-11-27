import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Client,
    ContainerBuilder,
    Interaction,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    Message,
    MessageFlags,
    TextDisplayBuilder,
} from 'discord.js';

import { config } from './Config.js';
import { isPrivacyOptedOut } from './Privacy.js';
import { MEXIMUTT, VideoCharacter } from './VideoCharacters.js';
import { VideoGalleryEntry } from './VideoProtocol.js';
import { brokerRequest, videoJobDirection } from './VideoGeneration.js';

/*
 * A random-order browser of a character's delivered videos. The broker keeps only the job
 * records (results are deleted after a day), so each page plays the video straight from its
 * Discord delivery. All browsing state lives in the button IDs, so a browser keeps working
 * across bot restarts and anyone in the channel can page through it.
 */

const PREFIX = 'vgallery:';
const CUSTOM_ID_LIMIT = 100;
const LIST_CACHE_MS = 60_000;
const MAX_SKIPS = 8;
const PROMPT_DISPLAY_LIMIT = 1200;
const ACCENT_COLOUR = 0x006847;

export type GalleryAction = 'prev' | 'next' | 'shuffle' | 'open';

export interface GalleryState {
    /** Shuffle seed: the same seed and list always give the same order. */
    seed: number;
    /** Short ID of the video on screen; empty when opening a fresh browser. */
    current: string;
    /** Only videos this user asked for. */
    userId: string;
    /** Every word must appear in the prompt. */
    query: string;
}

export interface GalleryMedia {
    url: string;
    name: string;
    size: number;
    spoiler: boolean;
    deliveryUrl: string;
}

export interface GalleryDependencies {
    list: (guildId: string) => Promise<VideoGalleryEntry[]>;
    resolve: (entry: VideoGalleryEntry, guildId: string) => Promise<GalleryMedia | null>;
}

const ACTION_CODES: Record<GalleryAction, string> = { prev: 'p', next: 'n', shuffle: 's', open: 'o' };
const CODE_ACTIONS = Object.fromEntries(Object.entries(ACTION_CODES).map(([action, code]) => [code, action])) as Record<string, GalleryAction>;

export function galleryVariants(character: VideoCharacter = MEXIMUTT): string[] {
    const { minimax, minimaxfast } = character.commands;
    return [minimax?.variant, ...(minimax?.aliases || []), minimaxfast?.variant]
        .filter((variant): variant is string => Boolean(variant));
}

function shortId(id: string): string {
    return id.slice(0, 8);
}

export function galleryCustomId(action: GalleryAction, state: GalleryState): string {
    return `${PREFIX}${ACTION_CODES[action]}:${state.seed.toString(36)}:${state.current}:${state.userId}:${state.query}`;
}

export function parseGalleryCustomId(customId: string): { action: GalleryAction; state: GalleryState } | null {
    if (!customId.startsWith(PREFIX)) return null;
    const [code, seed, current, userId, ...query] = customId.slice(PREFIX.length).split(':');
    const action = CODE_ACTIONS[code];
    const parsedSeed = parseInt(seed, 36);
    if (!action || !Number.isFinite(parsedSeed) || !/^[0-9a-f-]{0,8}$/.test(current || '') || !/^\d{0,20}$/.test(userId || '')) return null;
    return { action, state: { seed: parsedSeed >>> 0, current: current || '', userId: userId || '', query: query.join(':') } };
}

/** The longest search that still fits in a button ID alongside the rest of the state. */
export function maxGalleryQueryLength(userId: string): number {
    return CUSTOM_ID_LIMIT - galleryCustomId('shuffle', { seed: 0xffffffff, current: 'ffffffff', userId, query: '' }).length;
}

export function parseGalleryArgs(args: string, authorId: string): { userId: string; query: string } {
    const words = args.trim().split(/\s+/).filter(Boolean);
    let userId = '';
    const rest: string[] = [];
    for (const word of words) {
        const mention = /^<@!?(\d{5,20})>$/.exec(word);
        if (!userId && mention) userId = mention[1];
        else if (!userId && word.toLowerCase() === 'mine') userId = authorId;
        else rest.push(word);
    }
    return { userId, query: rest.join(' ').replace(/\s+/g, ' ').trim() };
}

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

/** A stable shuffle: entries are sorted by ID first so the broker's ordering never matters. */
export function galleryOrder<T extends { id: string }>(entries: T[], seed: number): T[] {
    const ordered = [...entries].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const random = mulberry32(seed);
    for (let index = ordered.length - 1; index > 0; index--) {
        const swap = Math.floor(random() * (index + 1));
        [ordered[index], ordered[swap]] = [ordered[swap], ordered[index]];
    }
    return ordered;
}

export function galleryEntryDirection(entry: VideoGalleryEntry): string {
    return videoJobDirection({ prompt: entry.prompt, planned_intent: entry.planned_intent });
}

export function filterGalleryEntries(
    entries: VideoGalleryEntry[],
    state: Pick<GalleryState, 'userId' | 'query'>,
    optedOut: (userId: string) => boolean = isPrivacyOptedOut,
): VideoGalleryEntry[] {
    const words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    return entries.filter(entry => !optedOut(entry.requester_id)
        && (!state.userId || entry.requester_id === state.userId)
        && words.every(word => galleryEntryDirection(entry).toLowerCase().includes(word)));
}

/** Where a delivery lives: its recorded message, or the link its status message was edited to. */
export function deliveryLinkFromStatus(content: string | null | undefined): { channelId: string; messageId: string } | null {
    const match = /discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d+)\/(\d+)/.exec(content || '');
    return match ? { channelId: match[1], messageId: match[2] } : null;
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function quotedPrompt(prompt: string): string {
    const text = prompt.trim() || 'No prompt recorded.';
    const shown = text.length > PROMPT_DISPLAY_LIMIT ? `${text.slice(0, PROMPT_DISPLAY_LIMIT - 1)}…` : text;
    return shown.includes('\n') ? `>>> ${shown}` : `> ${shown}`;
}

function filterDescription(state: GalleryState): string {
    const parts: string[] = [];
    if (state.userId) parts.push(`by <@${state.userId}>`);
    if (state.query) parts.push(`matching “${state.query}”`);
    return parts.join(' · ');
}

function navigationRow(state: GalleryState, total: number): ActionRowBuilder<ButtonBuilder> {
    const single = total <= 1;
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(galleryCustomId('prev', state)).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(single),
        new ButtonBuilder().setCustomId(galleryCustomId('shuffle', state)).setEmoji('🔀').setStyle(ButtonStyle.Secondary).setDisabled(single),
        new ButtonBuilder().setCustomId(galleryCustomId('next', state)).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(single),
    );
}

export interface GalleryPage {
    entry: VideoGalleryEntry;
    media: GalleryMedia;
    position: number;
    total: number;
    state: GalleryState;
}

export function galleryPagePayload(page: GalleryPage, title: string) {
    const { entry, media, position, total, state } = page;
    const filters = filterDescription(state);
    const delivered = entry.delivered_at ? ` · <t:${entry.delivered_at}:D>` : '';
    const container = new ContainerBuilder()
        .setAccentColor(ACCENT_COLOUR)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`### ${title} · ${position} of ${total}${filters ? `\n-# ${filters}` : ''}`),
            new TextDisplayBuilder().setContent(`${quotedPrompt(galleryEntryDirection(entry))}\n-# <@${entry.requester_id}>${delivered} · \`${shortId(entry.id)}\``),
        )
        .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
            new MediaGalleryItemBuilder().setURL(media.url).setSpoiler(media.spoiler)
                .setDescription(galleryEntryDirection(entry).slice(0, 1000) || media.name),
        ))
        .addActionRowComponents(
            navigationRow(state, total),
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setURL(media.url).setEmoji('⬇️').setStyle(ButtonStyle.Link)
                    .setLabel(`Download${media.size ? ` (${formatBytes(media.size)})` : ''}`),
                new ButtonBuilder().setURL(media.deliveryUrl).setLabel('Original post').setStyle(ButtonStyle.Link),
            ),
        );
    return {
        components: [container],
        flags: MessageFlags.IsComponentsV2 as const,
        allowedMentions: { parse: [] as never[], repliedUser: false },
    };
}

export function galleryNoticePayload(text: string, state?: GalleryState) {
    const container = new ContainerBuilder().setAccentColor(ACCENT_COLOUR)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
    if (state) {
        container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(galleryCustomId('shuffle', state)).setEmoji('🔀').setLabel('Try another').setStyle(ButtonStyle.Secondary),
        ));
    }
    return {
        components: [container],
        flags: MessageFlags.IsComponentsV2 as const,
        allowedMentions: { parse: [] as never[], repliedUser: false },
    };
}

/** The next playable page after applying an action, skipping deliveries that were deleted. */
export async function galleryPage(
    guildId: string,
    action: GalleryAction,
    requested: GalleryState,
    deps: GalleryDependencies,
    random: () => number = Math.random,
): Promise<GalleryPage | { empty: true; state: GalleryState } | { unavailable: true; state: GalleryState }> {
    const state = { ...requested };
    if (action === 'shuffle' || action === 'open') {
        state.seed = Math.floor(random() * 0x100000000) >>> 0;
        state.current = '';
    }
    const entries = filterGalleryEntries(await deps.list(guildId), state);
    if (!entries.length) return { empty: true, state };
    const order = galleryOrder(entries, state.seed);
    const found = state.current ? order.findIndex(entry => entry.id.startsWith(state.current)) : -1;
    const step = action === 'prev' ? -1 : 1;
    let index = found < 0 ? (action === 'prev' ? order.length - 1 : 0) : found + step;
    for (let attempt = 0; attempt < Math.min(MAX_SKIPS, order.length); attempt++) {
        index = ((index % order.length) + order.length) % order.length;
        const entry = order[index];
        const media = await deps.resolve(entry, guildId);
        if (media) {
            return { entry, media, position: index + 1, total: order.length, state: { ...state, current: shortId(entry.id) } };
        }
        index += step;
    }
    return { unavailable: true, state };
}

function messageUrl(guildId: string, channelId: string, messageId: string): string {
    return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/** Picks the delivered video (or GIF) from a delivery post, ignoring the workflow archive. */
export function deliveryMedia(message: Pick<Message, 'attachments' | 'url'>): GalleryMedia | null {
    for (const attachment of message.attachments.values()) {
        const type = attachment.contentType || '';
        const name = attachment.name || '';
        if (type.startsWith('video/') || type === 'image/gif' || /\.(mp4|webm|mov|gif)$/i.test(name)) {
            return {
                url: attachment.url,
                name,
                size: attachment.size,
                spoiler: attachment.spoiler || name.startsWith('SPOILER_'),
                deliveryUrl: message.url,
            };
        }
    }
    return null;
}

interface CachedList {
    at: number;
    entries: Promise<VideoGalleryEntry[]>;
}

/** Discord deliveries, resolved once per job; the signed CDN URL is refreshed on each lookup. */
export class DiscordGalleryDependencies implements GalleryDependencies {
    private readonly lists = new Map<string, CachedList>();
    private readonly locations = new Map<string, { channelId: string; messageId: string } | null>();

    public constructor(private readonly client: Client, private readonly variants: string[]) {}

    public list(guildId: string): Promise<VideoGalleryEntry[]> {
        const cached = this.lists.get(guildId);
        if (cached && Date.now() - cached.at < LIST_CACHE_MS) return cached.entries;
        const query = `/v1/gallery?guild_id=${encodeURIComponent(guildId)}&variants=${encodeURIComponent(this.variants.join(','))}`;
        const entries = brokerRequest<{ videos: VideoGalleryEntry[] }>(query).then(response => response.videos || []);
        this.lists.set(guildId, { at: Date.now(), entries });
        entries.catch(() => this.lists.delete(guildId));
        return entries;
    }

    private async fetchMessage(channelId: string, messageId: string): Promise<Message | null> {
        try {
            const channel = await this.client.channels.fetch(channelId);
            if (!channel || !channel.isTextBased() || !('messages' in channel)) return null;
            return await channel.messages.fetch(messageId);
        } catch {
            return null;
        }
    }

    public async resolve(entry: VideoGalleryEntry, guildId: string): Promise<GalleryMedia | null> {
        let location = this.locations.get(entry.id);
        if (location === undefined) {
            location = entry.delivery_message_id
                ? { channelId: entry.channel_id, messageId: entry.delivery_message_id }
                : deliveryLinkFromStatus((await this.fetchMessage(entry.channel_id, entry.status_message_id))?.content);
        }
        const message = location ? await this.fetchMessage(location.channelId, location.messageId) : null;
        const media = message ? deliveryMedia(message) : null;
        // Remember deleted deliveries too, so later pages skip them without asking Discord.
        this.locations.set(entry.id, media ? location : null);
        if (!media || !location) return null;
        return {
            ...media,
            spoiler: media.spoiler || Boolean(entry.prompt_tease),
            deliveryUrl: messageUrl(guildId, location.channelId, location.messageId),
        };
    }
}

export interface VideoGalleryOptions {
    character?: VideoCharacter;
    title?: string;
    command?: string;
}

const dependencies = new Map<string, DiscordGalleryDependencies>();

function clientDependencies(client: Client, variants: string[]): DiscordGalleryDependencies {
    const key = `${client.user?.id || ''}:${variants.join(',')}`;
    let deps = dependencies.get(key);
    if (!deps) {
        deps = new DiscordGalleryDependencies(client, variants);
        dependencies.set(key, deps);
    }
    return deps;
}

function pagePayload(page: Awaited<ReturnType<typeof galleryPage>>, title: string, command: string) {
    if ('empty' in page) {
        const filters = filterDescription(page.state);
        return galleryNoticePayload(filters
            ? `No ${title} videos ${filters} yet. Try \`${config.prefix}${command}\` on its own.`
            : `No ${title} videos have been delivered in this server yet.`);
    }
    if ('unavailable' in page) {
        return galleryNoticePayload('Couldn’t load these videos; their original posts may have been deleted.', page.state);
    }
    return galleryPagePayload(page, title);
}

export function videoGalleryHandler(options: VideoGalleryOptions = {}) {
    const character = options.character || MEXIMUTT;
    const variants = galleryVariants(character);
    const title = options.title || character.commands.minimax?.label || character.name;
    const command = options.command || 'oalgos';
    return async (msg: Message, args: string): Promise<void> => {
        if (!msg.guild) {
            await msg.reply('Video galleries are only available in servers.');
            return;
        }
        const { userId, query } = parseGalleryArgs(args, msg.author.id);
        const limit = maxGalleryQueryLength(userId);
        if (query.length > limit) {
            await msg.reply(`Please keep the search under ${limit + 1} characters.`);
            return;
        }
        const page = await galleryPage(msg.guild.id, 'open', { seed: 0, current: '', userId, query },
            clientDependencies(msg.client, variants));
        await msg.reply(pagePayload(page, title, command));
    };
}

export async function handleVideoGalleryInteraction(interaction: Interaction, options: VideoGalleryOptions = {}): Promise<void> {
    if (!interaction.isButton() || !interaction.customId.startsWith(PREFIX)) return;
    if (interaction.message.author.id !== interaction.client.user?.id) return;
    const parsed = parseGalleryCustomId(interaction.customId);
    if (!parsed || !interaction.guildId) {
        await interaction.reply({ content: 'This gallery button is no longer valid.', ephemeral: true });
        return;
    }
    const character = options.character || MEXIMUTT;
    const title = options.title || character.commands.minimax?.label || character.name;
    await interaction.deferUpdate();
    try {
        const page = await galleryPage(interaction.guildId, parsed.action, parsed.state,
            clientDependencies(interaction.client, galleryVariants(character)));
        await interaction.editReply(pagePayload(page, title, options.command || 'oalgos'));
    } catch (error) {
        console.warn(`[Video] Gallery navigation failed: ${String(error)}`);
        await interaction.followUp({ content: 'Couldn’t load the next video. Please try again.', ephemeral: true });
    }
}

const started = new WeakSet<Client>();

export function startVideoGallery(client: Client): void {
    if (started.has(client)) return;
    started.add(client);
    client.on('interactionCreate', interaction => {
        void handleVideoGalleryInteraction(interaction).catch(error => {
            console.warn(`[Video] Gallery interaction failed: ${String(error)}`);
        });
    });
}
