#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

import { saveJsonAtomic } from './video-cost-ab-lib.mjs';
import {
    applyFinalVideoRatings,
    finalVideoPath,
    sanitizeFinalVideoPacket,
} from './video-cost-ab-final-review.mjs';
import { FINAL_REVIEW_PAGE } from './video-cost-ab-final-review-ui.mjs';

function argument(name, fallback = null) {
    const prefix = `--${name}=`;
    const value = process.argv.find(candidate => candidate.startsWith(prefix));
    return value ? value.slice(prefix.length) : fallback;
}

function headers(type) {
    return {
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        'content-type': type,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
    };
}

function json(response, status, value) {
    response.writeHead(status, headers('application/json; charset=utf-8'));
    response.end(`${JSON.stringify(value)}\n`);
}

async function body(request) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) throw new Error('Request body is too large.');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function requestedRange(value, size) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(value || ''));
    if (!match) return null;
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end < size
        ? { start, end } : null;
}

export async function createFinalReviewServer({ runDirectory, port = 4318, readOnly = false, token: requestedToken = null }) {
    const packetPath = resolve(runDirectory, 'human-review/final-videos.json');
    sanitizeFinalVideoPacket(JSON.parse(await readFile(packetPath, 'utf8')));
    if (requestedToken !== null && !/^[a-f0-9]{48}$/.test(requestedToken)) {
        throw new Error('--token must contain exactly 48 lowercase hexadecimal characters.');
    }
    const token = requestedToken || randomBytes(24).toString('hex');
    let queue = Promise.resolve();
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url || '/', 'http://127.0.0.1');
            if (request.method === 'GET' && url.pathname === '/favicon.ico') {
                response.writeHead(204, headers('image/x-icon'));
                return response.end();
            }
            if (url.searchParams.get('token') !== token) return json(response, 403, { error: 'Use the exact private URL printed by the server.' });
            if (request.method === 'POST' && request.headers['x-review-token'] !== token) return json(response, 403, { error: 'Invalid review token.' });
            if (request.method === 'GET' && url.pathname === '/') {
                response.writeHead(200, headers('text/html; charset=utf-8'));
                return response.end(FINAL_REVIEW_PAGE);
            }
            if (request.method === 'GET' && url.pathname === '/api/final') {
                return json(response, 200, sanitizeFinalVideoPacket(JSON.parse(await readFile(packetPath, 'utf8'))));
            }
            const match = /^\/api\/final\/(v-\d+)\/video\/([AB])$/.exec(url.pathname);
            if (request.method === 'GET' && match) {
                const packet = JSON.parse(await readFile(packetPath, 'utf8'));
                const path = finalVideoPath(packet, match[1], match[2]);
                const info = await stat(path);
                const range = requestedRange(request.headers.range, info.size);
                const start = range?.start ?? 0;
                const end = range?.end ?? info.size - 1;
                response.writeHead(range ? 206 : 200, {
                    ...headers('video/mp4'),
                    'accept-ranges': 'bytes',
                    'content-length': end - start + 1,
                    ...(range ? { 'content-range': `bytes ${start}-${end}/${info.size}` } : {}),
                });
                return createReadStream(path, { start, end }).pipe(response);
            }
            if (request.method === 'POST' && url.pathname === '/api/final') {
                if (readOnly) return json(response, 403, { error: 'This review server is read-only.' });
                const payload = await body(request);
                let saved;
                queue = queue.catch(() => {}).then(async () => {
                    const current = JSON.parse(await readFile(packetPath, 'utf8'));
                    saved = applyFinalVideoRatings(current, payload);
                    await saveJsonAtomic(packetPath, saved);
                });
                await queue;
                return json(response, 200, sanitizeFinalVideoPacket(saved));
            }
            return json(response, 404, { error: 'Not found.' });
        } catch (error) {
            return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
        }
    });
    await new Promise((accept, reject) => {
        server.once('error', reject);
        server.listen(Number(port), '127.0.0.1', accept);
    });
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : Number(port);
    return {
        server,
        token,
        url: `http://localhost:${actualPort}/?token=${token}`,
        close: () => new Promise((accept, reject) => server.close(error => error ? reject(error) : accept())),
    };
}

if (process.argv[1]?.endsWith('serve-video-cost-ab-final-review.mjs')) {
    const review = await createFinalReviewServer({
        runDirectory: resolve(argument('run-dir')),
        port: Number(argument('port', '4318')),
        readOnly: process.argv.includes('--read-only'),
        token: argument('token'),
    });
    process.stdout.write(`Blinded final-video review server: ${review.url}\n`);
    const stop = async () => {
        await review.close();
        process.exit(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
}
