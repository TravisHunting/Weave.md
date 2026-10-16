import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Workspace} from '../workspace.mjs';
import {DirectoryStorage} from '../directory-storage.mjs';
import {logicalPath} from '../platform.mjs';
import {hash} from '../graph.mjs';
import {readStorage,collectionId} from '../storage.mjs';

// An in-memory document grant deliberately has no physical article directory.
// Fail at the boundary if any mutation leaks a reader-relative or OS path.
class RecordingStorage {
  constructor(identity, files = {}) {
    this.identity=identity;this.calls=[];this.files=new Map();this.folders=new Set(['/']);this.clock=0;
    for(const [file,text] of Object.entries(files)) this.put(file,text);
  }
  record(method, paths = []) {for(const file of paths) logicalPath(file,'entry');this.calls.push({method,paths});}
  put(file,text) {this.files.set(file,{path:file.slice(1),text,hash:hash(text),mtime:++this.clock,size:Buffer.byteLength(text),encoding:'utf8',bom:false});}
  async open(grant) {assert.equal(grant.token,this.identity);this.grant=grant;return {identity:this.identity,displayPath:'Granted notes',caseSensitive:true};}
  async scan() {this.record('scan');return {files:[...this.files.values()].map(({path,mtime,size})=>({path,mtime,size})),folders:[...this.folders].filter(p=>p!=='/').map(p=>p.slice(1)),otherFiles:[],warnings:[]};}
  async read(file) {this.record('read',[file]);if(!this.files.has(file))throw Object.assign(new Error('Missing note'),{code:'ENOENT'});return {...this.files.get(file)};}
  async write(file,text,expectedHash,format) {this.record('write',[file,...(format?.path ? [format.path] : [])]);assert.equal(this.files.get(file)?.hash ?? null,expectedHash);this.put(file,text);return this.read(file);}
  async create(file,directory) {this.record('create',[file]);if(directory)this.folders.add(file);else this.put(file,'# '+file.split('/').at(-1).replace(/\.md$/,'')+'\n\n');}
  subscribe(changed) {this.record('subscribe');this.changed=changed;return {close:()=>{this.unsubscribed=true;}};}
  async prepareMove(from,to) {this.record('prepareMove',[from,to]);return {source:from,destination:to};}
  async move(plan,{changes,updateLinks}) {
    this.record('move',[plan.source,plan.destination,...changes.flatMap(change=>[change.path,change.nextPath,change.original.path])]);
    for(const [file,doc] of [...this.files]) if(file===plan.source || file.startsWith(plan.source+'/')) {this.files.delete(file);this.put(plan.destination+file.slice(plan.source.length),doc.text);}
    for(const folder of [...this.folders]) if(folder===plan.source || folder.startsWith(plan.source+'/')) {this.folders.delete(folder);this.folders.add(plan.destination+folder.slice(plan.source.length));}
    if(updateLinks) for(const change of changes) await this.write(change.nextPath,change.text,change.original.hash);
    return {recovery:'provider-recovery:move'};
  }
  async delete(file) {this.record('delete',[file]);this.files.delete(file);return {recovery:'provider-recovery:delete'};}
}

async function runtime() {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'weave-storage-port-'));
  return directory;
}

test('workspace storage operations use logical absolute paths with an opaque document grant',async t=>{
  const directory=await runtime(), storage=new RecordingStorage('provider:Grant-A',{'/A.md':'# A\n[B](B.md)','/B.md':'# B'});
  const workspace=new Workspace(directory,{storage});t.after(async()=>{await workspace.close();await fs.rm(directory,{recursive:true,force:true});});
  const grant=Object.freeze({token:storage.identity});await workspace.open(grant);await workspace.ready;
  assert.equal(storage.grant,grant);assert.equal(path.isAbsolute(workspace.root),false);
  const a=await workspace.getDocument('A.md');await workspace.save('A.md',a.text+'\nUpdated',a.hash);
  await workspace.create('Folder',true);await workspace.create('Folder/New.md');
  assert.equal(workspace.catalog().tree.directories[0].logicalPath,'/Folder');
  assert.equal((await workspace.getDocument('Folder/New.md')).resource.logicalPath,'/Folder/New.md');
  const rename=await workspace.renamePreview('B.md','Folder/B.md');await workspace.rename(rename.token,true);
  assert.match((await workspace.getDocument('A.md')).text,/\[B\]\(\.\/Folder\/B\.md\)/);
  await workspace.delete('Folder/New.md',true);assert.equal(storage.files.has('/Folder/New.md'),false);
  storage.put('/Folder/B.md','# B\nChanged through provider');storage.changed('/Folder/B.md');
  for(let attempt=0;attempt<40 && !workspace.documents.get('Folder/B.md')?.text.includes('Changed through provider');attempt++) await new Promise(resolve=>setTimeout(resolve,20));
  assert.match(workspace.documents.get('Folder/B.md').text,/Changed through provider/);
  for(const method of ['scan','subscribe','read','write','create','prepareMove','move','delete']) assert(storage.calls.some(call=>call.method===method),'exercised '+method);
  const move=storage.calls.find(call=>call.method==='move');assert(move.paths.includes('/A.md'));assert(move.paths.includes('/Folder/B.md'));
  await workspace.close();assert.equal(storage.unsubscribed,true);
});

test('opaque grant identity, including case, separates caches even when display names are equal',async t=>{
  const directory=await runtime(), workspaces=[];
  t.after(async()=>{for(const workspace of workspaces) await workspace.close();await fs.rm(directory,{recursive:true,force:true});});
  for(const identity of ['provider:Grant-A','provider:grant-a']) {
    const storage=new RecordingStorage(identity,{'/Note.md':'# '+identity}),workspace=new Workspace(directory,{storage});workspaces.push(workspace);
    await workspace.open({token:identity});await workspace.ready;
    await workspace.close();
  }
  assert.equal(workspaces[0].root,workspaces[1].root);assert.notEqual(workspaces[0].collection,workspaces[1].collection);assert.notEqual(workspaces[0].graphFile,workspaces[1].graphFile);
  const config=await readStorage(directory);assert.equal(config.collections.length,2);assert(config.collections.every(item=>item.sourceKind==='logical'));

});

test('native storage preserves directory identity, recovery journals and deleted file copies',async t=>{
  const directory=await runtime(), notes=path.join(directory,'notes'), cache=path.join(directory,'runtime');await fs.mkdir(notes);
  await fs.writeFile(path.join(notes,'A.md'),'# A\r\n[B](B.md)\r\n');await fs.writeFile(path.join(notes,'B.md'),'# B');
  const storage=new DirectoryStorage(cache),workspace=new Workspace(cache,{storage});t.after(async()=>{await workspace.close();await fs.rm(directory,{recursive:true,force:true});});await workspace.open(notes);await workspace.ready;
  assert.equal(workspace.location.identity,await fs.realpath(notes));assert.equal(workspace.location.nativeDirectory,await fs.realpath(notes));assert.equal(workspace.collection,collectionId(workspace.root));
  const plan=await workspace.renamePreview('B.md','C.md'),moved=await workspace.rename(plan.token,true);
  assert.equal(await fs.readFile(path.join(notes,'A.md'),'utf8'),'# A\r\n[B](./C.md)\r\n');
  const journal=JSON.parse(await fs.readFile(path.join(moved.recovery,'journal.json'),'utf8'));
  assert.equal(journal.state,'complete');assert.equal(journal.from,'B.md');assert.equal(journal.changes[0].path,'A.md');assert.equal(journal.changes[0].original.path,'A.md');
  const deleted=await workspace.delete('C.md',true);assert.equal(await fs.readFile(path.join(deleted.recovery,'C.md'),'utf8'),'# B');
});
