import { FINAL_REVIEW_STYLES } from './video-audio-review-ui.mjs';

export const MUSIC_AUDITION_PAGE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Music audition</title><style>${FINAL_REVIEW_STYLES}
main{max-width:1050px}.intro{margin-bottom:20px}.intro p{color:var(--muted)}.brief{padding:20px}.brief p{margin:8px 0 0}.listen{padding:22px}audio{display:block;width:100%;margin:8px 0 14px}.field-title small{display:block;color:var(--muted);font-weight:400}.waiting{padding:24px;margin-top:20px}button:focus-visible,textarea:focus-visible{outline:3px solid var(--blue);outline-offset:3px}#save-status{color:var(--muted)}#status{margin-left:auto}.decision{border-top:1px solid var(--line)}
</style></head><body><header><h1>Music audition</h1><span id="status" role="status">Loading…</span></header>
<main><div class="intro"><h2>Would you actually use either?</h2><p>Two composers, one scene brief. Listen for musicality, natural instruments and whether the accompaniment would suit the scene. Choosing neither is a useful result.</p></div>
<section class="card"><div class="brief"><div class="eyebrow">The shared brief</div><p id="brief"></p></div><div id="samples" class="videos"></div><div id="waiting" class="waiting">Preparing the audition…</div>
<div id="decision" class="decision" hidden><div class="field"><span class="field-title">Which would you use for this scene?<small>Judge whether it meets your quality bar, not just whether it is less bad.</small></span><div id="choices" class="choices" role="group" aria-label="Music usability"></div></div>
<div class="field"><label class="field-title" for="notes">What still sounds wrong? (optional)</label><textarea id="notes" placeholder="For example: synthetic instruments, awkward melody, too busy, or generic mood."></textarea></div>
<div class="actions"><button id="save" class="primary" disabled>Save review</button><span id="save-status" role="status"></span></div></div></section></main>
<script>
const token=new URLSearchParams(location.search).get('token')||'';
let state=null,choice=null,dirty=false,saving=false,built=false,lastPlayed=null,polling=false;
const get=id=>document.getElementById(id);
function endpoint(path){const u=new URL(path,location.origin);u.searchParams.set('token',token);return u}
async function api(path,options={}){const r=await fetch(endpoint(path),{...options,headers:{'content-type':'application/json','x-review-token':token,...options.headers}});const b=await r.json();if(!r.ok)throw Error(b.error||'Request failed');return b}
function refresh(){for(const b of get('choices').children){b.classList.toggle('active',b.dataset.choice===choice);b.setAttribute('aria-pressed',String(b.dataset.choice===choice));b.disabled=saving}get('save').disabled=!choice||saving;get('save').textContent=saving?'Saving…':'Save review';get('notes').disabled=saving}
function changed(){dirty=true;get('save-status').textContent='Unsaved';refresh()}
async function listen(label){const all=[...document.querySelectorAll('audio')],next=all.find(a=>a.dataset.label===label),previous=all.find(a=>a.dataset.label===lastPlayed);if(previous&&previous!==next&&!previous.ended)next.currentTime=Math.min(previous.currentTime,Math.max(0,(next.duration||Infinity)-.05));for(const a of all)if(a!==next)a.pause();if(next.ended)next.currentTime=0;next.muted=false;try{await next.play()}catch(e){get('save-status').textContent=e.message}}
function build(){if(built)return;built=true;get('waiting').hidden=true;get('decision').hidden=false;
 for(const clip of state.clips){const card=document.createElement('div');card.className='listen video-card';const label=document.createElement('span');label.className='label';label.textContent=clip.label;const audio=document.createElement('audio');audio.controls=true;audio.preload='metadata';audio.src=endpoint(clip.url);audio.dataset.label=clip.label;audio.setAttribute('aria-label','Music '+clip.label);audio.muted=false;audio.addEventListener('play',()=>{lastPlayed=clip.label;for(const other of document.querySelectorAll('audio'))if(other!==audio)other.pause()});const button=document.createElement('button');button.textContent='▶ Listen '+clip.label;button.dataset.play=clip.label;button.onclick=()=>listen(clip.label);card.append(label,audio,button);get('samples').append(card)}
 for(const [value,label]of [['A','Use A'],['B','Use B'],['both','Either works'],['neither','Use neither']]){const b=document.createElement('button');b.dataset.choice=value;b.textContent=label;b.onclick=()=>{choice=value;changed()};get('choices').append(b)}
 get('notes').oninput=changed;
 get('save').onclick=async()=>{saving=true;refresh();try{await api('/api/review',{method:'POST',body:JSON.stringify({fingerprint:state.fingerprint,choice,notes:get('notes').value})});dirty=false;get('save-status').textContent='Saved. Return to Codex and say “reviewed”.'}catch(e){get('save-status').textContent='Save failed: '+e.message}finally{saving=false;refresh()}};
 if(state.review){choice=state.review.choice;get('notes').value=state.review.notes;get('save-status').textContent='Review saved'}refresh();
}
async function poll(){if(polling||saving)return;polling=true;try{const incoming=await api('/api/state');if(built&&incoming.fingerprint!==state.fingerprint){get('status').textContent='The audition changed. Reload before reviewing.';return}state=incoming;get('brief').textContent=state.brief;get('status').textContent=state.status==='ready'?state.seconds+' seconds each · matched loudness':state.stage;get('waiting').textContent=state.stage;if(state.status==='ready')build()}catch(e){get('status').textContent='Could not load audition: '+e.message}finally{polling=false}}
addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue=''}});poll();setInterval(poll,5000);
</script></body></html>`;
