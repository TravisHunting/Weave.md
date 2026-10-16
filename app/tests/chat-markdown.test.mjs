import test from 'node:test';
import assert from 'node:assert/strict';
import {renderChatMarkdown,articleResolver} from '../chat-markdown.mjs';
const entities=[
  {id:'server:psql-orders-prod-6cj4a:c30482ab45',name:'psql-orders-prod-6cj4a',file:'knowledge/infrastructure/postgres.md'},
  {id:'application:order-router:8b1e6b9937',name:'Order Router',file:'knowledge/infrastructure/order-router.md'}
];
test('Chat formats paragraphs, headings, emphasis, lists, tables, quotes and code without rendering HTML',()=>{
  const text='# Update\n\n**Bold** and *italic* with ~~old~~ text.\n\n1. First\n   - Nested **item**\n2. Second\n\n> A quoted fact.\n\n| Name | Status |\n| --- | --- |\n| Router | Active |\n\n\x60\x60\x60html\n<script>alert(1)</script>\n\x60\x60\x60';
  const html=renderChatMarkdown(text);
  for(const fragment of ['<h1>Update</h1>','<strong>Bold</strong>','<em>italic</em>','<del>old</del>','<ol start="1">','<ul>','<blockquote>','<th>Name</th>','<td>Active</td>','&lt;script&gt;'])assert(html.includes(fragment),fragment);
  assert(!html.includes('<script>'));assert(!html.includes('**'));
});
test('The supplied inline entity IDs and named Markdown article links resolve inside the open library',()=>{
  const text='The library records West Europe, but some resources are in North Europe—for example \x60psql-orders-prod-6cj4a\x60 (\x60server:psql-orders-prod-6cj4a:c30482ab45\x60). This affects **Router** (\x60application:order-router:8b1e6b9937\x60).\n\n[Router](entity:application:order-router:8b1e6b9937) · [Article](infrastructure/order-router.md)';
  const html=renderChatMarkdown(text,entities);
  assert.equal((html.match(/data-chat-entity=/g)||[]).length,5);
  assert(html.includes('data-chat-entity="application:order-router:8b1e6b9937"'));
  assert(!renderChatMarkdown(text,[]).includes('data-chat-entity='));
});
test('Chat never activates unsafe URLs, raw HTML, images, or ambiguous article names',()=>{
  const html=renderChatMarkdown('<img src=x onerror="alert(1)">\n\n[x](javascript:alert(1)) [file](file:///C:/outside.md) ![image](https://example.com/pixel) [web](https://example.com/page)',entities);
  assert(!html.includes('<img'));assert(!html.includes('href="javascript:'));assert(!html.includes('href="file:'));
  assert(html.includes('href="https://example.com/page"'));assert(html.includes('&lt;img'));
  const resolve=articleResolver([...entities,{id:'duplicate',name:'Order Router',file:'knowledge/other.md'}]);
  assert.equal(resolve('Order Router'),null);assert.equal(resolve('../outside.md'),null);
});

test('Markdown backslashes escape punctuation in prose and preserve literal code',()=>{
  const text=[String.raw`\*\*literal bold\*\* and \*literal italic\* and \[link](https://example.com).`,
    String.raw`\- literal list`,String.raw`**Bold with \*literal\* punctuation**`,String.raw`\# literal heading`,
    '\\`literal code\\`','`\\*literal code\\*`','Escaped slash \\\\'].join('\n\n');
  const html=renderChatMarkdown(text);
  assert(html.includes('**literal bold** and *literal italic* and [link](https://example.com).'));
  assert(html.includes('<p>- literal list</p>'));assert(html.includes('<p># literal heading</p>'));
  assert(html.includes('<strong>Bold with *literal* punctuation</strong>'));
  assert(html.includes('`literal code`'));assert(html.includes('<code>\\*literal code\\*</code>'));
  assert(html.includes('Escaped slash \\</p>'));assert(!html.includes('<a '));
});
test('literal tabs and four-space indentation render the same nested list structure',()=>{
  const spaced='- Parent\n    - Child\n        - Grandchild\n    - Sibling\n- Last';
  const tabbed='- Parent\n\t- Child\n\t\t- Grandchild\n\t- Sibling\n- Last';
  const mixed='- Parent\n\t- Child\n\t    - Grandchild\n    - Sibling\n- Last';
  const expected=renderChatMarkdown(spaced);
  assert.equal(renderChatMarkdown(tabbed),expected);assert.equal(renderChatMarkdown(mixed),expected);
  assert.equal((expected.match(/<li>/g)||[]).length,5);assert.equal((expected.match(/<ul>/g)||[]).length,3);
  assert.equal(renderChatMarkdown('12. Parent\n\t- Child\n13. Next'),renderChatMarkdown('12. Parent\n    - Child\n13. Next'));
  assert.match(renderChatMarkdown('- Parent\n\t- '),/<ul><li><\/li><\/ul>/,'an empty generated item retains its bullet in reading mode');
});

test('Underline tags render as <u> while other HTML stays escaped',()=>{
  const html=renderChatMarkdown('a <u>under **bold**</u> and <u class=x>raw</u>');
  assert(html.includes('<u>under <strong>bold</strong></u>'));assert(html.includes('&lt;u class=x&gt;raw&lt;/u&gt;'));
  // With underlining off (Weave's default), the tags are text like other inline HTML.
  assert.equal(renderChatMarkdown('a <u>under **bold**</u>',[],null,{underline:false}),'<p>a &lt;u&gt;under <strong>bold</strong>&lt;/u&gt;</p>');
});
