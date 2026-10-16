import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {NativeHarness} from './native-harness.mjs';
import {readWorkspace,ROOT} from '../build.mjs';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';

test('Rust parses the representative library identically to the shared article reader',async t=>{
  const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'weave-parser-parity-'));
  const host=new NativeHarness(runtime);t.after(async()=>{await host.close();await fs.rm(runtime,{recursive:true,force:true});});
  const root=path.join(ROOT,'knowledge-example'),reference=await readWorkspace(root);await host.open(root);
  const native=await host.call('graph');
  const nodes=g=>g.entities.filter(n=>!n.broken).map(n=>({file:n.file,title:n.name,type:n.type,tags:n.tags})).sort((a,b)=>a.file.localeCompare(b.file));
  const edges=g=>g.relationships.map(e=>({from:e.from,to:e.to,type:e.type,line:e.source_line,start:e.start_offset,raw:e.raw})).sort((a,b)=>a.from.localeCompare(b.from)||a.start-b.start);
  assert.deepEqual(nodes(native),nodes(reference.graph));assert.deepEqual(edges(native),edges(reference.graph));
  assert.equal(native.entities.filter(n=>!n.broken).length,46);assert.equal(native.relationships.length,339);
});

test('native migration imports durable preferences once and rejects junction traversal',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'weave-native-migrate-')),root=path.join(temp,'Notes'),runtime=path.join(temp,'.weave');
  await fs.mkdir(root);await fs.mkdir(path.join(runtime,'git'),{recursive:true});await fs.writeFile(path.join(root,'Note.md'),'# Note\n[[Old]]\n');
  const hash=s=>createHash('sha256').update(s).digest('hex'),id='kb-'+hash(process.platform==='win32'?root.toLowerCase():root).slice(0,20);
  const session={tabs:['Note.md'],active:'Note.md',tabState:[{id:'tab1',path:'Note.md',history:['Note.md'],at:0}],activeTab:'tab1'};
  await fs.writeFile(path.join(runtime,'storage.json'),JSON.stringify({collections:[{id,root,name:'Notes',indexing:{watchChanges:false,autoRefresh:false,refreshSeconds:75,scanMode:'content',autoEmbed:true}}]}));
  await fs.writeFile(path.join(runtime,'session.json'),JSON.stringify({lastWorkspace:root,workspaces:{[id]:session}}));
  const pulls=[{hash:'abc123',subject:'Imported pull'}],preferences={pullRemote:'origin',pushRemotes:['origin']};
  const gitFile=path.join(runtime,'git',hash(root).slice(0,24)+'.json');await fs.writeFile(gitFile,JSON.stringify(pulls));await fs.writeFile(gitFile+'.remotes',JSON.stringify(preferences));
  let host=new NativeHarness(runtime);t.after(async()=>{await host.close();await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const catalog=await host.call('restore');assert.deepEqual(catalog.session,session);await host.call('refresh');
  assert.equal((await host.call('status')).monitoring.refreshSeconds,75);assert.equal((await host.call('getDocument',{path:'Note.md'})).diagnostics.length,1);
  const db=new DatabaseSync(path.join(runtime,'weave.sqlite'));assert.deepEqual(JSON.parse(db.prepare('SELECT git FROM workspaces WHERE id=?').get(catalog.workspace.id).git),{pulls,preferences});db.close();
  await host.call('configureMonitoring',{refreshSeconds:95});await host.close();
  host=new NativeHarness(runtime);await host.call('restore');assert.equal((await host.call('status')).monitoring.refreshSeconds,95,'legacy settings cannot overwrite native settings on restart');
  const outside=path.join(temp,'Outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'Keep.md'),'# Keep');
  await fs.symlink(outside,path.join(root,'Linked'),process.platform==='win32'?'junction':'dir');
  for(const [op,args] of [['getDocument',{path:'Linked/Keep.md'}],['create',{path:'Linked/Injected.md'}],['delete',{path:'Linked',confirmed:true}],['renamePreview',{from:'Linked',to:'Moved'}]])await assert.rejects(host.call(op,args),/linked|link|reparse/i);
  assert.equal(await fs.readFile(path.join(outside,'Keep.md'),'utf8'),'# Keep');await assert.rejects(fs.stat(path.join(outside,'Injected.md')),{code:'ENOENT'});
  await fs.unlink(path.join(root,'Linked'));
});

test('native chunk index survives reopen, updates incrementally, and stays in one SQLite database',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'weave-native-search-')),root=path.join(temp,'Notes'),runtime=path.join(temp,'.weave');await fs.mkdir(root);
  // Multiple chunks and multiple workspaces exercise real FTS5, not a mocked ranker.
  await fs.writeFile(path.join(root,'Large.md'),'# Large\n\n'+('ordinary paragraph about storage\n'.repeat(250))+'\nuniquechecklast\n');
  await fs.writeFile(path.join(root,'Empty.md'),'');await fs.writeFile(path.join(root,'Fence.md'),'# Fence\n\n```\n\n[ignored](./Large.md)\n\n```\n[real](./Large.md)\n');
  let host=new NativeHarness(runtime);t.after(async()=>{await host.close();await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});});await host.open(root);
  assert.equal((await host.call('graph')).relationships.length,1,'blank code rows do not hang or create edges');
  assert.equal((await host.call('searchKnowledge',{query:'Empty'})).results[0].path,'Empty.md','empty notes remain searchable by title');
  const query=()=>host.call('searchKnowledge',{query:'uniquechecklast'});const found=(await query()).results[0];assert(found.excerpt.line>200);assert(found.excerpt.text.includes('uniquechecklast'));
  const db=new DatabaseSync(path.join(runtime,'weave.sqlite'));
  const rows=db.prepare('SELECT id FROM chunks WHERE path=? ORDER BY ordinal').all('Large.md');assert(rows.length>2);
  await host.call('refresh');assert.deepEqual(db.prepare('SELECT id FROM chunks WHERE path=? ORDER BY ordinal').all('Large.md'),rows,'unchanged chunks retain identity');db.close();
  const times=[];for(let i=0;i<30;i++){const start=performance.now();await query();times.push(performance.now()-start);}times.sort((a,b)=>a-b);console.log('Native FTS5 IPC latency, small fixture: p95='+times[28].toFixed(1)+'ms');
  await host.close();host=new NativeHarness(runtime);await host.call('restore');await host.call('refresh');assert.equal((await query()).results[0].chunkId,found.chunkId);
  const other=path.join(temp,'Other');await fs.mkdir(other);await fs.writeFile(path.join(other,'Secret.md'),'# Secret\nuniquesecret');await host.open(other);assert.equal((await query()).results.length,0);assert.equal((await host.call('controlPanel')).workspaces.length,2);
  assert.deepEqual((await fs.readdir(runtime)).filter(n=>n.endsWith('.sqlite')),['weave.sqlite']);
  for(const op of ['embed','downloadModel','rebuildQmd','deleteIndex','activateIndex','rebuildGraph'])await assert.rejects(host.call(op),/Unknown Weave operation/);
});
