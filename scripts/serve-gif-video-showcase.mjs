// Fixture view of the actual bot input resolver. No Discord posts or GPU jobs.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveVideoEditRequest, videoSourcesFromMessages, videoReplacementUsesPreset,
    initialVideoRequestStatus, completedVideoAttachmentName } from '../dist/VideoGeneration.js';
import { prepareVideoDelivery, videoOutputFormatForSources } from '../dist/VideoGifDelivery.js';
import { sourceClipDescriptor } from '../dist/VideoSourceClip.js';
import { MEXIMUTT } from '../dist/VideoCharacters.js';

const gif = { url: 'https://cdn.discordapp.com/attachments/1/2/referee.gif', name: 'referee.gif', contentType: 'image/gif', size: 321 };
const portrait = { ...gif, url: gif.url.replace('.gif', '.png'), name: 'portrait.png', contentType: 'image/png' };
const message = (content = '', attachments = [], embeds = []) => ({ content, attachments: new Map(attachments.map((value, i) => [i, value])), embeds });
const prompt = 'replace the referee with meximutt';
const command = message(prompt);
const noNetwork = async () => { throw new Error('This showcase uses fixtures only.'); };
const resolve = reply => resolveVideoEditRequest(prompt, command, reply, '', MEXIMUTT, noNetwork);
const summarize = result => ({ target: result.replacement.target,
    source: sourceClipDescriptor(result.sources.clip),
    output: videoOutputFormatForSources(result.sources.clip),
    replacement: videoReplacementUsesPreset(result.replacement.prompt, MEXIMUTT) ? 'Built-in Meximutt portrait' : 'Description' });
const uploaded = summarize(await resolve(message('', [gif])));
const discordLink = summarize(await resolve(message(gif.url, [], [{
    url: gif.url, thumbnail: { url: `${gif.url}?ex=123&is=456&hm=fixture` },
}])));
const discordUnsigned = summarize(await resolve(message(gif.url)));
let multipleLinks;
try { await resolve(message(`${gif.url} ${gif.url.replace('referee.gif', 'other.gif')}`)); } catch (caught) { multipleLinks = caught.message; }
const linked = summarize(await resolve(message('https://tenor.com/view/referee-gif-123456', [], [{
    url: 'https://tenor.com/view/referee-gif-123456', video: { url: 'https://media.tenor.com/example/referee.mp4' },
}])));
const giphy = summarize(await resolve(message('https://giphy.com/gifs/referee-example', [], [{
    url: 'https://giphy.com/gifs/referee-example', video: { url: 'https://media.giphy.com/media/example/giphy.mp4' },
}])));
const empty = await resolve(message());
const image = await videoSourcesFromMessages(message('', [portrait]), message('', [gif]), true, async () => null);
const frame = await videoSourcesFromMessages(message('animate this'), message('', [gif]), false, async () => null);
let error;
try { await resolve(message('', [gif, gif])); } catch (caught) { error = caught.message; }
const temporary = mkdtempSync(join(tmpdir(), 'gif-showcase-'));
process.once('exit', () => rmSync(temporary, { recursive: true, force: true }));
execFileSync('python3', ['scripts/generate-caption-showcase.py', '--output', temporary], { timeout: 60_000 });
const captions = JSON.parse(readFileSync(join(temporary, 'caption-cases.json'), 'utf8'));
const videoPath = join(temporary, 'result.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=1.5', '-c:v', 'libx264', videoPath]);
const deliveryJob = { id: 'demo1234-fixture', model: 'minimax', output_format: 'gif', result_path: videoPath, delivery_limit_bytes: 1024 * 1024 };
const delivered = await prepareVideoDelivery(deliveryJob);
const fallback = await prepareVideoDelivery({ ...deliveryJob, delivery_limit_bytes: 1 });
const cases = [
    ['Success · pasted Discord GIF', 'A Discord image embed supplies the signed GIF download URL, even with no uploaded attachment.', discordLink],
    ['Edge · Discord link without embed', 'The direct GIF URL remains usable when Discord provides no embed.', discordUnsigned],
    ['Error · multiple GIF links', 'Different attachment links need an explicit choice of source.', multipleLinks],
    ['Success · captions stay in front', 'The installed compositor detects fixed caption glyphs and excludes them after mask expansion and feathering.', captions.success],
    ['Empty · no fixed caption', 'A plain source keeps the normal subject composite.', captions.empty],
    ['Error · caption analysis unavailable', 'The production path stops and records an error; it does not silently deliver an unprotected edit.', captions.error],
    ['Success · GIF delivery', 'A real conversion of the synthetic animation below, using the same delivery code as the bot.',
        { attachment: completedVideoAttachmentName(deliveryJob, delivered.format), format: delivered.format, bytes: statSync(delivered.path).size, loops: true }],
    ['Edge · upload limit', 'A one-byte fixture limit exercises the fallback without truncating the animation.',
        { attachment: completedVideoAttachmentName(deliveryJob, fallback.format), notice: fallback.notice }],
    ['Success · uploaded GIF', 'The full animation is selected for replacement.', uploaded],
    ['Success · Tenor reply', 'A GIF-picker embed supplies its playable clip.', linked],
    ['Success · Giphy reply', 'The same replacement path accepts Giphy media.', giphy],
    ['Success · custom portrait', 'A PNG on the command stays the replacement image; the replied GIF supplies motion.', image],
    ['Edge · new-video request', 'A request to animate uses a starting frame, preserving existing behavior.', frame],
    ['Empty · no source', 'The resolver finds no clip. The command asks for a video or GIF.', { source: empty.sources.clip }],
    ['Loading · preparation', 'Actual shared bot status formatter; no job is started in this showcase.', initialVideoRequestStatus('minimax', 'oalgo')],
    ['Error · multiple GIFs', 'An ambiguous reply asks for one clip.', error],
];
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const revision = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no']).toString().trim();
const sourceHash = createHash('sha256');
for (const file of ['GifVideo', 'VideoGeneration', 'VideoSourceClip', 'VideoSourceImage', 'VideoGifDelivery', 'VideoProtocol', 'VideoBroker']) sourceHash.update(readFileSync(new URL(`../lib/${file}.ts`, import.meta.url)));
for (const file of ['video_edit_captions.py', 'video-edit-captions.patch']) sourceHash.update(readFileSync(new URL(`../desktop/${file}`, import.meta.url)));
const fingerprint = sourceHash.digest('hex').slice(0, 12);
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GIF input and output showcase</title><style>
*{box-sizing:border-box}body{margin:0;background:#101317;color:#eef1f5;font:16px/1.6 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:40px 24px}h1{font-size:clamp(28px,5vw,44px);line-height:1.12;margin:12px 0}h2{font-size:18px;margin:0 0 8px}p{color:#bac3cf;margin:10px 0 18px}.eyebrow{color:#9cdbc8;font-size:13px;letter-spacing:.08em;text-transform:uppercase}.command{padding:18px;background:#1c252c;border-left:3px solid #9cdbc8;overflow-wrap:anywhere}code,pre{font:13px/1.65 ui-monospace,monospace}section{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:28px}article{padding:22px;border:1px solid #35414d;border-radius:8px;min-width:0}article p{font-size:14px}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:#cce4db}footer{margin-top:28px;color:#99a5b3;font-size:13px}@media(max-width:650px){main{padding:24px 16px}section{grid-template-columns:1fr}article{padding:18px}}
</style><main><div class="eyebrow">Dave · shared resolver and delivery showcase</div><h1>GIF in. GIF out.</h1>
<p>Reply to a GIF upload, pasted Discord GIF link or Tenor/Giphy message with:</p><div class="command"><code>$oalgo ${escape(prompt)}</code></div>
<p>GIF uploads, Discord GIF links and Tenor/Giphy replies receive a looping GIF. These fixtures exercise the real resolver and delivery converter without starting a model render. If conversion fails or cannot fit Discord’s upload limit, the bot attaches the MP4 and explains why.</p>
<img src="/demo.gif" width="320" height="180" style="max-width:100%;height:auto" alt="Silent looping test animation converted by the actual GIF delivery code">
<h2 style="margin-top:32px">Keep source captions above replacement characters</h2>
<p>Actual CPU compositor output from a synthetic fixture. The blue replacement crosses the caption; the letters remain in front, with the open spaces between and inside them still editable. Fixed captions are detected automatically. Moving, changing, low-confidence or multicolour text may not be detected.</p>
<section style="margin-top:12px">${[['caption-source', 'Source'], ['caption-render', 'Generated subject before compositing'], ['caption-result', 'Final shared compositor output']].map(([file, label]) => `<article><h2>${label}</h2><img src="/${file}.png" width="320" height="180" style="max-width:100%;height:auto" alt="${label}: synthetic caption occlusion fixture"></article>`).join('')}</section>
<section>${cases.map(([title, detail, value]) => `<article><h2>${escape(title)}</h2><p>${escape(detail)}</p><pre>${escape(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}</pre></article>`).join('')}</section>
<footer>Source revision: ${escape(revision)}${dirty ? ' + working changes' : ''}; feature code SHA-256: ${fingerprint}. Silent synthetic animation; no credentials, private messages, or live requests. This read-only fixture view has no disabled controls.</footer></main></html>`;
const server = createServer((request, response) => {
    if (['/caption-source.png', '/caption-render.png', '/caption-result.png'].includes(request.url)) { response.writeHead(200, { 'content-type': 'image/png' }); response.end(readFileSync(join(temporary, request.url.slice(1)))); return; }
    if (request.url === '/demo.gif') { response.writeHead(200, { 'content-type': 'image/gif' }); response.end(readFileSync(delivered.path)); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html);
});
server.listen(4347, '0.0.0.0', () => console.log('GIF input and output showcase: http://localhost:4347'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
