import assert from 'node:assert/strict';
import test from 'node:test';
import {createHttpClient} from '../http-client.mjs';
const key='weave.server.session.v1';
function storage(initial) {const values=new Map(initial?[[key,JSON.stringify(initial)]]:[]);return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};}
function server(ids) {
  const opened=[];
  return {opened,fetch:async(url,request)=>{
    if (url === '/auth/status') return {ok: true, json: async () => ({authenticated: true, csrf: 'test-csrf'})};
    assert.equal(request.headers['X-Weave-CSRF'], 'test-csrf');
    const {op,args}=JSON.parse(request.body);
    const value=op==='health'?{instance:'test',capabilities:{session:true,workspaces:true,storage:true}}:op==='controlPanel'?{managedWorkspaces:true,defaultWorkspaces:ids,workspaces:ids.map(id=>({id,name:id}))}:op==='reopen'?(opened.push(args.id),{scope:ids.indexOf(args.id)+1,workspace:{id:args.id},tree:{}}):{};
    return {ok:true,json:async()=>value};
  }};
}
test('fresh browser tab loads every controller workspace despite a durable empty session',async()=>{
  const host=server(['second','first']),tab=storage(),durable=storage({open:[],sessions:{first:{position:8}}});
  const client=await createHttpClient({fetch:host.fetch,storage:tab,durable});
  const restored=await client.call('restore');assert.deepEqual(host.opened,['second','first']);assert.equal(restored.workspaces[1].session.position,8);
  await client.call('close',{scope:1});host.opened.length=0;
  await client.call('restore');assert.deepEqual(host.opened,['first']);
});
test('same-tab reload keeps deactivation; changed controller selection replaces stale choices',async()=>{
  const tab=storage({open:['first'],selection:JSON.stringify(['first','second'])}),host=server(['first','second']);
  let client=await createHttpClient({fetch:host.fetch,storage:tab,durable:storage()});await client.call('restore');assert.deepEqual(host.opened,['first']);
  const changed=server(['second','third']);client=await createHttpClient({fetch:changed.fetch,storage:tab,durable:storage()});await client.call('restore');assert.deepEqual(changed.opened,['second','third']);
});
