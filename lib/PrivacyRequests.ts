import { randomUUID } from 'node:crypto';
import type { Database } from 'sqlite3';
import { executeQuery, selectOneQuery, selectQuery } from './Database.js';
import { setPrivacyOptOut } from './Privacy.js';

export interface PrivacyDeletionRequest {
    id: string;
    user_id: string;
    platform: 'discord' | 'uproar';
    status: 'pending' | 'completed';
    created_at: string;
    completed_at: string | null;
}

export async function initPrivacyRequests(db: Database): Promise<void> {
    await executeQuery(`CREATE TABLE IF NOT EXISTS privacy_deletion_requests (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT
    )`, db);
    await executeQuery(`CREATE UNIQUE INDEX IF NOT EXISTS privacy_pending_request
        ON privacy_deletion_requests(platform, user_id) WHERE status = 'pending'`, db);
}

export async function latestDeletionRequest(db: Database, userId: string, platform: 'discord' | 'uproar'): Promise<PrivacyDeletionRequest | undefined> {
    return selectOneQuery<PrivacyDeletionRequest>(`SELECT * FROM privacy_deletion_requests
        WHERE user_id = ? AND platform = ? ORDER BY rowid DESC LIMIT 1`, db, [userId, platform]);
}

export async function requestDataDeletion(db: Database, userId: string, platform: 'discord' | 'uproar'): Promise<PrivacyDeletionRequest> {
    // Stop new processing first. A failure to save the request leaves the user
    // safely opted out, but must never return a successful request receipt.
    await setPrivacyOptOut(db, userId, platform, true);
    await executeQuery(`INSERT OR IGNORE INTO privacy_deletion_requests (id, user_id, platform)
        VALUES (?, ?, ?)`, db, [randomUUID(), userId, platform]);
    const request = await selectOneQuery<PrivacyDeletionRequest>(`SELECT * FROM privacy_deletion_requests
        WHERE user_id = ? AND platform = ? AND status = 'pending'`, db, [userId, platform]);
    if (!request) throw new Error('Could not save deletion request. Please try again or contact zpalmtree.');
    return request;
}

export async function pendingDeletionRequests(db: Database): Promise<PrivacyDeletionRequest[]> {
    return selectQuery(`SELECT * FROM privacy_deletion_requests WHERE status = 'pending'
        ORDER BY created_at, rowid`, db);
}

export async function completeDeletionRequest(db: Database, id: string): Promise<boolean> {
    const rows = await selectQuery(`SELECT id FROM privacy_deletion_requests WHERE id = ? AND status = 'pending'`, db, [id]);
    if (!rows.length) return false;
    await executeQuery(`UPDATE privacy_deletion_requests SET status = 'completed', completed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending'`, db, [id]);
    return true;
}
