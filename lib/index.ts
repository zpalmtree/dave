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
import { getDiscordLoginRetryDelay } from './DiscordRetry.js';

import {
    createTablesIfNeeded,
    deleteTablesIfNeeded,
} from './Database.js';

import { restoreTimers } from './Timer.js';
import { cacheMessageForSummarization } from './Summarize.js';
import { convertTwitterLinks } from './ConvertTwitterLinks.js';
import { convertPumpFunLinks } from './ConvertPumpFunLinks.js';
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
        const referencedMessage = await msg.channel.messages.fetch(msg.reference.messageId);

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

    if (await handleRestrictedExternalBotReply(msg)) {
        return;
    }

    if (!isMessageAllowed(msg)) {
        return;
    }

    if (!msg.content.startsWith(config.prefix)) {
        if (msg.author.id !== '446154284514541579') {
            cacheMessageForSummarization(msg);
        }

        convertTwitterLinks(msg);
        convertPumpFunLinks(msg);
        runWithTokenSpendContext(msg, 'autotranscribe', () => handleAutoTranscribe(msg));

        return;
    }

    await dispatchPrefixedCommand(msg, db);
}

function createDiscordClient(db: sqlite3.Database): Client {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMessageReactions,
        ],
    });

    client.on('clientReady', async () => {
        console.log('Logged in');

        restoreTimers(db, client);

    });

    client.on('messageCreate', async (msg) => {
        try {
            await handleMessage(msg as Message, db);
        /* Usually discord permissions errors */
        } catch (err) {
            console.error(`Caught error while executing ${msg.content} for ${msg.author.id}: ${(err as any).toString()}`);
            console.log(`Error stack trace: ${(err as any).stack}`);
            tryReactMessage(msg, '🔥');
            await msg.reply(`Error: ${(err as any).toString()}`);
        }
    });

    client.on('error', (err) => {
        console.log(`Caught error from discord client: ${err.toString()}`);
        console.log(`Error stack trace: ${err.stack}`);
    });

    return client;
}

async function loginWithRetry(db: sqlite3.Database): Promise<void> {
    let attempt = 0;

    while (true) {
        const client = createDiscordClient(db);

        try {
            await client.login(config.token);
            return;
        } catch (error) {
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
