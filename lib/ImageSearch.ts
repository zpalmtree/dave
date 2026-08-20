import fetch from 'node-fetch';
import * as dns from 'dns';
import * as https from 'https';
import * as net from 'net';

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 3000;

type FetchImage = (url: string, options: any) => Promise<any>;

export function createPublicImageLookup(lookupAll: any = dns.lookup): any {
    return (hostname: string, options: any, callback: (...args: any[]) => void) => {
        const lookupOptions = typeof options === 'number' ? { family: options } : (options || {});

        lookupAll(hostname, { ...lookupOptions, all: true, verbatim: true }, (err: Error | null, addresses: dns.LookupAddress[]) => {
            if (err) {
                callback(err);
                return;
            }

            const address = addresses.find((candidate) => isPublicIpAddress(candidate.address));
            if (!address) {
                callback(new Error(`Refusing to fetch image from private host ${hostname}`));
                return;
            }

            if (lookupOptions.all) {
                callback(null, addresses.filter((candidate) => isPublicIpAddress(candidate.address)));
            } else {
                callback(null, address.address, address.family);
            }
        });
    };
}

const publicImageAgent = new https.Agent({
    lookup: createPublicImageLookup(),
});

export interface ImageSearchResult {
    title: string;
    link: string;
    url: string;
    displayLink: string;
    thumbnailLink?: string;
    byteSize?: number;
}

export interface DownloadedImage {
    data: Buffer;
    extension: string;
}

function getImageExtension(data: Buffer): string | undefined {
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return 'jpg';
    }
    if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'png';
    }
    if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) {
        return 'gif';
    }
    if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF'
        && data.subarray(8, 12).toString('ascii') === 'WEBP') {
        return 'webp';
    }
    if (data.length >= 2 && data.subarray(0, 2).toString('ascii') === 'BM') {
        return 'bmp';
    }

    return undefined;
}

function isHttpsUrl(value: string | undefined): value is string {
    if (!value) {
        return false;
    }

    try {
        return new URL(value).protocol === 'https:';
    } catch {
        return false;
    }
}

function isPublicIpAddress(address: string): boolean {
    const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');

    if (net.isIPv4(normalized)) {
        const [a, b] = normalized.split('.').map(Number);

        return a !== 0
            && a !== 10
            && a !== 127
            && !(a === 100 && b >= 64 && b <= 127)
            && !(a === 169 && b === 254)
            && !(a === 172 && b >= 16 && b <= 31)
            && !(a === 192 && [0, 168].includes(b))
            && !(a === 198 && [18, 19].includes(b))
            && a < 224;
    }

    if (net.isIPv6(normalized)) {
        const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
        if (mappedIpv4) {
            return isPublicIpAddress(mappedIpv4);
        }

        return normalized !== '::'
            && normalized !== '::1'
            && !normalized.startsWith('fc')
            && !normalized.startsWith('fd')
            && !/^fe[89ab]/.test(normalized)
            && !normalized.startsWith('ff')
            && !normalized.startsWith('2001:db8:');
    }

    return false;
}

function isSafeRemoteImageUrl(value: string | undefined): value is string {
    if (!isHttpsUrl(value)) {
        return false;
    }

    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
        return false;
    }

    return net.isIP(hostname) === 0 || isPublicIpAddress(hostname);
}

function discardResponse(response: any): void {
    if (typeof response?.body?.destroy === 'function') {
        response.body.destroy();
    }
}

async function fetchWithSafeRedirects(
    initialUrl: string,
    controller: AbortController,
    fetchImage: FetchImage,
): Promise<any | undefined> {
    let currentUrl = initialUrl;

    for (let redirects = 0; redirects <= 3; redirects++) {
        if (!isSafeRemoteImageUrl(currentUrl)) {
            return undefined;
        }

        const response = await fetchImage(currentUrl, {
            agent: publicImageAgent,
            headers: {
                Accept: 'image/webp,image/png,image/jpeg,image/gif,image/bmp;q=0.9,*/*;q=0.1',
                'User-Agent': 'Mozilla/5.0',
            },
            redirect: 'manual',
            signal: controller.signal,
            size: MAX_IMAGE_BYTES,
        });

        if (response.status < 300 || response.status >= 400) {
            return response;
        }

        const location = response.headers?.get?.('location');
        discardResponse(response);
        if (!location || redirects === 3) {
            return undefined;
        }

        currentUrl = new URL(location, currentUrl).toString();
    }

    return undefined;
}

export async function downloadImageForUpload(
    url: string,
    reportedByteSize?: number,
    fetchImage: FetchImage = fetch,
): Promise<DownloadedImage | undefined> {
    if (!isSafeRemoteImageUrl(url) || (reportedByteSize && reportedByteSize > MAX_IMAGE_BYTES)) {
        return undefined;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);

    try {
        const response = await fetchWithSafeRedirects(url, controller, fetchImage);

        if (!response?.ok) {
            discardResponse(response);
            return undefined;
        }

        const contentLength = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
            discardResponse(response);
            return undefined;
        }

        const data = Buffer.from(await response.buffer());
        if (data.length === 0 || data.length > MAX_IMAGE_BYTES) {
            return undefined;
        }

        const extension = getImageExtension(data);
        return extension ? { data, extension } : undefined;
    } catch {
        return undefined;
    } finally {
        clearTimeout(timeout);
    }
}

export async function downloadSearchResultImage(
    result: ImageSearchResult,
    fetchImage: FetchImage = fetch,
): Promise<DownloadedImage | undefined> {
    const original = await downloadImageForUpload(result.link, result.byteSize, fetchImage);
    if (original) {
        return original;
    }

    const proxiedUrl = getImageProxyUrl(result.link);
    if (proxiedUrl) {
        const proxied = await downloadImageForUpload(proxiedUrl, undefined, fetchImage);
        if (proxied) {
            return proxied;
        }
    }

    if (result.thumbnailLink && result.thumbnailLink !== result.link) {
        return downloadImageForUpload(result.thumbnailLink, undefined, fetchImage);
    }

    return undefined;
}

function getImageProxyUrl(originalUrl: string): string | undefined {
    if (!isSafeRemoteImageUrl(originalUrl)) {
        return undefined;
    }

    const hostname = new URL(originalUrl).hostname.toLowerCase();
    if (hostname === 'wsrv.nl' || hostname.endsWith('.weserv.nl')) {
        return undefined;
    }

    return `https://wsrv.nl/?url=${encodeURIComponent(originalUrl)}&output=webp`;
}

export function isUsableImageResult(item: any): boolean {
    return isHttpsUrl(item?.link)
        && isHttpsUrl(item?.image?.thumbnailLink)
        && (item?.mime?.startsWith('image/') || getImageExtensionFromUrl(item.link));
}

function getImageExtensionFromUrl(url: string): boolean {
    try {
        const pathname = new URL(url).pathname.toLowerCase();
        return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']
            .some((extension) => pathname.endsWith(`.${extension}`));
    } catch {
        return false;
    }
}
