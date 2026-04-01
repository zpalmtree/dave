export interface UserChannelRestriction {
    userId: string;
    allowedChannels: string[];
}

export const userChannelRestrictions: UserChannelRestriction[] = [
    {
        userId: '1307359331724824744',
        allowedChannels: ['1234575197114204202'],
    },
];
