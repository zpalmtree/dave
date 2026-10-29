import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const directory = fileURLToPath(new URL('../artifacts/shot-blend/showcase/', import.meta.url));
const report = JSON.parse(readFileSync(join(directory, 'cases.json'), 'utf8'));
const labels = {
  'hard-cut': ['Before · hard cut', 'The original splice, with blending disabled.'],
  'short-blend': ['Default · ¼-second blend', 'Six frames blend the outgoing and incoming shots; audio overlaps by the same amount.'],
  'planned-dissolve': ['Intentional · ½-second dissolve', 'The longer transition remains available when the screenplay requests it.'],
  continuation: ['Edge · continuous action', 'Continuations keep every frame and their original timing.'],
  'song-timeline': ['Edge · fixed song timeline', 'External soundtrack timing remains intact, without overlap.'],
  single: ['Disabled · one shot', 'There is no shot boundary to blend.'],
};
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shot blend comparison</title><link rel="icon" href="data:,"><style>
*{box-sizing:border-box}body{margin:0;background:#131820;color:#f0f3f8;font:16px/1.5 system-ui}main{max-width:1100px;margin:auto;padding:32px 20px}h1{font-size:36px;line-height:1.1}h2{font-size:20px}p{color:#b9c4d4}section{display:grid;grid-template-columns:1fr 1fr;gap:20px}article{border:1px solid #42516a;border-radius:12px;padding:18px;min-width:0}video{width:100%;background:#080b10}button{font:inherit;padding:10px 16px;background:#c9e2ff;color:#12223a;border:0;border-radius:6px;margin-bottom:24px}small{color:#b9c4d4;overflow-wrap:anywhere}@media(max-width:650px){section{grid-template-columns:1fr}h1{font-size:28px}}
</style><main><h1>Softer changes between shots</h1><p>Actual output from Dave’s installed assembler, using public color fixtures. Playback starts muted. Each input shot lasts two seconds.</p>
<button id="replay">Replay comparisons together</button><section>${report.cases.map(({name,seconds}) => `<article><h2>${labels[name][0]}</h2><p>${labels[name][1]} Output: ${seconds.toFixed(2)} seconds.</p><video controls muted playsinline preload="metadata" ${name === 'single' ? '' : `poster="/${name}.png"`} src="/${name}.mp4"></video></article>`).join('')}
<article><h2>Empty / error · no clips</h2><p>The assembler rejects an empty sequence before rendering.</p><small>${escape(report.empty_error)}</small></article>
</section><p>Loading uses the browser’s native video controls; no model render is started by this page.</p><small>Installed assembler SHA-256: ${escape(report.source_sha256)}</small></main>
<script>document.querySelector('#replay').onclick=()=>{for(const video of document.querySelectorAll('video')){video.muted=true;video.currentTime=0;video.play().catch(()=>{});}};</script></html>`;
const media = new Set(report.cases.flatMap(({name}) => [`/${name}.mp4`, `/${name}.png`]));
createServer((request, response) => {
  if (request.url === '/') { response.writeHead(200, {'content-type':'text/html; charset=utf-8'}); response.end(html); return; }
  if (!media.has(request.url)) { response.writeHead(404); response.end(); return; }
  try {
    const data = readFileSync(join(directory, request.url.slice(1)));
    response.writeHead(200, {'content-type':request.url.endsWith('.mp4') ? 'video/mp4' : 'image/png', 'content-length':data.length});
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
}).listen(4348, '0.0.0.0', () => console.log('Shot blend showcase: http://localhost:4348'));
