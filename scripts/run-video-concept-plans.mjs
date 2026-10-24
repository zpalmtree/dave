#!/usr/bin/env node
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {prepareRecoveryPlan} from '../dist/VideoRecoveryService.js';
import {createFrontierVideoPlan} from '../dist/VideoFrontierPlanner.js';
import {VideoPlannerRequestLimitError} from '../dist/VideoUsage.js';
import {VideoExperimentLedger,ledgerTotals} from './video-experiment-ledger.mjs';
import {saveJsonAtomic} from './video-cost-ab-lib.mjs';
import {requestConcepts,selectedConceptGuidance} from './video-concept-selection.mjs';
const root=resolve(process.argv[2]||''),load=async name=>JSON.parse(await readFile(root+'/'+name,'utf8'));
const design=await load('design.json'),{cases}=await load('cases.json'),hash=x=>createHash('sha256').update(x).digest('hex');
for(const[path,digest]of Object.entries(design.runtime_dependencies))if(hash(await readFile(path))!==digest)throw Error('Frozen dependency changed: '+path);
await mkdir(root+'/plans',{recursive:true});await mkdir(root+'/concepts',{recursive:true});
const ledger=await VideoExperimentLedger.open(root+'/accounting',{budgetUsd:design.budget_usd,phaseCapUsd:design.phase_caps_usd.planning});
let state;try{state=await load('state.json')}catch(e){if(e.code!=='ENOENT')throw e;state={results:{},started_at:new Date().toISOString()}}
let saveQueue=Promise.resolve();const persist=()=>{const snapshot=structuredClone(state);saveQueue=saveQueue.then(()=>saveJsonAtomic(root+'/state.json',snapshot));return saveQueue};
const tasks=cases.flatMap((item,i)=>(i%2?[...design.arms].reverse():design.arms).map(arm=>({key:item.id+'-'+arm,item,arm})));let cursor=0;
async function worker(){while(cursor<tasks.length){const task=tasks[cursor++];if(state.results[task.key])continue;
 state.results[task.key]={status:'running',case_id:task.item.id,arm:task.arm};await persist();console.log('PLAN',task.key);
 const sources=[];for(const s of task.item.sources){const data=await readFile(s.path);if(hash(data)!==s.sha256)throw Error('Source changed');sources.push({data,mimeType:s.mimeType})}
 let guidance=task.item.guidance;
 try{
  if(task.arm==='candidate'){
   const concept=await ledger.checkpoint({phase:'concept',case:task.item.id,design_sha:hash(JSON.stringify(design))},hooks=>requestConcepts({prompt:task.item.prompt,guidance,sources,model:design.model,hooks}));
   await saveJsonAtomic(root+'/concepts/'+task.item.id+'.json',concept);
   if(!concept.ok)throw Error('Concept selection failed: '+concept.error);
   guidance+=selectedConceptGuidance(concept.value.value);
  }
  const result=await ledger.checkpoint({phase:'plan',case:task.item.id,arm:task.arm,design_sha:hash(JSON.stringify(design)),guidance_sha:hash(guidance)},async hooks=>{
   let calls=0;
   return prepareRecoveryPlan({prompt:task.item.prompt,model:'minimax',requester:'concept-evaluation',sources,requireSourceIdentity:task.item.requireSourceIdentity,requireOriginalFirstFrame:task.item.requireOriginalFirstFrame,planner:createFrontierVideoPlan,
    options:{plannerModel:design.model,plannerStrategy:design.strategy,plannerPromptVariant:design.prompt_variant,analysisReasoningEffort:design.effort,screenplayReasoningEffort:design.effort,plannerGuidance:guidance,maxRequestAttempts:1,...hooks,beforeRequest:async r=>{if(calls++)throw new VideoPlannerRequestLimitError('One first plan per arm; no quality rerolls');await hooks.beforeRequest(r)}}});
  });
  if(!result.ok)throw Error(result.error);
  await saveJsonAtomic(root+'/plans/'+task.key+'-prepared.json',result.value);
  state.results[task.key]={...state.results[task.key],status:'complete',plan_path:'plans/'+task.key+'-prepared.json',duration_seconds:result.duration_seconds,cost_usd:result.cost_usd,contract_hash:result.value.contract_hash};
 }catch(error){state.results[task.key]={...state.results[task.key],status:'failed',error:error.message};}
 await persist();console.log(state.results[task.key].status.toUpperCase(),task.key);
}}
try{await persist();await Promise.all(Array.from({length:design.concurrency},worker));state.accounting=ledgerTotals(ledger.state);state.finished_at=new Date().toISOString();await persist();console.log(JSON.stringify(state.accounting));}finally{await ledger.close()}
