export interface UserChannelRestriction {
    userId: string;
    allowedChannels: readonly string[];
    allowedGuilds?: readonly string[];
}

export function isAllowedByUserChannelRestriction(
    restriction: UserChannelRestriction,
    channelId: string,
    guildId: string | null
): boolean {
    return restriction.allowedChannels.includes(channelId)
        || (guildId !== null && restriction.allowedGuilds?.includes(guildId) === true);
}

// These IDs are alternate accounts belonging to the same person. Keep their
// access policy centralized so every account receives identical handling.
export const restrictedUserAccountIds = [
    '1307359331724824744',
    '673794444579045386',
    '1232469668548055061',
    '1259332105188671509',
] as const;

const restrictedUserAllowedChannels = [
    '1234575197114204202',
    '1073613902706909214',
] as const;

const restrictedUserAllowedGuilds = [
    '1516420657984831668',
] as const;

export const userChannelRestrictions: UserChannelRestriction[] = restrictedUserAccountIds.map(
    (userId) => ({
        userId,
        allowedChannels: restrictedUserAllowedChannels,
        allowedGuilds: restrictedUserAllowedGuilds,
    })
);
