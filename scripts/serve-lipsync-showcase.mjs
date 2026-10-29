import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const directory = fileURLToPath(new URL('../artifacts/isolated-lipsync/showcase/', import.meta.url));
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const names = ['source', 'before', 'after'];
const labels = ['Original performance', 'Delivered replacement', 'Candidate replacement'];
const html = (fixture = '') => {
  const report = existsSync(join(directory, 'report.json')) ? JSON.parse(readFileSync(join(directory, 'report.json'))) : {};
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Silent mouth-motion comparison</title><link rel="icon" href="data:,"><style>
*{box-sizing:border-box}body{margin:0;background:#131820;color:#f0f3f8;font:16px/1.5 system-ui}main{max-width:1280px;margin:auto;padding:28px 20px}h1{font-size:32px;line-height:1.15}h2{font-size:18px}p,small{color:#b9c4d4}section{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}article{border:1px solid #42516a;border-radius:10px;padding:16px;min-width:0}video{width:100%;background:#080b10}button{font:inherit;padding:10px 16px;background:#c9e2ff;color:#12223a;border:0;border-radius:6px;cursor:pointer}button:disabled{opacity:.4;cursor:default}button:focus-visible,input:focus-visible{outline:3px solid #fff;outline-offset:3px}.controls{display:flex;gap:16px;align-items:center;margin:24px 0;flex-wrap:wrap}input{flex:1;min-width:160px}small{display:block;overflow-wrap:anywhere}.status{font-size:14px}@media(max-width:650px){section{grid-template-columns:1fr}h1{font-size:26px}}
</style><main><h1>Preserving the silent performance</h1><p>The source has no soundtrack. Compare mouth shapes and timing, frame by frame. ${escape(report.summary || 'Candidate evaluation in progress.')}</p>
<div class="controls"><button id="play" disabled>Play together</button><label for="seek">Frame</label><input id="seek" type="range" min="0" max="71" value="0" step="1" aria-label="Video frame"><output id="frame">0 / 71</output></div>
<section>${names.map((name,i)=>`<article><h2>${labels[i]}</h2>${fixture !== 'empty' && existsSync(join(directory,name+'.mp4'))?`<video muted playsinline preload="auto" src="/${fixture === 'error' ? 'missing-' : ''}${name}.mp4${fixture === 'loading' ? '?loading=1' : ''}"></video><p class="status" aria-live="polite">Loading…</p>`:'<p class="status">No comparison video available.</p>'}</article>`).join('')}</section>
<p>${escape(report.evidence || 'The original delivery is retained for comparison.')}</p><small>${escape(report.revision || '')}</small></main><script>
const videos=[...document.querySelectorAll('video')],button=document.querySelector('#play'),seek=document.querySelector('#seek'),frame=document.querySelector('#frame');
const ready=()=>button.disabled=!videos.length||!videos.every(v=>v.readyState>=2);
videos.forEach(v=>{v.muted=true;v.addEventListener('loadeddata',()=>{v.nextElementSibling.textContent=v.videoWidth+' × '+v.videoHeight+' · '+v.duration.toFixed(2)+' seconds';ready()});v.addEventListener('error',()=>{v.nextElementSibling.textContent='Video unavailable. Regenerate the comparison asset.';button.disabled=true})});
button.onclick=()=>{videos.forEach(v=>{v.muted=true;v.currentTime=0;v.play().catch(()=>{})})};
seek.oninput=()=>{frame.value=seek.value+' / 71';videos.forEach(v=>{v.pause();v.currentTime=Number(seek.value)/24})};
</script></html>`;
};
createServer((request,response)=>{
  const url = new URL(request.url, 'http://localhost');
  if(url.pathname==='/'){response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});response.end(html(url.searchParams.get('case')));return;}
  if(!names.some(name=>url.pathname===`/${name}.mp4`)){response.writeHead(404);response.end();return;}
  const send = () => {
  try {
    const data=readFileSync(join(directory,url.pathname.slice(1)));
    const range=/^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),data.length-1):data.length-1;
    if(start>end||start>=data.length){response.writeHead(416,{'content-range':`bytes */${data.length}`});response.end();return;}
    response.writeHead(range?206:200,{'content-type':'video/mp4','accept-ranges':'bytes','cache-control':'no-store','content-length':end-start+1,
      ...(range?{'content-range':`bytes ${start}-${end}/${data.length}`}:{})});
    response.end(data.subarray(start,end+1));
  } catch {response.writeHead(404);response.end();}
  };
  if(url.searchParams.has('loading')) {
    const timer=setTimeout(send,10000);
    response.on('close',()=>clearTimeout(timer));
  } else send();
}).listen(4364,'0.0.0.0',()=>console.log('Mouth-motion showcase: http://localhost:4364'));
