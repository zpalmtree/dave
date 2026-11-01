import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PurgeState {
    runId: string;
    guildId: string;
    userId: string;
    deleted: number;
    failures: number;
    scanned: number;
    skipped: number;
    pages: number;
    phase: string;
    channelId?: string;
    before?: string;
}

export interface PurgeCheckpoint {
    version: 1;
    state: PurgeState;
    invokingChannelId: string;
    progressMessageId?: string;
    // Cursors here only advance AFTER all messages on a page have been handled.
    channels: Record<string, { before?: string; done: boolean }>;
}

export interface PurgeCheckpointStore {
    load(guildId: string): PurgeCheckpoint | undefined;
    list(): PurgeCheckpoint[];
    save(checkpoint: PurgeCheckpoint): void;
    remove(guildId: string): void;
}

export class PurgeCheckpointError extends Error {}

const id = (value: unknown): value is string => typeof value === 'string' && /^\d{1,20}$/.test(value);

export function validatePurgeCheckpoint(value: any): asserts value is PurgeCheckpoint {
    const state = value?.state;
    if (value?.version !== 1 || !state || !id(state.guildId) || !id(state.userId)
        || typeof state.runId !== 'string' || !state.runId || typeof state.phase !== 'string'
        || !id(value.invokingChannelId) || (value.progressMessageId !== undefined && !id(value.progressMessageId))
        || (state.channelId !== undefined && !id(state.channelId)) || (state.before !== undefined && !id(state.before))
        || !['deleted', 'failures', 'scanned', 'skipped', 'pages'].every(key => Number.isSafeInteger(state[key]) && state[key] >= 0)
        || !value.channels || typeof value.channels !== 'object' || Array.isArray(value.channels)
        || !Object.entries(value.channels).every(([key, cursor]: [string, any]) => id(key) && cursor
            && typeof cursor.done === 'boolean' && (cursor.before === undefined || id(cursor.before)))) {
        throw new PurgeCheckpointError('Invalid purge checkpoint; retained for operator inspection.');
    }
}

// One-time bridge for an old running process whose cursor names the oldest
// message of an IN-FLIGHT page. Rewind to a larger, previously observed cursor;
// using the live cursor directly could skip undeleted messages on that page.
export function migrateLegacyPurgeCheckpoint(state: PurgeState, events: Array<Record<string, any>>): PurgeCheckpoint {
    if (state.scanned !== 1 || !id(state.channelId) || !id(state.before)) {
        throw new PurgeCheckpointError('Legacy migration requires one known active history scan.');
    }
    const previous = [...events].reverse().find(event => event.runId === state.runId
        && event.channelId === state.channelId && id(event.before)
        && ['scanning_messages', 'deleting_message'].includes(event.phase)
        && BigInt(event.before) > BigInt(state.before!));
    const checkpoint: PurgeCheckpoint = {
        version: 1,
        state: { ...state, before: previous?.before, phase: 'waiting_to_resume' },
        invokingChannelId: state.channelId,
        channels: { [state.channelId]: { before: previous?.before, done: false } },
    };
    validatePurgeCheckpoint(checkpoint);
    return checkpoint;
}

// The production working directory is inside the encrypted service mount.
// Synchronous, small atomic commits make every deletion/cursor update durable
// before the next Discord operation, without overlapping writes during shutdown.
export function createFilePurgeCheckpointStore(directory: string): PurgeCheckpointStore {
    const path = (guildId: string) => {
        if (!id(guildId)) throw new PurgeCheckpointError('Invalid guild ID.');
        return join(directory, `${guildId}.json`);
    };
    const syncDirectory = () => {
        const fd = openSync(directory, 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
    };
    const load = (guildId: string) => {
        let raw: string;
        try { raw = readFileSync(path(guildId), 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        const value = JSON.parse(raw);
        validatePurgeCheckpoint(value);
        if (value.state.guildId !== guildId) throw new PurgeCheckpointError('Checkpoint guild does not match filename.');
        return value;
    };
    return {
        load,
        list: () => {
            let files: string[];
            try { files = readdirSync(directory); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
            return files.filter(file => /^\d{1,20}\.json$/.test(file)).map(file => load(file.slice(0, -5))!);
        },
        save: checkpoint => {
            validatePurgeCheckpoint(checkpoint);
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            const destination = path(checkpoint.state.guildId);
            const temporary = `${destination}.${process.pid}.tmp`;
            const fd = openSync(temporary, 'w', 0o600);
            try { writeFileSync(fd, JSON.stringify(checkpoint)); fsyncSync(fd); }
            finally { closeSync(fd); }
            renameSync(temporary, destination);
            syncDirectory();
        },
        remove: guildId => {
            try { unlinkSync(path(guildId)); syncDirectory(); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        },
    };
}
