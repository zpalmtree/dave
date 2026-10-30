import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createCanvas } from 'canvas';
import { createVideoEditStill } from '../dist/VideoKeyframeProvider.js';
import { config } from '../dist/Config.js';
import { initialVideoRequestStatus, failedVideoPost } from '../dist/VideoGeneration.js';

// Exercise the actual editor orchestration with provider fixtures. Never call a live API.
const image = {bytes: createCanvas(160, 90).toBuffer('image/png'), mimeType: 'image/png'};
const rejected = [400, {error: {code: 'moderation_blocked', message: 'The image editor declined this request.'}}];
const primary = [200, {data: [{b64_json: image.bytes.toString('base64')}]}];
const alternate = [200, {candidates: [{content: {parts: [{inlineData: {mimeType:'image/png', data:image.bytes.toString('base64')}}]}}], usageMetadata: {promptTokenCount:20}}];
const job = {id:'fixture1-demo', model:'minimax', command_variant:'oalgo', prompt:'replace the cartoon character with the attached mascot'};
async function run(respond, enabled = true, cancelled = false) {
    const previousFetch = globalThis.fetch, key = config.geminiApiKey;
    const attempts = [];
    const controller = new AbortController();
    if (cancelled) controller.abort();
    config.geminiApiKey = enabled ? 'fixture-key' : '';
    globalThis.fetch = async (input) => {
        const provider = String(input).includes('api.openai.com') ? 'openai' : 'gemini';
        const [status, body] = respond(provider);
        return new Response(JSON.stringify(body), {status, headers:{'content-type':'application/json'}});
    };
    try {
        const result = await createVideoEditStill(image, image, 'the cartoon character', 'the attached mascot', {
            abortSignal:controller.signal, onAttempt: value => attempts.push(`${value.provider}: ${value.outcome}`),
        });
        return {message:'Replacement frame prepared. Pose and identity review comes next.', editor:result.provider, attempts};
    } catch (error) {
        return {message: cancelled ? 'Cancelled before contacting an editor.' : failedVideoPost({...job, error:error.message}), attempts};
    } finally {
        globalThis.fetch = previousFetch;
        config.geminiApiKey = key;
    }
}
const cases = [
    ['loading', 'Preparing the replacement', {message:initialVideoRequestStatus('minimax','oalgo')}],
    ['primary', 'Success · preferred editor', await run(() => primary)],
    ['fallback', 'Success · alternate editor', await run(provider => provider === 'openai' ? rejected : alternate)],
    ['outage', 'Edge · preferred editor unavailable', await run(provider => provider === 'openai' ? [503,{error:{message:'Service unavailable'}}] : alternate)],
    ['empty', 'Empty · alternate editor returns no image', await run(provider => provider === 'openai' ? rejected : [200,{candidates:[]}])],
    ['error', 'Error · both editors decline', await run(provider => provider === 'openai' ? rejected : [200,{promptFeedback:{blockReason:'SAFETY'}}])],
    ['disabled', 'Disabled · alternate editor not configured', await run(() => rejected, false)],
    ['cancelled', 'Edge · cancellation', await run(() => primary, true, true)],
    ['usable', 'Success · usable imperfect still', {message:'A recognizable, coherent replacement may proceed with a different expression, hand gesture or clothing. Source-driven animation and its separate motion review come next.'}],
    ['source-recovery', 'Recovery · target leaves and re-enters', {message:'If source tracking fails, the worker retries the same target backward. If that track is fragmented, it tracks outward from one stable target mask. Recovered tracks must pass the existing checks; frames without the target keep the source footage.'}],
    ['source-error', 'Error · source target still cannot be tracked', {message:failedVideoPost({...job, error:'Could not reliably isolate the target: no stable recovery seed.'})}],
    ['motion-retry', 'Recovery · animation loses its track', {message:'If the generated character cannot be tracked, the worker retries that segment once with the alternate local motion model, using the same accepted still and source motion. Lost alternate tracks get frame-by-frame spatial segmentation. The finished animation must still pass review.'}],
    ['mask-recovery', 'Recovery · background selected instead of subject', {message:'If replacement tracking selects the surrounding background, the worker retries segmentation once using points inside the source subject. It reuses the generated animation. The corrected masks must cover the subject throughout the segment.'}],
    ['colour-protection', 'Success · subject remains opaque', {message:'Background colour correction leaves both subject silhouettes untouched. An invalid background track clears correction history instead of painting across the replacement. The rebuilt video still requires motion review.'}],
    ['motion-error', 'Error · animation recovery fails', {message:failedVideoPost({...job, error:'Animation was generated, but the replacement could not be isolated for compositing (selected pixels 7.18%; usable tracking in 15% of frames). No finished video was produced.'})}],
    ['quality', 'Error · wrong replacement identity', {message:failedVideoPost({...job, error:'Replacement pose/identity check failed: The reference identity is missing.'})}],
];
const revision = execFileSync('git',['rev-parse','--short','HEAD']).toString().trim();
const fingerprint = createHash('sha256').update(readFileSync(new URL('../lib/VideoKeyframeProvider.ts',import.meta.url))).update(readFileSync(new URL('../lib/VideoBroker.ts',import.meta.url))).update(readFileSync(new URL('../lib/VideoEditReview.ts',import.meta.url))).update(readFileSync(new URL('../desktop/video-edit-recovery.patch',import.meta.url))).update(readFileSync(new URL('../desktop/video_edit_source_recovery.py',import.meta.url))).update(readFileSync(new URL('../desktop/video-edit-source-recovery.patch',import.meta.url))).update(readFileSync(new URL('../desktop/video_edit_alignment.py',import.meta.url))).digest('hex').slice(0,12);
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Replacement editor fallback showcase</title>
<style>*{box-sizing:border-box}body{margin:0;background:#101317;color:#eef1f5;font:16px/1.6 system-ui,sans-serif}main{max-width:1080px;margin:auto;padding:32px 24px}h1{font-size:clamp(28px,5vw,40px);line-height:1.15}h2{font-size:18px;margin:0 0 12px}p{color:#bac3cf}section{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:24px 0}article{border:1px solid #35414d;border-radius:8px;padding:20px;min-width:0}pre{font:14px/1.6 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;color:#cce4db}.trace,footer{font-size:13px;color:#99a5b3}.tag{color:#9cdbc8;font-size:13px}nav{display:flex;flex-wrap:wrap;gap:12px}a{color:#9cdbc8}@media(max-width:650px){main{padding:24px 16px}section{grid-template-columns:1fr}}</style>
<main><div class="tag">Dave · replacement editor showcase</div><h1>Another editor when the first cannot finish.</h1>
<p>The bot preserves the original source and replacement images when trying Gemini. Every alternate frame must pass a usability check before animation. Recognizable, coherent replacements can proceed despite expression or gesture differences; the finished animation gets a separate motion review.</p>
<p>These fixtures run the real editor routing and shared bot message formatters. Provider replies are simulated; no image quality or finished video is claimed.</p>
<nav>${cases.map(([id])=>`<a href="#${id}">${id}</a>`).join('')}</nav>
<section>${cases.map(([id,title,result])=>`<article id="${id}"><h2>${escape(title)}</h2><pre>${escape(result.message)}</pre>${result.editor ? `<p>Editor: ${escape(result.editor)}</p>`:''}${result.attempts ? `<p class="trace">${escape(result.attempts.join(' → ') || 'No provider requests')}</p>`:''}</article>`).join('')}</section>
<footer>Revision ${escape(revision)} · feature SHA-256 ${fingerprint}. Synthetic fixtures only; no private job data, API keys, or live requests. No interactive or audio controls.</footer></main></html>`;
const server = createServer((_request,response)=>{response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end(html);});
server.listen(4348,'0.0.0.0',()=>console.log('Replacement editor showcase: http://localhost:4348'));
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>server.close());
