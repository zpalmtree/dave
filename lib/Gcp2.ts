import fetch from 'node-fetch';

const BASE_URL = 'https://gcp2.net';
const TOKEN_CACHE_MS = 60 * 60 * 1000;

export interface Gcp2Response {
    currentNetvar?: { netvar?: { netvar: string }[] }
    netvarAggregate24H?: {
        aggregates?: { end_epoch: number | string, netvar_aggregate: string }[]
    }
}

class AuthorizationError extends Error {}

// The official live-data page publishes this read-only credential in a script.
// Read it as data (never execute it), so rotations require no bot configuration.
export function createGcp2Client(request: typeof fetch = fetch) {
    let tokenCache: { expiresAt: number, promise: Promise<string> } | undefined;

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
        if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.promise;
        const promise = read('/js/data/api_token.js').then(script => {
            const token = script.match(/\bconst\s+bearer\s*=\s*(["'])([^"'\r\n]+)\1\s*;/)?.[2];
            if (!token) throw new Error('GCP 2.0 public API token was not found');
            return token;
        });
        tokenCache = { expiresAt: Date.now() + TOKEN_CACHE_MS, promise };
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

    return async function fetchSnapshot(): Promise<Gcp2Response> {
        for (let attempt = 0; ; attempt++) {
            const token = await getToken();
            const usedCache = tokenCache;
            try {
                const [currentNetvar, netvarAggregate24H] = await Promise.all([
                    json('/api/getcurrentnetvar', token),
                    json('/api/getNetVarAggregate24H', token),
                ]);
                return { currentNetvar, netvarAggregate24H };
            } catch (error) {
                if (!(error instanceof AuthorizationError)) throw error;
                if (tokenCache === usedCache) tokenCache = undefined;
                if (attempt > 0) throw error;
            }
        }
    };
}

export const fetchGcp2Snapshot = createGcp2Client();
