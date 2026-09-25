import fetch from 'node-fetch';

const BASE_URL = 'https://gcp2.net';
const TOKEN_CACHE_MS = 60 * 60 * 1000;
const SNAPSHOT_CACHE_MS = 60 * 1000;
const STALE_CACHE_MS = 15 * 60 * 1000;
const MAX_RETRY_WAIT_MS = 60 * 1000;

export interface Gcp2Response {
    currentNetvar?: { netvar?: { netvar: string }[] }
    netvarAggregate24H?: {
        aggregates?: { end_epoch: number | string, netvar_aggregate: string }[]
    }
}

class AuthorizationError extends Error {}

export interface Gcp2Snapshot extends Gcp2Response {
    fetchedAt: number
    stale: boolean
}

export class Gcp2RateLimitError extends Error {
    constructor(public readonly retryAt: number) {
        super('The dot provider is busy. Please try again shortly.');
    }
}

// The official live-data page publishes this read-only credential in a script.
// Read it as data (never execute it), so rotations require no bot configuration.
export function createGcp2Client(request: typeof fetch = fetch, clock = {
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
}) {
    let tokenCache: { expiresAt: number, promise: Promise<string> } | undefined;
    let cached: Gcp2Snapshot | undefined;
    let inFlight: Promise<Gcp2Snapshot> | undefined;
    let retryAt = 0;

    async function read(path: string, token?: string): Promise<string> {
        const response = await request(BASE_URL + path, {
            headers: {
                accept: token ? 'application/json' : 'text/javascript',
                'user-agent': 'dave-discord-bot/1.1',
                ...(token ? { authorization: token } : {}),
            },
            redirect: 'manual',
            timeout: 15000,
            size: 2 * 1024 * 1024,
        });
        const body = await response.text();
        if (response.status === 429) {
            const header = response.headers.get('retry-after');
            const seconds = header?.trim() ? Number(header) : NaN;
            const deadline = Number.isFinite(seconds) ? clock.now() + seconds * 1000 :
                (header ? Date.parse(header) : NaN);
            // A small buffer avoids retrying on the reset boundary.
            retryAt = Math.max(retryAt, clock.now() + 1000,
                (Number.isFinite(deadline) ? deadline : clock.now() + 30000) + 1000);
            throw new Gcp2RateLimitError(retryAt);
        }
        // Expired credentials may redirect to an HTML session-expired page.
        if (token && (response.status === 401 || response.status === 403 ||
            (response.status >= 300 && response.status < 400 &&
                (response.headers.get('location') || '').includes('/session/expired')))) {
            throw new AuthorizationError('GCP 2.0 API authorization expired');
        }
        if (!response.ok) {
            throw new Error(`GCP 2.0 API returned ${response.status} ${response.statusText}`);
        }
        return body;
    }

    async function getToken(): Promise<string> {
        if (tokenCache && tokenCache.expiresAt > clock.now()) return tokenCache.promise;
        const promise = read('/js/data/api_token.js').then(script => {
            const token = script.match(/\bconst\s+bearer\s*=\s*(["'])([^"'\r\n]+)\1\s*;/)?.[2];
            if (!token) throw new Error('GCP 2.0 public API token was not found');
            return token;
        });
        tokenCache = { expiresAt: clock.now() + TOKEN_CACHE_MS, promise };
        try {
            return await promise;
        } catch (error) {
            if (tokenCache?.promise === promise) tokenCache = undefined;
            throw error;
        }
    }

    async function json(path: string, token: string) {
        const body = await read(path, token);
        try {
            const data = JSON.parse(body);
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                throw new Error('response root is not an object');
            }
            return data;
        } catch {
            throw new Error('GCP 2.0 API returned invalid JSON');
        }
    }

    async function fetchSnapshot(): Promise<Gcp2Response> {
        for (let attempt = 0; ; attempt++) {
            const token = await getToken();
            const usedCache = tokenCache;
            try {
                // Settle both requests before refreshing credentials or retrying.
                const results = await Promise.allSettled([
                    json('/api/getcurrentnetvar', token),
                    json('/api/getNetVarAggregate24H', token),
                ]);
                if (retryAt > clock.now()) throw new Gcp2RateLimitError(retryAt);
                const values = results.map(result => {
                    if (result.status === 'rejected') throw result.reason;
                    return result.value;
                });
                const [currentNetvar, netvarAggregate24H] = values;
                return { currentNetvar, netvarAggregate24H };
            } catch (error) {
                if (!(error instanceof AuthorizationError)) throw error;
                if (tokenCache === usedCache) tokenCache = undefined;
                if (attempt > 0) throw error;
            }
        }
    }

    function staleSnapshot(): Gcp2Snapshot | undefined {
        if (cached && clock.now() - cached.fetchedAt <= STALE_CACHE_MS) {
            return { ...cached, stale: true };
        }
    }

    async function refresh(): Promise<Gcp2Snapshot> {
        for (let attempt = 0; ; attempt++) {
            try {
                const data = await fetchSnapshot();
                cached = { ...data, fetchedAt: clock.now(), stale: false };
                return cached;
            } catch (error) {
                if (!(error instanceof Gcp2RateLimitError)) throw error;
                const stale = staleSnapshot();
                if (stale) return stale;
                const wait = retryAt - clock.now();
                if (attempt > 0 || wait > MAX_RETRY_WAIT_MS) throw error;
                await clock.sleep(Math.max(0, wait));
            }
        }
    }

    return async function getSnapshot(): Promise<Gcp2Snapshot> {
        if (cached && clock.now() - cached.fetchedAt < SNAPSHOT_CACHE_MS) return cached;
        if (inFlight) return inFlight;
        if (retryAt > clock.now()) {
            const stale = staleSnapshot();
            if (stale) return stale;
            throw new Gcp2RateLimitError(retryAt);
        }
        const promise = refresh();
        inFlight = promise;
        try {
            return await promise;
        } finally {
            if (inFlight === promise) inFlight = undefined;
        }
    };
}

export const fetchGcp2Snapshot = createGcp2Client();
