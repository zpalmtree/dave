import { timingSafeEqual } from 'crypto';
import { createReadStream, statSync } from 'fs';
import { IncomingMessage, ServerResponse } from 'http';

export function safeToken(actual: string, expected: string): boolean {
    if (!actual || !expected) return false;
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length
        && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function bearer(req: IncomingMessage): string {
    const header = req.headers.authorization || '';
    return header.startsWith('Bearer ') ? header.slice(7) : '';
}

export async function readJson(req: IncomingMessage, maxBytes = 256 * 1024): Promise<any> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += buffer.length;
        if (length > maxBytes) throw new Error('Request body is too large.');
        chunks.push(buffer);
    }
    if (length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': payload.length,
        'cache-control': 'no-store',
    });
    res.end(payload);
}

export async function readImageBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += buffer.length;
        if (length > maxBytes) throw new Error('The frame is too large.');
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

export function writeImage(res: ServerResponse, path: string, mimeType: string, headers: Record<string, string>): void {
    const size = statSync(path).size;
    res.writeHead(200, {
        'content-type': mimeType,
        'content-length': size,
        'cache-control': 'no-store',
        ...headers,
    });
    createReadStream(path).pipe(res);
}
