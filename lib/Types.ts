export interface TimeUnits {
    Y: number;  // year
    M: number;  // month
    W: number;  // week
    d: number;  // day
    h: number;  // hour
    m: number;  // minute
    s: number;  // second
}

export interface Quote {
    quote: string;
    timestamp: number;
}

export interface ScheduledWatch {
    id: number;
    title: string;
    link: string;
    time: Date;
    attending: string[];
    magnet?: string;
}

export interface Command {
    /* How can we access the command? */
    aliases: string[];

    /* Do we need the args, do we want them split on spaces or not */
    argsFormat: Args;

    /* Is this a private command */
    hidden: boolean;

    /* The function that implements this command */
    implementation: any;

    /* The function that provides help / examples on this command */
    helpFunction?: any;

    /* A description of the command for help strings */
    description?: string;

    /* If the command is disabled */
    disabled?: boolean;
}

export enum Args {
    DontNeed,
    Split,
    Combined,
};
