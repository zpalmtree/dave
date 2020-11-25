import {
    Message,
} from 'discord.js';

import { Database } from 'sqlite3';

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
    /* Id of the watch event */
    watchID: number;

    /* ID of the movie */
    movieID: number;

    /* Title of the watch */
    title: string;

    /* IMDB / myanimelist links */
    infoLinks: string[];

    /* Magnet / youtube links */
    downloadLinks: string[];

    /* Date of the watch */
    time: Date;

    /* Discord IDs attending */
    attending: string[];
}

export type DontNeedArgsCommandDb = (msg: Message, db: Database) => void;
export type DontNeedArgsCommand = (msg: Message) => void;

export type SplitArgsCommandDb = (msg: Message, args: string[], db: Database) => void;
export type SplitArgsCommand = (msg: Message, args: string[]) => void;

export type CombinedArgsCommandDb = (msg: Message, args: string, db: Database) => void;
export type CombinedArgsCommand = (msg: Message, args: string) => void;

export interface Command {
    /* How can we access the command? */
    aliases: string[];

    /* Do we need the args, do we want them split on spaces or not */
    argsFormat: Args;

    /* Is this a private command */
    hidden: boolean;

    /* The function that implements this command */
    implementation: DontNeedArgsCommandDb
                  | DontNeedArgsCommand
                  | SplitArgsCommandDb
                  | SplitArgsCommand
                  | CombinedArgsCommandDb
                  | CombinedArgsCommand;

    /* The function that provides help / examples on this command */
    helpFunction?: (msg: Message) => void;

    /* A description of the command for help strings */
    description?: string;

    /* If the command is disabled */
    disabled?: boolean;

    needDb?: boolean;
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
