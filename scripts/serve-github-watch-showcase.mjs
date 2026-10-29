// Shows actual production planner/delivery payloads with fixture data; never posts to Discord.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { planUpdates, planPullRequests, planIssues, notificationOptions } from '../dist/GitHubCommitWatch.js';
const revision = createHash('sha256').update(readFileSync(new URL('../lib/GitHubCommitWatch.ts', import.meta.url))).digest('hex').slice(0, 12);
const state = {repository:'blocknetprivacy/core',threadId:'746507379310461010',heads:{master:'old'},lastPullRequestNumber:1,lastIssueNumber:1,pending:[]};
const user={login:'example-developer',avatar_url:''};
const pr={number:2,title:'Improve wallet sync',state:'open',draft:false,merged_at:null,head:{ref:'fix-sync'},base:{ref:'master'},user};
const issue={number:3,title:'Wallet sync stops',state:'open',user};
const ping='1213306439175766031';
const rows=[];
const add=(label,result,mention=ping)=>rows.push({label,payload:result.pending.map(n=>notificationOptions(n,mention))});
add('Empty / initial baseline',await planIssues({...state,lastIssueNumber:undefined},async()=>[issue]));
add('Success / new pull request',await planPullRequests(state,async()=>[pr]));
add('Success / new issue',await planIssues(state,async()=>[issue]));
add('Edge / issue closed between polls',await planIssues(state,async()=>[{...issue,state:'closed'}]));
add('Edge / draft pull request',await planPullRequests(state,async()=>[{...pr,draft:true}]));
add('Disabled pings / existing watcher policy',await planPullRequests(state,async()=>[pr]),undefined);
// Explicitly omit ping configuration for the disabled case.
rows.at(-1).payload=(await planPullRequests(state,async()=>[pr])).pending.map(n=>notificationOptions(n));
for(const merge of [false,true])add(merge?'Success / merge, no ping':'Success / commit, no ping',await planUpdates(state,state.repository,state.threadId,async path=>{
 if(path.startsWith('/branches'))return [{name:'master',commit:{sha:'new'}}];
 if(path.includes('/pulls?'))return [];
 return {status:'ahead',commits:[{sha:'new',parents:merge?[{sha:'old'},{sha:'topic'}]:[{sha:'old'}],commit:{message:merge?"Merge branch 'fix-sync' into master":'Improve wallet sync',author:{name:'example-developer'}}}]};
}));
try{await planIssues(state,async()=>{throw Error('GitHub request failed; retry on next poll');});}catch(error){rows.push({label:'Error / cursor preserved for retry',payload:{error:error.message,lastIssueNumber:state.lastIssueNumber,pending:state.pending}});}
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const html=`<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GitHub tracker showcase</title><style>body{font:16px system-ui;background:#111820;color:#edf2f8;margin:0;padding:24px}main{max-width:1000px;margin:auto}h1{font-size:28px}p{color:#bdcad8;line-height:1.6}section{background:#1b2633;border:1px solid #3a4a5e;border-radius:10px;padding:18px;margin:20px 0}h2{font-size:18px;margin-top:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 monospace;margin-bottom:0}@media(max-width:500px){body{padding:12px}section{padding:12px}}</style><main><h1>GitHub tracker · Blocknet Privacy</h1><p>Production notification payloads from fixture data. Source SHA-256: ${revision}. These are payload inspections, not screenshots of Discord. No messages are sent.</p><p>New PRs and issues allow only the configured user mention. Commits and merges have an empty mention allowlist. Initial baselines send nothing. Polling has no visible loading indicator or interactive disabled controls.</p>${rows.map(r=>`<section><h2>${escape(r.label)}</h2><pre>${escape(JSON.stringify(r.payload,null,2))}</pre></section>`).join('')}</main></html>`;
createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html);}).listen(8768,'0.0.0.0',()=>console.log('GitHub tracker showcase: http://localhost:8768'));
