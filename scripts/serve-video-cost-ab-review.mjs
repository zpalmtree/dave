#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { saveJsonAtomic } from './video-cost-ab-lib.mjs';
import {
    applyPlannerRatings,
    applyReviewerRatings,
    reviewProgress,
    reviewerImagePath,
    sanitizePlannerPacket,
    sanitizeReviewerPacket,
} from './video-cost-ab-review.mjs';
import { REVIEW_PAGE } from './video-cost-ab-review-ui.mjs';

const MAX_BODY_BYTES = 1024 * 1024;

function argument(name, fallback = null) {
    const prefix = `--${name}=`;
    const entry = process.argv.find(value => value.startsWith(prefix));
    return entry ? entry.slice(prefix.length) : fallback;
}

function flag(name) {
    return process.argv.includes(`--${name}`);
}

function securityHeaders(contentType) {
    return {
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        'content-type': contentType,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
    };
}

function json(response, status, body) {
    response.writeHead(status, securityHeaders('application/json; charset=utf-8'));
    response.end(`${JSON.stringify(body)}\n`);
}

function textResponse(response, status, body, contentType = 'text/plain; charset=utf-8') {
    response.writeHead(status, securityHeaders(contentType));
    response.end(body);
}

async function readJson(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new Error('Request body is too large.');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function loadPacket(path) {
    return JSON.parse(await readFile(path, 'utf8'));
}

function imageContentType(path) {
    return ({
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.webp': 'image/webp', '.gif': 'image/gif',
    })[extname(path).toLowerCase()] || 'application/octet-stream';
}

export async function createReviewServer({ runDirectory, port = 4317, readOnly = false }) {
    if (!runDirectory) throw new Error('--run-dir is required.');
    const directory = resolve(runDirectory);
    const reviewerPath = resolve(directory, 'human-review', 'reviewer.json');
    const plannerPath = resolve(directory, 'human-review', 'planner.json');
    const initialReviewer = await loadPacket(reviewerPath);
    const initialPlanner = await loadPacket(plannerPath);
    sanitizeReviewerPacket(initialReviewer);
    sanitizePlannerPacket(initialPlanner);
    const token = randomBytes(24).toString('hex');
    let saveQueue = Promise.resolve();

    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url || '/', 'http://127.0.0.1');
            if (request.method === 'GET' && url.pathname === '/favicon.ico') {
                response.writeHead(204, securityHeaders('image/x-icon'));
                return response.end();
            }
            const authorized = url.searchParams.get('token') === token;
            if (!authorized) return json(response, 403, { error: 'Open the exact private review URL printed by the server.' });
            if (request.method === 'POST' && request.headers['x-review-token'] !== token) {
                return json(response, 403, { error: 'Invalid review token.' });
            }

            if (request.method === 'GET' && url.pathname === '/') {
                return textResponse(response, 200, REVIEW_PAGE, 'text/html; charset=utf-8');
            }
            if (request.method === 'GET' && url.pathname === '/api/status') {
                const [reviewer, planner] = await Promise.all([loadPacket(reviewerPath), loadPacket(plannerPath)]);
                return json(response, 200, {
                    read_only: readOnly,
                    reviewer: reviewProgress(reviewer, 'reviewer'),
                    planner: reviewProgress(planner, 'planner'),
                });
            }
            if (request.method === 'GET' && url.pathname === '/api/reviewer') {
                return json(response, 200, sanitizeReviewerPacket(await loadPacket(reviewerPath)));
            }
            if (request.method === 'GET' && url.pathname === '/api/planner') {
                return json(response, 200, sanitizePlannerPacket(await loadPacket(plannerPath)));
            }

            const imageMatch = /^\/api\/reviewer\/(r-\d+)\/image$/.exec(url.pathname);
            if (request.method === 'GET' && imageMatch) {
                const packet = await loadPacket(reviewerPath);
                const imagePath = reviewerImagePath(packet, imageMatch[1]);
                const info = await stat(imagePath);
                response.writeHead(200, {
                    ...securityHeaders(imageContentType(imagePath)),
                    'content-length': info.size,
                });
                return createReadStream(imagePath).pipe(response);
            }

            if (request.method === 'POST' && ['/api/reviewer', '/api/planner'].includes(url.pathname)) {
                if (readOnly) return json(response, 403, { error: 'This review server is read-only.' });
                const payload = await readJson(request);
                const kind = url.pathname.endsWith('reviewer') ? 'reviewer' : 'planner';
                const path = kind === 'reviewer' ? reviewerPath : plannerPath;
                const apply = kind === 'reviewer' ? applyReviewerRatings : applyPlannerRatings;
                let saved;
                saveQueue = saveQueue.catch(() => {}).then(async () => {
                    const current = await loadPacket(path);
                    saved = apply(current, payload);
                    await saveJsonAtomic(path, saved);
                });
                await saveQueue;
                return json(response, 200, kind === 'reviewer'
                    ? sanitizeReviewerPacket(saved)
                    : sanitizePlannerPacket(saved));
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
        directory,
        token,
        url: `http://localhost:${actualPort}/?token=${token}`,
        close: () => new Promise((accept, reject) => server.close(error => error ? reject(error) : accept())),
    };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    const runDirectory = argument('run-dir');
    const reviewServer = await createReviewServer({
        runDirectory,
        port: Number(argument('port', 4317)),
        readOnly: flag('read-only'),
    });
    process.stdout.write(`Blinded review server: ${reviewServer.url}\n`);
    process.stdout.write(`Run directory: ${reviewServer.directory}\n`);
    process.stdout.write(`Mode: ${flag('read-only') ? 'read-only' : 'writable'}\n`);
    const stop = async () => {
        await reviewServer.close();
        process.exit(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
}
