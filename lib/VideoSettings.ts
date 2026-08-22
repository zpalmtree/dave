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
}

export interface VideoSettings {
    brokerUrl: string;
    botToken: string;
    workerToken: string;
    brokerHost: string;
    brokerPort: number;
    brokerDb: string;
    resultsDir: string;
    configFile: string;
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
        configFile,
    };
}
