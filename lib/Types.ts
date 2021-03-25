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

    /* Channel the movie is being watched in */
    channelID: string;
}

export type DontNeedArgsCommandDb = (msg: Message, db: Database) => void;
export type DontNeedArgsCommand = (msg: Message) => void;

export type SplitArgsCommandDb = (msg: Message, args: string[], db: Database) => void;
export type SplitArgsCommand = (msg: Message, args: string[]) => void;

export type CombinedArgsCommandDb = (msg: Message, args: string, db: Database) => void;
export type CombinedArgsCommand = (msg: Message, args: string) => void;

export type CommandImplementation = DontNeedArgsCommandDb
                                  | DontNeedArgsCommand
                                  | SplitArgsCommandDb
                                  | SplitArgsCommand
                                  | CombinedArgsCommandDb
                                  | CombinedArgsCommand;

export interface Example {
    name?: string;
    value: string;
}

export interface CommandFunc {
    /* Do we need the args, do we want them split on spaces or not */
    argsFormat: Args;

    /* The function that implements this command */
    implementation: CommandImplementation;

    /* Simple description of the sub command */
    description: string;

    /* How can we access the sub command? Missing if primary command. */
    aliases?: string[];

    /* More detailed description of the command for help strings */
    helpDescription?: string;

    /* More detailed description of the command for help strings. Useful if
     * something must be initialized first. */
    helpDescriptionFunc?: () => string;

    /* Whether we need the DB for this command. Default false. */
    needDb?: boolean;

    /* Examples on how to use this sub command */
    examples?: Example[];

    /* The function that provides help / examples on this sub command */
    helpFunction?: (msg: Message) => void;

    /* Sub-commands that are relevant to this one */
    relatedCommands?: string[];

    /* Whether this sub command is disabled. Default false. */
    disabled?: boolean;
}

export interface Command {
    /* How can we access the command? */
    aliases: string[];

    /* The function to call when the command is called with no arguments */
    primaryCommand: CommandFunc;

    /* Is this a private command */
    hidden?: boolean;

    /* Other 'sub commands', e.g. $watch addlink. */
    subCommands?: CommandFunc[];

    /* Commands that are related to this one */
    relatedCommands?: string[];
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
