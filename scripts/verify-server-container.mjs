// Production image smoke: confined non-root writes, persistence across recreation,
// graceful SIGTERM and no bundled desktop/runtime tools. No cloud service is used.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
const exec = promisify(execFile);
const option = (name, fallback) => {const at=process.argv.indexOf('--'+name); return at<0?fallback:process.argv[at+1];};
const engine = option('engine','docker'), image = option('image','weave-server:local');
const args = engine === 'podman' ? ['--cgroup-manager=cgroupfs'] : [];
const run = async (...command) => (await exec(engine,[...args,...command],{maxBuffer:2*1024*1024,windowsHide:true})).stdout.trim();
const name = 'weave-server-test-'+randomUUID(), data=name+'-data', workspaces=name+'-workspaces';
const socket=net.createServer(); await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
const port=socket.address().port; await new Promise(resolve=>socket.close(resolve));
const base='http://127.0.0.1:'+port;
let instance, cookie = '', csrf = '', password = 'container replacement password';
async function start() {
  await run('run','-d','--name',name,'--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
    ...(process.argv.includes('--no-cgroups')?['--cgroups=disabled']:['--pids-limit=256']),
    '--tmpfs','/tmp:size=64m,mode=1777','-p',`127.0.0.1:${port}:8765`,'-e','WEAVE_ADMIN_PASSWORD='+password,
    '-v',data+':/data','-v',workspaces+':/workspaces',image,
    '--host','0.0.0.0','--port','8765','--workspaces','/workspaces','--data','/data','--origin',base);
  for(let i=0;i<100;i++) {
    try {
      if ((await fetch(base+'/healthz')).status!==200) throw new Error('Starting');
      await login(password);
      const health=await call('health'); instance=health.instance;return;
    } catch {}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('Container did not start: '+await run('logs',name));
}
async function login(secret) {
  const response=await fetch(base+'/api/auth',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Weave-Request':'1'},body:JSON.stringify({op:'login',args:{username:'admin',password:secret}})});
  assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];
  csrf=(await fetch(base+'/auth/status',{headers:{Cookie:cookie}}).then(r=>r.json())).csrf;
}
async function call(op,args={}) {
  const response=await fetch(base+'/api/request',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Weave-Request':'1',Cookie:cookie,'X-Weave-CSRF':csrf,...(instance?{'X-Weave-Instance':instance}:{})},body:JSON.stringify({op,args})});
  const value=await response.json(); assert.equal(response.status,200,JSON.stringify(value));return value;
}
async function stop() {
  await run('stop','--time','30',name);
  assert.equal(await run('inspect','--format','{{.State.ExitCode}}',name),'0','SIGTERM shuts down cleanly');
  await run('rm',name);
}
try {
  await start();
  assert.equal(await run('exec',name,'id','-u'),'10001');
  const binaries=await run('exec',name,'sh','-c','for tool in node npm cargo git; do command -v "$tool" || true; done');
  assert.equal(binaries,'','the production image has no build/desktop helper tools');
  const a=await call('serverOpen',{name:'Alpha',create:true}), b=await call('serverOpen',{name:'Beta',create:true});
  await call('create',{scope:a.scope,path:'Start.md',text:'# Container persistence\n'});
  await call('create',{scope:b.scope,path:'Start.md',text:'# Independent workspace\n'});
  await call('configureWorkspace',{id:a.workspace.id,name:'Container notes',color:'#123456'});
  const first=instance; await stop(); await start(); assert.notEqual(instance,first);
  const panel=await call('controlPanel'); assert.equal(panel.workspaces.length,2);
  assert.equal(panel.workspaces.find(w=>w.id===a.workspace.id).name,'Container notes');
  const restored=await call('reopen',{id:a.workspace.id});
  assert.equal((await call('getDocument',{scope:restored.scope,path:'Start.md'})).text,'# Container persistence\n');
  await stop();
  console.log('Container passed: UID 10001, read-only root, dropped capabilities, no build helpers, independent workspaces, volume persistence after recreation and graceful SIGTERM.');
} finally {
  await run('rm','-f',name).catch(()=>{});
  await run('volume','rm',data,workspaces).catch(()=>{});
}
