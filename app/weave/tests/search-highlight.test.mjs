import assert from 'node:assert/strict';
import test from 'node:test';
import {highlightSearch} from '../search-highlight.mjs';

test('search highlighting matches literal phrases, preserving casing and escaping markup', () => {
  assert.equal(highlightSearch('First A+B then a+b and AxB', 'a+b'), 'First <mark class="search-match">A+B</mark> then <mark class="search-match">a+b</mark> and AxB');
  assert.equal(highlightSearch('<script>hello</script>', '<script>'), '<mark class="search-match">&lt;script&gt;</mark>hello&lt;/script&gt;');
  assert.equal(highlightSearch('Two exact words', 'exact words'), 'Two <mark class="search-match">exact words</mark>');
  assert.equal(highlightSearch('No & query', ' '), 'No &amp; query');
});
