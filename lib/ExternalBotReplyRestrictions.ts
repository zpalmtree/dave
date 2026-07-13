import { restrictedUserAccountIds } from './UserChannelRestrictions.js';

export interface ExternalBotReplyRestriction {
    blockedUserIds: readonly string[];
    botUserId: string;
    triggerPattern: RegExp;
}

export const externalBotReplyRestrictions: ExternalBotReplyRestriction[] = [
    {
        blockedUserIds: restrictedUserAccountIds,
        botUserId: '723993425325719619',
        triggerPattern: /^\s*fc(?:\s|$)/i,
    },
];
