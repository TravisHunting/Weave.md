import assert from 'node:assert/strict';
import test from 'node:test';
import {layoutColumns, shufflePositions} from '../graph-layout.mjs';

const nodes = (prefix, count) => Array.from({length: count}, (_, i) => ({id: `${prefix}-${i}`, name: `${prefix} ${String(i).padStart(2, '0')}`}));
const columnCounts = positions => [...positions.values()].reduce((counts, position) => counts.set(position.x, (counts.get(position.x) || 0) + 1), new Map());

test('shuffling scatters nodes around the centred article without overlaps or columns', () => {
  const positions = layoutColumns(new Map([[0, [{id:'active',name:'Active'}]], [1,nodes('other',12)]]), 720, 300);
  const before = JSON.stringify([...positions]);
  let seed = 7; const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const shuffled = shufflePositions(positions, 'active', random, {width:300, height:130});
  assert.deepEqual(shuffled.get('active'), {x:0,y:0});
  assert.deepEqual([...shuffled.keys()].sort(), [...positions.keys()].sort());
  const points = [...shuffled.values()];
  for (const [i, a] of points.entries()) for (const b of points.slice(i + 1)) assert(Math.abs(a.x - b.x) >= 300 || Math.abs(a.y - b.y) >= 130, 'nodes do not overlap');
  assert(new Set(points.map(p => p.x)).size > 6, 'nodes are not arranged in columns');
  assert(points.some(p => p.x < 0) && points.some(p => p.x > 0) && points.some(p => p.y < 0) && points.some(p => p.y > 0), 'nodes surround the article');
  assert.equal(shufflePositions(positions, 'active', () => 0).size, positions.size, 'a degenerate random source still places every node');
  assert.equal(JSON.stringify([...positions]), before, 'cached layout is unchanged');
});

test('large neighborhoods expand outward with at most five nodes per column', () => {
  const buckets = new Map([[0, nodes('focus', 1)], [-1, nodes('incoming', 16)], [-2, nodes('ancestors', 8)], [1, nodes('outgoing', 31)], [2, nodes('descendants', 13)]]);
  const positions = layoutColumns(buckets, 360, 150);
  assert.equal(positions.size, 69);
  assert([...columnCounts(positions).values()].every(count => count <= 5));
  assert.equal(new Set([...positions.values()].map(({x,y}) => `${x},${y}`)).size, positions.size, 'no overlapping auto-layout positions');
  for (const [depth, group] of buckets) for (const node of group) assert.equal(Math.sign(positions.get(node.id).x), Math.sign(depth));
  assert(Math.max(...buckets.get(-2).map(node => positions.get(node.id).x)) < Math.min(...buckets.get(-1).map(node => positions.get(node.id).x)), 'deeper incoming nodes stay outside direct neighbors');
  assert(Math.min(...buckets.get(2).map(node => positions.get(node.id).x)) > Math.max(...buckets.get(1).map(node => positions.get(node.id).x)), 'deeper outgoing nodes stay outside direct neighbors');
});

test('overflow columns balance their rows and overview categories never share a column', () => {
  const buckets = new Map([[0, nodes('first', 6)], [1, nodes('second', 11)]]);
  const positions = layoutColumns(buckets, 360, 150, {overview:true});
  assert.deepEqual([...columnCounts(positions).values()], [3,3,4,4,3]);
  for (const x of columnCounts(positions).keys()) {
    const ys = [...positions.values()].filter(position => position.x === x).map(position => position.y);
    assert.equal(Math.min(...ys) + Math.max(...ys), 0, 'each short column is vertically centered');
  }
  assert.deepEqual(layoutColumns(new Map(), 360, 150), new Map());
});
