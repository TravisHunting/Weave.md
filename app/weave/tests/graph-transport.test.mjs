import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeClient} from '../native-client.mjs';

test('native graph transport requests labels once and streams neighborhood deltas', async () => {
  class Channel {}
  const calls=[],chunks=[];
  const client=await createNativeClient({Channel,invoke:async(command,input)=>{
    calls.push({command,input});
    if(input?.op==='health')return {ok:true,capabilities:{graphStream:true}};
    if(command==='choose_workspace')return {scope:8};
    if(input?.op==='graph')return {revision:12,entities:[{id:'A.md'}],relationships:[]};
    if(command==='weave_graph_neighborhood'){input.onChunk.onmessage({depth:1,nodes:[{id:'A.md'}],edges:[],complete:true});return {nodes:1};}
    throw new Error('Unexpected graph transport call');
  }});
  await client.choose();const args={};await client.call('graph',args);
  assert.equal(args.summaryOnly,undefined,'transport does not mutate caller arguments');
  assert.equal(calls.at(-1).input.args.summaryOnly,true);
  await client.graphNeighborhood({path:'A.md',depth:1,revision:12},chunk=>chunks.push(chunk));
  assert.equal(calls.at(-1).input.args.scope,8);assert.equal(chunks.length,1);
  assert.equal(chunks[0].nodes[0].id,'A.md');
});
