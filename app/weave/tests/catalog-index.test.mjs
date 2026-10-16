import test from 'node:test';
import assert from 'node:assert/strict';
import {CatalogIndex} from '../catalog-index.mjs';
import {createResolver, PathResolver} from '../links.mjs';
import {renderNote} from '../render.mjs';

const tree = {files: [{path: 'Systems/Store.md', title: 'Warehouse'}, {path: 'Overview.md'}, {path: 'Teams/Store.md'}], otherFiles: [{path: 'Systems/diagram.png'}], folders: ['Systems', 'Teams']};

test('a catalog index lists folders first, sorted, and gives titles or filenames', () => {
  const index = new CatalogIndex(tree);
  assert.deepEqual(index.childrenOf('').map(e => e.path), ['Systems', 'Teams', 'Overview.md']);
  assert.deepEqual(index.childrenOf('Systems').map(e => [e.path, e.other]), [['Systems/diagram.png', true], ['Systems/Store.md', false]]);
  assert.equal(index.titles.get('Systems/Store.md'), 'Warehouse');
  assert.equal(index.titles.get('Overview.md'), 'Overview', 'an implied title is the filename');
  assert.equal(index.titles.get('Missing.md'), undefined, 'unknown paths have no title');
  assert.equal(index.isFolder('Teams'), true);
  assert.deepEqual(index.match(['store']), ['Teams/Store.md', 'Systems/Store.md'], 'autocomplete matches paths and titles, shortest first');
  assert.deepEqual(index.match(['ware']), ['Systems/Store.md'], 'titles match too');
  index.apply({files: [{path: 'Store.md'}]});
  assert.equal(index.match(['store'])[0], 'Store.md', 'a new article is matched after the catalog changes');
  assert.equal(index.has('Systems/diagram.png'), false, 'only articles are articles');
});

test('catalog changes update paths, titles, children and link resolution in place', () => {
  const index = new CatalogIndex(tree, {caseSensitive: false}), resolve = createResolver(index);
  const paths = index.paths;
  assert.equal(resolve('Store.md', 'Overview.md').reason, 'ambiguous');
  assert.equal(index.paths, paths, 'the path list keeps its identity while unchanged');
  const titleOnly = index.apply({files: [{path: 'Systems/Store.md', title: 'Stores'}], removed: []});
  assert.deepEqual(titleOnly, {paths: false, titles: true, changed: true});
  assert.equal(index.paths, paths, 'a title change keeps the list');
  assert.equal(index.childrenOf('Systems').find(e => e.path === 'Systems/Store.md').title, 'Stores');
  const moved = index.apply({removed: ['Teams/Store.md', 'Teams'], files: [{path: 'New/Plan.md', title: 'Plan'}], folders: ['New']});
  assert.equal(moved.paths, true);
  assert.notEqual(index.paths, paths, 'adding or removing articles makes a new list');
  assert.equal(resolve('store.md', 'Overview.md').resolvedPath, 'Systems/Store.md', 'the remaining article resolves, ignoring case');
  assert.equal(resolve('./New/Plan.md', 'Overview.md').resolvedPath, 'New/Plan.md');
  assert.deepEqual(index.childrenOf('').map(e => e.path), ['New', 'Systems', 'Overview.md']);
  assert.equal(index.find('new/plan.MD'), 'New/Plan.md');
  assert.deepEqual(index.apply({files: [{path: 'New/Plan.md', title: 'Plan'}]}), {paths: false, titles: false, changed: false}, 'an unchanged row changes nothing');
  // A path that changes kind leaves its old kind.
  index.apply({folders: ['Overview.md']});
  assert.equal(index.has('Overview.md'), false);
  assert.equal(index.isFolder('Overview.md'), true);
});

test('resolvers of the same path list are built once and match a fresh build', () => {
  const list = ['A B.md', 'One/A.md', 'Two/A.md'];
  const first = createResolver(list, {caseSensitive: false}), second = createResolver(list, {caseSensitive: false});
  for (const [target, source] of [['./a b.md', 'Start.md'], ['A.md', 'Start.md'], ['../outside.md', 'Start.md'], ['One/A.md', 'Two/x.md']]) {
    assert.deepEqual(first(target, source), new PathResolver(list, {caseSensitive: false}).resolve(target, source));
    assert.deepEqual(second(target, source), first(target, source));
  }
  // Rendering with a catalog index resolves like rendering with its path list.
  const index = new CatalogIndex({files: list.map(path => ({path}))}, {caseSensitive: false});
  const text = '[x](./a b.md) [y](A.md) [z](One/A.md)';
  assert.equal(renderNote(text, index, false, new Map(), 'Start.md', {titles: index.titles}), renderNote(text, list, false, new Map(), 'Start.md', {titles: index.titles}));
});
