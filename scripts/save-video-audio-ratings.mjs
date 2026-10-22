import { readFile } from 'node:fs/promises';
import { saveJsonAtomic } from './video-cost-ab-lib.mjs';
import { applyFinalVideoRatings, finalVideoPacketFingerprint } from './video-cost-ab-final-review.mjs';
let input='';
for await (const chunk of process.stdin) input+=chunk;
const payload=JSON.parse(input), path=process.argv[2];
const current=JSON.parse(await readFile(path,'utf8'));
if(payload.fingerprint!==finalVideoPacketFingerprint(current)){
  // Completed pairs are only appended; permit a still-valid older prefix.
  const oldLength=current.pairs.findIndex((_pair,index)=>
    finalVideoPacketFingerprint({...current,pairs:current.pairs.slice(0,index+1)})===payload.fingerprint)+1;
  if(!oldLength||payload.pairs.some(row=>!/^v-\d+$/.test(row.public_id)||Number(row.public_id.slice(2))>oldLength)){
    throw Error('Review changed. Reload before saving.');
  }
  payload.fingerprint=finalVideoPacketFingerprint(current);
}
const saved=applyFinalVideoRatings(current,payload);
await saveJsonAtomic(path,saved);
process.stdout.write(JSON.stringify(saved));
