// Test-only bridge to the same Rust Backend used by Tauri. No JS backend mocks.
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {ROOT} from '../build.mjs';
export class NativeHarness extends EventEmitter {
  // `profile` selects the Cargo build (benchmarks use release); `timeout` bounds each call.
  constructor(runtime, {profile = process.env.WEAVE_TEST_HOST_PROFILE || 'debug', timeout = 90000} = {}) {
    super(); this.scope = 0; this.pending = new Map(); this.serial = 0; this.timeout = timeout;
    const target = process.env.CARGO_TARGET_DIR || path.join(ROOT,'src-tauri/target');
    this.binaryDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'weave-test-binary-'));
    const executable=path.join(this.binaryDirectory,process.platform === 'win32' ? 'weave-test-host.exe' : 'weave-test-host');
    fs.copyFileSync(path.join(target,profile,path.basename(executable)),executable);
    this.child = spawn(executable,[runtime],{windowsHide:true,env:{...process.env,PATH:'',NODE_PATH:'',NODE_OPTIONS:''},stdio:['pipe','pipe','pipe']});
    this.errors = ''; this.child.stderr.on('data',data=>this.errors+=data);
    this.lines = readline.createInterface({input:this.child.stdout});
    this.lines.on('line',line=>{const value=JSON.parse(line);if(value.event){this.emit('changed',value);return;}const item=this.pending.get(value.id);if(!item)return;this.pending.delete(value.id);clearTimeout(item.timer);value.ok?item.resolve(value.result):item.reject(new Error(value.error.message));});
    this.child.on('error',error=>this.fail(error));this.child.on('exit',code=>{this.fail(new Error('Native test host exited '+code+': '+this.errors));fs.rmSync(this.binaryDirectory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  }
  fail(error){for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error);}this.pending.clear();}
  async call(op,args={},{timeout=this.timeout}={}) {
    const value=await new Promise((resolve,reject)=>{const id=++this.serial;const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Native test request timed out: '+op+' '+this.errors));},timeout);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,op,args:{scope:this.scope,...args}})+'\n');});
    if(value?.scope!=null)this.scope=value.scope;
    if(value?.root)this.root=value.root;
    return value;
  }
  async open(root){await this.call('open',{root});await this.call('refresh');return this.call('catalog');}
  getDocument(path){return this.call('getDocument',{path});}
  getOutgoingRelationships(path){return this.call('getOutgoingRelationships',{path});}
  controlPanel(){return this.call('controlPanel');}
  async close(){if(this.child.exitCode!==null)return;const kill=setTimeout(()=>this.child.kill(),5000);try{await this.call('shutdown');this.child.stdin.end();await new Promise(resolve=>{if(this.child.exitCode!==null)resolve();else this.child.once('exit',resolve);});}finally{clearTimeout(kill);this.lines.close();if(this.child.exitCode===null)this.child.kill();}}
}
