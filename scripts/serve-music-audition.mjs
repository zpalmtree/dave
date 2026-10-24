import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { MUSIC_AUDITION_PAGE } from './music-audition-ui.mjs';

export function validateMusicReview(state, payload) {
    if (state.status !== 'ready' || !state.fingerprint || payload?.fingerprint !== state.fingerprint) throw Error('Audition is not ready or has changed. Reload before saving.');
    if (!['A', 'B', 'both', 'neither'].includes(payload.choice)) throw Error('Choose A, B, both, or neither.');
    if (typeof payload.notes !== 'string' || payload.notes.length > 4000) throw Error('Notes must be text of at most 4000 characters.');
    if (payload.preference != null && !['A', 'B', 'tie'].includes(payload.preference)) throw Error('Musical preference must be A, B, or tie.');
    return { fingerprint: state.fingerprint, choice: payload.choice, notes: payload.notes,
        ...(state.collectPreference === true ? { preference: payload.preference ?? null } : {}), saved_at: new Date().toISOString() };
}

export async function createMusicAuditionServer({ runDirectory, auditions, collectPreference = false, port = 4344, token = randomBytes(24).toString('hex') }) {
    if (!/^[a-f0-9]{48}$/.test(token)) throw Error('Invalid review token');
    const entries = auditions ?? [{ id: 'default', title: 'Music audition', runDirectory }];
    if (!entries.length || entries.some(e => !/^[a-z0-9-]+$/.test(e.id) || !e.runDirectory || typeof e.title !== 'string') || new Set(entries.map(e => e.id)).size !== entries.length) throw Error('Invalid audition collection');
    const cases = new Map(entries.map(e => [e.id, { ...e, statePath: resolve(e.runDirectory, 'state.json'), reviewPath: resolve(e.runDirectory, 'review.json') }]));
    const load = entry => readFile(entry.statePath, 'utf8').then(JSON.parse).then(state => collectPreference ? { ...state, collectPreference: true } : state);
    const loadReview = entry => readFile(entry.reviewPath, 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    await Promise.all([...cases.values()].map(load));
    let saves = Promise.resolve();
    const headers = type => ({ 'content-type': type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
    const server = createServer(async (request, response) => {
        const send = (code, value) => { response.writeHead(code, headers('application/json')); response.end(JSON.stringify(value)); };
        try {
            const url = new URL(request.url || '/', 'http://localhost');
            if (url.pathname === '/favicon.ico') { response.writeHead(204); return response.end(); }
            if (url.searchParams.get('token') !== token) return send(403, { error: 'Use the private audition URL.' });
            const entry = cases.get(url.searchParams.get('case') ?? entries[0].id);
            if (!entry) return send(404, { error: 'Unknown audition.' });
            if (request.method === 'GET' && url.pathname === '/') { response.writeHead(200, headers('text/html; charset=utf-8')); return response.end(MUSIC_AUDITION_PAGE); }
            if (request.method === 'GET' && url.pathname === '/api/collection') {
                return send(200, { current: entry.id, auditions: await Promise.all([...cases.values()].map(async item => {
                    const [state, review] = await Promise.all([load(item), loadReview(item)]);
                    return { id: item.id, title: item.title, status: state.status, reviewed: Boolean(state.status === 'ready' && review && review.fingerprint === state.fingerprint) };
                })) });
            }
            if (request.method === 'GET' && url.pathname === '/api/state') {
                const state = await load(entry);
                const review = await loadReview(entry);
                return send(200, { status: state.status, stage: state.stage, brief: state.brief, seconds: state.seconds, fingerprint: state.fingerprint,
                    fullTracks: state.fullTracks === true,
                    collectPreference: state.collectPreference === true,
                    clips: state.status === 'ready' ? ['A', 'B'].map(label => ({ label, url: '/audio/' + label })) : [],
                    review: review?.fingerprint === state.fingerprint ? review : null });
            }
            const match = /^\/audio\/([AB])$/.exec(url.pathname);
            if (request.method === 'GET' && match) {
                const state = await load(entry);
                if (state.status !== 'ready' || !state.clips?.[match[1]]) return send(404, { error: 'Audio is not ready.' });
                const path = state.clips[match[1]], info = await stat(path);
                let start = 0, end = info.size - 1;
                if (request.headers.range) {
                    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
                    if (!range) return send(416, { error: 'Unsupported byte range.' });
                    start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end;
                    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= info.size) return send(416, { error: 'Invalid byte range.' });
                }
                response.writeHead(request.headers.range ? 206 : 200, { ...headers('audio/wav'), 'accept-ranges': 'bytes', 'content-length': end - start + 1,
                    ...(request.headers.range ? { 'content-range': `bytes ${start}-${end}/${info.size}` } : {}) });
                const stream = createReadStream(path, { start, end });
                stream.on('error', () => response.destroy());
                response.on('close', () => stream.destroy());
                return stream.pipe(response);
            }
            if (request.method === 'POST' && url.pathname === '/api/review') {
                if (request.headers['x-review-token'] !== token) return send(403, { error: 'Invalid review token.' });
                const chunks = []; let size = 0;
                for await (const chunk of request) { size += chunk.length; if (size > 20000) throw Error('Review is too large.'); chunks.push(chunk); }
                const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); let saved;
                saves = saves.catch(() => {}).then(async () => {
                    saved = validateMusicReview(await load(entry), payload);
                    const reviewPath = entry.reviewPath;
                    await writeFile(reviewPath + '.tmp', JSON.stringify(saved, null, 2)); await rename(reviewPath + '.tmp', reviewPath);
                });
                await saves; return send(200, saved);
            }
            return send(404, { error: 'Not found.' });
        } catch (e) { if (!response.headersSent) send(400, { error: e.message }); else response.destroy(); }
    });
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
    return { server, token, url: `http://localhost:${server.address().port}/?token=${token}`,
        close: () => new Promise((accept, reject) => server.close(e => e ? reject(e) : accept())) };
}
