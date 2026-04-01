export interface ExternalBotReplyRestriction {
    blockedUserIds: string[];
    botUserId: string;
    triggerPattern: RegExp;
}

export const externalBotReplyRestrictions: ExternalBotReplyRestriction[] = [
    {
        blockedUserIds: [
            '1307359331724824744',
            '673794444579045386',
            '1232469668548055061',
            '1259332105188671509',
        ],
        botUserId: '723993425325719619',
        triggerPattern: /^\s*fc(?:\s|$)/i,
    },
];
