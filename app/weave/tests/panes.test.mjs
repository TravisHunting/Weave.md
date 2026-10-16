import test from 'node:test';
import assert from 'node:assert/strict';
import {PANE_IDS, paneId, paneStyles} from '../panes.mjs';

test('split view styles cover the right pane copy without changing specificity', () => {
  assert.equal(paneId('article', 0), 'article');
  assert.equal(paneId('article', 1), 'article-2');
  assert(PANE_IDS.includes('note-panel') && !PANE_IDS.includes('graph-panel'), 'the graph and Deep search are shared, not copied');
  assert.equal(paneStyles('#article .md-h1,#article-resize{a:b}'), ':is(#article,#article-2) .md-h1,:is(#article-resize,#article-resize-2){a:b}');
  assert.equal(paneStyles(':is(#article,#source-editor) p{}'), ':is(:is(#article,#article-2),:is(#source-editor,#source-editor-2)) p{}');
  assert.equal(paneStyles('#welcome-recent h2,#graph-panel{color:#abcdef}'), '#welcome-recent h2,#graph-panel{color:#abcdef}', 'other ids and colours are untouched');
});
