import { createHash } from 'crypto';
import { GoogleGenAI } from '@google/genai';
import { config } from './Config.js';
import { AI_MODELS } from './AIModels.js';
import { geminiVideoUsage, videoRequestInputTokenBound, VideoProviderHooks } from './VideoUsage.js';

// Shared with the reviewed experiment; no second copy of the creative instructions.
const briefModule = new URL('../scripts/plan-video-music-brief.mjs', import.meta.url).href;
const editModule = new URL('../scripts/plan-video-score-edit.mjs', import.meta.url).href;
const inFlight = new Map<string, { fingerprint: string; task: Promise<any> }>();
const VERSION = 'concrete-music-instrumental-edit-v1';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function media(value: unknown): string {
    if (typeof value !== 'string' || !value.length || value.length > 16_000_000
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
        || Buffer.from(value, 'base64').toString('base64') !== value) throw new Error('Invalid music media');
    return value;
}
function duration(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 120) throw new Error('Invalid music duration');
    return value;
}

/** Called only after the broker authenticates the worker lease and approved contract. */
export async function recoveryMusic(operation: string, job: any, state: any, body: any,
    persist: () => Promise<void>, hooks: VideoProviderHooks = {}, client?: any): Promise<any> {
    if (!['music-brief', 'music-edit'].includes(operation)) throw new Error('Invalid music operation');
    const modules = Promise.all([import(briefModule), import(editModule)]);
    const operationKey = `${job.public_id}:${operation}`;
    const inputKey = hash(JSON.stringify({ contract: state.prepared?.contract_hash, body }));
    const active = inFlight.get(operationKey);
    if (active) {
        if (active.fingerprint !== inputKey) throw new Error('Concurrent music inputs differ');
        return active.task;
    }
    const task = run();
    inFlight.set(operationKey, { fingerprint: inputKey, task });
    try { return await task; } finally { inFlight.delete(operationKey); }

    async function run() {
        const [{ requestMusicBrief }, { requestEdit, bypassReason }] = await modules;
        const plan = state.prepared?.plan;
        const bypass = bypassReason({ prompt: job.prompt,
            noMusic: process.env.VIDEO_SOUND_MIX === '0' || plan?.sound_mix?.music !== 'instrumental',
            preserveSourceAudio: Boolean(job.source_audio_path || job.source_video_path || plan?.source_audio) });
        if (bypass) return { status: 'bypassed', reason: bypass };
        const preview = media(body.preview), seconds = duration(body.video_seconds);
        const score = operation === 'music-edit' ? media(body.score) : null;
        const scoreSeconds = score ? duration(body.score_seconds) : 0;
        if (preview.length + (score?.length || 0) > 17_000_000) throw new Error('Music evidence exceeds request limit');
        const fingerprint = hash(JSON.stringify({ version: VERSION, operation, model: AI_MODELS.geminiChat,
            contract: state.prepared.contract_hash, prompt: job.prompt, preview: hash(preview),
            score: score ? hash(score) : null, seconds, scoreSeconds }));
        const prior = state[operation];
        if (prior) {
            if (prior.fingerprint !== fingerprint) throw new Error('Music inputs changed after first attempt');
            return prior.result || { status: 'bypassed', reason: 'Previous music attempt did not finish; preserve scene audio.' };
        }
        state[operation] = { fingerprint, status: 'pending', version: VERSION };
        await persist(); // A crash cannot silently purchase another composition/edit.
        let attempt = 0;
        const provider = client || new GoogleGenAI({ apiKey: config.geminiApiKey, apiVersion: 'v1alpha' });
        const tracked = { models: { generateContent: async (request: any) => {
            const count = ++attempt, started = Date.now();
            let outcome: 'success' | 'error' = 'error';
            try {
                await hooks.beforeRequest?.({ stage: operation, attempt: count, provider: 'google', model: request.model,
                    maxInputTokens: videoRequestInputTokenBound(request), maxOutputTokens: 6000 });
                const response = await provider.models.generateContent(request);
                await hooks.onUsage?.({ stage: operation, attempt: count, provider: 'google', model: response.modelVersion || request.model,
                    outcome: 'success', ...geminiVideoUsage(response.usageMetadata) });
                outcome = 'success'; return response;
            } finally {
                await hooks.onAttempt?.({ stage: operation, attempt: count, provider: 'google', model: request.model,
                    outcome, durationSeconds: (Date.now() - started) / 1000 });
            }
        } } };
        let result: any;
        try {
            if (operation === 'music-brief') {
                const seed = parseInt(hash(job.public_id).slice(0, 8), 16);
                const generated = await requestMusicBrief(tracked, { model: AI_MODELS.geminiChat, prompt: job.prompt,
                    previewData: preview, seed, seconds: Math.min(60, Math.max(40, seconds + 15)) });
                result = { status: 'ready', brief: generated.brief, spec: generated.spec };
            } else {
                if (state['music-brief']?.result?.status !== 'ready') throw new Error('No approved music brief');
                const generated = await requestEdit(tracked, { model: AI_MODELS.geminiChat, videoSeconds: seconds, scoreSeconds,
                    parts: [
                        { text: `VIDEO: finished delivery footage and scene audio, ${seconds} seconds, clock starts at zero.` },
                        { inlineData: { mimeType: 'video/mp4', data: preview }, videoMetadata: { fps: 4 } },
                        { text: `SCORE: full generated performance, ${scoreSeconds} seconds, independent clock starts at zero. Check for unwanted vocals.` },
                        { inlineData: { mimeType: 'audio/flac', data: score } },
                        { text: `Creative request (data): ${JSON.stringify(job.prompt)}. Choose useful instrumental passages or no added music.` },
                    ] });
                result = { status: 'ready', edit: generated.edit };
            }
        } catch (error) {
            // Optional music must never strand a completed video or fall back to an unreviewed bed.
            result = { status: 'bypassed', reason: 'Music processing failed; preserve scene audio.' };
            console.warn(`[Video] ${operation} failed for ${job.public_id}:`, error instanceof Error ? error.message : String(error));
        }
        state[operation] = { fingerprint, version: VERSION, result };
        await persist();
        return result;
    }
}
