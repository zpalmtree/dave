import { canProcessMessage, fetchProcessableMessage, initPrivacy, onPrivacyChange, runWithPrivacyContext } from './Privacy.js';
import { handlePrivacyInteraction, handlePrivacyMessage } from './PrivacyCommand.js';
import { initPrivacyRequests } from './PrivacyRequests.js';
import { minimizeCommandLogs } from './PrivacyRetention.js';
import sqlite3 from 'sqlite3';

import {
    Message,
    Client,
    GatewayIntentBits,
} from 'discord.js';

import { config } from './Config.js';
import {
    tryDeleteMessage,
    tryReactMessage,
} from './Utilities.js';
import { startGitHubCommitWatch } from './GitHubCommitWatch.js';
import { startCodexResetWatch } from './CodexResetWatch.js';
import { getDiscordLoginRetryDelay, isDisallowedIntentsError } from './DiscordRetry.js';

import {
    selectQuery,
    executeQuery,
    createTablesIfNeeded,
    deleteTablesIfNeeded,
} from './Database.js';

import { restoreTimers } from './Timer.js';
import { cacheMessageForSummarization } from './Summarize.js';
import { convertTwitterLinks } from './ConvertTwitterLinks.js';
import { handleAutoTranscribe } from './OpenAI.js';
import {
    initTokenSpend,
    runWithTokenSpendContext,
} from './TokenSpend.js';
import {
    dispatchPrefixedCommand,
    isMessageAllowed,
} from './CommandDispatcher.js';
import {
    isAllowedByUserChannelRestriction,
    userChannelRestrictions,
} from './UserChannelRestrictions.js';
import { externalBotReplyRestrictions } from './ExternalBotReplyRestrictions.js';
import { startUproar } from './Uproar.js';
import { exchangeService } from './Exchange.js';
import { startVideoGenerationService } from './VideoGeneration.js';
import { startQwenImageService } from './QwenImage.js';
import { startSlugStatChannels } from './SlugStatChannels.js';

async function handleRestrictedExternalBotReply(msg: Message): Promise<boolean> {
    if (!msg.reference?.messageId) {
        return false;
    }

    const relevantRestrictions = externalBotReplyRestrictions.filter(
        ({ botUserId }) => botUserId === msg.author.id
    );

    if (relevantRestrictions.length === 0) {
        return false;
    }

    try {
        const referencedMessage = await fetchProcessableMessage(msg, msg.reference.messageId);

        for (const restriction of relevantRestrictions) {
            if (!restriction.blockedUserIds.includes(referencedMessage.author.id)) {
                continue;
            }

            if (!restriction.triggerPattern.test(referencedMessage.content)) {
                continue;
            }

            const userChannelRestriction = userChannelRestrictions.find(
                ({ userId }) => userId === referencedMessage.author.id
            );

            if (userChannelRestriction && isAllowedByUserChannelRestriction(
                userChannelRestriction,
                msg.channel.id,
                msg.guild?.id ?? null
            )) {
                continue;
            }

            await tryDeleteMessage(msg);
            return true;
        }
    } catch (err) {
        console.log(`Failed to inspect referenced message ${msg.reference.messageId}, ${(err as any).toString()}`);
    }

    return false;
}

/* This is the main entry point to handling messages. */
async function handleMessage(msg: Message, db: sqlite3.Database): Promise<void> {
    if (msg.author.id === msg.client.user.id) {
        return;
    }

    if (await handlePrivacyMessage(msg, db)) return;
    if (!canProcessMessage(msg)) {
        msg.channel.messages.cache.delete(msg.id);
        return;
    }

    if (await handleRestrictedExternalBotReply(msg)) {
        return;
    }

    if (!isMessageAllowed(msg)) {
        return;
    }

    if (!msg.content.startsWith(config.prefix)) {
        if (!msg.author.bot) {
            cacheMessageForSummarization(msg);
        }

        convertTwitterLinks(msg);
        runWithTokenSpendContext(msg, 'autotranscribe', () => handleAutoTranscribe(msg));

        return;
    }

    await dispatchPrefixedCommand(msg, db);
}

function createDiscordClient(db: sqlite3.Database, messageContent = true): { client: Client; dispose: () => Promise<void> } {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            ...(messageContent ? [GatewayIntentBits.MessageContent] : []),
            GatewayIntentBits.GuildMessageReactions,
        ],
    });

    const removePrivacyListener = onPrivacyChange(() => {
        for (const channel of client.channels.cache.values()) {
            if ('messages' in channel) channel.messages.cache.clear();
        }
    });
    client.on('clientReady', async () => {
        console.log('Logged in');

        startSlugStatChannels(client);
        restoreTimers(db, client);
        startVideoGenerationService(client);
        startQwenImageService(client);
        startGitHubCommitWatch(client);
        startCodexResetWatch(client);

        /* Backfill guild_id for existing log rows */
        const rows = await selectQuery(
            `SELECT DISTINCT channel_id FROM logs WHERE guild_id IS NULL`,
            db,
            []
        );

        for (const row of rows) {
            try {
                const channel = await client.channels.fetch(row.channel_id);

                if (channel && 'guildId' in channel && channel.guildId) {
                    await executeQuery(
                        `UPDATE logs SET guild_id = ? WHERE channel_id = ? AND guild_id IS NULL`,
                        db,
                        [channel.guildId, row.channel_id]
                    );
                    console.log(`Backfilled guild_id for channel ${row.channel_id}`);
                }
            } catch (err) {
                console.log(`Could not resolve channel ${row.channel_id}, skipping backfill`);
            }
        }
    });

    client.on('interactionCreate', interaction => {
        void handlePrivacyInteraction(interaction, db).catch(() => {
            console.error('[Privacy] Could not acknowledge a privacy interaction.');
        });
    });

    client.on('messageCreate', async (msg) => {
        try {
            await runWithPrivacyContext(() => handleMessage(msg as Message, db));
        /* Usually discord permissions errors */
        } catch (err) {
            console.error(`Caught error while handling message ${msg.id}: ${(err as any).toString()}`);
            console.log(`Error stack trace: ${(err as any).stack}`);
            tryReactMessage(msg, '🔥');
            await msg.reply(`Error: ${(err as any).toString()}`);
        }
    });

    client.on('error', (err) => {
        console.log(`Caught error from discord client: ${err.toString()}`);
        console.log(`Error stack trace: ${err.stack}`);
    });

    return {
        client,
        dispose: async () => {
            removePrivacyListener();
            await client.destroy();
        },
    };
}

async function loginWithRetry(db: sqlite3.Database): Promise<void> {
    let attempt = 0;
    let messageContent = true;

    while (true) {
        const { client, dispose } = createDiscordClient(db, messageContent);

        try {
            await client.login(config.token);
            return;
        } catch (error) {
            await dispose();
            if (messageContent && isDisallowedIntentsError(error)) {
                messageContent = false;
                console.warn('[Discord] Message Content access is unavailable. Reconnecting without it; mention this bot followed by "privacy" for privacy controls. Restart after access is restored.');
                continue;
            }
            const retryDelay = getDiscordLoginRetryDelay(attempt);
            const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            console.error(`[Discord] Login failed (${detail}); retrying in ${retryDelay / 1000}s.`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            attempt += 1;
        }
    }
}

async function main() {
    const db: sqlite3.Database = new sqlite3.Database(config.dbFile);

    await deleteTablesIfNeeded(db);
    await createTablesIfNeeded(db);

    await initPrivacy(db);
    await initPrivacyRequests(db);
    await minimizeCommandLogs(db);
    initTokenSpend(db);
    exchangeService.start();

    db.on('error', console.error);

    startUproar(db);

    await loginWithRetry(db);
}

main().catch(error => {
    console.error('Fatal startup error:', error);
    process.exitCode = 1;
});
