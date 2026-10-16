import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {articlePresentation} from '../presentation.mjs';
import {parseLinks, rewriteTargets} from '../links.mjs';
import {renderNote} from '../render.mjs';

test('article reading links describe the open gesture without changing their destinations',()=>{
  const html=renderNote('[Target](Folder/Target.md) [article](Folder/Target.md "Title")@@uses [external](https://example.invalid/notes) [Missing](Missing.md)',['Folder/Target.md']);
  assert.equal((html.match(/title="Ctrl click to open"/g)||[]).length,3);
  assert.equal((html.match(/data-open="Folder\/Target.md"/g)||[]).length,2);assert(html.includes('>article</button>'));assert(html.includes('href="https://example.invalid/notes"'));
  assert.match(html,/class="wiki-link broken"[^>]*title="missing"/,'broken links retain their diagnostic instead of promising navigation');
});
import {SessionStore} from '../session.mjs';
import {GraphIndex} from '../graph.mjs';

test('first-line headings, parent categories and interchangeable Topics/Tags feed graph metadata', () => {
  const content='### PROD.SYSTEM.SALES_ANALYTICS\n\nTags: API, SQL.\nTopics: #SQL, #D365.\n```\nTags: ignored\n```';
  const meta=articlePresentation(content,'infrastructure/databases/file.md');
  assert.equal(meta.title,'PROD.SYSTEM.SALES_ANALYTICS');assert.equal(meta.type,'databases');assert.deepEqual(meta.tags,['API','SQL','D365']);
  assert.equal(articlePresentation('intro\n# Later title','file_name.md','My workspace').title,'file_name');assert.equal(articlePresentation('','file.md','My workspace').type,'My workspace');
  const g=new GraphIndex(':memory:','Root');try {g.upsert('infrastructure/databases/file.md',content);const n=g.snapshot().entities[0];assert.equal(n.name,meta.title);assert.equal(n.type,'databases');assert.deepEqual(n.tags,meta.tags);}finally{g.close();}
});
test('an OKF frontmatter title replaces the first-line heading and frontmatter tags lead', () => {
  const content='---\ntype: BigQuery Table\ntitle: Orders\ntags: [sales, revenue]\nauthors: [Travis Hunting, Codex]\n---\n# orders_table\n\nTags: SQL';
  const meta=articlePresentation(content,'tables/orders.md');
  assert.equal(meta.title,'Orders');assert.equal(meta.heading,'orders_table');assert.deepEqual(meta.tags,['sales','revenue','SQL']);
  assert.equal(articlePresentation('---\ntype: Note\n---\n# Heading','a.md').title,'Heading','without an OKF title the heading after the frontmatter is used');
  const g=new GraphIndex(':memory:','Root');try {g.upsert('tables/orders.md',content+'\n[Customers](tables/customers.md "reads-from")');assert.equal(g.snapshot().entities.find(e=>e.id==='tables/orders.md').name,'Orders');assert.equal(g.outgoing('tables/orders.md')[0].relationship_type,'reads-from');}finally{g.close();}
});
test('title relationships preserve rename offsets and are hidden in rendered articles', () => {
  const text='[](./systems/file.md "hosted-in"). `[No](./No.md "ignored")`\n[Other label](/Other.md "depends-on")';
  const links=parseLinks(text,'Source.md').links;assert.equal(links.length,2);assert.equal(links[0].relationship,'hosted-in');assert(!links[0].raw.endsWith('.'));
  const renamed=rewriteTargets(text,[{...links[0],resolvedPath:'systems/file.md'}],new Map([['systems/file.md','systems/new.md']]),{source:'Source.md'});assert(renamed.startsWith('[](./systems/new.md "hosted-in").'));
  const titles=new Map([['systems/file.md','Actual heading'],['Other.md','Other title']]);const html=renderNote(text,['systems/file.md','Other.md'],true,new Map(),'Source.md',{titles});assert(html.includes('Actual heading'),'an empty label shows the target title');assert(html.includes('Other label'),'authored labels are displayed');assert(!html.includes('hosted-in'));assert(!html.includes('broken'),'relative and bundle-relative targets both resolve');
  assert(renderNote(text,['systems/file.md'],true,new Map(),'Source.md',{titles,showRelationships:true}).includes('@@hosted-in'));
});
test('sessions survive restart, remain per workspace and preserve explicitly empty tabs', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'weave-session-'));try {
    const a=new SessionStore(root);await a.opened('C:/Notes/A');await a.save('C:/Notes/A',{tabs:['One.md','Two.md','One.md'],active:'One.md',source:true});await a.opened('C:/Notes/B');await a.save('C:/Notes/B',{tabs:['Other.md'],active:'Other.md'});
    const b=new SessionStore(root);assert.equal((await b.read()).lastWorkspace,'C:/Notes/B');assert.deepEqual((await b.get('C:/Notes/A')).tabs,['One.md','Two.md']);assert.equal((await b.get('C:/Notes/A')).source,true);
    await b.save('C:/Notes/A',{tabs:[],active:null});assert.deepEqual((await new SessionStore(root).get('C:/Notes/A')).tabs,[]);assert.deepEqual((await b.get('C:/Notes/B')).tabs,['Other.md']);
    await assert.rejects(b.save('C:/Notes/A',{tabs:['../outside.md']}),/path|workspace/i);
    const tabState=[{id:'first',path:'One.md',history:['Two.md','One.md'],at:1},{id:'second',path:'One.md',history:['One.md'],at:0},{id:'blank',path:null,history:[],at:-1}];
    await b.save('C:/Notes/A',{tabs:['One.md','One.md'],active:null,tabState,activeTab:'blank'});
    const restored=await new SessionStore(root).get('C:/Notes/A');assert.deepEqual(restored.tabState,tabState);assert.equal(restored.activeTab,'blank');
    await assert.rejects(b.save('C:/Notes/A',{tabState:[{id:'bad',path:'One.md',history:['../outside.md']}]}),/path|workspace/i);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
