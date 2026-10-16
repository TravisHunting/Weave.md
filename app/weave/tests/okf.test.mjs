import test from 'node:test';
import assert from 'node:assert/strict';
import {splitFrontmatter, readFrontmatter, setFrontmatterField, createFrontmatter, stampArticle, isoTimestamp, TIMESTAMP_FIELDS} from '../okf.mjs';
import {retitleArticle} from '../article-title.mjs';
import {parseLinks} from '../links.mjs';

const example = '---\ntype: BigQuery Table\ntitle: Orders\ndescription: One row per completed customer order.\nresource: https://console.cloud.google.com/bigquery?p=acme&d=sales&t=orders\nauthors: [Travis Hunting, Codex]\ntags: [sales, revenue]\n---\n# Orders\n\nBody';

test('frontmatter splits byte-for-byte and parses OKF fields', () => {
  const {frontmatter, body} = splitFrontmatter(example);
  assert.equal(frontmatter + body, example); assert(body.startsWith('# Orders'));
  const okf = readFrontmatter(example);
  assert.equal(okf.fields.type, 'BigQuery Table'); assert.deepEqual(okf.fields.authors, ['Travis Hunting', 'Codex']); assert.deepEqual(okf.fields.tags, ['sales', 'revenue']);
  assert.equal(splitFrontmatter('# No frontmatter\n---\n').frontmatter, '');
  assert.equal(splitFrontmatter('\uFEFF---\r\ntype: Note\r\n---\r\nBody').body, 'Body');
  assert.match(readFrontmatter('---\ntype: [unclosed\n---\n').error, /./);
});

test('editing one field preserves comments, order, unknown keys and the body', () => {
  const source = '---\r\n# kept comment\r\ntype: Note\r\nstatus: draft\r\ngenerated: {by: human:th}\r\n---\r\n# Title\r\n';
  const next = setFrontmatterField(source, 'tags', ['a', 'b']);
  assert.equal(next, '---\r\n# kept comment\r\ntype: Note\r\nstatus: draft\r\ngenerated: {by: human:th}\r\ntags: [a, b]\r\n---\r\n# Title\r\n');
  assert.equal(readFrontmatter(setFrontmatterField(next, 'status', undefined)).fields.status, undefined);
  assert.throws(() => setFrontmatterField(next, 'type', ''), /type/);
  assert.throws(() => setFrontmatterField('# none', 'type', 'Note'), /no frontmatter/);
});

test('generated frontmatter puts type first, keeps the body and hides from link parsing', () => {
  const text = createFrontmatter('# Heading\n\n[Other](Other.md)\n', {title: 'Heading'});
  assert.equal(text, '---\ntype: Note\ntitle: Heading\n---\n# Heading\n\n[Other](Other.md)\n');
  assert.throws(() => createFrontmatter(text), /already/);
  assert.deepEqual(parseLinks('---\nresource: "[x](x.md)"\n---\n' + 'y').links, []);
});

test('retitling updates an OKF title and the heading together', () => {
  assert.equal(retitleArticle('---\ntype: Note\ntitle: Old\n---\n# Old\n\nBody', 'New [draft]'), '---\ntype: Note\ntitle: New [draft]\n---\n# New \\[draft\\]\n\nBody');
  assert.equal(retitleArticle('---\ntype: Note\n---\n# Old\n', 'New'), '---\ntype: Note\n---\n# New\n', 'without an OKF title only the heading changes');
  assert.equal(retitleArticle('---\ntype: Note\ntitle: Old\n---\nNo heading', 'New'), '---\ntype: Note\ntitle: New\n---\nNo heading');
});

test('saving stamps created_at once and updated_at every time, as local ISO timestamps', () => {
  const now = new Date(2026, 9, 7, 14, 3, 22), created = new Date(2026, 0, 2, 3, 4, 5).getTime();
  assert.match(isoTimestamp(now), /^2026-10-07T14:03:22[+-]\d\d:\d\d$/);
  const plain = stampArticle('# Notes\r\n\r\nBody', {created, now});
  assert.equal(splitFrontmatter(plain).body, '# Notes\r\n\r\nBody', 'the body is unchanged');
  assert.deepEqual(readFrontmatter(plain).fields, {type: 'Note', created_at: isoTimestamp(new Date(created)), updated_at: isoTimestamp(now)}, 'an article without frontmatter gains type, created_at and updated_at');
  assert(plain.startsWith('---\r\n'), 'the new block keeps the article line endings');
  const later = new Date(2026, 9, 8, 9, 0, 0), again = stampArticle(plain, {created: later.getTime(), now: later});
  assert.equal(readFrontmatter(again).fields.created_at, isoTimestamp(new Date(created)), 'an existing created_at is kept');
  assert.equal(readFrontmatter(again).fields.updated_at, isoTimestamp(later));
  const kept = stampArticle('---\ntype: Table\n# comment\ncustom: x\n---\nBody', {now});
  assert(kept.includes('# comment') && kept.includes('custom: x'), 'other keys and comments are preserved');
  assert.equal(readFrontmatter(kept).fields.created_at, isoTimestamp(now), 'without a known creation time, now is used');
  assert.equal(readFrontmatter(stampArticle('# A', {created: now.getTime() + 60000, now})).fields.created_at, isoTimestamp(now), 'a creation time in the future is not trusted');
  const broken = '---\ntype: [\n---\nBody';
  assert.equal(stampArticle(broken, {now}), broken, 'invalid YAML is left for the author to fix');
  assert.deepEqual(TIMESTAMP_FIELDS, ['created_at', 'updated_at']);
});
