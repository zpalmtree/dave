import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
    type Interaction, type Message,
} from 'discord.js';
import type { Database } from 'sqlite3';
import { config } from './Config.js';
import { isPrivacyOptedOut, privacyPlatform, PRIVACY_POLICY_URL, setPrivacyOptOut } from './Privacy.js';
import {
    completeDeletionRequest, latestDeletionRequest, pendingDeletionRequests, requestDataDeletion,
} from './PrivacyRequests.js';

function button(id: string, label: string, style = ButtonStyle.Secondary): ButtonBuilder {
    return new ButtonBuilder().setCustomId(`privacy:${id}`).setLabel(label).setStyle(style);
}

export function privacyCommandArgs(msg: Message): string | undefined {
    const content = msg.content.trim();
    let command: string;
    if (content.startsWith(config.prefix)) {
        command = content.slice(config.prefix.length);
    } else {
        const mention = content.match(/^<@!?(\d+)>\s+([\s\S]*)$/);
        if (!mention || mention[1] !== msg.client?.user?.id) return undefined;
        command = mention[2];
    }
    const match = command.match(/^privacy(?:\s+([\s\S]*))?$/i);
    return match ? (match[1] || '').trim().toLowerCase() : undefined;
}

export async function privacyPanel(db: Database, userId: string, platform: 'discord' | 'uproar') {
    const disabled = isPrivacyOptedOut(userId, platform);
    const request = await latestDeletionRequest(db, userId, platform);
    const components = platform === 'discord' ? [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            button('status', 'My status'),
            button('optout', 'Opt out'),
            button('optin', 'Opt in'),
            button('delete', 'Request deletion', ButtonStyle.Danger),
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Privacy policy').setURL(PRIVACY_POLICY_URL),
        ),
    ] : [];
    if (platform === 'discord' && userId === config.god) {
        const pending = await pendingDeletionRequests(db);
        components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
            button('requests:0', `Review deletion requests (${pending.length})`),
        ));
    }
    return {
        content: `Privacy policy: ${PRIVACY_POLICY_URL}\n\n`
            + (disabled
                ? 'You are opted out. This bot skips your new messages and commands except privacy controls, and excludes your messages from new summaries and fetched reply context.'
                : 'You are opted in. This bot can process messages in channels it can access for summaries, link previews, audio transcription and commands.')
            + (request ? `\n\nLatest deletion request: ${request.id}\nStatus: ${request.status === 'pending' ? 'Pending operator review — deletion is not yet complete.' : 'Marked completed by the operator.'}` : '')
            + `\n\nUse the buttons or \`${config.prefix}privacy optout\`, \`${config.prefix}privacy optin\`, and \`${config.prefix}privacy delete\`. You can also mention this bot followed by \`privacy\`. Button responses are private to the person clicking.`
            + '\nPreferences apply to this bot on this platform and persist across restarts. Opting out does not erase existing records or cancel work already submitted. Contact zpalmtree privately on Discord if you need help.',
        components,
        allowedMentions: { parse: [] as const, repliedUser: false },
    };
}

function deletionConfirmation(platform: 'discord' | 'uproar') {
    return {
        content: 'Request deletion of your data from this bot? Confirming also opts you out of future message processing. The operator will review stored records, saved features, media, logs and relevant external copies. This submits a request; it does not claim everything is already deleted. You can check progress with privacy status. The request retains your user ID, platform and timestamps so it can be handled.'
            + (platform === 'uproar' ? `\nConfirm with \`${config.prefix}privacy delete confirm\`.` : ''),
        components: platform === 'discord' ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
            button('delete-confirm', 'Request deletion and opt out', ButtonStyle.Danger),
            button('status', 'Cancel'),
        )] : [],
        allowedMentions: { parse: [] as const, repliedUser: false },
    };
}

function deletionReceipt(id: string) {
    return {
        content: `Deletion request received: ${id}\nYou are opted out. Your request is pending operator review; deletion is not yet complete. Use privacy status to check progress. Contact zpalmtree privately on Discord with this reference if you need to add details.`,
        allowedMentions: { parse: [] as const, repliedUser: false },
        components: [] as ActionRowBuilder<ButtonBuilder>[],
    };
}

export async function handlePrivacy(msg: Message, args: string, db: Database): Promise<void> {
    const platform = privacyPlatform(msg as Message & { platform?: string });
    if (args === 'delete') {
        await msg.reply(deletionConfirmation(platform));
        return;
    }
    if (args === 'delete confirm') {
        const request = await requestDataDeletion(db, msg.author.id, platform);
        await msg.reply(deletionReceipt(request.id));
        return;
    }
    if (args === 'optout' || args === 'optin') {
        await setPrivacyOptOut(db, msg.author.id, platform, args === 'optout');
    } else if (args && args !== 'status' && args !== 'help') {
        await msg.reply(`Use \`${config.prefix}privacy\`, \`${config.prefix}privacy optout\`, \`${config.prefix}privacy optin\`, or \`${config.prefix}privacy delete\`.`);
        return;
    }
    await msg.reply(await privacyPanel(db, msg.author.id, platform));
}

export async function handlePrivacyMessage(msg: Message, db: Database): Promise<boolean> {
    const args = privacyCommandArgs(msg);
    if (args === undefined) return false;
    await handlePrivacy(msg, args, db);
    return true;
}

export async function handlePrivacyInteraction(interaction: Interaction, db: Database): Promise<boolean> {
    if (!interaction.isButton() || !interaction.customId.startsWith('privacy:')) return false;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const action = interaction.customId.slice('privacy:'.length);
    const userId = interaction.user.id; // Never trust a user ID supplied by a button or another person's panel.
    try {
        if (action.startsWith('requests:') || action.startsWith('review:') || action.startsWith('complete:')) {
            if (userId !== config.god) {
                await interaction.editReply({ content: 'Only the bot operator can review deletion requests.' });
                return true;
            }
            const requests = await pendingDeletionRequests(db);
            if (action.startsWith('requests:')) {
                const value = Number(action.split(':')[1]);
                const page = Number.isSafeInteger(value) && value >= 0 ? value : 0;
                const selected = requests.slice(page * 4, page * 4 + 4);
                const rows = selected.map(request => new ActionRowBuilder<ButtonBuilder>().addComponents(
                    button(`review:${request.id}`, `Review ${request.id.slice(0, 8)}`),
                ));
                const navigation = new ActionRowBuilder<ButtonBuilder>().addComponents(button('status', 'My privacy'));
                if (page > 0) navigation.addComponents(button(`requests:${page - 1}`, 'Previous'));
                if (requests.length > (page + 1) * 4) navigation.addComponents(button(`requests:${page + 1}`, 'Next'));
                rows.push(navigation);
                await interaction.editReply({
                    content: `Pending deletion requests: ${requests.length}\n` + selected.map(request =>
                        `${request.id.slice(0, 8)} — ${request.platform} user ${request.user_id} — ${request.created_at} UTC`).join('\n'),
                    components: rows, allowedMentions: { parse: [] },
                });
            } else {
                const id = action.split(':')[1];
                const request = requests.find(candidate => candidate.id === id);
                if (!request) {
                    await interaction.editReply({ content: 'That pending request was not found. Refresh the queue.' });
                } else if (action.startsWith('review:')) {
                    await interaction.editReply({
                        content: `Request ${request.id}\n${request.platform} user ${request.user_id}\n\nReview and remove applicable bot records, saved content, media/worker files, logs and retained backups; handle provider-side requests where needed. Verify any content without author metadata with the requester. This button only records completion; it does not perform deletion. Mark completed only after the request has been handled.`,
                        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
                            button(`complete:${request.id}`, 'I have completed the deletion', ButtonStyle.Danger),
                            button('requests:0', 'Back to requests'),
                        )], allowedMentions: { parse: [] },
                    });
                } else {
                    const completed = await completeDeletionRequest(db, id);
                    await interaction.editReply({ content: completed ? `Request ${id} marked completed. The user's status has been updated.` : 'That request is no longer pending.', components: [] });
                }
            }
            return true;
        }
        if (action === 'delete') {
            await interaction.editReply(deletionConfirmation('discord'));
        } else if (action === 'delete-confirm') {
            const request = await requestDataDeletion(db, userId, 'discord');
            await interaction.editReply(deletionReceipt(request.id));
        } else if (action === 'status' || action === 'optout' || action === 'optin') {
            if (action !== 'status') await setPrivacyOptOut(db, userId, 'discord', action === 'optout');
            await interaction.editReply(await privacyPanel(db, userId, 'discord'));
        } else {
            await interaction.editReply({ content: 'Unknown privacy action. Open a fresh privacy panel.' });
        }
    } catch {
        await interaction.editReply({ content: 'Could not complete this privacy action. Please try again or contact zpalmtree privately on Discord. A failed deletion request may still leave you opted out; check privacy status.', components: [] });
    }
    return true;
}
