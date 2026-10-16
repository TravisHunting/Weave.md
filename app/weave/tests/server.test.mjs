import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from '../server.mjs';
test('dynamic reader allows same-origin read-only API, isolates paths and denies writes',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'weave-server-'));await fs.writeFile(path.join(root,'Note.md'),'# Note\nLocal content');const server=await createServer({root,port:0,runtime:path.join(root,'.weave')});
  try{
    assert.match(server.url,/127\.0\.0\.1/);
    const request=(op,args={})=>fetch(server.url+'/api/weave?'+new URLSearchParams({op,args:JSON.stringify(args)}));
    assert.equal((await (await request('getDocument',{path:'Note.md'})).json()).title,'Note');
    assert.equal((await request('getDocument',{path:'../private.md'})).status,400);
    assert.equal((await request('save',{path:'Note.md',text:'overwrite'})).status,403);
    assert.equal((await fetch(server.url+'/api/weave',{method:'POST'})).status,405);
    assert.equal((await fetch(server.url+'/api/weave?op=status',{headers:{Origin:'https://example.invalid'}})).status,403);
    assert.equal((await fetch(server.url+'/README.md')).status,404);
    assert.equal(await fs.readFile(path.join(root,'Note.md'),'utf8'),'# Note\nLocal content');
  }finally{await server.close();await fs.rm(root,{recursive:true,force:true});}
});
