#!/usr/bin/env node
import {readFile,writeFile,mkdir,copyFile,access,rm} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {VideoBroker} from '../dist/VideoBroker.js';
import {VideoExperimentLedger,ledgerTotals} from './video-experiment-ledger.mjs';
import {saveJsonAtomic} from './video-cost-ab-lib.mjs';
const root=resolve(process.argv[2]||''),runtime='/mnt/d/AI/ComfyUI_windows_portable/video_gen/experiments/concept_selection_20261024',live=resolve(runtime,'../..');
const load=async path=>JSON.parse(await readFile(path,'utf8')),hash=x=>createHash('sha256').update(x).digest('hex');
const design=await load(root+'/design.json'),{cases,pairs}=await load(root+'/cases.json'),state=await load(root+'/state.json');
if(Object.keys(state.results).length!==24||Object.values(state.results).some(x=>x.status==='running'))throw Error('Planning is not finished');
for(const[path,digest]of Object.entries(design.runtime_dependencies))if(hash(await readFile(path))!==digest)throw Error('Frozen runtime drift: '+path);
for(const[name,digest]of Object.entries(design.renderer_hashes))if(hash(await readFile(live+'/'+name))!==digest)throw Error('Frozen renderer drift: '+name);
await mkdir(runtime,{recursive:true});await mkdir(root+'/renders/human-review',{recursive:true});
const packetPath=root+'/renders/human-review/final-videos.json';
try{await access(packetPath)}catch{await saveJsonAtomic(packetPath,{schema_version:1,blinded:true,rubric:['creative','identity','audio'],require_acceptability:true,acceptability_scope:'video',pairs:[]})}
let identity;try{identity=await load(root+'/broker-identity.json')}catch{identity={botToken:randomBytes(24).toString('hex'),workerToken:randomBytes(24).toString('hex')};await saveJsonAtomic(root+'/broker-identity.json',identity)}
const tasks=pairs.flatMap((pair,i)=>(i%2?['candidate','control']:['control','candidate']).map(arm=>({key:pair.id+'-'+arm,pair_id:pair.id,case_id:pair.case_id,arm,seed:pair.seed})));
const lookup={};for(const [index,task]of tasks.entries()){
 task.requester=String(1000+index);task.item=cases.find(c=>c.id===task.case_id);
 const planned=state.results[task.case_id+'-'+task.arm];
 task.plan_error=planned.status!=='complete'?planned.error:null;
 if(!task.plan_error)task.prepared=await load(root+'/'+planned.plan_path);
 lookup[task.requester]=task;
}
const broker=new VideoBroker({host:'127.0.0.1',port:4362,dbPath:root+'/broker.sqlite3',resultsDir:root+'/broker-results',...identity,recoveryEnabled:true,preplanQueuedJobs:false,heartbeatTimeoutMs:180000,
 recoveryPlanner:async input=>{const task=lookup[input.requester];if(!task?.prepared||input.prompt!==task.item.prompt)throw Error('Unknown frozen request');return structuredClone(task.prepared)},frontierPlanner:async()=>{throw Error('Experiment forbids replanning')}});
const ledger=await VideoExperimentLedger.open(root+'/accounting',{budgetUsd:design.budget_usd,phaseCapUsd:design.phase_caps_usd.rendering});
const originalHooks=broker.providerHooks.bind(broker);
broker.providerHooks=job=>{const base=originalHooks(job),limit=ledger.hooks(job.public_id);return {...base,beforeRequest:async r=>{await limit.beforeRequest(r);await base.beforeRequest?.(r)},onUsage:async e=>{await limit.onUsage(e);await base.onUsage?.(e)}}};
const call=async(path,body={})=>{const response=await fetch('http://127.0.0.1:4362'+path,{method:'POST',headers:{authorization:'Bearer '+identity.botToken,'content-type':'application/json'},body:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw Error(JSON.stringify(value));return value};
await broker.start();
let jobs;try{jobs=await load(root+'/jobs.json')}catch{jobs=[]}
async function admit(){
 const existing=await broker.all("SELECT public_id,status FROM video_jobs");
 const active=existing.filter(j=>!['ready','delivered','failed','cancelled'].includes(j.status)).length;
 if(active>=18||!tasks.some(t=>!t.plan_error&&!jobs.some(j=>j.key===t.key)))return;
 await call('/v1/control/drain',{actor_id:'concept-experiment'});
 try{
  let slots=18-active;
  for(const task of tasks){if(!slots||task.plan_error||jobs.some(j=>j.key===task.key))continue;
   const value=await call('/v1/jobs',{model:'minimax',prompt:task.item.prompt,requester_id:task.requester,origin_bot_id:'experiment',channel_id:'experiment',command_message_id:design.experiment+'-'+task.key,status_message_id:'local-review',experiment_id:design.experiment,variant_id:task.arm,command_variant:task.item.command_variant,planner_guidance:task.item.guidance,...(task.item.sources.length?{source_image:{preset:'meximutt'}}:{})});
   // Isolated replay uses the frozen source shared by both arms, never a live user's job.
   if(task.item.sources.length)await broker.run('UPDATE video_jobs SET source_image_path=? WHERE public_id=?',[task.item.sources[0].path,value.job.id]);
   jobs.push({id:value.job.id,key:task.key,pair_id:task.pair_id,case_id:task.case_id,arm:task.arm,seed:task.seed});slots--;
   await saveJsonAtomic(root+'/jobs.json',jobs);
  }
  await saveJsonAtomic(runtime+'/worker-config.json',{broker_url:'ws://127.0.0.1:4362/v1/worker',seeds:Object.fromEntries(jobs.map(j=>[j.id,j.seed])),renderer_hashes:design.renderer_hashes});
 }finally{await call('/v1/control/resume-dispatch',{actor_id:'concept-experiment'})}
}
await admit();
await copyFile(resolve('desktop/video_experiment_worker.py'),runtime+'/worker.py');
await saveJsonAtomic(runtime+'/worker-settings.json',{workerId:design.experiment,brokerUrl:'wss://unused.invalid/v1/worker',workerToken:identity.workerToken});
await rm(runtime+'/stop',{force:true});
const win=execFileSync('wslpath',['-w',runtime+'/worker.py'],{encoding:'utf8'}).trim();
const python='/mnt/d/AI/ComfyUI_windows_portable/python_embeded/python.exe';
execFileSync(python,['-s',win,'--validate']);
const admission=JSON.parse(execFileSync('gpuq',['status'],{encoding:'utf8'}));if(!admission.submissionAvailable)throw Error('GPU admission unavailable');
let worker, previous;
try{previous=await load(root+'/render-processes.json')}catch{}
let existingAlive=false;
if(previous?.worker_launcher_pid){try{process.kill(previous.worker_launcher_pid,0);existingAlive=true}catch{}}
if(existingAlive){worker={pid:previous.worker_launcher_pid,exitCode:null};console.log('Reusing existing isolated worker',worker.pid)}
else {const fd=openSync(root+'/worker.log','a');try{worker=spawn(python,['-u','-s',win],{stdio:['ignore',fd,fd]})}finally{closeSync(fd)}}
await saveJsonAtomic(root+'/render-processes.json',{broker_pid:process.pid,worker_launcher_pid:worker.pid,runtime});
let stopping=false;process.on('SIGTERM',()=>{stopping=true});process.on('SIGINT',()=>{stopping=true});
const done=new Set(),checkedPairs=new Set(),identicalPairs=new Set();const reviewKey=Object.fromEntries(pairs.map((pair,i)=>[pair.id,i%2?{A:'candidate',B:'control'}:{A:'control',B:'candidate'}]));
await saveJsonAtomic(root+'/renders/review-key.json',reviewKey);
async function publish(){
 const rows=await broker.all('SELECT public_id,status,stage,error,result_path,updated_at FROM video_jobs');
 for(const row of rows)if(['ready','delivered'].includes(row.status)&&row.result_path&&!done.has(row.public_id)){
  const job=jobs.find(j=>j.id===row.public_id),target=root+'/renders/'+job.key+'.mp4';
  try{await access(target)}catch{
   const admission=spawn('gpuq',['gaming','check','--quiet']);const code=await new Promise(r=>admission.on('close',r));if(![0,75].includes(code))throw Error('CPU admission unavailable');
   execFileSync('ffmpeg',['-nostdin','-v','error','-y','-i',row.result_path,'-map','0:v:0','-map','0:a:0?','-c','copy','-map_metadata','-1','-map_metadata:s','-1','-movflags','+faststart',target]);
   execFileSync('ffmpeg',['-nostdin','-v','error','-threads','2','-xerror','-i',target,'-f','null','-']);
  }
  done.add(row.public_id);
  // Local review is this isolated broker's delivery destination; no Discord client exists.
  if(row.status==='ready')await broker.run("UPDATE video_jobs SET status='delivered',updated_at=? WHERE public_id=? AND status='ready'",[Date.now()/1000,row.public_id]);
 }
 const updates=[];
 for(const pair of pairs){const pairJobs=jobs.filter(j=>j.pair_id===pair.id);if(pairJobs.length!==2||!pairJobs.every(j=>done.has(j.id)))continue;
  if(!checkedPairs.has(pair.id)){if(hash(await readFile(root+'/renders/'+pairJobs[0].key+'.mp4'))===hash(await readFile(root+'/renders/'+pairJobs[1].key+'.mp4')))identicalPairs.add(pair.id);checkedPairs.add(pair.id)}
  if(identicalPairs.has(pair.id))continue;
  const item=cases.find(c=>c.id===pair.case_id);
  updates.push({pair_id:pair.id,prompt:'$'+item.command_variant+' '+item.prompt+(pair.sample===2?' [Repeat: same plans, different render seed; assessed separately]':''),videos:['A','B'].map(label=>({label,video_path:root+'/renders/'+pairJobs.find(j=>j.arm===reviewKey[pair.id][label]).key+'.mp4'})),preferred:null,acceptability:{A:null,B:null},overall:{A:null,B:null},dimension_preferences:{creative:null,identity:null,audio:null},material_failure:{A:false,B:false},notes:''});
 }
 const append=spawn('flock',[root+'/renders/review.lock','node',resolve('scripts/append-video-experiment-pairs.mjs'),packetPath],{stdio:['pipe','inherit','inherit']});append.stdin.end(JSON.stringify(updates));if(await new Promise(r=>append.on('close',r)))throw Error('Review publish failed');
 const versions=task=>{if(task.plan_error)return {status:'failed',stage:'Planning',error:task.plan_error};const job=jobs.find(j=>j.key===task.key),row=rows.find(r=>r.public_id===job?.id);return {status:row?.status==='delivered'?'ready':row?.status||'pending',stage:row?.stage||(job?'Queued in isolated broker':'Waiting for isolated broker admission'),error:row?.error||null}};
 const outcomes=tasks.map(versions),terminal=outcomes.every(x=>['ready','failed','cancelled'].includes(x.status));
 await saveJsonAtomic(root+'/progress.json',{status:terminal?'awaiting-review':'rendering',planned_pairs:15-identicalPairs.size,primary_pairs:12,repeat_pairs:3,identical_pairs_excluded:[...identicalPairs],planned_videos:30,ready_pairs:updates.length,finished_videos:outcomes.filter(x=>x.status==='ready').length,failed_videos:outcomes.filter(x=>x.status==='failed').length,cases:pairs.map(pair=>({id:pair.id,prompt:'$'+cases.find(c=>c.id===pair.case_id).command_variant+' '+cases.find(c=>c.id===pair.case_id).prompt+(pair.sample===2?' [Repeat seed]':''),versions:tasks.filter(t=>t.pair_id===pair.id).map(versions)})),accounting:ledgerTotals(ledger.state),updated_at:new Date().toISOString()});
 await saveJsonAtomic(root+'/job-status-private.json',rows);return terminal;
}
try{while(true){const terminal=await publish();if(terminal)break;if(stopping){await call('/v1/control/drain',{actor_id:'experiment-stop'});if(!broker.worker?.currentJob)break;}else await admit();if(worker.exitCode!==null)throw Error('Isolated worker exited: '+worker.exitCode);await new Promise(r=>setTimeout(r,10000));}}
finally{await writeFile(runtime+'/stop','Stop after current job\n');if(!broker.worker?.currentJob){await new Promise(r=>setTimeout(r,1500));await broker.stop();await ledger.close();}}
console.log('Render controller finished. Results and any failures retained.');
