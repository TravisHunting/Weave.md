import test from 'node:test';
import assert from 'node:assert/strict';
import {capabilities, readerCapabilities, desktopCapabilities, assertCapability, logicalPath, resource, articleResource, resourcePath, encodeResourceArgs, decodeResourceArgs} from '../platform.mjs';
import {createNativeClient} from '../native-client.mjs';
import {createReaderClient} from '../reader-client.mjs';

const workspaceId = 'provider:grant/opaque-id?version=2';

test('capabilities are independent, explicit booleans and immutable', () => {
  const features = capabilities({write:true,resources:true,fts:'true',git:1,nativeWindow:false,unknown:true});
  assert.equal(features.write,true); assert.equal(features.resources,true);
  assert.equal(features.fts,false); assert.equal(features.git,false); assert.equal(features.nativeWindow,false);
  assert.equal(features.unknown,undefined); assert(Object.isFrozen(features));
  assert.deepEqual(capabilities(null),readerCapabilities);
  assert.doesNotThrow(()=>assertCapability(features,'save'));
  for (const op of ['gitAction','configureStorage','workspaceSession','restore']) assert.throws(()=>assertCapability(features,op),/does not provide/);
  assert.doesNotThrow(()=>assertCapability(capabilities({storage:true}),'controlPanel'));
  assert.throws(()=>assertCapability(features,'controlPanel'),/does not provide/);
});

test('logical files and directories carry an opaque workspace grant independently of OS paths', () => {
  const file = resource(workspaceId,'/Māori/Meeting notes.md');
  assert.deepEqual(file,{workspaceId,kind:'file',logicalPath:'/Māori/Meeting notes.md'});
  assert.equal(resourcePath(file,workspaceId,'file'),'Māori/Meeting notes.md');
  assert.equal(resourcePath(resource(workspaceId,'/','directory'),workspaceId,'directory'),'');
  assert.deepEqual(articleResource(workspaceId,'Māori/Meeting notes.md'),file);
  assert.equal(logicalPath('/100% notes/%2e%2e.md'),'/100% notes/%2e%2e.md','logical names are not URL-decoded');
  assert(Object.isFrozen(file));
});

test('logical resources reject traversal, stale grants, invalid kinds and physical paths', () => {
  for (const value of ['Note.md','C:/Notes/A.md','/C:/Notes/A.md','/../A.md','/Folder/../A.md','/./A.md','//A.md','/A//B.md','/A/','/A\\B.md','/A\u0000.md','/' + 'a'.repeat(2049),'/' + Array(65).fill('a').join('/')]) {
    assert.throws(()=>resource(workspaceId,value),/logical workspace path/,'reject '+JSON.stringify(value));
  }
  assert.throws(()=>resource(workspaceId,'/'),/logical workspace path/);
  assert.throws(()=>resource('', '/A.md'),/workspace and resource kind/);
  assert.throws(()=>resource(workspaceId,'/A.md','unknown'),/workspace and resource kind/);
  assert.throws(()=>resourcePath(resource(workspaceId,'/A.md'),'another-grant'),/different workspace/);
  assert.throws(()=>resourcePath(resource(workspaceId,'/Folder','directory'),workspaceId,'file'),/resource kind/);
});

test('resource argument translation preserves data and validates explicit references', () => {
  for (const [op,args,kind] of [
    ['save',{path:'A.md',text:'# Edited',hash:'version-one'},'file'],
    ['create',{path:'Folder',folder:true},'directory'],
    ['create',{path:'Folder/A.md',folder:false},'file'],
    ['delete',{path:'Folder',confirmed:true},'entry'],
    ['getNeighbors',{path:'A.md',depth:3,limit:100},'file'],
  ]) {
    const encoded = encodeResourceArgs(op,args,workspaceId);
    assert.equal(encoded.path,undefined); assert.equal(encoded.resource.kind,kind);
    assert.equal(encoded.resource.logicalPath,'/'+args.path); assert.equal(args.path.startsWith('/'),false);
    const decoded = decodeResourceArgs(op,encoded,workspaceId);
    for (const [key,value] of Object.entries(args)) assert.deepEqual(decoded[key],value);
  }
  const explicit = {resource:resource(workspaceId,'/Folder/A.md'),text:'new',hash:'old'};
  assert.deepEqual(encodeResourceArgs('save',explicit,workspaceId),explicit);
  assert.throws(()=>encodeResourceArgs('save',explicit,'new-grant'),/different workspace/);
  assert.throws(()=>decodeResourceArgs('save',explicit,'new-grant'),/different workspace/);
  assert.throws(()=>encodeResourceArgs('getDocument',{resource:resource(workspaceId,'/Folder','directory')},workspaceId),/resource kind/);
  const override = encodeResourceArgs('getDocument',{path:'Safe.md',resource:resource('another','/Unrelated.md')},workspaceId);
  assert.equal(override.resource.logicalPath,'/Safe.md'); assert.equal(override.resource.workspaceId,workspaceId);
  const rename = {source:resource(workspaceId,'/Old','directory'),destination:resource(workspaceId,'/New','directory')};
  assert.deepEqual(encodeResourceArgs('renamePreview',rename,workspaceId),rename);
  assert.equal(decodeResourceArgs('renamePreview',rename,workspaceId).to,'New');
  assert.throws(()=>encodeResourceArgs('renamePreview',{...rename,destination:resource('another','/New','directory')},workspaceId),/different workspace/);
  const encodedRename = encodeResourceArgs('renamePreview',{from:'Old.md',to:'New.md',...rename},workspaceId);
  assert.equal(encodedRename.source.logicalPath,'/Old.md'); assert.equal(encodedRename.destination.logicalPath,'/New.md');
});

test('a writable native provider works without FTS, Git, session, storage or desktop window APIs', async () => {
  const calls = [], notes = new Map([['/Notes/A.md',{path:'Notes/A.md',text:'# A',hash:'old'}]]);
  const invoke = async (command,input) => {
    calls.push({command,input});
    if (command === 'choose_workspace') return {scope:3,workspace:{id:workspaceId,label:'Granted notes'}};
    assert.equal(command,'weave_request','no desktop command is needed for article operations');
    const {op,args} = input;
    if (op === 'health') return {ok:true,capabilities:{write:true,resources:true}};
    assert.equal(args.scope,3);
    if (op === 'getDocument') return notes.get(args.resource.logicalPath);
    if (op === 'save') {const result = {...notes.get(args.resource.logicalPath),text:args.text,hash:'new'}; notes.set(args.resource.logicalPath,result); return result;}
    if (op === 'create') {assert.equal(args.resource.kind,'directory');return {created:args.resource};}
    if (op === 'searchKnowledge') return {method:'text',results:[{path:'Notes/A.md'}]};
    if (op === 'buildEvidenceBundle') return {generated:false,documents:[notes.get('/Notes/A.md')]};
    throw new Error('Unexpected provider operation '+op);
  };
  const client = await createNativeClient({invoke});
  assert.equal(client.writable,true); assert.equal(client.capabilities.fts,false); assert.equal(client.capabilities.nativeWindow,false);
  await client.choose();
  assert.deepEqual(client.file('/Notes/A.md'),resource(workspaceId,'/Notes/A.md'));
  assert.deepEqual(client.directory(),resource(workspaceId,'/','directory'));
  assert.equal((await client.call('getDocument',{path:'Notes/A.md'})).text,'# A');
  assert.equal((await client.call('save',{resource:client.file('/Notes/A.md'),text:'# Edited',hash:'old'})).hash,'new');
  await client.call('create',{resource:client.directory('/Folder'),folder:true});
  assert.equal((await client.call('searchKnowledge',{query:'Edited',enrich:false})).method,'text');
  assert.equal((await client.call('buildEvidenceBundle',{question:'Edited'})).generated,false);
  const count = calls.length;
  for (const op of ['gitStatus','controlPanel','restore','workspaceSession']) await assert.rejects(client.call(op),/does not provide/);
  assert.throws(()=>client.windowAction('minimize'),/unavailable/);
  assert.throws(()=>client.chooseDirectory(),/does not provide/);
  await assert.rejects(client.call('getDocument',{resource:resource('stale-grant','/Notes/A.md')}),/different workspace/);
  assert.equal(calls.length,count,'unavailable features and stale grants are rejected before IPC');
});

test('legacy desktop capability fallback preserves existing hosts', async () => {
  const calls = [];
  const client = await createNativeClient({invoke:async (command,input) => {calls.push({command,input}); return input?.op === 'health' ? {ok:true} : {scope:5};}});
  assert.deepEqual(client.capabilities,{...desktopCapabilities,resources:false});
  await client.choose(); await client.call('getDocument',{path:'A.md'});
  assert.equal(calls.at(-1).input.args.path,'A.md'); assert.equal(calls.at(-1).input.args.scope,5);
});

test('native requests started in an old workspace cannot restore its scope or catalog', async () => {
  let scope = 0, finishOldCatalog;
  const client = await createNativeClient({invoke:async (command,input) => {
    if (command === 'choose_workspace') {scope++;return {scope,workspace:{id:'grant-'+scope,name:'Library '+scope}};}
    if (input.op === 'health') return {ok:true,capabilities:{write:true,resources:true}};
    if (input.op === 'catalog') return new Promise(resolve=>{finishOldCatalog=resolve;});
    if (input.op === 'getDocument') return {scope:input.args.scope,path:input.args.resource.logicalPath};
    throw new Error('Unexpected operation');
  }});
  await client.choose();
  const oldRequest = client.call('catalog');
  await client.choose();
  finishOldCatalog({scope:1,workspace:{id:'grant-1',name:'Library 1'}});
  await assert.rejects(oldRequest,/workspace changed/);
  assert.equal(client.workspace.id,'grant-2');
  assert.equal((await client.call('getDocument',{path:'A.md'})).scope,2);
});

test('reader catalogs expose logical resources and reject references after choosing another library', async t => {
  const reader = createReaderClient({root:'Example',documents:[{path:'Notes/A.md',title:'A',text:'# A'}],folders:['Notes'],otherFiles:[{path:'Notes/diagram.svg'}]});
  const catalog = await reader.call('catalog'), grant = catalog.workspace.id;
  assert.deepEqual(catalog.workspace.directory,resource(grant,'/','directory'));
  assert.deepEqual(catalog.tree.directories,[resource(grant,'/Notes','directory')]);
  assert.deepEqual(catalog.tree.files[0].resource,resource(grant,'/Notes/A.md'));
  assert.deepEqual(catalog.tree.otherFiles[0].resource,resource(grant,'/Notes/diagram.svg'));
  const original = reader.file('/Notes/A.md');
  assert.equal((await reader.call('getDocument',{resource:original})).text,'# A');
  const previous = Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement() {return {files:[{name:'B.md',webkitRelativePath:'New library/Subfolder/B.md',text:async ()=>'# B'}],setAttribute(){},click(){queueMicrotask(()=>this.onchange());}};}}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
  const next = await reader.choose();
  assert.notEqual(next.workspace.id,grant);
  assert.equal(next.tree.files[0].resource.logicalPath,'/Subfolder/B.md');
  await assert.rejects(reader.call('getDocument',{resource:original}),/different workspace/);
  assert.equal((await reader.call('getDocument',{resource:reader.file('/Subfolder/B.md')})).title,'B');
});
