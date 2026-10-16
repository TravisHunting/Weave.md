// Mermaid diagrams in the live editor under the packaged CSP (hashed style-src):
// lazy runtime, drawing only visible diagrams, the source-hash/theme cache,
// theme changes, turning diagrams off, editing with a preview, errors, the
// strict security level and wide diagrams fitting the pane.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {mermaidRuntime} from './build.mjs';
import {launchBrowser, recordBlockedStyleAttributes} from './test-browser.mjs';
const root = path.resolve(import.meta.dirname, '../..'), output = path.join(root, 'test-results');
await fs.mkdir(output, {recursive: true});

// The page converts its own interface spelling (here to American: the page runs
// as en-US); only marked interface text may change, never the inert Mermaid
// runtime, articles or diagrams.
const fixture = `import {LiveEditor} from './live-editor.mjs';
import {localizeMarked} from './locale.mjs';
localizeMarked();
const editor = new LiveEditor(document.querySelector('#article'), {paths: () => [], titles: () => new Map(), sourcePath: () => 'Diagrams.md', caseSensitive: () => true, changed: () => {}});
window.harness = {
  open(text) {editor.setText(text); editor.setEnabled(false); editor.requestMeasure();},
  enabled(value) {editor.setEnabled(value); if (value) editor.view.focus();},
  appearance(values) {for (const [key, value] of Object.entries(values)) {if (key.startsWith('--')) document.documentElement.style.setProperty(key, value); else document.documentElement.dataset[key] = value;} editor.requestMeasure();},
  text() {return editor.text;},
  stats() {return {...window.weaveMermaidStats};},
  settle() {return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));}
};`;
const runtime = await mermaidRuntime();
const app = await build({stdin: {contents: fixture, resolveDir: import.meta.dirname}, bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022'});
const script = app.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
// Like the packaged pages: Mermaid is inert text whose hash (and the app's) is in script-src.
const hashes = [script, runtime].map(text => `'sha256-${createHash('sha256').update(text).digest('base64')}'`).join(' ');
const css = (await Promise.all(['skin-contract.css', 'styles.css', 'workspace.css', 'appearance.css', 'mermaid.css'].map(file => fs.readFile(path.join(import.meta.dirname, file), 'utf8')))).join('\n');
const colours = '--bg:#eeebf2;--paper:#fcfaff;--ink:#36303f;--muted:#70667f;--line:#d9d0e5;--accent:#735494;--wash:#e8e0f0;--code:#eee8f4;--selection:#d2bce9;--article-zoom:1';
const page = (csp, nonce, withRuntime = true) => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style${nonce ? ' nonce="weave-test"' : ''}>${css}\n:root{${colours}}body{margin:0;height:100vh;overflow:auto;background:var(--paper);color:var(--ink);font:15px/1.7 'Segoe UI',system-ui,sans-serif}#article{padding:24px 30px 24px 40px;max-width:820px}</style></head><body><article id="article"></article><div id="suggestions" hidden></div><p id="ui-hint" data-ui>Pick a colour</p>${withRuntime ? `<script id="weave-mermaid-runtime" type="text/plain">${runtime}</script>` : ''}<script>${script}</script></body></html>`;
// The packaged desktop/server CSP: a hashed (here, nonce) style-src makes
// browsers ignore 'unsafe-inline', so <style> and style attributes are refused.
const strict = path.join(output, 'weave-mermaid-fixture.html'), loose = path.join(output, 'weave-mermaid-loose.html');
await fs.writeFile(strict, page(`default-src 'none'; script-src ${hashes}; style-src 'unsafe-inline' 'nonce-weave-test'; img-src data:`, true));
await fs.writeFile(loose, page(`default-src 'none'; script-src ${hashes}; style-src 'unsafe-inline'; img-src data:`, false));
// An export made without diagrams carries no runtime.
const bare = path.join(output, 'weave-mermaid-bare.html');
await fs.writeFile(bare, page(`default-src 'none'; script-src ${hashes}; style-src 'unsafe-inline'; img-src data:`, false, false));

const flowchart = 'flowchart LR\n    Source[Markdown source] --> Reader{Weave reader}\n    Reader -->|draws| Diagram([Mermaid diagram])\n    Reader --> Cache[(SVG cache)]\n    Cache --> Theme[Color and center]';
const sequence = 'sequenceDiagram\n    participant Reader\n    participant Mermaid\n    Reader->>Mermaid: render(source)\n    Mermaid-->>Reader: SVG';
const article = `# Diagrams\n\nIntro paragraph about colour.\n\n\`\`\`mermaid\n${flowchart}\n\`\`\`\n\n${Array.from({length: 160}, (_, i) => `Filler paragraph ${i + 1} keeps the second diagram far below the fold.`).join('\n\n')}\n\n\`\`\`mermaid\n${sequence}\n\`\`\`\n\nEnd.\n`;

const browser = await launchBrowser(), errors = [];
try {
  const tab = await browser.newPage({locale: 'en-US', viewport: {width: 1100, height: 850}});
  await tab.addInitScript(recordBlockedStyleAttributes);
  tab.on('pageerror', error => errors.push(error.stack || error.message));
  await tab.route(/^https?:/i, route => route.abort());
  const settle = () => tab.evaluate(() => window.harness.settle());
  const stats = () => tab.evaluate(() => window.harness.stats());
  const ready = (index = 0) => tab.waitForFunction(i => {const box = document.querySelectorAll('.mermaid-diagram')[i]; const image = box?.querySelector('img'); return box?.dataset.state === 'ready' && image?.complete && image.naturalWidth > 0;}, index, {timeout: 20000});
  await tab.goto(pathToFileURL(strict).href);

  await tab.evaluate(() => window.harness.open('# Plain\n\n```js\nconst mermaid = "not a diagram";\n```\n'));
  await settle();
  assert.equal((await stats()).loaded, false, 'an article without Mermaid fences never starts the runtime');

  await tab.evaluate(text => window.harness.open(text), article);
  await ready(0);
  let counts = await stats();
  assert.equal(counts.loaded, true);
  assert.equal(counts.renders, 1, 'only the visible diagram is drawn');
  assert.equal(await tab.locator('.mermaid-diagram').count(), 1, 'CodeMirror creates only diagrams near the viewport');
  assert.equal(await tab.locator('.mermaid-diagram svg').count(), 0, 'diagrams are images, not inline SVG');
  const first = await tab.locator('.mermaid-diagram img').first().evaluate(image => ({alt: image.alt, width: image.naturalWidth, height: image.naturalHeight, src: image.src.slice(0, 27)}));
  assert.equal(first.src, 'data:image/svg+xml;charset=');
  assert(first.width > 300 && first.height > 50, 'the flowchart has a real size: ' + JSON.stringify(first));
  assert.match(first.alt, /flowchart/);
  assert(decodeURIComponent(await tab.locator('.mermaid-diagram img').first().getAttribute('src')).includes('Color and center'), 'diagram text keeps its spelling');
  assert(await tab.getByText('flowchart LR').count() === 0, 'reading shows the diagram instead of its source');
  assert.equal(await tab.getByText('Intro paragraph about colour.').count(), 1, 'interface spelling never changes article text');
  assert.equal(await tab.locator('#ui-hint').textContent(), 'Pick a color', 'marked interface text is converted');
  await tab.screenshot({path: path.join(output, 'weave-mermaid-light.png')});

  await tab.evaluate(() => document.scrollingElement.scrollTo(0, document.scrollingElement.scrollHeight));
  await tab.waitForFunction(() => [...document.querySelectorAll('.mermaid-diagram')].some(box => box.dataset.state === 'ready' && box.querySelector('img')?.alt.includes('sequence')), null, {timeout: 20000});
  assert.equal((await stats()).renders, 2, 'scrolling to a diagram draws it');

  // Reopening the article reuses the cached drawings.
  await tab.evaluate(text => window.harness.open(text + '\n'), article);
  await tab.evaluate(() => document.scrollingElement.scrollTo(0, 0)); await ready(0);
  counts = await stats();
  assert.equal(counts.renders, 2, 'the cache is keyed by source and theme, so nothing is redrawn');
  assert(counts.cacheHits >= 1);

  // A dark scheme gives a different theme key, so diagrams are drawn again.
  const lightSrc = await tab.locator('.mermaid-diagram img').first().getAttribute('src');
  await tab.evaluate(() => window.harness.appearance({'--bg': '#202124', '--paper': '#292a2d', '--ink': '#e8eaed', '--muted': '#b0b3bb', '--line': '#474950', '--accent': '#abc4ef', '--wash': '#383e49', '--code': '#34363c'}));
  await tab.waitForFunction(src => {const image = document.querySelector('.mermaid-diagram img'); return image && image.getAttribute('src') !== src && document.querySelector('.mermaid-diagram').dataset.state === 'ready';}, lightSrc, {timeout: 20000});
  assert.equal((await stats()).renders, 3, 'only the visible diagram is redrawn for the new theme');
  const darkSvg = decodeURIComponent((await tab.locator('.mermaid-diagram img').first().getAttribute('src')).split(',')[1]);
  assert.match(darkSvg, /fill:#e8eaed/i, 'the dark scheme colours the diagram');
  await tab.screenshot({path: path.join(output, 'weave-mermaid-dark.png')});
  for (const palette of ['pastel', 'vivid', 'mono', 'mermaid']) {
    await tab.evaluate(value => window.harness.appearance({mermaidPalette: value}), palette); await ready(0);
    await tab.locator('.mermaid-diagram').first().screenshot({path: path.join(output, `weave-mermaid-${palette}.png`)});
  }
  await tab.evaluate(() => window.harness.appearance({mermaidPalette: 'scheme', mermaidLook: 'handDrawn'})); await ready(0);
  await tab.locator('.mermaid-diagram').first().screenshot({path: path.join(output, 'weave-mermaid-hand-drawn.png')});
  await tab.evaluate(() => window.harness.appearance({mermaidLook: 'classic', '--bg': '#eeebf2', '--paper': '#fcfaff', '--ink': '#36303f', '--muted': '#70667f', '--line': '#d9d0e5', '--accent': '#735494', '--wash': '#e8e0f0', '--code': '#eee8f4'}));
  await ready(0);

  // Turned off, the fence is ordinary code.
  await tab.evaluate(() => window.harness.appearance({mermaid: 'false'})); await settle();
  assert.equal(await tab.locator('.mermaid-diagram').count(), 0);
  assert(await tab.getByText('flowchart LR').count() > 0, 'with diagrams off the source shows as code');
  await tab.evaluate(() => window.harness.appearance({mermaid: 'true'})); await ready(0);

  // Editing: clicking the diagram opens its source, with a live preview below.
  await tab.evaluate(() => window.harness.enabled(true)); await settle();
  await tab.locator('.mermaid-diagram').first().click(); await settle();
  assert(await tab.getByText('flowchart LR').count() > 0, 'the source is revealed while the caret is inside the fence');
  await tab.locator('.mermaid-preview').waitFor();
  await tab.waitForFunction(() => document.querySelector('.mermaid-preview')?.dataset.state === 'ready');
  await tab.keyboard.press('End'); await tab.keyboard.type('\n    Cache --> Done[Edited node]');
  await tab.waitForFunction(() => decodeURIComponent(document.querySelector('.mermaid-preview img')?.getAttribute('src') || '').includes('Edited node'), null, {timeout: 20000});
  assert((await tab.evaluate(() => window.harness.text())).includes('Cache --> Done[Edited node]'), 'the Markdown keeps the Mermaid source');
  assert(!(await tab.evaluate(() => window.harness.text())).includes('<svg'), 'no SVG is written into the article');
  await tab.screenshot({path: path.join(output, 'weave-mermaid-editing.png')});
  await tab.evaluate(() => {document.activeElement.blur();}); await settle();
  await tab.evaluate(() => window.harness.enabled(false)); await ready(0);

  // Errors are shown in place; strict security keeps scripts and links inert.
  await tab.evaluate(() => {window.__pwned = 0; window.harness.open('```mermaid\nflowchart TD\n    A[<img src=x onerror="window.__pwned++">] --> B\n    click A call alert("x")\n    click B "javascript:window.__pwned++"\n```\n\n```mermaid\nflowchart TD\n    A --> \n```\n');});
  await tab.waitForFunction(() => document.querySelectorAll('.mermaid-diagram[data-state=ready], .mermaid-diagram[data-state=error]').length === 2, null, {timeout: 20000});
  assert.equal(await tab.locator('.mermaid-diagram[data-state=error] .mermaid-error').count(), 1, 'a syntax error is reported beside the diagram');
  assert.match(await tab.locator('.mermaid-diagram[data-state=error] .mermaid-error').innerText(), /^Mermaid: /);
  await tab.locator('.mermaid-diagram img').first().click(); await settle();
  assert.equal(await tab.evaluate(() => window.__pwned), 0, 'no script in a diagram runs');
  await tab.screenshot({path: path.join(output, 'weave-mermaid-error.png')});

  // Measured under the packaged CSP, a diagram has the size it has without it.
  const strictSize = await tab.evaluate(async source => {window.harness.open('```mermaid\n' + source + '\n```\n'); await new Promise(resolve => setTimeout(resolve, 50));}, flowchart).then(() => ready(0)).then(() => tab.locator('.mermaid-diagram img').first().evaluate(image => [image.naturalWidth, image.naturalHeight]));
  const blocked = await tab.evaluate(() => window.__blockedStyles);
  const other = await browser.newPage({locale: 'en-US', viewport: {width: 1100, height: 850}});
  await other.goto(pathToFileURL(loose).href);
  await other.evaluate(source => window.harness.open('```mermaid\n' + source + '\n```\n'), flowchart);
  await other.waitForFunction(() => document.querySelector('.mermaid-diagram img')?.naturalWidth > 0, null, {timeout: 20000});
  const looseSize = await other.locator('.mermaid-diagram img').first().evaluate(image => [image.naturalWidth, image.naturalHeight]);
  assert.deepEqual(strictSize, looseSize, 'labels are measured with their styles under the hashed style-src');
  // A diagram wider than the pane shrinks to fit (the default size) and never
  // widens the article: prose keeps wrapping at the pane's edge. (CodeMirror's
  // own styles, which make .cm-scroller a flex box as in the app, apply only here.)
  const wide = 'flowchart LR\n    ' + Array.from({length: 14}, (_, i) => `N${i}[Step number ${i + 1} of the long chain]`).join(' --> ');
  await other.evaluate(source => window.harness.open(`# A heading long enough to wrap when the article is no wider than its pane\n\n${'Prose that should wrap. '.repeat(40)}\n\n\`\`\`mermaid\n${source}\n\`\`\`\n`), wide);
  await other.waitForFunction(() => document.querySelector('.mermaid-diagram')?.dataset.state === 'ready' && document.querySelector('.mermaid-diagram img')?.naturalWidth > 0, null, {timeout: 20000}); await other.evaluate(() => window.harness.settle());
  const fit = await other.evaluate(() => {const content = document.querySelector('.cm-content'), scroller = document.querySelector('.cm-scroller'), image = document.querySelector('.mermaid-diagram img'); return {content: content.getBoundingClientRect().width, scroller: scroller.clientWidth, overflow: scroller.scrollWidth - scroller.clientWidth, image: image.getBoundingClientRect().width, natural: image.naturalWidth};});
  assert(fit.natural > fit.scroller, 'the test diagram is wider than the pane: ' + JSON.stringify(fit));
  assert(fit.content <= fit.scroller, 'a wide diagram never makes .cm-content wider than .cm-scroller: ' + JSON.stringify(fit));
  assert(fit.overflow <= 0 && fit.image < fit.scroller, 'the diagram shrinks to the pane: ' + JSON.stringify(fit));
  // At its natural size the diagram scrolls inside its frame, still without widening the article.
  await other.evaluate(() => window.harness.appearance({mermaidSize: 'natural'})); await other.evaluate(() => window.harness.settle());
  const natural = await other.evaluate(() => {const content = document.querySelector('.cm-content'), scroller = document.querySelector('.cm-scroller'), box = document.querySelector('.mermaid-diagram'); return {content: content.getBoundingClientRect().width, scroller: scroller.clientWidth, frame: box.scrollWidth - box.clientWidth};});
  assert(natural.content <= natural.scroller && natural.frame > 0, 'a natural-size diagram scrolls in its frame: ' + JSON.stringify(natural));
  await other.goto(pathToFileURL(bare).href);
  await other.evaluate(source => window.harness.open('```mermaid\n' + source + '\n```\n'), flowchart); await other.evaluate(() => window.harness.settle());
  assert.equal(await other.locator('.mermaid-diagram').count(), 0, 'without the runtime no diagram is attempted');
  assert(await other.getByText('flowchart LR').count() > 0, 'without the runtime Mermaid blocks show as code');
  // Chromium also reports refused styles while documents are parsed inertly (Mermaid's
  // DOMPurify pass, the image conversion); those are reported against the document.
  assert.deepEqual(blocked.filter(Boolean), [], 'no style attribute on a shown element is refused by the CSP');
  assert.deepEqual(errors, []);
  console.log('Mermaid verification passed: lazy runtime, visible-only drawing, cache, themes, editing preview, errors, strict security, CSP measurement and wide diagrams.');
} finally {await browser.close();}
