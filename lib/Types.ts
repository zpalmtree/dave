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
    /* Id of the watch */
    id: number;

    /* Title of the watch */
    title: string;

    /* IMDB link */
    link: string;

    /* Date of the watch */
    time: Date;

    /* Discord IDs attending */
    attending: string[];

    /* Magnet link to download */
    magnet?: string;

    /* Has it completed */
    complete: boolean;
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

export interface RGB {
    r: number;
    g: number;
    b: number;
}
