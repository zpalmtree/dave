export interface UserChannelRestriction {
    userId: string;
    allowedChannels: string[];
}

export const userChannelRestrictions: UserChannelRestriction[] = [
    {
        userId: '1307359331724824744',
        allowedChannels: ['1234575197114204202', '1073613902706909214'],
    },
    {
        userId: '673794444579045386',
        allowedChannels: ['1234575197114204202', '1073613902706909214'],
    },
    {
        userId: '1232469668548055061',
        allowedChannels: ['1234575197114204202', '1073613902706909214'],
    },
    {
        userId: '1259332105188671509',
        allowedChannels: ['1234575197114204202', '1073613902706909214'],
    },
];
