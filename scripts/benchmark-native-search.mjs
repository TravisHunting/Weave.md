// Informational native FTS benchmark; generated Markdown and databases are disposable.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {NativeHarness} from '../app/weave/tests/native-harness.mjs';
import {DatabaseSync} from 'node:sqlite';
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'weave-fts-benchmark-'));
const root=path.join(temporary,'Notes'),runtime=path.join(temporary,'.weave');
await fs.mkdir(root);let host;
try {
  for(let i=0;i<1000;i++)await fs.writeFile(path.join(root,`Article ${i}.md`),`# Article ${i}\n`+('A paragraph about warehouse storage and lineage for reporting.\n'.repeat(130))+`\nuniqueterm${i}\n`);
  host=new NativeHarness(runtime);const start=performance.now();await host.open(root);const indexMs=performance.now()-start;
  const db=new DatabaseSync(path.join(runtime,'weave.sqlite'));
  const chunks=db.prepare('SELECT count(*) n FROM chunks').get().n;db.close();
  const measure=async query=>{
    const times=[];
    for(let i=0;i<35;i++){const start=performance.now();const result=await host.call('searchKnowledge',{query});if(!result.results.length)throw new Error('Expected matching chunks');if(i>=5)times.push(performance.now()-start);}
    times.sort((a,b)=>a-b);return {p50:times[15],p95:times[28]};
  };
  const metrics={articles:1000,chunks,indexMs,selective:await measure('uniqueterm527'),broad:await measure('warehouse storage')};
  console.log(JSON.stringify(metrics,null,2));await fs.mkdir('test-results',{recursive:true});
  await fs.writeFile('test-results/native-search-benchmark.json',JSON.stringify(metrics,null,2));
} finally {await host?.close();await fs.rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
