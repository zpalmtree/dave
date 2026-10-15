import type { Database } from 'sqlite3';
import { executeQuery, selectOneQuery } from './Database.js';

// Usage reports read command names/counts, never the submitted text. Remove
// that redundant copy from the active database, retaining the useful metadata.
export async function minimizeCommandLogs(db: Database): Promise<void> {
    await executeQuery('PRAGMA secure_delete = ON', db);
    await executeQuery(`CREATE TABLE IF NOT EXISTS privacy_migrations (
        name TEXT PRIMARY KEY
    )`, db);
    const done = await selectOneQuery(`SELECT name FROM privacy_migrations
        WHERE name = 'remove_command_arguments'`, db);
    if (done) return;
    await executeQuery('UPDATE logs SET args = NULL WHERE args IS NOT NULL', db);
    await executeQuery(`INSERT OR IGNORE INTO privacy_migrations(name)
        VALUES ('remove_command_arguments')`, db);
}
