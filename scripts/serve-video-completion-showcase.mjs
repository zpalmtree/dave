// Read-only fixtures rendered by the production Discord message formatters.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { completedVideoPost, failedVideoPost, formatVideoStatusPost } from '../dist/VideoGeneration.js';

const job = { id: '1a1fe3e2-fixture', model: 'minimax', command_variant: 'oalgo',
    prompt: 'meximutt', has_source_video: true, source_kind: 'video_edit',
    created_at: 1000, completed_at: 1360, render_seconds: 165 };
const cases = [
    ['Success · direct completion reply', completedVideoPost(job)],
    ['Edge · timing unavailable', completedVideoPost({ ...job, created_at: null, completed_at: null, render_seconds: null })],
    ['Edge · delivery notice', completedVideoPost({ ...job, generation_notice: 'The GIF exceeded the upload limit; attached the MP4 instead.' })],
    ['Loading · progress message', formatVideoStatusPost({ ...job, status: 'running', worker_online: true, progress: 0.5 })],
    ['Paused · creation disabled', formatVideoStatusPost({ ...job, status: 'queued', dispatch_paused: true, worker_online: true })],
    ['Error · failed request', failedVideoPost({ ...job, error: 'The render timed out.' })],
];
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const revision = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
const fingerprint = createHash('sha256').update(readFileSync(new URL('../lib/VideoGeneration.ts', import.meta.url))).digest('hex').slice(0, 12);
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Video completion replies</title><style>
body{margin:0;background:#22252b;color:#eee;font:16px/1.5 system-ui}main{max-width:900px;margin:auto;padding:24px}h1{font-size:28px}h2{font-size:17px}article{margin:16px 0;padding:16px;background:#31343b;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin-bottom:0}.context,footer{color:#b5bdca;font-size:14px}footer{overflow-wrap:anywhere}
</style><main><h1>Video completion replies</h1><p>Production message formatter output with synthetic data. Completed videos reply to the original command, which supplies the request context.</p>
${cases.map(([title, content]) => `<article><h2>${escape(title)}</h2><div class="context">Original request: $oalgo replace the man with meximutt</div><pre>${escape(content)}</pre></article>`).join('')}
<footer>Source revision: ${escape(revision)}; formatter SHA-256: ${fingerprint}. Raw Discord Markdown shown verbatim. A completion without timing is the empty-data state. No interactive controls or media playback.</footer></main></html>`;
const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
});
server.listen(4351, '0.0.0.0', () => console.log('Video completion showcase: http://localhost:4351'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
