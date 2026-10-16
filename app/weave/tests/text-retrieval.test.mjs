import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {lexicalFallback, passageFor, buildEvidenceBundle} from '../text-retrieval.mjs';

test('local retrieval bundles for a browser provider without native or service dependencies', async () => {
  const result = await build({entryPoints:[fileURLToPath(new URL('../text-retrieval.mjs',import.meta.url))],bundle:true,write:false,platform:'browser',format:'esm',metafile:true});
  assert.deepEqual(Object.keys(result.metafile.inputs).map(name=>name.replaceAll('\\','/').split('/').at(-1)).sort(),['search-query.mjs','text-retrieval.mjs']);
  assert(Object.values(result.metafile.inputs).every(input=>input.imports.every(item=>!item.external)));
  assert(result.outputFiles[0].text.includes('buildEvidenceBundle'));
});

test('text matching ranks article titles and returns source passages without an index service', () => {
  const documents = new Map([
    ['Other.md',{path:'Other.md',title:'Other',text:'# Other\nA policy warehouse reference.'}],
    ['Policy.md',{path:'Policy.md',title:'Policy warehouse',text:'# Policy warehouse\nLine 2\nLine 3\nLine 4\nPolicy warehouse source.\nLine 6'}],
  ]);
  const results = lexicalFallback(documents,'policy warehouse');
  assert.equal(results[0].path,'Policy.md'); assert.equal(results[0].method,'text');
  assert.deepEqual(lexicalFallback(documents,'   '),[]); assert.equal(lexicalFallback(documents,'policy',1).length,1);
  assert.deepEqual(passageFor('One\r\nTwo\r\nThree policy\r\nFour','policy'),{text:'Two\nThree policy\nFour',line:2});
});

test('evidence assembly supports a provider with only text search and logical document identities', async () => {
  const documents = new Map([
    ['Policy.md',{path:'Policy.md',title:'Policy',text:'# Policy\nPolicy source.',hash:'policy-hash'}],
    ['Warehouse.md',{path:'Warehouse.md',title:'Warehouse',text:'# Warehouse\nStorage source.',hash:'warehouse-hash'}],
  ]);
  const edge = {source_document_id:'Policy.md',target_document_id:'Warehouse.md',relationship_type:'writes-to'};
  let expansions = 0;
  const provider = {
    async searchKnowledge(query,options) {assert.equal(options.searchChannel,'evidence');return {method:'text',notices:[],results:lexicalFallback(documents,query)};},
    getNeighbors(path) {assert.equal(path,'Policy.md');expansions++;return {documents:[{path:'Warehouse.md',via:edge}],truncated:false};},
    async getDocument(path) {return documents.get(path);},
    async getPassage(path,query,doc) {return passageFor(doc.text,query);},
    getOutgoingRelationships(path) {return path==='Policy.md'?[edge]:[];},
  };
  const bundle = await buildEvidenceBundle(provider,'policy',{});
  assert.equal(bundle.generated,false);assert.equal(bundle.retrieval,'text');assert.equal(expansions,1);
  assert.deepEqual(bundle.documents.map(d=>d.path),['Policy.md','Warehouse.md']);
  assert.equal(bundle.documents[0].contentHash,'policy-hash');assert.deepEqual(bundle.documents[0].relationships,[edge]);
  assert.equal(bundle.documents[1].kind,'related');assert.match(bundle.documents[1].passage.text,/Storage source/);
  const localOnly = await buildEvidenceBundle(provider,'policy',{connections:false});
  assert.equal(expansions,1);assert.deepEqual(localOnly.documents.map(d=>d.path),['Policy.md']);
});
