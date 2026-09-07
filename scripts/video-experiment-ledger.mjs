import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { VideoUsagePersistenceError, videoUsageCost } from '../dist/VideoUsage.js';
import { saveJsonAtomic, stableHash } from './video-cost-ab-lib.mjs';

export class ExperimentBudgetError extends VideoUsagePersistenceError {}

export function requestCostBound(request) {
    for (const name of ['maxInputTokens', 'maxOutputTokens']) {
        if (!Number.isSafeInteger(request[name]) || request[name] < 0) {
            throw new ExperimentBudgetError(`Missing finite request bound: ${name}.`);
        }
    }
    const image = Boolean(request.maxImages);
    return videoUsageCost({
        ...request, outcome: 'success',
        // A cache write is more expensive than an uncached input for these models.
        inputTokens: request.provider === 'openai' && !image ? 0 : request.maxInputTokens,
        cacheWriteTokens: request.provider === 'openai' && !image ? request.maxInputTokens : 0,
        outputTokens: request.maxOutputTokens,
        images: request.maxImages || 0,
        webSearches: request.maxWebSearches || 0,
        pricingDate: new Date().toISOString().slice(0, 10),
    });
}

export function ledgerTotals(state) {
    const requests = Object.values(state.requests);
    const charged = requests.reduce((sum, request) => sum + (request.cost_usd || 0), 0);
    const reserved = requests.filter(request => request.status !== 'settled')
        .reduce((sum, request) => sum + request.reserve_usd, 0);
    return { charged_usd: charged, reserved_usd: reserved, committed_usd: charged + reserved,
        requests: requests.length, unresolved: requests.filter(request => request.status !== 'settled').length };
}

/** One durable ledger covers generation, retries, image creation and judges. */
export class VideoExperimentLedger {
    static async open(directory, { budgetUsd = 50, phaseCapUsd = budgetUsd } = {}) {
        if (!(budgetUsd > 0 && budgetUsd <= 50 && phaseCapUsd > 0 && phaseCapUsd <= budgetUsd)) {
            throw new ExperimentBudgetError('Campaign budget must be at most the authorized $50.');
        }
        await mkdir(directory, { recursive: true });
        const path = resolve(directory, 'ledger.json');
        const lockPath = resolve(directory, 'ledger.lock');
        let lock;
        try { lock = await open(lockPath, 'wx', 0o600); }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const pid = Number(await readFile(lockPath, 'utf8'));
            if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid ledger lock; inspect it before recovery.');
            try { process.kill(pid, 0); }
            catch (probe) {
                if (probe.code !== 'ESRCH') throw probe;
                await unlink(lockPath);
                return VideoExperimentLedger.open(directory, { budgetUsd, phaseCapUsd });
            }
            throw new Error(`Experiment ledger is owned by live process ${pid}.`);
        }
        await lock.writeFile(String(process.pid));
        try {
            let state;
            try { state = JSON.parse(await readFile(path, 'utf8')); }
            catch (error) {
                if (error.code !== 'ENOENT') throw error;
                state = { schema_version: 1, budget_usd: budgetUsd, requests: {}, calls: {}, created_at: new Date().toISOString() };
            }
            if (state.schema_version !== 1 || !state.requests || !state.calls || state.budget_usd !== budgetUsd) {
                throw new Error('Incompatible experiment ledger or changed budget.');
            }
            return new VideoExperimentLedger({ state, path, lock, lockPath, phaseCapUsd });
        } catch (error) { await lock.close(); await unlink(lockPath); throw error; }
    }

    constructor(values) { Object.assign(this, values); this.writeChain = Promise.resolve(); }

    async save() {
        this.state.updated_at = new Date().toISOString();
        const snapshot = structuredClone(this.state);
        this.writeChain = this.writeChain.then(() => saveJsonAtomic(this.path, snapshot));
        try { await this.writeChain; }
        catch (error) { throw new VideoUsagePersistenceError('Could not checkpoint experiment accounting.', error); }
    }

    hooks(scope) {
        const pending = [];
        return {
            beforeRequest: async request => {
                const reserve = requestCostBound(request);
                const totals = ledgerTotals(this.state);
                if (totals.committed_usd + reserve > Math.min(this.state.budget_usd, this.phaseCapUsd)) {
                    throw new ExperimentBudgetError(`Spend cap reached: $${totals.charged_usd.toFixed(4)} charged, $${totals.reserved_usd.toFixed(4)} unresolved; next bound $${reserve.toFixed(4)}, cap $${this.phaseCapUsd}.`);
                }
                const id = randomUUID();
                this.state.requests[id] = { id, scope, ...request, reserve_usd: reserve,
                    cost_usd: 0, status: 'reserved', started_at: new Date().toISOString() };
                pending.push(id);
                await this.save();
            },
            onUsage: async usage => {
                const id = [...pending].reverse().find(key => {
                    const request = this.state.requests[key];
                    return request.status === 'reserved' && request.provider === usage.provider
                        && (usage.model === request.model || usage.model.startsWith(`${request.model}-`));
                });
                if (!id) throw new VideoUsagePersistenceError(`Unmetered provider usage in ${scope}: ${usage.model}/${usage.stage}.`);
                const request = this.state.requests[id];
                request.usage = usage;
                request.completed_at = new Date().toISOString();
                if (usage.usageMissing) {
                    request.status = 'unresolved';
                    await this.save();
                    throw new VideoUsagePersistenceError('Provider omitted billable usage; its full reservation remains held.');
                }
                try { request.cost_usd = videoUsageCost(usage); }
                catch (error) { request.status = 'unresolved'; await this.save(); throw new VideoUsagePersistenceError(error.message); }
                request.status = 'settled';
                await this.save();
                if (request.cost_usd > request.reserve_usd + 1e-8) {
                    throw new VideoUsagePersistenceError('Provider charge exceeded its conservative reservation; stop the campaign.');
                }
            },
        };
    }

    async checkpoint(identity, execute) {
        const key = stableHash(JSON.stringify(identity), 64);
        if (this.state.calls[key]) return { ...this.state.calls[key], reused: true };
        const started = performance.now();
        const usage = [], attempts = [];
        const hooks = this.hooks(key);
        let result;
        try {
            const value = await execute({ ...hooks,
                onUsage: async event => { usage.push(event); await hooks.onUsage(event); },
                onAttempt: event => { attempts.push(event); },
            });
            result = { ok: true, value };
        } catch (error) {
            if (error instanceof VideoUsagePersistenceError) { await this.save(); throw error; }
            result = { ok: false, error: error.message || String(error) };
        }
        const requests = Object.values(this.state.requests).filter(request => request.scope === key);
        result = { ...identity, ...result, usage, attempts, duration_seconds: (performance.now() - started) / 1000,
            cost_usd: requests.reduce((sum, request) => sum + request.cost_usd, 0),
            accounting_complete: requests.every(request => request.status === 'settled'),
            request_ids: requests.map(request => request.id), completed_at: new Date().toISOString() };
        this.state.calls[key] = result;
        await this.save();
        return result;
    }

    async close() {
        try { await this.writeChain; } finally { await this.lock.close(); await unlink(this.lockPath); }
    }
}

export async function executionFingerprint(paths) {
    const files = await Promise.all(paths.map(async path => [path, stableHash(await readFile(path), 64)]));
    return stableHash(JSON.stringify(files), 64);
}
