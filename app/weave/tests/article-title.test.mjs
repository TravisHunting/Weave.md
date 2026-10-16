import test from 'node:test';
import assert from 'node:assert/strict';
import {retitleArticle} from '../article-title.mjs';
import {articlePresentation} from '../presentation.mjs';
test('retitling preserves level, BOM, line endings and article body', () => {
  assert.equal(retitleArticle('\uFEFF  ### Before ###\r\n\r\nKeep [File](File.md "uses")\r\n','After'), '\uFEFF  ### After\r\n\r\nKeep [File](File.md "uses")\r\n');
  assert.equal(retitleArticle('Body\n## Subheading\n','Title'), '# Title\n\nBody\n## Subheading\n');
  assert.equal(retitleArticle('# Old','New'), '# New');
});
test('retitle input is plain text, cannot add links or markup', () => {
  const title = 'A [link](path) with *stars* and ~~tildes~~ # tags <tag> \\';
  const text = retitleArticle('# Old\n', title);
  assert.equal(articlePresentation(text,'same-file.md').title, title);
  assert.throws(() => retitleArticle('', ''), /one line/);
  assert.throws(() => retitleArticle('', 'One\nTwo'), /one line/);
});
