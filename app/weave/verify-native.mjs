// Diagnostic-only loopback CDP is injected into the child WebView2 process on
// Windows; on Linux, WebKit's WebDriver drives the app on a test display.
// Production Weave starts no HTTP/debug listener. Every launch below uses a
// copied executable and private LocalAppData, never an existing user's .weave.
import fs from 'node:fs/promises';
import {existsSync, readFileSync, realpathSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import {ROOT} from './build.mjs';
import {launchBrowser, menuItem} from './test-browser.mjs';

assert(process.argv[2], 'Pass the path to a freshly built Weave executable');
const linux = process.platform === 'linux';
// --quick (development builds) launches twice instead of eight times: it skips
// window restoration, the desktop-hosted server and data relocation.
const quick = process.argv.includes('--quick');
const sourceExecutable = path.resolve(process.argv[2]);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-native-'));
const executable = path.join(temporary, path.basename(sourceExecutable));
const localAppData = path.join(temporary, 'LocalAppData');
const runtime = path.join(localAppData, 'Weave', '.weave');
const statePath = path.join(runtime, 'window-state.json');
const output = path.join(ROOT, 'test-results');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let current;

async function freePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

const isolatedEnvironment = {...process.env, PATH: '', NODE_PATH: '', NODE_OPTIONS: '', RUST_BACKTRACE: '1',
  ...(linux ? {XDG_DATA_HOME: localAppData} : {LOCALAPPDATA: localAppData})};

// WebKitGTK has no DevTools protocol; WebKit's WebDriver starts and drives the
// real app instead (Tauri allows it only with TAURI_WEBVIEW_AUTOMATION set).
async function launchLinux({graphFixture = false, expectedRuntime = runtime} = {}) {
  const port = await freePort();
  const driver = spawn('/usr/bin/WebKitWebDriver', [`--port=${port}`], {
    cwd: temporary, env: {...isolatedEnvironment, TAURI_WEBVIEW_AUTOMATION: 'true'}, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let nativeLog = '', session, pid;
  driver.stdout.on('data', data => {nativeLog += data;});
  driver.stderr.on('data', data => {nativeLog += data;});
  const request = async (method, route, body) => {
    let response;
    try {response = await fetch(`http://127.0.0.1:${port}${route}`, {method, headers: {'content-type': 'application/json'}, body: body && JSON.stringify(body), signal: AbortSignal.timeout(20000)});} catch (error) {throw new Error(`WebDriver ${method} ${route}: ${error.message} ${nativeLog}`,{cause:error});}
    const result = await response.json();
    if (!response.ok) throw new Error(`WebDriver ${method} ${route}: ${JSON.stringify(result.value).slice(0, 600)} ${nativeLog}`);
    return result.value;
  };
  const running = () => pid !== undefined && existsSync(`/proc/${pid}`) && !readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ');
  const dispose = async () => {
    if (session) await request('DELETE', `/session/${session}`).catch(() => {});
    if (running()) process.kill(pid);
    if (driver.exitCode === null) driver.kill();
    await new Promise(resolve => {if (driver.exitCode !== null) resolve(); else driver.once('exit', resolve);});
  };
  try {
    for (let attempt = 0; attempt < 100 && !session; attempt++) {
      if (driver.exitCode !== null) throw new Error(`WebKitWebDriver exited: ${driver.exitCode} ${nativeLog}`);
      try {
        session = (await request('POST', '/session', {capabilities: {alwaysMatch: {'webkitgtk:browserOptions': {binary: executable, args: []}}}})).sessionId;
      } catch (error) {if (!/ECONNREFUSED|fetch failed/.test(error.cause?.code || error.message)) throw error; await pause(100);}
    }
    assert(session, `WebKitWebDriver did not start a session: ${nativeLog}`);
    const evaluate = async expression => {
      const script = `const done = arguments[arguments.length - 1];
        (async () => (${expression}))().then(value => done({value}), error => done({error: String(error && error.stack || error)}));`;
      const result = await request('POST', `/session/${session}/execute/async`, {script, args: []});
      if (result?.error) throw new Error(result.error);
      return result?.value;
    };
    return await connected({graphFixture, expectedRuntime, evaluate, dispose,
      setPid: value => {pid = value; assert.equal(realpathSync(`/proc/${pid}/exe`), realpathSync(executable), 'IPC executes inside the copied weave');},
      screenshotData: () => request('GET', `/session/${session}/screenshot`),
      exited: async () => {
        for (let attempt = 0; attempt < 80 && running(); attempt++) await pause(100);
        // The app is WebKitWebDriver's child, so only its exit (not its status) is visible here.
        assert(!running(), 'custom close control exits: ' + nativeLog);
        session = undefined;
      }});
  } catch (error) {
    await dispose();
    throw error;
  }
}

// Checks shared by both platforms once the native page answers evaluate().
async function connected({graphFixture, expectedRuntime, evaluate, dispose, setPid, screenshotData, exited}) {
  const state = () => evaluate("window.__TAURI__.core.invoke('window_action',{action:'state'})");
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const waitState = async (predicate, message) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const value = await state();
      if (predicate(value)) return value;
      await pause(100);
    }
    assert.fail(`${message}: ${JSON.stringify(await state())}`);
  };
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    ready = await evaluate(graphFixture ? "!!document.querySelector('[data-tree-path=\"Start.md\"]')" : "document.getElementById('tree')?.textContent.includes('Choose a Markdown workspace')");
    if (ready) break;
    await pause(100);
  }
  assert(ready, 'Native frontend did not initialize: ' + await evaluate("document.getElementById('message')?.textContent"));
  assert.equal(await evaluate('document.title'), 'Weave');
  const initial = await state();
  assert.equal(initial.decorated, false, 'native title bar is disabled');
  assert.equal(await evaluate("document.getElementById('window-controls').hidden"), false);
  const health = await evaluate("window.__TAURI__.core.invoke('weave_request',{op:'health',args:{}})");
  assert.equal(health.ok, true, health.error);
  assert.equal(health.backend, 'rust');setPid(health.pid);
  assert.equal(health.capabilities.fts,true);
  assert.equal(path.resolve(health.runtime), expectedRuntime, 'native service uses the selected application data folder');
  assert.equal(await evaluate("document.getElementById('message').textContent"), '');
  return {
    state, click, waitState, dispose, evaluate,
    // Diagnostic escape hatch for WebKitWebDriver builds whose screenshot endpoint hangs under Xvfb. Geometry and all functional assertions still run.
    screenshot: async filename => {if (linux && process.argv.includes('--skip-screenshots')) {console.log('Native screenshot skipped: '+filename);return;} await fs.writeFile(path.join(output, filename), Buffer.from(await screenshotData(), 'base64'));},
    close: async () => {
      // The window closes while the click is reported, so a lost reply is expected.
      await click('window-close').catch(() => {});
      await exited();
      await dispose();
    },
  };
}

async function launch(options) {
  if (linux) return launchLinux(options);
  const {graphFixture = false, expectedRuntime = runtime} = options || {};
  const port = await freePort();
  const child = spawn(executable, [], {
    cwd: temporary,
    windowsHide: true,
    env: {...isolatedEnvironment, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let nativeLog = '', socket, serial = 0;
  const pending = new Map();
  child.stdout.on('data', data => {nativeLog += data;});
  child.stderr.on('data', data => {nativeLog += data;});
  const dispose = async () => {
    socket?.close();
    for (const item of pending.values()) clearTimeout(item.timer);
    if (child.exitCode === null) child.kill();
    await new Promise(resolve => {if (child.exitCode !== null) resolve(); else child.once('exit', resolve);});
  };
  try {
    let target, lastTargets = [], connectionError = '';
    for (let attempt = 0; attempt < 300; attempt++) {
      if (child.exitCode !== null) throw new Error(`Weave exited at startup: ${child.exitCode} ${nativeLog}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        lastTargets = await response.json();
        target = lastTargets.find(item => /tauri/.test(item.url));
        if (target) break;
      } catch (error) {connectionError = error.message;}
      await pause(100);
    }
    assert(target, `Native Weave WebView was not found: ${nativeLog} targets=${JSON.stringify(lastTargets)} connection=${connectionError}`);
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {socket.onopen = resolve; socket.onerror = reject;});
    socket.onmessage = event => {
      const value = JSON.parse(event.data), item = pending.get(value.id);
      if (!item) return;
      pending.delete(value.id);
      clearTimeout(item.timer);
      value.error ? item.reject(new Error(JSON.stringify(value.error))) : item.resolve(value.result);
    };
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {pending.delete(id); reject(new Error(`Native CDP timeout ${method} ${JSON.stringify(params).slice(0,600)} ${nativeLog}`));}, 15000);
      pending.set(id, {resolve, reject, timer});
      socket.send(JSON.stringify({id, method, params}));
    });
    const evaluate = async expression => {
      const result = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    return await connected({graphFixture, expectedRuntime, evaluate, dispose,
      setPid: value => assert.equal(value, child.pid, 'IPC executes inside Weave.exe'),
      screenshotData: async () => (await call('Page.captureScreenshot', {format: 'png'})).data,
      exited: async () => {
        for (let attempt = 0; attempt < 80 && child.exitCode === null; attempt++) await pause(100);
        assert.equal(child.exitCode, 0, 'custom close control exits cleanly: ' + nativeLog);
      }});
  } catch (error) {
    await dispose();
    throw error;
  }
}

function assertGeometry(actual, expected, message) {
  for (const [field, value] of Object.entries(expected)) {
    const observed = field === 'x' || field === 'y' ? actual.position[field] : actual.size[field];
    assert(Math.abs(observed - value) <= 2, `${message} ${field}: expected ${value}, got ${observed}`);
  }
}

try {
  await fs.copyFile(sourceExecutable, executable);
  await fs.mkdir(output, {recursive: true});
  // Only the executable is copied: no sidecar, runtime, or adjacent resources.
  current = await launch();
  const initial = await current.state();
  assert.equal(initial.maximized, false, 'fresh isolated app starts normally');
  await current.screenshot('weave-native-startup.png');
  await current.evaluate("document.querySelector('[data-panel=\"settings\"]').click()");
  for(let i=0;i<30&&!await current.evaluate("document.getElementById('database-directory').textContent.includes('Weave')");i++)await pause(100);
  assert.equal(await current.evaluate("document.getElementById('database-directory').textContent"),runtime);
  await current.screenshot('weave-native-storage-settings.png');
  await current.close(); current = null;
  const original = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(original.maximized, false);
  assertGeometry(initial, original.normal, 'normal close persists the native window bounds');

  if (!quick) {
    // Seed a visibly different valid normal size within the current window's work
    // area, then verify the actual native bounds on restart, not just saved JSON.
    const normal = {
      width: Math.max(Math.min(original.normal.width, Math.round(800 * original.scale_factor)), original.normal.width - Math.round(180 * original.scale_factor)),
      height: Math.max(Math.min(original.normal.height, Math.round(600 * original.scale_factor)), original.normal.height - Math.round(100 * original.scale_factor)),
    };
    normal.x = original.normal.x + Math.floor((original.normal.width - normal.width) / 2);
    normal.y = original.normal.y + Math.floor((original.normal.height - normal.height) / 2);
    await fs.writeFile(statePath, JSON.stringify({...original, normal}));
    current = await launch();
    assertGeometry(await current.state(), normal, 'normal size and position restored');
    await current.click('window-maximize');
    await current.waitState(value => value.maximized, 'custom maximize control');
    await current.close(); current = null;
    const maximized = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(maximized.maximized, true, 'close remembers maximized state');
    assert.deepEqual(maximized.normal, normal, 'maximizing preserves the normal restore bounds');

    current = await launch();
    await current.waitState(value => value.maximized, 'restart restores maximized state');
    await current.screenshot('weave-native-restored-maximized.png');
    await current.click('window-maximize');
    const restored = await current.waitState(value => !value.maximized, 'custom restore control');
    assertGeometry(restored, normal, 'restoring a maximized restart keeps the original normal bounds');
    await current.click('window-maximize');
    await current.waitState(value => value.maximized, 'maximize before minimizing');
    await current.click('window-minimize');
    await current.waitState(value => value.minimized, 'custom minimize control');
    await current.close(); current = null;
    assert.equal(JSON.parse(await fs.readFile(statePath, 'utf8')).maximized, true, 'minimizing preserves maximize-on-restore intent');

    current = await launch();
    await current.waitState(value => value.maximized && !value.minimized, 'minimized app reopens visibly maximized');
    await current.click('window-maximize');
    assertGeometry(await current.waitState(value => !value.maximized, 'restore from maximized'), normal, 'minimized close preserves normal bounds');
    await current.close(); current = null;

    current = await launch();
    assert.equal((await current.state()).maximized, false, 'last normal state wins over earlier maximization');
    assertGeometry(await current.state(), normal, 'normal placement persists across repeated launches');
    await current.close(); current = null;
  }

  // Exercise the actual Tauri Channel and Rust adjacency cache. The browser
  // harness deliberately has no Channel and verifies the standalone fallback.
  const serverRoot=path.join(temporary,'server-workspaces');await fs.mkdir(serverRoot);
  const graphRoot=path.join(serverRoot,'graph-workspace');await fs.mkdir(graphRoot);
  await fs.writeFile(path.join(graphRoot,'Start.md'),'# Start\n\n[First](First.md)\n');
  await fs.writeFile(path.join(graphRoot,'First.md'),'# First\n\n[Second](Second.md)\n');
  await fs.writeFile(path.join(graphRoot,'Second.md'),'# Second\n\n[Third](Third.md)\n');
  await fs.writeFile(path.join(graphRoot,'Third.md'),'# Third\n');
  const otherRoot=path.join(temporary,'elsewhere','graph-workspace');await fs.mkdir(otherRoot,{recursive:true});await fs.writeFile(path.join(otherRoot,'Other.md'),'# Other');
  const database=new DatabaseSync(path.join(runtime,'weave.sqlite'));database.prepare("INSERT OR REPLACE INTO settings VALUES('lastWorkspace',?)").run(JSON.stringify(graphRoot));database.prepare("INSERT OR REPLACE INTO settings VALUES('workspaceLayout',?)").run(JSON.stringify({open:[graphRoot,otherRoot]}));database.close();
  current=await launch({graphFixture:true});
  const graphUI=await current.evaluate(`(async()=>{
    const pause=()=>new Promise(r=>setTimeout(r,50));
    for(let i=0;i<100&&!document.getElementById('index-status').textContent.includes('4 articles');i++)await pause();
    document.querySelector('[data-tree-path="Start.md"]').click();
    for(let i=0;i<100&&document.getElementById('note-panel').hidden;i++)await pause();
    document.getElementById('view-graph').click();
    for(let i=0;i<100&&document.getElementById('graph-panel').dataset.graphComplete!=='true';i++)await pause();
    const depth=document.getElementById('graph-depth');depth.value='3';depth.dispatchEvent(new Event('change',{bubbles:true}));
    for(let i=0;i<100;i++){const panel=document.getElementById('graph-panel');if(panel.dataset.graphComplete==='true'&&panel.dataset.renderedDepth==='3')break;await pause();}
    const visible=()=>{const bounds=document.getElementById('graph').getBoundingClientRect();return [...document.querySelectorAll('#graph-nodes .node-body')].every(node=>{const box=node.getBoundingClientRect();return box.left>=bounds.left&&box.right<=bounds.right&&box.top>=bounds.top&&box.bottom<=bounds.bottom;});};
    for(let i=0;i<30&&!visible();i++)await pause();
    await new Promise(r=>setTimeout(r,250));
    return {complete:document.getElementById('graph-panel').dataset.graphComplete,depth:document.getElementById('graph-panel').dataset.renderedDepth,nodes:document.querySelectorAll('#graph-nodes [data-node]').length,visible:visible(),message:document.getElementById('message').textContent};
  })()`);
  assert.equal(graphUI.complete,'true',graphUI.message);assert.equal(graphUI.depth,'3',graphUI.message);assert.equal(graphUI.nodes,4,graphUI.message);
  assert(graphUI.visible,'all arriving graph layers fit into the native viewport');
  await current.screenshot('weave-native-graph-stream.png');
  const streamed=await current.evaluate(`(async()=>{
    const invoke=window.__TAURI__.core.invoke,catalog=await invoke('weave_request',{op:'restore',args:{}});
    let status;for(let i=0;i<100;i++){status=await invoke('weave_request',{op:'status',args:{scope:catalog.scope}});if(status.documents===4&&status.graph==='ready')break;await new Promise(r=>setTimeout(r,50));}
    const snapshot=await invoke('weave_request',{op:'graph',args:{scope:catalog.scope,summaryOnly:true}}),chunks=[];
    const onChunk=new window.__TAURI__.core.Channel();onChunk.onmessage=chunk=>chunks.push(chunk);
    const args={scope:catalog.scope,revision:snapshot.revision,path:'Start.md',depth:3,direction:'downstream',limit:100,requestId:'native-test'};
    const result=await invoke('weave_graph_neighborhood',{args,onChunk});
    for(let i=0;i<100&&chunks.length<3;i++)await new Promise(r=>setTimeout(r,10));
    // Neighbourhoods are read from the current index in one snapshot, so a revision newer than the reader's is served, not rejected.
    const later=await invoke('weave_graph_neighborhood',{args:{...args,revision:snapshot.revision+1},onChunk:new window.__TAURI__.core.Channel()});
    let otherScopeRejected=false;try{await invoke('weave_graph_neighborhood',{args:{...args,scope:catalog.scope+1000},onChunk:new window.__TAURI__.core.Channel()});}catch{otherScopeRejected=true;}
    return {chunks,result,later,otherScopeRejected,snapshotLinks:snapshot.relationships.length,snapshotNodes:snapshot.entities.length};
  })()`);
  assert.equal(streamed.result.nodes,4);assert.equal(streamed.chunks.length,3);
  assert.equal(streamed.snapshotLinks,0,'full graph relationships stay in Rust');assert.equal(streamed.snapshotNodes,0,'the summary leaves nodes to the stream; titles come from the catalog');
  assert.deepEqual(streamed.chunks.map(chunk=>chunk.nodes.map(node=>node.id)),[['Start.md','First.md'],['Second.md'],['Third.md']]);
  assert.equal(streamed.later.nodes,4,'a revision changed since the summary still streams the current neighbourhood');
  assert(streamed.otherScopeRejected,'native graph rejects a scope that is not open');
  assert(streamed.chunks.at(-1).complete,'native stream marks final depth');
  const editing=await current.evaluate(`(async()=>{
    const invoke=window.__TAURI__.core.invoke,catalog=await invoke('weave_request',{op:'restore',args:{}});
    const call=(op,args={})=>invoke('weave_request',{op,args:{...args,scope:catalog.scope}});
    await call('create',{path:'Native acceptance.md',text:'# Native acceptance\\nportableftsneedle\\n'});
    const doc=await call('getDocument',{path:'Native acceptance.md'});
    await call('save',{path:doc.path,hash:doc.hash,text:doc.text+'updatedftsneedle\\n'});
    let stale=false;try{await call('save',{path:doc.path,hash:doc.hash,text:'stale'});}catch{stale=true;}
    const found=await call('searchKnowledge',{query:'updatedftsneedle'});
    const plan=await call('renamePreview',{from:doc.path,to:'Renamed acceptance.md'});
    await call('rename',{token:plan.token,updateLinks:true});
    const renamed=await call('searchKnowledge',{query:'updatedftsneedle'});
    const removed=await call('delete',{path:'Renamed acceptance.md',confirmed:true});
    const gone=await call('searchKnowledge',{query:'updatedftsneedle'});
    return {stale,found,renamed,removed,gone};
  })()`);
  assert(editing.stale);assert.equal(editing.found.method,'bm25');
  assert.equal(editing.found.results[0].path,'Native acceptance.md');assert(editing.found.results[0].chunkId);
  assert.equal(editing.renamed.results[0].path,'Renamed acceptance.md');assert.equal(editing.gone.results.length,0);
  assert.equal(await fs.readFile(path.join(graphRoot,'Start.md'),'utf8'),'# Start\n\n[First](First.md)\n');
  if (process.argv.includes('--explorer') && process.platform==='win32') {
    const folder=path.join(graphRoot,'Nested folder'),file=path.join(folder,'Selected, note.txt');
    await fs.mkdir(folder);await fs.writeFile(file,'Explorer selection test');
    await current.evaluate(`(async()=>{const invoke=window.__TAURI__.core.invoke,catalog=await invoke('weave_request',{op:'restore',args:{}});return invoke('weave_request',{op:'revealPath',args:{scope:catalog.scope,path:'Nested folder/Selected, note.txt'}});})()`);
    const script=`$shell=New-Object -ComObject Shell.Application
      $wanted=$env:WEAVE_EXPLORER_TEST
      $parent=Split-Path -LiteralPath $wanted
      for($attempt=0;$attempt -lt 50;$attempt++) {
        foreach($window in $shell.Windows()) {
          try {if($window.Document.Folder.Self.Path -eq $parent) {
            $selected=@($window.Document.SelectedItems() | ForEach-Object {$_.Path})
            if($selected -contains $wanted) {$window.Quit();Write-Output 'Selected exact file';exit 0}
          }} catch {}
        }
        Start-Sleep -Milliseconds 200
      }
      foreach($window in $shell.Windows()) {try{if($window.Document.Folder.Self.Path -eq $parent){$window.Quit()}}catch{}}
      throw 'Explorer did not select the requested file'`;
    const result=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,env:{...process.env,WEAVE_EXPLORER_TEST:await fs.realpath(file)}});
    assert.match(result.stdout,/Selected exact file/);
    console.log('Explorer verification passed: selected the exact nested file with spaces and a comma.');
  }
  if (quick) {
    await current.close(); current = null;
    console.log('Quick native verification passed: isolated startup and storage settings, Rust graph streaming, CRUD and chunk FTS5, stale-write rejection and empty PATH. Window restoration, the desktop server and data relocation were skipped.');
  } else {
    // Real desktop listener shares this process and backend, including file locks.
    const invokeServer = (action, settings) => current.evaluate(`window.__TAURI__.core.invoke('server_control', {action:${JSON.stringify(action)}, settings:${JSON.stringify(settings ?? null)}})`);
    const restoredWorkspaces=await current.evaluate("window.__TAURI__.core.invoke('weave_request',{op:'restore',args:{}})");
    const other=restoredWorkspaces.workspaces.find(w=>w.root!==graphRoot && w.workspace.name==='graph-workspace');
    const initialServer=await invokeServer('status');assert.equal(initialServer.settings.workspaces,null);
    const selectedIds=initialServer.workspaceChoices.filter(w=>w.open).map(w=>w.id);assert.equal(selectedIds.length,2);
    const closeSettings=()=>current.evaluate("(async()=>{const dialog=document.getElementById('settings-dialog');const closed=new Promise(r=>dialog.addEventListener('close',r,{once:true}));dialog.close();await closed;})()");
    const openServerSettings=()=>current.evaluate(`(async()=>{document.getElementById('open-settings').click();for(let i=0;i<100;i++){const button=[...document.querySelectorAll('.settings-nav-item')].find(e=>e.textContent==='Web server');if(button){button.click();return;}await new Promise(r=>setTimeout(r,50));}throw new Error('Web server settings did not appear');})()`);
    const settings = {host:'127.0.0.1',port:0,workspaces:selectedIds,origin:'',background:true,username:'admin',password:'native test password'};
    await invokeServer('configure', settings);
    const serving = await invokeServer('start'); assert(serving.running); assert(serving.backgroundAvailable);
    const login=await fetch(serving.url+'/api/auth',{method:'POST',headers:{Origin:serving.url,'Content-Type':'application/json','X-Weave-Request':'1'},body:JSON.stringify({op:'login',args:{username:'admin',password:settings.password}})});
    assert.equal(login.status,200); let cookie=login.headers.get('set-cookie').split(';')[0];
    const authentication=await fetch(serving.url+'/auth/status',{headers:{Cookie:cookie}}).then(r=>r.json());
    const authHeaders={Cookie:cookie,'X-Weave-CSRF':authentication.csrf};
    // Subsequent settings updates preserve the existing password.
    delete settings.password;
    let instance;
    const httpCall = async (op,args={}) => {
      const response=await fetch(serving.url+'/api/request',{method:'POST',headers:{Origin:serving.url,'Content-Type':'application/json','X-Weave-Request':'1',...authHeaders,...(instance?{'X-Weave-Instance':instance}:{})},body:JSON.stringify({op,args})});
      const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
    };
    instance=(await httpCall('health')).instance;
    const serverPanel=await httpCall('controlPanel');assert.equal(serverPanel.managedWorkspaces,true);assert.deepEqual(serverPanel.defaultWorkspaces,selectedIds);assert.equal(serverPanel.workspaces.length,2);
    const shared=serverPanel.workspaces.find(w=>w.id!==other.workspace.id);assert(shared);
    const remote=await httpCall('reopen',{id:shared.id});
    const localRestore=await current.evaluate("window.__TAURI__.core.invoke('weave_request',{op:'restore',args:{}})");
    const local=localRestore.workspaces.find(w=>w.workspace.id===shared.id);
    assert.equal(remote.scope,local.scope,'same workspace and write lock in desktop and HTTP');
    await httpCall('create',{scope:remote.scope,path:'Browser edit.md',text:'# From browser'});
    assert.match(await current.evaluate(`window.__TAURI__.core.invoke('weave_request',{op:'getDocument',args:{scope:${local.scope},path:'Browser edit.md'}}).then(d=>d.text)`),/From browser/);
    const browser=await launchBrowser();
    try {
      const context=await browser.newContext(),page=await context.newPage();
      await context.addCookies([{name:cookie.split('=')[0],value:cookie.split('=')[1],url:serving.url,httpOnly:true,sameSite:'Strict'}]);
      await page.addInitScript(()=>{localStorage.setItem('weave.server.session.v1',JSON.stringify({open:[],sessions:{},layout:{}}));});
      await page.goto(serving.url);
      await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('weave.server.session.v1')||'{}').open?.length===2);
      assert.equal(await page.locator('html').getAttribute('data-scheme'),'lavender');
      assert.equal((await page.locator('html').getAttribute('data-skin')).split(' ').at(-1),'aurora-flow');
      await menuItem(page,'choose-workspace');
      await page.locator('#server-workspace-picker .server-folder-name').first().waitFor();
      assert.equal(await page.locator('#server-workspace-picker .server-folder-name').count(),2);
      assert(await page.locator('#server-workspace-picker [type=submit]').isHidden());
      await page.locator('#server-workspace-picker [data-cancel]').click();
      await page.screenshot({path:path.join(output,'weave-desktop-hosted-browser.png')});
    } finally {await browser.close();}
    await openServerSettings();
    const selectedUI=await current.evaluate("[...document.querySelectorAll('#server-workspaces input:checked')].map(e=>e.value)");assert.deepEqual(selectedUI.sort(),selectedIds.toSorted());
    await current.screenshot('weave-native-server-settings.png');
    await current.click('server-auth-save');
    for(let i=0;i<100&&await current.evaluate("document.getElementById('server-auth-save').disabled");i++)await pause(50);
    assert.equal((await httpCall('health')).ok,true,'blank password preserves credentials and sessions');
    await current.evaluate("document.getElementById('server-username').scrollIntoView({block:'center'});document.getElementById('server-password').value='replacement native password';document.getElementById('server-turnstile-secret').value='private native turnstile secret'");
    await current.screenshot('weave-native-server-authentication.png');
    await current.click('server-auth-save');
    for(let i=0;i<100&&(await invokeServer('status')).authentication.secretConfigured!==true;i++)await pause(50);
    const updatedAuth=await invokeServer('status');assert(updatedAuth.authentication.configured);assert(updatedAuth.authentication.secretConfigured);assert(!JSON.stringify(updatedAuth).includes('private native turnstile secret'));assert(!JSON.stringify(updatedAuth).includes('replacement native password'));
    const revoked=await fetch(serving.url+'/api/request',{method:'POST',headers:{Origin:serving.url,'Content-Type':'application/json','X-Weave-Request':'1',...authHeaders},body:JSON.stringify({op:'health',args:{}})});assert.equal(revoked.status,401,'GUI credentials invalidate browser sessions while running');
    const replacement=await fetch(serving.url+'/api/auth',{method:'POST',headers:{Origin:serving.url,'Content-Type':'application/json','X-Weave-Request':'1'},body:JSON.stringify({op:'login',args:{username:'admin',password:'replacement native password'}})});assert.equal(replacement.status,200);
    cookie=replacement.headers.get('set-cookie').split(';')[0];authHeaders.Cookie=cookie;authHeaders['X-Weave-CSRF']=(await fetch(serving.url+'/auth/status',{headers:{Cookie:cookie}}).then(r=>r.json())).csrf;
    await closeSettings();
    await current.click('window-close'); await pause(400);
    assert.equal(await current.evaluate("window.__TAURI__.core.invoke('window_action',{action:'state'}).then(s=>s.visible)"),false,'close hides to tray');
    assert.equal((await fetch(serving.url+'/healthz')).status,200,'listener remains alive after close');
    const second=spawn(executable,[],{cwd:temporary,env:isolatedEnvironment,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let secondLog='';second.stdout.on('data',data=>secondLog+=data);second.stderr.on('data',data=>secondLog+=data);
    await new Promise((resolve,reject)=>{second.once('error',reject);second.once('exit',code=>code===0?resolve():reject(new Error('second launch failed: '+code+' '+secondLog)));});
    for(let i=0;i<50&&!await current.evaluate("window.__TAURI__.core.invoke('window_action',{action:'state'}).then(s=>s.visible)");i++)await pause(100);
    assert.equal(await current.evaluate("window.__TAURI__.core.invoke('window_action',{action:'state'}).then(s=>s.visible)"),true,'second launch restores background window');
    await openServerSettings();
    await current.click('server-stop');
    for(let i=0;i<50&&(await invokeServer('status')).running;i++)await pause(100);
    assert.equal((await invokeServer('status')).running,false);
    await assert.rejects(fetch(serving.url+'/healthz'),'stop closes listener');
    await current.click('server-start');
    for(let i=0;i<50&&!(await invokeServer('status')).running;i++)await pause(100);
    assert.equal((await invokeServer('status')).running,true,'settings Start button configures and starts');
    await current.click('server-stop');
    for(let i=0;i<50&&(await invokeServer('status')).running;i++)await pause(100);
    assert.equal((await invokeServer('status')).running,false);
    await closeSettings();
    await invokeServer('configure',{...settings,background:false});
    await openServerSettings();
    await current.evaluate("(async()=>{for(let i=0;i<100;i++){if(!document.getElementById('server-save').disabled && !document.getElementById('server-background').checked && [...document.querySelectorAll('#server-workspaces input')].every(e=>!e.disabled))return;await new Promise(r=>setTimeout(r,50));}throw new Error('Stopped settings did not refresh');})()");
    await current.evaluate(`(()=>{const input=[...document.querySelectorAll('#server-workspaces input')].find(e=>e.value===${JSON.stringify(other.workspace.id)});input.checked=false;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await current.click('server-save');
    for(let i=0;i<50&&(await invokeServer('status')).settings.workspaces.length!==1;i++)await pause(100);
    assert.deepEqual((await invokeServer('status')).settings.workspaces,[shared.id],'checkbox selection persists');
    const narrowed=await invokeServer('start');
    const newInstance=await fetch(narrowed.url+'/api/request',{method:'POST',headers:{Origin:narrowed.url,'Content-Type':'application/json','X-Weave-Request':'1',...authHeaders},body:JSON.stringify({op:'health',args:{}})}).then(r=>r.json());
    const selectedPanel=await fetch(narrowed.url+'/api/request',{method:'POST',headers:{Origin:narrowed.url,'Content-Type':'application/json','X-Weave-Request':'1','X-Weave-Instance':newInstance.instance,...authHeaders},body:JSON.stringify({op:'controlPanel',args:{}})}).then(r=>r.json());
    assert.equal(selectedPanel.workspaces.length,1);assert.equal(selectedPanel.workspaces[0].id,shared.id);
    assert.equal((await current.evaluate("window.__TAURI__.core.invoke('weave_request',{op:'restore',args:{}})")).workspaces.length,2,'unselected workspace remains active locally');
    await invokeServer('stop');await closeSettings();
    console.log('Desktop server verification passed: shared scopes and files, background close, second launch restore, stop and restart.');
    const selectedParent=path.join(temporary,'selected-data');await fs.mkdir(selectedParent);
    const scheduled=await current.evaluate(`(async()=>{const invoke=window.__TAURI__.core.invoke,catalog=await invoke('weave_request',{op:'restore',args:{}});return invoke('weave_request',{op:'configureStorage',args:{scope:catalog.scope,dataDirectory:${JSON.stringify(selectedParent)}}});})()`);
    const movedRuntime=path.join(await fs.realpath(selectedParent),'.weave');
    assert.equal(scheduled.restartRequired,true);
    assert.equal(path.resolve(scheduled.pendingDataDirectory),movedRuntime);
    await current.close();current=null;
    assert.equal(await fs.stat(movedRuntime).then(()=>true,()=>false),false,'transfer waits until restart');
    // WebView children can finish flushing their profile after the host exits.
    await pause(2000);
    current=await launch({graphFixture:true,expectedRuntime:movedRuntime});
    assert.equal(await fs.stat(path.join(movedRuntime,'weave.sqlite')).then(()=>true,()=>false),true,'database moved with application data');
    assert.equal(await fs.stat(path.join(movedRuntime,'window-state.json')).then(()=>true,()=>false),true,'window state moved with application data');
    assert.equal(await fs.stat(path.join(movedRuntime,'webview')).then(()=>true,()=>false),true,'WebView profile moved with application data');
    await current.close();current=null;
    console.log('Native verification passed: isolated default and relocated data, native window controls and restoration, Rust graph streaming, CRUD and chunk FTS5, stale-write rejection, Rust backend, no bundled runtime, and empty PATH.');
  }
} finally {
  await current?.dispose();
  // Only this harness-created temporary directory is removed; linked resources
  // are unlinked explicitly first and their original directory is never removed.
  await fs.rm(path.join(temporary, 'resources'), {force: true}).catch(() => {});
  await fs.rm(temporary, {recursive: true, force: true, maxRetries: 10, retryDelay: 250});
}
