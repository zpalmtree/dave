import { promises as dns } from 'dns';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { BlockList, isIP } from 'net';
import { Readable } from 'stream';
import fetch, { RequestInit, Response } from 'node-fetch';

const blocked = new BlockList();
for (const cidr of ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
    '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24',
    '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4']) {
    const [address, bits] = cidr.split('/'); blocked.addSubnet(address, Number(bits), 'ipv4');
}
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
    blocked.addSubnet(address, bits, 'ipv6');
}

export function isPublicMediaAddress(address: string): boolean {
    const family = isIP(address);
    return family === 4 ? !blocked.check(address, 'ipv4')
        : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function publicMediaUrl(value: string): URL | null {
    try {
        const url = new URL(value);
        const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
            || !host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
            || (!isIP(host) && !host.includes('.')) || (isIP(host) && !isPublicMediaAddress(host))) return null;
        url.hash = '';
        return url;
    } catch { return null; }
}

type Address = { address: string; family: number };
type Resolver = (hostname: string) => Promise<Address[]>;

export function discardMediaResponse(response: Response): void {
    (response.body as Readable | null)?.destroy?.();
}

function resolveAddresses(host: string, lookup: Resolver, signal: RequestInit['signal']): Promise<Address[]> {
    return new Promise((resolve, reject) => {
        const cancel = () => finish(new Error('Media request cancelled.'));
        const timer = setTimeout(() => finish(new Error('Media DNS lookup timed out.')), 10_000);
        const finish = (error: Error | null, addresses?: Address[]) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
            if (error) reject(error); else resolve(addresses!);
        };
        signal?.addEventListener('abort', cancel);
        if (signal?.aborted) { cancel(); return; }
        Promise.resolve().then(() => lookup(host)).then(value => finish(null, value), error => finish(error));
    });
}

/** Validate every redirect, then pin DNS at the actual socket connection. */
export async function fetchPublicMedia(value: string, options: RequestInit = {},
    dependencies: { fetcher?: typeof fetch; lookup?: Resolver } = {}): Promise<Response> {
    let current = value;
    const lookup = dependencies.lookup || (host => dns.lookup(host, { all: true, verbatim: true }));
    for (let hop = 0; hop <= 4; hop++) {
        if (options.signal?.aborted) throw new Error('Media request cancelled.');
        const url = publicMediaUrl(current);
        if (!url) throw new Error('Media links must use public HTTP or HTTPS addresses on standard ports.');
        const host = url.hostname.replace(/^\[|\]$/g, '');
        const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolveAddresses(host, lookup, options.signal);
        if (!addresses.length || addresses.some(value => !isPublicMediaAddress(value.address))) {
            throw new Error('Media links cannot access private or reserved network addresses.');
        }
        if (options.signal?.aborted) throw new Error('Media request cancelled.');
        // Prefer IPv4 where available; there is no second DNS lookup to rebind.
        const address = addresses.find(value => value.family === 4) || addresses[0];
        const pinnedLookup = (_host: string, settings: any, callback: any) => settings?.all
            ? callback(null, [address]) : callback(null, address.address, address.family);
        const agent = new (url.protocol === 'https:' ? HttpsAgent : HttpAgent)({ lookup: pinnedLookup as any });
        let response: Response;
        try {
            response = await (dependencies.fetcher || fetch)(url.toString(), {
                ...options, method: 'GET', body: undefined, agent, redirect: 'manual', headers: { 'user-agent': 'Dave-Media/1.0', accept: '*/*' },
            });
        } catch (error) { agent.destroy(); throw error; }
        if (typeof response.body?.once === 'function') response.body.once('close', () => agent.destroy());
        else agent.destroy();
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        discardMediaResponse(response); agent.destroy();
        const location = response.headers.get('location');
        if (!location) throw new Error('Media redirect has no destination.');
        current = new URL(location, url).toString();
    }
    throw new Error('The media link redirected too many times.');
}
