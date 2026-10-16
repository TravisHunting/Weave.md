import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {NativeHarness} from './native-harness.mjs';
test('native monitoring preferences persist independently for each workspace',async t=>{
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'weave-monitor-')),a=path.join(temporary,'A'),b=path.join(temporary,'B');await fs.mkdir(a);await fs.mkdir(b);
 const host=new NativeHarness(path.join(temporary,'.weave'));t.after(async()=>{await host.close();await fs.rm(temporary,{recursive:true,force:true});});await host.open(a);
 assert.equal((await host.call('status')).monitoring.refreshSeconds,300);
 // Disabling future monitoring does not cancel an already admitted first scan.
 const deadline=Date.now()+10000;while((await host.call('status')).graph!=='ready'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
 assert.equal((await host.call('status')).graph,'ready');
 await host.call('configureMonitoring',{refreshSeconds:90,autoRefresh:false,watchChanges:false,scanMode:'content'});
 await fs.writeFile(path.join(a,'New.md'),'# New');await new Promise(r=>setTimeout(r,500));assert.equal((await host.call('status')).documents,0);
 await host.call('refresh');assert.equal((await host.call('status')).documents,1);
 await host.open(b);assert.equal((await host.call('status')).monitoring.refreshSeconds,300);
 await host.open(a);assert.deepEqual((await host.call('status')).monitoring,{refreshSeconds:90,autoRefresh:false,watchChanges:false,scanMode:'content'});
 for(const changes of [{refreshSeconds:0},{refreshSeconds:10.5},{watchChanges:'yes'},{scanMode:'unknown'},{embed:true}])await assert.rejects(host.call('configureMonitoring',changes));
});
