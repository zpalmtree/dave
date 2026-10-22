export const FINAL_REVIEW_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Audio comparison</title>
<style>
:root{color-scheme:dark;--bg:#090a0c;--panel:#15181e;--panel2:#1c2129;--text:#f6f7f9;--muted:#9fa9b8;--line:#313844;--blue:#75a9ff;--green:#60d8a2;--red:#ff7d85;--amber:#ffc76e}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,"Segoe UI",sans-serif}button,textarea,input{font:inherit;color:inherit}header{position:sticky;top:0;z-index:5;display:flex;gap:18px;align-items:center;padding:14px 22px;background:#090a0cf2;border-bottom:1px solid var(--line)}h1{font-size:17px;margin:0}.private{margin-left:auto;color:var(--green);font-size:12px}main{max-width:1500px;margin:auto;padding:22px}.progress{height:6px;background:#242a33;border-radius:8px;overflow:hidden;margin:0 0 18px}.bar{height:100%;background:linear-gradient(90deg,var(--blue),var(--green))}.nav,.choices,.actions,.sync{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.nav{justify-content:space-between;margin-bottom:16px}button{border:1px solid var(--line);background:var(--panel);padding:9px 14px;border-radius:10px;cursor:pointer}button:hover:not(:disabled){border-color:#697484;background:#222833}button:disabled{opacity:.4;cursor:not-allowed}button.active{border-color:var(--blue);background:#1a3458}button.bad.active{border-color:var(--red);background:#4a2026}button.primary{background:#265795;border-color:var(--blue);font-weight:700}.card{border:1px solid var(--line);border-radius:16px;background:var(--panel);overflow:hidden}.prompt{padding:17px 20px;background:var(--panel2);border-bottom:1px solid var(--line);font-size:18px;font-weight:650}.eyebrow{font-size:11px;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;margin-bottom:4px}.videos{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line)}.video-card{padding:14px;background:#0d0f13}.label{display:inline-grid;place-items:center;width:32px;height:32px;border-radius:50%;background:#263145;color:var(--blue);font-weight:800;margin-bottom:10px}video{display:block;width:100%;aspect-ratio:16/9;background:#000;border-radius:9px}.sync{justify-content:center;padding:13px;background:#101319;border-top:1px solid var(--line)}.decision{padding:20px}.field{margin:0 0 18px}.field-title{display:block;font-weight:650;margin-bottom:8px}.scores{display:grid;grid-template-columns:1fr 1fr;gap:14px}.score{display:flex;align-items:center;gap:9px}.score input{width:78px;background:#0e1116;border:1px solid var(--line);border-radius:9px;padding:8px}textarea{width:100%;min-height:70px;background:#0e1116;border:1px solid var(--line);border-radius:9px;padding:9px}.hint,.position,#status{color:var(--muted);font-size:13px}.complete{margin-top:18px;border:1px solid #2b654c;background:#0e2c21;color:#bef3db;padding:16px;border-radius:12px;text-align:center}@media(max-width:850px){.videos,.scores{grid-template-columns:1fr}.private{display:none}main{padding:12px}}
</style></head><body><header><h1>Audio comparison</h1><span class="private">Identical visuals · audio only</span><span id="status">Loading…</span></header><main id="app"></main>
<script>
const token=new URLSearchParams(location.search).get('token')||'',app=document.querySelector('#app'),statusNode=document.querySelector('#status');let packet=null,index=0,dirty=false,saving=false;
function endpoint(path){const u=new URL(path,location.origin);u.searchParams.set('token',token);return u}
async function api(path,options={}){const r=await fetch(endpoint(path),{...options,headers:{'content-type':'application/json','x-review-token':token,...(options.headers||{})}}),b=await r.json().catch(()=>({}));if(!r.ok)throw Error(b.error||('Request failed '+r.status));return b}
function el(tag,attrs={},children=[]){const n=document.createElement(tag);for(const[k,v]of Object.entries(attrs)){if(k==='class')n.className=v;else if(k==='text')n.textContent=v;else if(k==='onclick')n.onclick=v;else if(k==='disabled')n.disabled=!!v;else n.setAttribute(k,v)}for(const c of[].concat(children))if(c!=null)n.append(c.nodeType?c:document.createTextNode(String(c)));return n}
function validScore(value){if(value===null||value===undefined||value==='')return false;const number=Number(value);return Number.isFinite(number)&&number>=1&&number<=10}function complete(p){return['A','B','tie'].includes(p.preferred)&&['A','B'].every(l=>validScore(p.overall[l]))}function progress(){return{done:packet.pairs.filter(complete).length,total:packet.pairs.length}}function choose(text,on,set,tone=''){return el('button',{class:(on?'active ':'')+tone,'aria-pressed':String(!!on),onclick:set,text})}function changed(){dirty=true;statusNode.textContent='Unsaved';render()}
function mergePacket(incoming){
  const existing=new Map((packet?.pairs||[]).map(pair=>[pair.public_id,pair]));
  incoming.pairs=incoming.pairs.map(pair=>{
    const retained=existing.get(pair.public_id);
    return retained?Object.assign(retained,pair):pair;
  });
  packet=incoming;
}
function refreshControls(){
  const pair=packet.pairs[index],p=progress();
  const groups=document.querySelectorAll('.decision .choices');
  [[groups[0],['A','B','tie'],label=>pair.preferred===label],
   [groups[1],['A','B'],label=>pair.material_failure[label]]].forEach(([group,labels,selected])=>{
    group?.querySelectorAll('button').forEach((button,i)=>{
      const active=!!selected(labels[i]);
      button.classList.toggle('active',active);
      button.setAttribute('aria-pressed',String(active));
    });
  });
  document.querySelector('.bar').style.width=(p.total?p.done/p.total*100:100)+'%';
  document.querySelector('.position').textContent='Pair '+(index+1)+' of '+p.total+' ready (4 planned) · '+p.done+' complete';
  const nav=document.querySelectorAll('.nav button');
  nav[0].disabled=index===0;nav[1].disabled=index===p.total-1;
  const save=document.querySelector('[data-save]');
  save.textContent=saving?'Saving…':'Save & next';
  refreshReadiness();
  let notice=document.querySelector('.complete');
  if(p.done===p.total&&p.total===4&&!dirty){
    if(!notice)app.append(el('div',{class:'complete',text:'All paired-video decisions are saved. Return to Codex and say “video review complete”.'}));
  }else notice?.remove();
}

function videoCard(pair,label){const item=pair.videos.find(v=>v.label===label),video=el('video',{src:endpoint(item.video_url),controls:'',preload:'metadata','data-label':label});video.muted=true;video.addEventListener('volumechange',()=>{if(!video.muted){for(const other of document.querySelectorAll('video'))if(other!==video)other.muted=true;refreshListening()}});return el('div',{class:'video-card'},[el('span',{class:'label',text:label}),video])}
function refreshListening(){for(const b of document.querySelectorAll('[data-listen]')){const selected=[...document.querySelectorAll('video')].some(v=>v.dataset.label===b.dataset.listen&&!v.muted);b.classList.toggle('active',selected);b.setAttribute('aria-pressed',String(selected))}}
let playbackAction=0;
async function syncVideos(action){
 const version=++playbackAction,videos=[...document.querySelectorAll('video')];if(!videos.length)return;
 if(action==='pause'){for(const v of videos)v.pause();return}
 const master=videos.find(v=>!v.muted)||videos.find(v=>!v.paused)||videos[0];
 // Mute both before switching, including while metadata/seeking is pending.
 for(const v of videos)v.muted=true;refreshListening();
 try{
  await Promise.all(videos.map(v=>v.readyState?Promise.resolve():new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(Error('Video is still loading. Try again.'))},10000);const loaded=()=>{cleanup();resolve()};const failed=()=>{cleanup();reject(Error('Video failed to load'))};function cleanup(){clearTimeout(timer);v.removeEventListener('loadedmetadata',loaded);v.removeEventListener('error',failed)}v.addEventListener('loadedmetadata',loaded);v.addEventListener('error',failed)})));
  if(version!==playbackAction||!master.isConnected)return;
  const t=master.ended?0:master.currentTime;
  for(const v of videos){if(Math.abs(v.currentTime-t)>.03)v.currentTime=t;v.muted=v.dataset.label!==action}
  refreshListening();await Promise.all(videos.map(v=>v.play()));
 }catch(e){statusNode.textContent=e.message}
}
function refreshReadiness(){const pair=packet?.pairs[index],ready=pair&&complete(pair),save=document.querySelector('[data-save]'),hint=document.querySelector('#readiness');if(save)save.disabled=!ready||saving;if(hint)hint.textContent=ready?'Ready to save':'Choose a preference and score both videos'}
function score(pair,label){const input=el('input',{type:'number',min:'1',max:'10',step:'0.5','aria-label':'Overall score '+label});input.value=pair.overall[label]??'';input.oninput=()=>{const v=input.value===''?null:Number(input.value);pair.overall[label]=v;dirty=true;statusNode.textContent='Unsaved';refreshReadiness()};return el('label',{class:'score'},[el('span',{text:'Video '+label+' audio quality (1–10)'}),input])}
function payload(){return{fingerprint:packet.fingerprint,pairs:packet.pairs.map(p=>({public_id:p.public_id,preferred:p.preferred,overall:p.overall,material_failure:p.material_failure,notes:p.notes}))}}
async function saveNext(){saving=true;render();try{mergePacket(await api('/api/final',{method:'POST',body:JSON.stringify(payload())}));dirty=false;statusNode.textContent='Saved locally';const next=packet.pairs.findIndex((p,i)=>i>index&&!complete(p)),any=packet.pairs.findIndex(p=>!complete(p));index=next>=0?next:any>=0?any:index}catch(e){statusNode.textContent='Save failed';alert(e.message)}finally{saving=false;render()}}
setInterval(async()=>{if(saving)return;try{const next=await api('/api/final');if(!saving&&packet&&next.pairs.length>packet.pairs.length){next.pairs=packet.pairs.concat(next.pairs.slice(packet.pairs.length));mergePacket(next);render();}}catch{}},15000);
function render(){if(!packet)return;if(!packet.pairs.length){app.replaceChildren(el('div',{class:'card',style:'padding:28px',text:'Four fixed-footage comparisons: three real requests and the leaf regression. Preparing audio mixes. Completed pairs will appear here automatically. You can leave this page open or return later.'}));statusNode.textContent='Waiting for first pair';return;}const pair=packet.pairs[index],p=progress();if(app.dataset.pairId===pair.public_id&&app.querySelector('.videos')){refreshControls();return;}app.dataset.pairId=pair.public_id;app.replaceChildren(el('div',{class:'progress'},el('div',{class:'bar',style:'width:'+(p.total?p.done/p.total*100:100)+'%'})),el('div',{class:'nav'},[el('button',{disabled:index===0,onclick:()=>{index--;render()},text:'← Previous'}),el('span',{class:'position',text:'Pair '+(index+1)+' of '+p.total+' ready (4 planned) · '+p.done+' complete'}),el('button',{disabled:index===p.total-1,onclick:()=>{index++;render()},text:'Next →'})]));
const preference=el('div',{class:'choices'},['A','B','tie'].map(l=>choose(l==='tie'?'Tie':'Video '+l,pair.preferred===l,()=>{pair.preferred=l;changed()})));const failures=el('div',{class:'choices'},['A','B'].map(l=>choose('Clear audio failure in '+l,pair.material_failure[l],()=>{pair.material_failure[l]=!pair.material_failure[l];changed()},'bad')));const notes=el('textarea',{placeholder:'Does the music help? Are effects proportionate and words clear? Note distracting sounds, unwanted vocals or music seams, with a time.'});notes.value=pair.notes||'';notes.oninput=()=>{pair.notes=notes.value;dirty=true;statusNode.textContent='Unsaved'};
const card=el('div',{class:'card'},[el('div',{class:'prompt'},[el('div',{class:'eyebrow',text:'Original request'}),pair.prompt]),el('div',{class:'videos'},[videoCard(pair,'A'),videoCard(pair,'B')]),el('div',{class:'sync'},[...['A','B'].map(l=>el('button',{'data-listen':l,'aria-pressed':'false',onclick:()=>syncVideos(l),text:'▶ Listen '+l})),el('button',{onclick:()=>syncVideos('pause'),text:'Pause both'}),el('span',{class:'hint',text:'Switch A/B at the same moment. Only one soundtrack plays. Ratings keep playback running.'})]),el('div',{class:'decision'},[el('div',{class:'field'},[el('span',{class:'field-title',text:'Which sounds better?'}),preference]),el('div',{class:'field scores'},[score(pair,'A'),score(pair,'B')]),el('div',{class:'field'},[el('span',{class:'field-title',text:'Clipping, obscured speech or other clear audio failure?'}),failures]),el('div',{class:'field'},[el('span',{class:'field-title',text:'Notes (optional)'}),notes]),el('div',{class:'actions'},[el('button',{class:'primary','data-save':'',disabled:!complete(pair)||saving,onclick:saveNext,text:saving?'Saving…':'Save & next'}),el('span',{id:'readiness',class:'hint',text:complete(pair)?'Ready to save':'Choose a preference and score both videos'})])])]);app.append(card);if(p.done===p.total&&p.total===4&&!dirty)app.append(el('div',{class:'complete',text:'All paired-video decisions are saved. Return to Codex and say “video review complete”.'}))}
addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue=''}});api('/api/final').then(v=>{packet=v;index=Math.max(0,packet.pairs.findIndex(p=>!complete(p)));statusNode.textContent='Ready';render()}).catch(e=>{statusNode.textContent='Error';app.textContent=e.message});
</script></body></html>`;
