import assert from 'node:assert/strict';
import test from 'node:test';
import {lexicalSearchQuery, lexicalQueryTerms, literalSearchQuery, searchHighlightQuery} from '../search-query.mjs';
import {lexicalFallback} from '../text-retrieval.mjs';
import {createReaderClient} from '../reader-client.mjs';

test('quoted lexical phrases keep word order while unquoted terms match throughout the article', async () => {
  const documents = [
    {path:'Phrase.md',title:'Phrase',text:'The policy records flow through a pipeline.'},
    {path:'Separated.md',title:'Separated',text:'Records of a policy move through another pipeline.'},
    {path:'One-term.md',title:'One term',text:'Only a policy is described.'},
  ];
  const map = new Map(documents.map(doc => [doc.path, doc]));
  const paths = query => lexicalFallback(map, query).map(result => result.path);
  assert.deepEqual(paths('policy records'), ['Phrase.md','Separated.md']);
  assert.deepEqual(paths('"policy records"'), ['Phrase.md']);
  assert.deepEqual(paths('“policy records”'), ['Phrase.md']);
  assert.deepEqual(paths('policy records -another'), ['Phrase.md']);
  assert.deepEqual(paths('-policy'), []);
  const reader = createReaderClient({documents});
  assert.deepEqual((await reader.call('searchKnowledge',{query:'"policy records"'})).results.map(result => result.path), ['Phrase.md']);
  assert.deepEqual((await reader.call('searchKnowledge',{query:'policy records'})).results.map(result => result.path), paths('policy records'));
});

test('literal query and highlighting remove paired outer quotes without splitting the phrase', () => {
  assert.equal(lexicalSearchQuery('  “policy\n records”  '), '"policy records"');
  assert.equal(literalSearchQuery('“policy records”'), 'policy records');
  assert.equal(literalSearchQuery('policy records'), 'policy records');
  assert.equal(searchHighlightQuery('"policy records"'), 'policy records');
  assert.equal(literalSearchQuery('find "policy records" mappings'), 'find "policy records" mappings');
  assert.deepEqual(lexicalQueryTerms('"policy records" -"archived items" ABC-901'), {positive:['policy records','abc-901'],negative:['archived items']});
  assert.deepEqual(lexicalQueryTerms('"policy records'), {positive:['policy records'],negative:[]}, 'an unfinished live-search phrase remains usable');
});
