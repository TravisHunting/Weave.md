import {NativeHarness} from './native-harness.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const active=new Map();
export class NativeGitService {
  constructor(root){this.root=root;let entry=active.get(root);if(!entry){entry={users:0,ready:(async()=>{const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'weave-native-git-'));const host=new NativeHarness(runtime);await host.open(root);return {host,runtime};})()};active.set(root,entry);}entry.users++;this.entry=entry;}
  async call(op,args={}){return (await this.entry.ready).host.call(op,args);}
  action(args){return this.call('gitAction',args);}
  status(){return this.call('gitStatus');}
  readIgnore(){return this.call('gitIgnore');}
  diff(args){return this.call('gitDiff',args);}
  history(){return this.call('gitHistory');}
  commitDiff(args){return this.call('gitCommitDiff',args);}
  async close(){if(this.closed)return;this.closed=true;if(--this.entry.users===0){active.delete(this.root);const {host,runtime}=await this.entry.ready;await host.close();await fs.rm(runtime,{recursive:true,force:true,maxRetries:5,retryDelay:100});}}
}
