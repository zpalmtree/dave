import { AsyncLocalStorage } from 'node:async_hooks';
import type { Message } from 'discord.js';
import type { Database } from 'sqlite3';
import { executeQuery, selectQuery } from './Database.js';

export const PRIVACY_POLICY_URL = 'https://github.com/zpalmtree/dave/blob/master/PRIVACY.md';
type Platform = 'discord' | 'uproar';
const optedOut = new Set<string>();
const listeners = new Set<() => void>();
const contexts = new AsyncLocalStorage<number>();
let revision = 0;
let pendingWrite: Promise<void> = Promise.resolve();

export function privacyPlatform(msg: { platform?: string }): Platform {
    return msg.platform === 'uproar' ? 'uproar' : 'discord';
}

export function isPrivacyOptedOut(userId: string, platform: Platform = 'discord'): boolean {
    return optedOut.has(`${platform}:${userId}`);
}

export function canProcessMessage(msg: { author?: { id: string }; platform?: string }): boolean {
    return !msg.author || !isPrivacyOptedOut(msg.author.id, privacyPlatform(msg));
}

export function onPrivacyChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function invalidateCaches(): void {
    revision += 1;
    for (const listener of listeners) listener();
}

export async function initPrivacy(db: Database): Promise<void> {
    await executeQuery(`CREATE TABLE IF NOT EXISTS privacy_preferences (
        platform TEXT NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (platform, user_id)
    )`, db);
    const rows = await selectQuery('SELECT platform, user_id FROM privacy_preferences', db);
    optedOut.clear();
    for (const row of rows) optedOut.add(`${row.platform}:${row.user_id}`);
    invalidateCaches();
}

export async function setPrivacyOptOut(db: Database, userId: string, platform: Platform, disabled: boolean): Promise<void> {
    // Serialize writes so rapid opt-out/opt-in requests cannot leave RAM and SQLite disagreeing.
    const write = pendingWrite.then(async () => {
        await executeQuery(disabled
            ? 'INSERT OR IGNORE INTO privacy_preferences (platform, user_id) VALUES (?, ?)'
            : 'DELETE FROM privacy_preferences WHERE platform = ? AND user_id = ?',
        db, [platform, userId]);
        const key = `${platform}:${userId}`;
        if (disabled) optedOut.add(key);
        else optedOut.delete(key);
        invalidateCaches();
    });
    pendingWrite = write.catch(() => undefined);
    await write;
}

export function runWithPrivacyContext<T>(callback: () => T): T {
    return contexts.run(revision, callback);
}

export function assertPrivacyContextCurrent(): void {
    const started = contexts.getStore();
    if (started !== undefined && started !== revision) {
        throw new Error('Privacy preferences changed during this request. Please try again.');
    }
}

// Derived chat histories lack reliable author attribution. Clear them on a
// preference change and prevent an older in-flight request from repopulating them.
export class PrivacyAwareHistoryCache<T> extends Map<string, T> {
    constructor() {
        super();
        onPrivacyChange(() => this.clear());
    }

    set(key: string, value: T): this {
        const started = contexts.getStore();
        if (started === undefined || started === revision) super.set(key, value);
        return this;
    }
}

export async function fetchProcessableMessage(msg: Message, id: string): Promise<Message> {
    const fetched = await msg.channel.messages.fetch(id);
    if (!canProcessMessage(fetched)) {
        msg.channel.messages.cache?.delete(id);
        throw new Error('The author of the referenced message has opted out of bot processing.');
    }
    return fetched;
}
