import type { Message } from 'discord.js';
import type { Database } from 'sqlite3';
import { config } from './Config.js';
import { isPrivacyOptedOut, privacyPlatform, PRIVACY_POLICY_URL, setPrivacyOptOut } from './Privacy.js';

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

export async function handlePrivacy(msg: Message, args: string, db: Database): Promise<void> {
    const platform = privacyPlatform(msg as Message & { platform?: string });
    if (args === 'optout' || args === 'optin') {
        await setPrivacyOptOut(db, msg.author.id, platform, args === 'optout');
    } else if (args && args !== 'status' && args !== 'help') {
        await msg.reply(`Use \`${config.prefix}privacy\`, \`${config.prefix}privacy optout\`, or \`${config.prefix}privacy optin\`.`);
        return;
    }
    const disabled = isPrivacyOptedOut(msg.author.id, platform);
    await msg.reply({
        content: `Privacy policy: ${PRIVACY_POLICY_URL}\n\n`
            + (disabled
                ? 'You are opted out. This bot skips your new messages and commands (except privacy controls), excludes your messages from new summaries and fetched reply context, and clears its conversation caches when your preference changes.'
                : 'You are opted in. This bot can process your messages in channels it can access, including for summaries, link previews and audio transcription.')
            + `\n\nUse \`${config.prefix}privacy optout\` to opt out or \`${config.prefix}privacy optin\` to opt back in. You can also mention this bot followed by \`privacy optout\` or \`privacy optin\`.`
            + '\nYour preference persists across restarts and applies to this bot on this platform. We retain your user ID to enforce it. It does not cancel work already submitted, erase existing records or outputs, or control copies posted by others. Contact zpalmtree privately on Discord for deletion requests.',
        allowedMentions: { parse: [], repliedUser: false },
    });
}

export async function handlePrivacyMessage(msg: Message, db: Database): Promise<boolean> {
    const args = privacyCommandArgs(msg);
    if (args === undefined) return false;
    await handlePrivacy(msg, args, db);
    return true;
}
