// Caller holds the same flock used by review saves. Preserve existing votes.
import {readFile} from 'node:fs/promises';
import {saveJsonAtomic} from './video-cost-ab-lib.mjs';
let text='';for await(const chunk of process.stdin)text+=chunk;
const packet=JSON.parse(await readFile(process.argv[2],'utf8'));
for(const pair of JSON.parse(text))if(!packet.pairs.some(p=>p.pair_id===pair.pair_id))packet.pairs.push(pair);
await saveJsonAtomic(process.argv[2],packet);
