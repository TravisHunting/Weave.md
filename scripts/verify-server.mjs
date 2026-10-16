// Real headless binary, HTTP boundary and shared browser UI. All fixtures are local.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import http from 'node:http';
import {launchBrowser, menuItem, recordBlockedStyleAttributes, blockedStyleElementMessage} from '../app/weave/test-browser.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-server-'));
const root = path.join(temporary, 'workspaces'), data = path.join(temporary, 'data');
const primary = process.argv.includes('--primary') || !!process.env.WEAVE_SERVER_PRIMARY;
const binary = process.env.WEAVE_SERVER || path.join(process.env.CARGO_TARGET_DIR || path.join(ROOT, 'src-tauri/target'), 'debug', primary ? (process.platform === 'win32' ? 'weave.exe' : 'weave') : (process.platform === 'win32' ? 'weave-server.exe' : 'weave-server'));
const output = path.join(ROOT, 'test-results'); await fs.mkdir(output, {recursive: true});
await fs.mkdir(path.join(root, 'Alpha'), {recursive: true}); await fs.mkdir(path.join(root, 'Beta'));
await fs.writeFile(path.join(root, 'Alpha', 'Overview.md'), '# Alpha overview\n\nA lighthouse. [Store](./Store.md "writes-to")\n');
await fs.writeFile(path.join(root, 'Alpha', 'Store.md'), '# Store\n\nAlpha storage.\n');
await fs.writeFile(path.join(root, 'Beta', 'Plan.md'), '# Beta plan\n\nAnother lighthouse.\n');
await fs.writeFile(path.join(root, 'Alpha', 'Board.md'), '---\ntype: Kanban Board\nweave:\n  kanban:\n    columns:\n      - id: todo\n        title: To do\n      - id: done\n        title: Done\n---\n# Board\n');
await fs.writeFile(path.join(root, 'Alpha', 'Card.md'), '---\ntype: Note\nweave:\n  kanban:\n    board: Board.md\n    column: todo\n    rank: 1000\n---\n# Card\n');
let child, base, instance, browser, cookie = '', csrf = '', password = 'updated test password';
async function authenticate(name, secret) {
  const response = await fetch(base + '/api/auth', {method:'POST', headers:{Origin:base,'Content-Type':'application/json','X-Weave-Request':'1'}, body:JSON.stringify({op:'login',args:{username:name,password:secret}})});
  assert.equal(response.status,200,await response.clone().text());
  const setCookie = response.headers.get('set-cookie'); assert.match(setCookie,/HttpOnly/); assert.match(setCookie,/SameSite=Strict/);
  cookie = setCookie.split(';')[0];
  const status = await fetch(base + '/auth/status',{headers:{Cookie:cookie}}).then(r=>r.json()); csrf = status.csrf;
  return response.json();
}
async function start(port = 0) {
  let log = '';
  child = spawn(binary, [...(primary ? ['server'] : []),'--host','127.0.0.1','--port',String(port),'--workspaces',root,'--data',data], {windowsHide: true, env: {...process.env, DISPLAY:'', WAYLAND_DISPLAY:'', WEBVIEW2_BROWSER_EXECUTABLE_FOLDER:path.join(temporary,'no-webview-runtime')}, stdio: ['ignore','pipe','pipe']});
  child.stdout.on('data', chunk => log += chunk); child.stderr.on('data', chunk => log += chunk);
  child.on('error', error => log += error.message);
  await until(async () => {const match = log.match(/listening on (http:\/\/[^\s]+)/); if (match) {base = match[1]; return true;} if (child.exitCode != null) throw new Error(log);}, 'server start');
  const unauthenticated = await raw('health',{}, {Cookie:''}); assert.equal(unauthenticated.status,401);
  const status = await fetch(base + '/auth/status').then(r=>r.json());
  if (status.setup) {
    assert.match(log,/create one/,'a new installation asks for browser setup');
    assert.equal((await fetch(base + '/auth/status',{headers:{Cookie:'weave-session='+'a'.repeat(64)}}).then(r=>r.json())).setup,true,'a stale cookie from another server still reaches setup');
    assert.equal(await fs.stat(path.join(data,'auth','initial-credentials')).catch(()=>null),null,'no generated credentials');
    assert.equal((await raw('setup',{username:'admin',password:'short'},{},'/api/auth')).status,400,'setup enforces the password policy');
    const created = await raw('setup',{username:'admin',password},{Origin:base},'/api/auth'); assert.equal(created.status,200,JSON.stringify(created));
    assert.equal((await raw('setup',{username:'intruder',password:'another long password'},{},'/api/auth')).status,400,'setup closes once an administrator exists');
    assert.equal((await fetch(base + '/auth/status').then(r=>r.json())).setup,false);
  }
  await authenticate('admin',password);
  const health = await raw('health'); assert.equal(health.status, 200); instance = health.value.instance;
}
async function stop() {
  if (child && child.exitCode == null && child.signalCode == null) {
    const ended = once(child, 'exit'); let timedOut=false;
    const deadline=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},30000);
    child.kill('SIGTERM'); await ended; clearTimeout(deadline);
    assert(!timedOut,'server did not finish graceful shutdown within 30 seconds');
  }
}
async function raw(op, args = {}, headers = {}, endpoint = '/api/request') {
  let response;
  try { response = await fetch(base + endpoint, {method:'POST', signal:AbortSignal.timeout(30000), headers:{Origin:base,'Content-Type':'application/json','X-Weave-Request':'1',Cookie:cookie,'X-Weave-CSRF':csrf,...(instance ? {'X-Weave-Instance':instance} : {}),...headers}, body:JSON.stringify({op,args})}); }
  catch(error) {throw new Error(`${op} HTTP request failed: ${error.message}`,{cause:error});}
  return {status:response.status, value:await response.json()};
}
async function call(op, args = {}) {const result = await raw(op,args); assert.equal(result.status,200,JSON.stringify(result)); return result.value;}
async function until(test, label, timeout = 20000) {
  const start = Date.now(); while (Date.now() - start < timeout) {if (await test()) return; await new Promise(r=>setTimeout(r,75));} throw new Error('Timed out: ' + label);
}
const errors = [];
try {
  const help = spawnSync(binary, [...(primary ? ['server'] : []),'--help'], {encoding:'utf8',windowsHide:true});
  assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/--workspaces/);
  const alias = spawnSync(binary, ['--server','--help'], {encoding:'utf8',windowsHide:true});
  assert.equal(alias.status,0);assert.equal(alias.stdout,help.stdout);
  await start();
  assert.equal((await raw('health',{}, {'X-Weave-CSRF':''})).status,403);
  assert.equal((await raw('health',{}, {Cookie:'weave-session=forged'})).status,401);
  assert.equal((await raw('login',{username:'admin',password:'wrong'}, {},'/api/auth')).status,401);
  assert.equal((await fetch(base)).status,200);
  assert.equal((await fetch(base,{headers:{'Sec-Fetch-Site':'cross-site'}})).status,200,'gateway redirects and external links can navigate to the page');
  assert.equal((await raw('health', {}, {Origin:'https://evil.example'})).status,403);
  assert.equal((await raw('health', {}, {'X-Weave-Request':''})).status,403);
  assert.equal((await raw('health', {}, {Origin:''})).status,403);
  assert.equal((await raw('health', {}, {'Sec-Fetch-Site':'cross-site'})).status,403);
  const hosted = (url, headers, method = 'GET') => new Promise((resolve,reject)=>{const req=http.request(url,{method,headers},response=>{response.resume();resolve(response.statusCode);});req.on('error',reject);req.end(method==='POST'?JSON.stringify({op:'health',args:{}}):undefined);});
  assert.equal(await hosted(base,{Host:'notes.example.org'}),200,'any host name is served by default (reverse proxies, LAN names)');
  assert.equal(await hosted(base + '/api/request',{Host:'notes.example.org',Origin:'https://notes.example.org','Content-Type':'application/json','X-Weave-Request':'1'},'POST'),401,'an API call from a page on that host reaches authentication');
  assert.equal(await hosted(base + '/api/request',{Host:'notes.example.org',Origin:base,'Content-Type':'application/json','X-Weave-Request':'1'},'POST'),403,'API calls must come from a page on the requested host');
  assert.equal(await hosted(base,{Host:'bad/host'}),403);
  {
    const strict = spawn(binary, [...(primary ? ['server'] : []),'--host','127.0.0.1','--port','0','--workspaces',path.join(temporary,'strict-workspaces'),'--data',path.join(temporary,'strict-data'),'--allowed-hosts','local'], {windowsHide:true, env:{...process.env, DISPLAY:'', WAYLAND_DISPLAY:''}, stdio:['ignore','pipe','pipe']});
    let strictLog = ''; strict.stdout.on('data', chunk => strictLog += chunk);
    try {
      await until(() => /listening on http:\/\/[^\s]+/.test(strictLog), 'strict server start');
      const strictBase = strictLog.match(/listening on (http:\/\/[^\s]+)/)[1];
      assert.equal(await hosted(strictBase,{Host:'rebind.example'}),403,'--allowed-hosts local rejects other host names');
      assert.equal(await hosted(strictBase,{}),200);
    } finally {strict.kill();}
  }
  assert.equal((await fetch(base + '/api/request?op=health')).status,404);
  assert.equal((await fetch(base + '/data/weave.sqlite')).status,404);
  assert.equal((await raw('serverOpen', {name:'../escape',create:true})).status,409);
  const a = await call('serverOpen',{name:'Alpha'}), b = await call('serverOpen',{name:'Beta'});
  assert.notEqual(a.workspace.id,b.workspace.id);
  assert.equal(a.root,'Alpha');
  assert.equal((await raw('getDocument',{path:'Overview.md'})).status,409);
  assert.equal((await raw('getDocument',{scope:b.scope,path:'Overview.md'})).status,409);
  assert.equal((await raw('getDocument',{scope:a.scope,path:'../Beta/Plan.md'})).status,409);
  assert.equal((await raw('getDocument',{scope:a.scope,resource:{workspaceId:b.workspace.id,logicalPath:'/Plan.md',kind:'file'}})).status,409);
  for (const op of ['server_control','serverControl','open','restore','shutdown','configureStorage','revealPath','gitAction','exportWorkspace','workspaceLayout','workspaceSession','close']) assert.equal((await raw(op,{scope:a.scope})).status,409,op);
  const panel = await call('controlPanel');
  assert(!JSON.stringify(panel).includes(temporary)); assert(!('database' in panel));
  const deletion = await call('configureDeletion',{backups:false});
  assert(!JSON.stringify(deletion).includes(temporary)); assert(!('pendingDataDirectory' in deletion));
  await until(async () => (await call('status',{scope:a.scope})).graph === 'ready','indexing');
  const search = await call('searchKnowledge',{scope:a.scope,query:'lighthouse'});
  assert(JSON.stringify(search).includes('Overview.md')); assert(!JSON.stringify(search).includes('Plan.md'));
  const graph = await call('graphNeighborhood',{scope:a.scope,path:'Overview.md',depth:1,limit:30});
  assert(graph.chunks.length); assert(JSON.stringify(graph).includes('Store.md'));
  await call('create',{scope:a.scope,path:'Fresh.md',text:'# Fresh\n\nOriginal.\n'});
  const old = await call('getDocument',{scope:a.scope,path:'Fresh.md'});
  await call('save',{scope:a.scope,path:'Fresh.md',text:'# Fresh\n\nSaved.\n',hash:old.hash});
  assert.equal((await raw('save',{scope:a.scope,path:'Fresh.md',text:'overwrite',hash:old.hash})).status,409);
  await call('copy',{scope:a.scope,from:'Fresh.md',to:'Copied.md'});
  const preview = await call('renamePreview',{scope:a.scope,from:'Copied.md',to:'Renamed.md'});
  await call('rename',{scope:a.scope,token:preview.token,updateLinks:true});
  await call('delete',{scope:a.scope,path:'Renamed.md',confirmed:true});
  assert.equal((await raw('getDocument',{scope:a.scope,path:'Renamed.md'})).status,409);
  const card = await call('getDocument',{scope:a.scope,path:'Card.md'});
  await call('kanbanSave',{scope:a.scope,writes:[{path:'Card.md',text:card.text.replace('column: todo','column: done'),hash:card.hash}]});
  assert(JSON.stringify(await call('kanbanBoard',{scope:a.scope,path:'Board.md'})).includes('done'));
  await fs.writeFile(path.join(root,'Alpha','External.md'),'# Watched change\n\nExternalquartz.\n');
  await until(async()=>JSON.stringify(await call('searchKnowledge',{scope:a.scope,query:'Externalquartz'})).includes('External.md'),'watcher');
  // Linked workspace roots and linked files must never create filesystem grants.
  await fs.symlink(path.join(root,'Beta'),path.join(root,'Linked'),process.platform==='win32'?'junction':'dir');
  assert.equal((await raw('serverOpen',{name:'Linked'})).status,409);
  await fs.symlink(path.join(root,'Beta'),path.join(root,'Alpha','Linked'),process.platform==='win32'?'junction':'dir');
  assert.equal((await raw('getDocument',{scope:a.scope,path:'Linked/Plan.md'})).status,409);
  const exportResponse = await fetch(base + '/api/export',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Weave-Request':'1','X-Weave-Instance':instance,Cookie:cookie,'X-Weave-CSRF':csrf},body:JSON.stringify({op:'export',args:{scope:a.scope,folder:'',graph:true,path:path.join(temporary,'forbidden.html'),template:'injected'}})});
  assert.equal(exportResponse.status,200); const exported = await exportResponse.text();
  assert(Number(exportResponse.headers.get('x-weave-documents')) >= 5);
  assert(exported.includes('Alpha overview')); assert(!exported.includes('"mode":"server"'));
  assert.equal(await fs.stat(path.join(temporary,'forbidden.html')).catch(()=>null),null);
  const large = await fetch(base+'/api/request',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Weave-Request':'1','X-Weave-Instance':instance,Cookie:cookie,'X-Weave-CSRF':csrf},body:' '.repeat(8*1024*1024+1)});
  assert.equal(large.status,413);

  browser = await launchBrowser();
  const context = await browser.newContext({viewport:{width:1500,height:1000}});
  // Plain HTTP to a LAN address is not a secure context: crypto.randomUUID is absent there.
  await context.addInitScript(() => {delete Crypto.prototype.randomUUID;});
  const page = await context.newPage();
  page.on('pageerror', e=>errors.push(e.message));
  page.on('console', m=>{if(m.type()==='error'&&!blockedStyleElementMessage(m.text())) errors.push(m.text());});
  await page.addInitScript(recordBlockedStyleAttributes);
  await page.goto(base);
  await page.locator('#login [name=username]').fill('admin');
  await page.locator('#login [name=password]').fill(password);
  await page.screenshot({path:path.join(output,'server-login.png')});
  await page.locator('#login [type=submit]').click();
  await page.locator('[data-tree-path="Overview.md"]').waitFor();
  await page.locator('[data-tree-path="Overview.md"]').click();
  await page.waitForFunction(()=>document.getElementById('note-path').dataset.path==='Overview.md');
  await page.locator('#edit-mode').click();
  await menuItem(page,'source-mode');
  const editor = page.locator('#source-editor .cm-content'); await editor.click();
  await page.keyboard.press('Control+End'); await page.keyboard.type('\nBrowser saved quartz.');
  await page.keyboard.press('Control+s');
  await until(async()=>(await fs.readFile(path.join(root,'Alpha','Overview.md'),'utf8')).includes('Browser saved quartz'),'browser save');
  // A second page can select and deactivate workspaces independently.
  const second = await context.newPage(); await second.goto(base);
  await second.locator('[data-tree-path="Plan.md"]').click();
  await second.waitForFunction(()=>document.getElementById('note-path').dataset.path==='Plan.md');
  await second.locator('[data-panel="settings"]').click();
  await second.locator(`#open-workspaces [data-ws="${a.workspace.id}"] [data-ws-close]`).click();
  await until(async()=>await second.locator('[data-tree-path="Overview.md"]').count()===0,'tab-local deactivation');
  assert(await page.locator('[data-tree-path="Overview.md"]').count());
  await page.reload(); await page.waitForFunction(()=>document.getElementById('note-path').dataset.path==='Overview.md');
  assert(await page.locator('[data-tree-path="Overview.md"]').count());
  await menuItem(page,'source-mode');
  await page.locator('#view-graph').click();
  await page.locator('#graph .graph-node').first().waitFor();
  await page.screenshot({path:path.join(output,'server-graph.png')});
  await page.locator('[data-tree-path="Board.md"]').click();
  await page.locator('#kanban-view').waitFor({state:'visible'});
  await until(async()=>(await page.locator('#kanban-view').innerText()).includes('Card'),'Kanban cards loaded');
  await page.locator('[data-tree-path="Overview.md"]').click();
  await second.reload(); await second.locator('[data-tree-path="Plan.md"]').waitFor();
  assert.equal(await second.locator('[data-tree-path="Overview.md"]').count(),0);
  await menuItem(page,'choose-workspace');
  await page.getByLabel('New workspace folder').fill('Gamma');
  await page.getByRole('button',{name:'Create workspace',exact:true}).click();
  await page.locator('#server-workspace-picker').waitFor({state:'detached'});
  assert((await fs.stat(path.join(root,'Gamma'))).isDirectory());
  assert(await page.locator('#window-controls').isHidden());
  assert.deepEqual(await page.evaluate(()=>window.__blockedStyles),[]);
  await page.screenshot({path:path.join(output,'server-workspaces.png')});
  await second.screenshot({path:path.join(output,'server-independent-tab.png')});
  assert.deepEqual(errors,[]);
  const ids = (await call('controlPanel')).workspaces.map(w=>w.id);
  await call('configureWorkspace',{id:a.workspace.id,name:'Alpha notes',color:'#123456'});
  const oldInstance = instance, port = Number(new URL(base).port);
  await stop(); await start(port);
  assert.notEqual(instance,oldInstance);
  assert.equal((await raw('status',{scope:a.scope},{'X-Weave-Instance':oldInstance})).status,409);
  const restored = await call('controlPanel'); assert.deepEqual(restored.workspaces.map(w=>w.id).sort(),ids.sort());
  assert.equal(restored.workspaces.find(w=>w.id===a.workspace.id).name,'Alpha notes');
  await page.reload(); await page.locator('[data-tree-path="Overview.md"]').waitFor();
  const current = await call('reopen',{id:a.workspace.id});
  assert((await call('getDocument',{scope:current.scope,path:'Overview.md'})).text.includes('Browser saved quartz'));
  await call('serverRemove',{id:a.workspace.id,confirmed:true});
  assert(!(await call('controlPanel')).workspaces.some(w=>w.id===a.workspace.id));
  assert((await fs.stat(path.join(root,'Alpha','Overview.md'))).isFile());
  await stop(); await start(port);
  assert(!(await call('controlPanel')).workspaces.some(w=>w.id===a.workspace.id));
  assert.equal((await call('serverOpen',{name:'Alpha'})).workspace.id,a.workspace.id);
  const missing = await call('serverOpen',{name:'Unavailable',create:true});
  await fs.rename(path.join(root,'Unavailable'),path.join(temporary,'Unavailable'));
  await stop(); await start(port);
  await page.reload(); await page.locator('[data-tree-path="Overview.md"]').waitFor();
  await menuItem(page,'choose-workspace');
  const unavailable = page.getByRole('button',{name:'Unavailable',exact:true});
  assert(await unavailable.isDisabled(),'missing registrations remain removable in the picker');
  page.once('dialog',dialog=>dialog.dismiss());
  await unavailable.locator('..').getByRole('button',{name:'Remove from server'}).click();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await call('serverRemove',{id:missing.workspace.id,confirmed:true});
  assert((await fs.stat(path.join(temporary,'Unavailable'))).isDirectory());
  const currentCookie=cookie;
  const pendingBody=JSON.stringify({op:'health',args:{}});
  let pendingRequest;
  const pendingResponse=new Promise((resolve,reject)=>{pendingRequest=http.request(base+'/api/request',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','Content-Length':Buffer.byteLength(pendingBody),'X-Weave-Request':'1',Cookie:cookie,'X-Weave-CSRF':csrf}},response=>{response.resume();resolve(response.statusCode);});pendingRequest.on('error',reject);pendingRequest.write(pendingBody.slice(0,1));});
  await new Promise(resolve=>setTimeout(resolve,100));
  const passwordFile=path.join(temporary,'password'); await fs.writeFile(passwordFile,'replacement test password');
  const reset=spawnSync(binary,[...(primary?['server']:[]),'admin','reset-password','--data',data,'--password-file',passwordFile],{encoding:'utf8',windowsHide:true}); assert.equal(reset.status,0,reset.stderr);
  pendingRequest.end(pendingBody.slice(1));assert.equal(await pendingResponse,401,'reset revokes a request whose body is still arriving');
  assert.equal((await raw('health',{}, {Cookie:currentCookie})).status,401,'CLI reset revokes active sessions');
  await page.reload(); await page.locator('#login').waitFor({state:'visible'});
  await authenticate('admin','replacement test password');
  const secretFile=path.join(temporary,'turnstile-secret'); await fs.writeFile(secretFile,'server-only-test-secret');
  const configure=(...args)=>spawnSync(binary,[...(primary?['server']:[]),'admin','turnstile','--data',data,...args],{encoding:'utf8',windowsHide:true});
  const enabled=configure('--enabled','true','--site-key','public-test-key','--hostname','localhost','--secret-file',secretFile);assert.equal(enabled.status,0,enabled.stderr);
  const publicStatus=await fetch(base+'/auth/status').then(r=>r.json());assert.equal(publicStatus.turnstile.siteKey,'public-test-key');assert(!JSON.stringify(publicStatus).includes('server-only-test-secret'));
  const localStatus=spawnSync(binary,[...(primary?['server']:[]),'admin','status','--data',data],{encoding:'utf8',windowsHide:true});assert.equal(localStatus.status,0);assert(!localStatus.stdout.includes('server-only-test-secret'));
  assert.equal((await raw('health')).status,401,'Turnstile configuration revokes existing sessions');
  assert.equal((await raw('login',{username:'admin',password:'replacement test password'}, {},'/api/auth')).status,401,'Turnstile is required even with a valid password');
  const disabled=configure('--enabled','false');assert.equal(disabled.status,0,disabled.stderr);await authenticate('admin','replacement test password');
  assert.equal((await raw('logout',{}, {},'/api/auth')).status,200);
  assert.equal((await raw('health')).status,401,'logout revokes session');
  let throttled=false;
  for(let i=0;i<11;i++) {const result=await raw('login',{username:'admin',password:'incorrect'}, {},'/api/auth');if(result.status===429){throttled=true;break;}assert.equal(result.status,401);}
  assert(throttled,'login attempts are throttled');
  console.log('Weave Server HTTP security, CRUD, search, graph, Kanban, watcher, export, browser editing, independent tabs and restart persistence passed.');
} finally {
  await browser?.close(); await stop();
  // Windows junction fixtures must be unlinked before recursive fixture cleanup.
  for(const target of [path.join(root,'Linked'),path.join(root,'Alpha','Linked')]) await fs.unlink(target).catch(()=>{});
  await fs.rm(temporary,{recursive:true,force:true,maxRetries:4});
}
