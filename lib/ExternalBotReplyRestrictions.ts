export interface ExternalBotReplyRestriction {
    blockedUserId: string;
    botUserId: string;
    triggerPattern: RegExp;
}

export const externalBotReplyRestrictions: ExternalBotReplyRestriction[] = [
    {
        blockedUserId: '673794444579045386',
        botUserId: '723993425325719619',
        triggerPattern: /^\s*fc(?:\s|$)/i,
    },
];
