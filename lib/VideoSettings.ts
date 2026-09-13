import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

interface VideoSettingsFile {
    brokerUrl?: string;
    botToken?: string;
    workerToken?: string;
    brokerHost?: string;
    brokerPort?: number;
    brokerDb?: string;
    resultsDir?: string;
    stallAlertAfterSeconds?: number;
    stallRealertSeconds?: number;
    stallAlertUserId?: string;
    stallAlertChannelId?: string;
}

export interface VideoSettings {
    brokerUrl: string;
    botToken: string;
    workerToken: string;
    brokerHost: string;
    brokerPort: number;
    brokerDb: string;
    resultsDir: string;
    /** Seconds a job may wait for GPU admission with nothing ahead before the owner is alerted. */
    stallAlertAfterSeconds: number;
    /** Seconds between repeat alerts while the same job stays stalled. */
    stallRealertSeconds: number;
    /** Discord user to DM about stalls; empty means the configured bot owner. */
    stallAlertUserId: string;
    /** Optional Discord channel that also receives stall alerts. */
    stallAlertChannelId: string;
    configFile: string;
}

function positiveSeconds(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadVideoSettings(): VideoSettings {
    const configFile = process.env.VIDEO_CONFIG_FILE
        || join(homedir(), '.config', 'dave-video.json');
    let file: VideoSettingsFile = {};
    if (existsSync(configFile)) {
        file = JSON.parse(readFileSync(configFile, 'utf8')) as VideoSettingsFile;
    }
    return {
        brokerUrl: (process.env.VIDEO_BROKER_URL || file.brokerUrl || 'http://127.0.0.1:8765').replace(/\/$/, ''),
        botToken: process.env.VIDEO_BROKER_BOT_TOKEN || file.botToken || '',
        workerToken: process.env.VIDEO_BROKER_WORKER_TOKEN || file.workerToken || '',
        brokerHost: process.env.VIDEO_BROKER_HOST || file.brokerHost || '127.0.0.1',
        brokerPort: Number(process.env.VIDEO_BROKER_PORT || file.brokerPort || 8765),
        brokerDb: process.env.VIDEO_BROKER_DB || file.brokerDb || join(homedir(), 'video-broker.sqlite3'),
        resultsDir: process.env.VIDEO_RESULTS_DIR || file.resultsDir || join(homedir(), 'video-results'),
        stallAlertAfterSeconds: positiveSeconds(
            process.env.VIDEO_STALL_ALERT_AFTER_SECONDS || file.stallAlertAfterSeconds,
            15 * 60,
        ),
        stallRealertSeconds: positiveSeconds(
            process.env.VIDEO_STALL_REALERT_SECONDS || file.stallRealertSeconds,
            60 * 60,
        ),
        stallAlertUserId: process.env.VIDEO_STALL_ALERT_USER_ID || file.stallAlertUserId || '',
        stallAlertChannelId: process.env.VIDEO_STALL_ALERT_CHANNEL_ID || file.stallAlertChannelId || '',
        configFile,
    };
}
