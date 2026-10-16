import test from 'node:test';
import assert from 'node:assert/strict';
import {displayGraphRelationships} from '../graph-display.mjs';
import {indexes, neighborhood, displayRelationships} from '../../graph-core.js';

const edge = (id, from, to, type = 'links-to', start_offset = 0, source_line = 1) => ({id, from, to, type, start_offset, source_line, source_document_id: from});

test('opposing links share one arrow while retaining all records and their direction', () => {
  const edges = [edge('a', 'A.md', 'B.md'), edge('b', 'B.md', 'A.md'), edge('c', 'A.md', 'B.md')];
  const original = structuredClone(edges), shown = displayGraphRelationships(edges, 'B.md');
  assert.equal(shown.length, 1);assert.equal(shown[0].type, 'links-to');
  assert.deepEqual(shown[0].records, edges);assert.deepEqual(edges, original);
  assert.equal(displayRelationships(edges).length, 3, 'historical consumers retain their separate arrows');
});

test('named reverse relationship wins over plain links and supplies the arrow direction', () => {
  const edges = [edge('plain', 'A.md', 'B.md'), edge('named', 'B.md', 'A.md', 'depends-on')];
  const [shown] = displayGraphRelationships(edges, 'A.md');
  assert.equal(shown.id, 'named');assert.equal(shown.from, 'B.md');assert.equal(shown.to, 'A.md');assert.equal(shown.type, 'depends-on');
  assert.deepEqual(shown.records, edges);
});

test('first named relationship authored in the active article wins by numeric position', () => {
  const edges = [edge('other:1', 'Other.md', 'Active.md', 'hosts', 1, 1),
    edge('Active.md:100', 'Active.md', 'Other.md', 'writes-to', 100, 10),
    edge('Active.md:20', 'Active.md', 'Other.md', 'reads-from', 20, 3),
    edge('Active.md:0', 'Active.md', 'Other.md', 'links-to', 0, 1)];
  assert.equal(displayGraphRelationships(edges, 'Active.md')[0].type, 'reads-from');
  assert.equal(displayGraphRelationships(edges, 'Other.md')[0].type, 'hosts', 'changing active article changes the representative');
  assert.equal(displayGraphRelationships([...edges].reverse(), 'Active.md')[0].type, 'reads-from', 'chunk arrival order does not change authored precedence');
  edges[1].source_line = edges[2].source_line;
  assert.equal(displayGraphRelationships(edges, 'Active.md')[0].id, 'Active.md:20', 'same-line source offsets remain numeric');
});

test('fallback is deterministic by source and numeric position; self-links stay separate', () => {
  const edges = [edge('B:0', 'B.md', 'A.md', 'hosts'), edge('A:100', 'A.md', 'B.md', 'writes-to', 100, 10),
    edge('A:20', 'A.md', 'B.md', 'reads-from', 20, 3), edge('self', 'A.md', 'A.md', 'depends-on')];
  assert.equal(displayGraphRelationships(edges, 'Unrelated.md')[0].id, 'A:20');
  assert.equal(displayGraphRelationships([...edges].reverse(), 'Unrelated.md').find(item => item.from !== item.to).id, 'A:20');
  assert.equal(displayGraphRelationships(edges, 'Unrelated.md').length, 2);
  const lines = [edge('later', 'A.md', 'B.md', 'writes-to', undefined, 10), edge('earlier', 'A.md', 'B.md', 'reads-from', undefined, 2)];
  delete lines[0].start_offset;delete lines[1].start_offset;
  assert.equal(displayGraphRelationships(lines, 'A.md')[0].id, 'earlier');
});

test('display grouping cannot affect neighborhood traversal or underlying relationship counts', () => {
  const edges = [edge('ab', 'A.md', 'B.md', 'reads-from'), edge('ba', 'B.md', 'A.md', 'writes-to'), edge('bc', 'B.md', 'C.md')];
  const graph = {entities: ['A.md','B.md','C.md'].map(id => ({id, tags: []})), relationships: edges};
  const before = neighborhood(indexes(graph), 'A.md', 2, {direction:'downstream', inactive:true});
  const shown = displayGraphRelationships(before.edges, 'A.md');
  assert.equal(shown.length, 2);assert.equal(before.edges.length, 3);
  assert.deepEqual(neighborhood(indexes(graph), 'A.md', 2, {direction:'downstream', inactive:true}), before);
});
