import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parseLinks, createResolver} from '../links.mjs';
import {GraphIndex} from '../graph.mjs';
import {Workspace} from '../workspace.mjs';
import {readNote, atomicWrite, checkedPath, revealTarget, acquireRuntimeLock} from '../files.mjs';
import {buildEvidenceBundle} from '../retrieval.mjs';
import {renderPage} from '../build.mjs';

async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-test-'));
  for (const [file, text] of Object.entries(files)) {await fs.mkdir(path.dirname(path.join(root,file)), {recursive:true});await fs.writeFile(path.join(root,file),text);}
  const w = new Workspace(path.join(root,'.weave'), {}); await w.open(root); await w.ready;
  t.after(async () => {await w.close();await fs.rm(root,{recursive:true,force:true});}); return w;
}
test('grammar retains exact offsets, Unicode, CRLF and open relationship vocabulary', () => {
  const text='😀\r\n[B](A/B.md "writes-to") [C D](<A B/C D.md> "depends-on") [Simple Note](<Simple Note.md>) [雪](Māori/雪.md "custom-type")';
  const parsed=parseLinks(text,'Source.md');assert.equal(parsed.links.length,4);assert.deepEqual(parsed.links.map(l=>l.relationship),['writes-to','depends-on','links-to','custom-type']);
  for(const link of parsed.links){assert.equal(text.slice(link.start,link.end),link.raw);assert.equal(text.slice(link.targetStart,link.targetEnd),link.target);assert.equal(link.line,2);}
});
test('fences, comments, inline code, frontmatter, escapes and malformed links do not create edges', () => {
  const text='---\na: "[bad](bad.md)"\n---\n```md\n[bad](bad.md)\n```\n`[bad](bad.md)` <!-- [bad](bad.md) --> \\[bad](bad.md)\n[[A][x][y]] [[old.md]]@@uses ![image](img.md) [web](https://example.invalid/a.md) [text](notes.txt) [ref][x] [open](a.md\n[never\n[valid](valid.md)';
  const result=parseLinks(text);assert.deepEqual(result.links.map(l=>l.target),['valid.md']);assert.equal(result.diagnostics.length,2);assert.match(result.diagnostics[0].message,/Wiki links are not supported/);
});
test('resolution is deterministic, rejects traversal and never picks ambiguous names', () => {
  const resolve=createResolver(['A/Note.md','B/Note.md','Systems/Azure Data Factory.md','Māori/雪.md'],{caseSensitive:false});
  assert.equal(resolve('systems\\azure data factory').resolvedPath,'Systems/Azure Data Factory.md');assert.equal(resolve('Māori/雪').resolved,true);
  assert.equal(resolve('Note').reason,'ambiguous');assert.equal(resolve('Missing').reason,'missing');assert.equal(resolve('../outside').reason,'invalid-path');
  assert.equal(createResolver(['A.md'],{caseSensitive:true})('a').resolved,false);
  const scoped=createResolver(['A/x.md','A/y.md','y.md','A/z.md']);
  assert.equal(scoped('/y.md','A/x.md').resolvedPath,'y.md');assert.equal(scoped('./y.md','A/x.md').resolvedPath,'A/y.md');assert.equal(scoped('../y.md','A/x.md').resolvedPath,'y.md');
  assert.equal(scoped('y.md','A/x.md').resolvedPath,'A/y.md','bare paths are relative to the source article first');assert.equal(scoped('A/z.md','A/x.md').resolvedPath,'A/z.md','then relative to the workspace root');
  assert.equal(scoped('A/z.md','A/x.md').fallback,true,'a root fallback is reported for validators');assert.equal(scoped('./z.md','A/x.md').fallback,false);
  assert.equal(scoped('../../y.md','A/x.md').reason,'invalid-path');
});
test('Markdown links keep labels, angle destinations, encoded paths and titles', () => {
  const text='[Azure `ADF`](<Systems/Azure Data Factory.md> "writes-to") [Space](Systems/Azure%20Data%20Factory.md "A tooltip") [Bare](Systems/Azure Data Factory.md)@@reads-from.';
  assert.match(parseLinks(text).diagnostics[0].message,/Unsupported @@relationship suffix/,'@@ suffixes are read but reported');
  const links=parseLinks(text).links;assert.deepEqual(links.map(l=>[l.label,l.target,l.relationship]),[['Azure ADF','Systems/Azure Data Factory.md','writes-to'],['Space','Systems/Azure Data Factory.md','links-to'],['Bare','Systems/Azure Data Factory.md','reads-from']]);
  assert(!links[2].raw.endsWith('.'));assert.equal(text.slice(links[0].targetStart,links[0].targetEnd),'Systems/Azure Data Factory.md');
});
test('graph updates edges, missing targets, creations, ambiguity and deletions transactionally', () => {
  const graph=new GraphIndex(':memory:','fixture');try {
    graph.upsert('A.md','# A\n[B](B.md "writes-to")');assert.equal(graph.status().unresolved,1);
    graph.upsert('B.md','# B');assert.equal(graph.incoming('B.md').length,1);
    graph.upsert('A.md','# A\n[B](B.md "depends-on")');assert.equal(graph.outgoing('A.md')[0].relationship_type,'depends-on');
    graph.remove('B.md');assert.equal(graph.status().unresolved,1);graph.upsert('A.md','# A');assert.equal(graph.status().relationships,0);
    graph.upsert('A.md','[Note](Note.md)');graph.upsert('X/Note.md','# N');assert.equal(graph.status().unresolved,0);graph.upsert('Y/Note.md','# N');assert.equal(graph.status().unresolved,1);
  }finally{graph.close();}
});
test('YAML never supplies runtime relationships and metadata identity survives', () => {
  const graph=new GraphIndex(':memory:','fixture');try{graph.upsert('A.md','# A\n```yaml\nid: stable:a\ntags: [one, two]\nrelationships:\n  - to: B\n    type: writes-to\n```\n');assert.equal(graph.status().relationships,0);assert.equal(graph.documents()[0].stableId,'stable:a');assert.equal(graph.documents()[0].legacyRelationships,1);}finally{graph.close();}
});
test('file rename rewrites parsed incoming targets only, preserving type and unrelated bytes', async t => {
  const original='# A\r\n[Bee](  ./B.md "Writes_To" )\r\n`[B](B.md)`\r\nPlain B\r\n';
  const w=await fixture(t,{'A.md':original,'B.md':'# B'});const plan=await w.renamePreview('B.md','C.md');assert.equal(plan.links,1);await w.rename(plan.token,true);
  assert.equal((await w.getDocument('A.md')).text,original.replace('./B.md "','./C.md "'));assert.equal(w.getIncomingRelationships('C.md').length,1);
});
test('folder moves rewrite nested references including links inside the moved folder', async t => {
  const w=await fixture(t,{'A.md':'[B](Old/B.md "depends-on")','Old/B.md':'[C](Old/C.md "reads-from")','Old/C.md':'# C','New/.keep':''});
  const p=await w.renamePreview('Old','New/Moved');assert.equal(p.links,2);await w.rename(p.token,true);assert.match((await w.getDocument('A.md')).text,/New\/Moved\/B/);assert.equal(w.getOutgoingRelationships('New/Moved/B.md')[0].target_document_id,'New/Moved/C.md');
});
test('declining link updates leaves references broken', async t => {
  const w=await fixture(t,{'A.md':'[B](B.md "writes-to")','B.md':'# B'});const p=await w.renamePreview('B.md','C.md');await w.rename(p.token,false);assert.equal((await w.getDocument('A.md')).text,'[B](B.md "writes-to")');assert.equal(w.graph.status().unresolved,1);
});
test('rename refuses a changed incoming note and leaves originals intact', async t => {
  const w=await fixture(t,{'A.md':'[B](B.md)','B.md':'# B'});const p=await w.renamePreview('B.md','C.md');await fs.writeFile(path.join(w.root,'A.md'),'External [B](B.md)');await assert.rejects(w.rename(p.token,true),/changed/);assert.equal((await w.getDocument('B.md')).text,'# B');
});
test('save detects stale content, including same-size changes, without losing external edits', async t => {
  const w=await fixture(t,{'A.md':'one'});const note=await w.getDocument('A.md');await fs.writeFile(path.join(w.root,'A.md'),'two');await assert.rejects(w.save('A.md','draft',note.hash),/changed outside/);assert.equal((await w.getDocument('A.md')).text,'two');
});
test('new files cannot clobber existing notes and path isolation rejects symlinks/traversal', async t => {
  const w=await fixture(t,{'A.md':'hello'});await assert.rejects(w.create('A.md'),/changed outside/);await assert.rejects(checkedPath(w.root,'../private.md'));await assert.rejects(checkedPath(w.root,'.weave/graph.sqlite'));await assert.rejects(w.create('Bad:Name.md'));
});
test('UTF-16 and BOM survive save', async t => {
  const w=await fixture(t,{'A.md':'hello'});await fs.writeFile(path.join(w.root,'A.md'),Buffer.concat([Buffer.from([255,254]),Buffer.from('# 雪\r\n','utf16le')]));const doc=await readNote(w.root,'A.md');await atomicWrite(w.root,'A.md',doc.text+'[B](B.md)',doc.hash,doc);const bytes=await fs.readFile(path.join(w.root,'A.md'));assert.deepEqual([...bytes.subarray(0,2)],[255,254]);assert.equal((await readNote(w.root,'A.md')).text,'# 雪\r\n[B](B.md)');
});
test('rebuilding gives the same entities and edges as incremental changes', async t => {
  const w=await fixture(t,{'A.md':'[B](B.md "reads-from")','B.md':'# B'});let doc=await w.getDocument('A.md');await w.save('A.md','[B](B.md "writes-to") [Missing](Missing.md)',doc.hash);await w.create('New.md');const before=w.graph.snapshot();await w.rebuildGraph();assert.deepEqual(w.graph.snapshot(),before);
});
test('Explorer targets stay within the workspace, including deleted Git entries', async t => {
  const w=await fixture(t,{'Folder/A.md':'hello','AGENTS.md':'instructions'});
  assert.equal(await revealTarget(w.root,'Folder/A.md'),path.join(w.root,'Folder/A.md'));
  assert.equal(await revealTarget(w.root,'Folder/deleted.md'),path.join(w.root,'Folder'));
  assert.equal(await revealTarget(w.root,'gone/deleted.md'),w.root);
  assert.equal(await revealTarget(w.root,'AGENTS.md'),path.join(w.root,'AGENTS.md'));
  for(const target of ['../outside','C:/outside','.git/config','.weave/session.json'])await assert.rejects(revealTarget(w.root,target));
});

test('external create, modify and delete are reconciled by the watcher; private directories are ignored', async t => {
  const w=await fixture(t,{'A.md':'# A','.weave/hidden.md':'[No](No.md)'});assert.equal(w.graph.status().documents,1);
  const wait=async check=>{for(let i=0;i<60;i++){if(check())return;await new Promise(r=>setTimeout(r,50));}assert.fail('watcher did not converge');};
  await fs.writeFile(path.join(w.root,'B.md'),'[A](A.md)');await wait(()=>w.graph.status().relationships===1);
  await fs.writeFile(path.join(w.root,'B.md'),'[Missing](Missing.md)');await wait(()=>w.graph.status().unresolved===1);
  await fs.unlink(path.join(w.root,'B.md'));await wait(()=>w.graph.status().documents===1);
});
test('delete requires confirmation and retains a recovery copy', async t => {
  const w=await fixture(t,{'A.md':'# A'});await assert.rejects(w.delete('A.md',false),/confirmation/);const result=await w.delete('A.md',true);assert.equal(await fs.readFile(path.join(result.recovery,'A.md'),'utf8'),'# A');assert.equal(w.graph.status().documents,0);
});
test('Ask evidence joins retrieval seed paths, one-hop edges, and supporting passages without generation', async t => {
  const w=await fixture(t,{'ADF.md':'# ADF\nPolicy records are copied. [Snowflake](Snowflake.md "writes-to")','Snowflake.md':'# Snowflake\nREPORT contains copied policy records. [Far](Far.md "depends-on")','Far.md':'# Far'});
  w.searchKnowledge=async()=>({results:[{path:'ADF.md',score:.9,method:'text'}],method:'text',notices:[]});
  const evidence=await buildEvidenceBundle(w,'policy copies');assert.equal(evidence.generated,false);assert.deepEqual(evidence.documents.map(d=>d.path),['ADF.md','Snowflake.md']);assert.equal(evidence.documents[1].via.relationship_type,'writes-to');assert.match(evidence.documents[1].passage.text,/REPORT/);
});
test('standalone build is executable, CSP-safe, and escapes hostile document data', async () => {
  const html=await renderPage({documents:[{text:'</script><img src=x onerror=alert(1)> $\' $&'}]});const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];new Function(script);assert.match(html,/connect-src 'none'/);assert(!html.includes('<img src=x'));assert.match(html,/\\u003c\/script/);
});
test('a mid-rename write failure rolls back already rewritten notes and the moved resource', async t => {
  const w=await fixture(t,{'A.md':'[B](B.md "writes-to")','B.md':'# B','D.md':'[B](B.md "reads-from")'}), plan=await w.renamePreview('B.md','C.md');
  const rename=fs.rename;let failed=false;
  fs.rename=async(from,to)=>{if(!failed&&String(from).endsWith('.tmp')&&String(to)===path.join(w.root,'D.md')){failed=true;throw new Error('Injected replacement failure');}return rename(from,to);};
  try {await assert.rejects(w.rename(plan.token,true),/rolled back/);}finally{fs.rename=rename;}
  assert.equal((await w.getDocument('A.md')).text,'[B](B.md "writes-to")');assert.equal((await w.getDocument('B.md')).text,'# B');assert.equal(w.graph.status().unresolved,0);
});
test('corrupt graph cache can be reconstructed without changing Markdown', async t => {
  const w=await fixture(t,{'A.md':'[B](B.md)','B.md':'# B'});w.graph.close();w.graph=null;
  for(const suffix of ['','-wal','-shm'])await fs.rm(w.graphFile+suffix,{force:true});
  await fs.writeFile(w.graphFile,'not sqlite');
  assert.throws(()=>new GraphIndex(w.graphFile,w.root),/database/);await w.rebuildGraph();assert.equal(w.graph.status().relationships,1);assert.equal((await w.getDocument('A.md')).text,'[B](B.md)');
});
test('portable runtime lock prevents two applications from switching the same cache', async t => {
  const w=await fixture(t,{'A.md':'# A'}), release=await acquireRuntimeLock(w.runtime);try{await assert.rejects(acquireRuntimeLock(w.runtime),/Another Weave instance/);}finally{await release();}const again=await acquireRuntimeLock(w.runtime);await again();
});
