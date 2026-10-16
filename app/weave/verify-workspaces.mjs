// Several open workspaces in one window: Files sections, tinted tabs, per-workspace
// Git sections, Control panel naming/colours/order, close and reopen, and restore.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {NativeHarness} from './tests/native-harness.mjs';
import {buildDesktop, ROOT} from './build.mjs';
import {ensureAppearanceSection} from './verify-appearance.mjs';
import {englishVariant, localizeText} from './locale.mjs';
import {launchBrowser, recordBlockedStyleAttributes, blockedStyleElementMessage, menuItem} from './test-browser.mjs';
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-workspaces-')), output = path.join(ROOT, 'test-results');
const alpha = path.join(temporary, 'Alpha'), beta = path.join(temporary, 'Beta');
await fs.mkdir(path.join(alpha, 'Systems'), {recursive: true}); await fs.mkdir(beta); await fs.mkdir(output, {recursive: true});
await fs.writeFile(path.join(alpha, 'Overview.md'), '# Alpha overview\n\nShared term lighthouse.\n\n[Store](./Systems/Store.md "writes-to")\n');
await fs.writeFile(path.join(alpha, 'Systems/Store.md'), '# Store\n\nAlpha storage.\n');
await fs.writeFile(path.join(alpha, 'Scratch.md'), '# Scratch\n\nDelete me.\n');
await fs.writeFile(path.join(alpha, 'Long.md'), '# Long article\n\n' + Array.from({length: 160}, (_, i) => (i % 10 === 9 ? `## Section ${i + 1}\n\n` : '') + `Paragraph ${i + 1} of a long article with **bold** and [Overview](./Overview.md).\n`).join('\n'));
await fs.writeFile(path.join(beta, 'Plan.md'), '# Beta plan\n\nAnother lighthouse appears here.\n');
await buildDesktop();
const service = new NativeHarness(path.join(temporary, '.weave'));
const browser = await launchBrowser(), page = await browser.newPage({viewport: {width: 1500, height: 1000}}), errors = [];
page.on('pageerror', error => errors.push(error.message)); await page.addInitScript(recordBlockedStyleAttributes); page.on('console', m => {if (m.type() === 'error' && !blockedStyleElementMessage(m.text())) errors.push(m.text());});
let next = alpha, exportRequest = null;
const exported = path.join(temporary, 'Alpha export.html'), folderExport = path.join(temporary, 'Systems.html');
await page.exposeFunction('__WEAVE_TEST_INVOKE__', async (command, input) => {
  if (command === 'choose_workspace') {const root = next; next = beta; return service.open(root);}
  // The desktop shell's save dialog is replaced by a fixed path; the export itself runs in Rust.
  if (command === 'export_workspace') {exportRequest = input; return service.call('exportWorkspace', {scope: input.scope, path: input.folder ? folderExport : exported, graph: input.graph, otherFiles: input.otherFiles, folder: input.folder || '', template: await fs.readFile(path.join(ROOT, 'dist/export-template.html'), 'utf8')});}
  if (command === 'reveal_export') return null;
  if (command === 'window_action') return {maximized: false, decorated: false};
  if (command === 'editor_state' || command === 'open_resource' || command === 'choose_storage_directory') return null;
  const {op, args} = input;
  if (op === 'revealPath') return {revealed: true};
  return service.call(op, args);
});
const tabNames = () => page.locator('#file-tabs .tab-workspace').allInnerTexts();
const sectionOrder = selector => page.locator(selector).evaluateAll(nodes => nodes.map(node => node.dataset.ws));
try {
  // Emulate the packaged app's CSP: Tauri adds hashes to style-src, which makes the
  // browser ignore inline style attributes, so colours must not rely on them.
  const shell = path.join(output, 'weave-workspaces-csp.html');
  await fs.writeFile(shell, (await fs.readFile(path.join(ROOT, 'dist/desktop/index.html'), 'utf8')).replace('<style>', `<meta http-equiv="Content-Security-Policy" content="style-src 'unsafe-inline' 'nonce-weave-test'"><style nonce="weave-test">`));
  await page.goto(pathToFileURL(shell).href);
  await page.locator('#welcome-open').click(); await page.locator('[data-tree-path="Overview.md"]').waitFor();
  assert.equal(await page.locator('.tree-workspace-divider').count(), 0, 'one workspace has no divider');
  assert.equal(await page.locator('.git-workspace').count(), 1);
  assert.equal(await page.locator('.git-workspace').evaluate(node => node.open), true, 'a single Git section opens by default');
  await page.locator('[data-tree-path="Overview.md"]').click(); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Overview.md');
  assert.equal(await page.locator('#file-tabs .tab-workspace').count(), 0, 'tabs name a workspace only when several are open');
  const singleHeight = await page.locator('.file-tab').first().evaluate(node => node.getBoundingClientRect().height);

  // Open a second workspace beside the first.
  await menuItem(page,'choose-workspace'); await page.locator('[data-tree-path="Plan.md"]').waitFor();
  assert(await page.locator('[data-tree-path="Overview.md"]').isVisible(), 'the first workspace stays open');
  assert.equal(await page.locator('.tree-workspace-divider').count(), 1, 'a bar separates the workspaces');
  assert.deepEqual(await page.locator('.tree-workspace-heading').allInnerTexts(), ['ALPHA', 'BETA']);
  const [alphaKey, betaKey] = await sectionOrder('.tree-workspace');
  const colours = await page.locator('.tree-workspace').evaluateAll(nodes => nodes.map(node => node.style.getPropertyValue('--workspace-color')));
  assert.notEqual(colours[0], colours[1], 'workspaces receive different default colours');
  await page.keyboard.press('Control+t'); await page.locator('[data-tree-path="Plan.md"]').click(); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Plan.md');
  assert.equal(await page.locator('#file-tabs [role="tab"]').count(), 2, 'another workspace\'s article opens in its own tab');
  assert.deepEqual(await tabNames(), ['Alpha', 'Beta']);
  assert.equal(await page.locator('.file-tab').first().evaluate(node => node.getBoundingClientRect().height), singleHeight, 'named tabs keep the single-workspace height');
  const tint = await page.locator('.file-tab.workspace-tab').first().evaluate(node => getComputedStyle(node).backgroundColor);
  assert.notEqual(tint, 'rgba(0, 0, 0, 0)', 'workspace tabs are tinted');
  const backgrounds = await page.locator('.file-tab.workspace-tab').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
  assert.notEqual(backgrounds[0], backgrounds[1], 'each tab takes its own workspace colour under the desktop CSP');
  assert.match(await page.locator('#workspace-name').innerText(), /Beta$/);

  // The active article's workspace expands its Git section and collapses the others.
  const openSections = () => page.locator('.git-workspace').evaluateAll(nodes => nodes.filter(node => node.open).map(node => node.dataset.ws));
  assert.deepEqual(await openSections(), [betaKey]);
  await page.locator('#file-tabs [role="tab"]').first().click(); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Overview.md');
  assert.deepEqual(await openSections(), [alphaKey]);
  await page.locator('[data-panel="git"]').click(); await page.locator('.git-workspace').first().waitFor();
  assert.deepEqual(await sectionOrder('.git-workspace'), [alphaKey, betaKey]);
  await page.screenshot({path: path.join(output, 'weave-workspaces-git.png')});

  // Search interleaves every active workspace by relevance, labelling each result.
  await page.getByRole('button', {name: 'Search', exact: true}).click(); await page.locator('#search-query').fill('lighthouse');
  await page.waitForFunction(() => document.querySelectorAll('#search-results .result.workspace-result').length === 2);
  assert.deepEqual((await page.locator('#search-results .result-workspace-label').allInnerTexts()).sort(), ['Alpha', 'Beta']);
  assert.equal(await page.locator('#search-results .result small').count(), 0, 'filenames are hidden by default');
  assert.equal(await page.locator('#ask-form button').count(), 0, 'Enter runs deep search');
  const head = await page.locator('#search-results .result-head').first().boundingBox(), label = await page.locator('#search-results .result-workspace-label').first().boundingBox();
  assert(Math.abs(head.y + head.height / 2 - label.y - label.height / 2) < 4 && label.x > head.x + head.width / 2, 'the workspace label is right-aligned on the title line');
  await page.locator('#search-filter > summary').click(); await page.locator(`[data-search-workspace="${alphaKey}"]`).uncheck();
  await page.waitForFunction(() => document.querySelectorAll('#search-results .result').length === 1);
  assert.equal(await page.locator('#search-results .result-workspace-label').innerText(), 'Beta');
  await page.locator(`[data-search-workspace="${alphaKey}"]`).check(); await page.locator('#search-filter > summary').click();
  await page.waitForFunction(() => document.querySelectorAll('#search-results .result').length === 2);
  await page.screenshot({path: path.join(output, 'weave-workspaces-search.png')});
  // A result from another workspace loads into the same tab; Back returns across workspaces.
  await page.locator('#search-results .result', {hasText: 'Beta plan'}).click();
  await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Plan.md');
  assert.equal(await page.locator('#file-tabs [role="tab"]').count(), 2, 'another workspace\'s article loads into the same tab');
  assert.equal(await page.locator('.file-tab.active .tab-workspace').innerText(), 'Beta', 'the tab takes the colour and name of the workspace it now shows');
  await page.keyboard.press('Alt+ArrowLeft'); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Overview.md');
  assert.equal(await page.locator('.file-tab.active .tab-workspace').innerText(), 'Alpha');
  await page.locator('#file-tabs [role="tab"]').nth(1).click(); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Plan.md');

  // Control panel: rename, recolour, reorder.
  await page.locator('[data-panel="settings"]').click(); await page.locator('.workspace-card').nth(1).waitFor();
  assert.equal(await page.locator('.workspace-card').count(), 2);
  assert.equal(await page.locator('.workspace-card.current').getAttribute('data-ws'), betaKey);
  assert.match(await page.locator('.workspace-card.current').innerText(), /In use/);
  assert.equal(await page.locator('[data-ws-show]').count(), 0);
  await page.locator(`.workspace-card[data-ws="${betaKey}"] [data-ws-name]`).fill('Team plans'); await page.locator(`.workspace-card[data-ws="${betaKey}"] [data-ws-name]`).press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('#file-tabs .tab-workspace')].some(node => node.textContent === 'Team plans'));
  await page.locator(`.workspace-card[data-ws="${betaKey}"] [data-ws-color]`).evaluate(input => {input.value = '#cc3366'; input.dispatchEvent(new Event('change', {bubbles: true}));});
  await page.waitForFunction(key => document.querySelector(`.tree-workspace[data-ws="${key}"]`)?.style.getPropertyValue('--workspace-color') === '#cc3366', betaKey);
  await page.locator(`.workspace-card[data-ws="${betaKey}"] [data-ws-move="-1"]`).click();
  await page.waitForFunction(key => document.querySelector('.tree-workspace')?.dataset.ws === key, betaKey);
  assert.deepEqual(await sectionOrder('.git-workspace'), [betaKey, alphaKey], 'Git sections follow the workspace order');
  await page.screenshot({path: path.join(output, 'weave-workspaces-control-panel.png')});
  await page.keyboard.press('Control+,'); await page.locator('#settings-dialog .workspace-card').first().waitFor();
  await page.screenshot({path: path.join(output, 'weave-workspaces-settings.png')}); await page.keyboard.press('Escape'); await page.locator('#settings-dialog').waitFor({state: 'hidden'});
  // Workspace names in tabs can be turned off without changing the tab height.
  const tabHeight = await page.locator('.file-tab').first().evaluate(node => node.getBoundingClientRect().height);
  await page.locator('[data-panel="appearance"]').click(); await ensureAppearanceSection(page, 'appearance-tabs');
  await page.locator('#tab-workspace-names').uncheck(); assert.equal(await page.locator('#file-tabs .tab-workspace').count(), 0);
  assert.equal(await page.locator('.file-tab').first().evaluate(node => node.getBoundingClientRect().height), tabHeight, 'workspace names do not enlarge tabs');
  assert.equal(await page.locator('.file-tab.workspace-tab').count(), 2, 'tabs keep their workspace colour');
  await page.locator('#tab-workspace-names').check();
  await page.locator('#tab-tint').uncheck(); await page.waitForFunction(() => getComputedStyle(document.querySelector('.file-tab.workspace-tab:not(.active)')).backgroundColor === 'rgba(0, 0, 0, 0)'); assert.equal(await page.locator('.file-tab.workspace-tab:not(.active)').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)', 'tab colouring can be turned off');
  await page.locator('#tab-tint').check();

  // Restore after reload keeps workspaces, order, names, colours and tabs.
  await page.reload(); await page.locator('[data-tree-path="Plan.md"]').waitFor(); await page.locator('[data-tree-path="Overview.md"]').waitFor();
  await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Plan.md');
  assert.deepEqual(await sectionOrder('.tree-workspace'), [betaKey, alphaKey]);
  assert.deepEqual(await tabNames(), ['Alpha', 'Team plans']);
  assert.equal(await page.locator(`.tree-workspace[data-ws="${betaKey}"]`).evaluate(node => node.style.getPropertyValue('--workspace-color')), '#cc3366');
  await page.screenshot({path: path.join(output, 'weave-workspaces-tabs.png')});

  // Each tab remembers its reading position across tab switches and Back/Forward.
  if (await page.locator('.rail [data-panel="files"]').getAttribute('aria-pressed') !== 'true') await page.locator('.rail [data-panel="files"]').click();
  await page.locator('#file-tabs [role="tab"]').first().click(); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Overview.md');
  await page.locator('[data-tree-path="Long.md"]').click();
  await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Long.md');
  await page.locator('#note-panel').evaluate(node => {node.scrollTop = 1500;}); await page.waitForTimeout(100);
  const position = await page.locator('#note-panel').evaluate(node => node.scrollTop);
  assert(position > 1000, 'the long article scrolls');
  await page.locator('#file-tabs [role="tab"]').nth(1).click(); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Plan.md');
  // Sample every frame while switching back: the article must never be visible at another position.
  await page.evaluate(() => {window.__samples = []; const panel = document.getElementById('note-panel'), sample = () => {if (!panel.hidden && getComputedStyle(panel).visibility === 'visible' && document.getElementById('note-path').dataset.path === 'Long.md') {window.__samples.push(panel.scrollTop); const lines = [...document.querySelectorAll('#article .cm-line')].filter(line => {const box = line.getBoundingClientRect(); return box.bottom > 0 && box.top < innerHeight;}); (window.__styled ||= []).push(lines.filter(line => /\*\*|\]\(|^##/.test(line.textContent)).length);} if (window.__samples.length < 40) requestAnimationFrame(sample);}; requestAnimationFrame(sample);});
  await page.locator('#file-tabs [role="tab"]').first().click(); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Long.md');
  await page.waitForTimeout(400); assert(Math.abs(await page.locator('#note-panel').evaluate(node => node.scrollTop) - position) < 4, 'switching tabs keeps the reading position');
  const samples = await page.evaluate(() => window.__samples);
  assert(samples.length && samples.every(top => Math.abs(top - position) < 4), 'the article appears at its position without a jump: ' + samples.slice(0, 8));
  const unstyled = await page.evaluate(() => window.__styled);
  assert(unstyled.length && unstyled.every(n => n === 0), 'Markdown is fully rendered in the first visible frame (no raw ** or link syntax pops in): ' + unstyled.slice(0, 8));
  await page.locator('[data-tree-path="Overview.md"]').click(); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Overview.md');
  await page.keyboard.press('Alt+ArrowLeft'); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Long.md');
  await page.waitForTimeout(150); assert(Math.abs(await page.locator('#note-panel').evaluate(node => node.scrollTop) - position) < 4, 'Back returns to the reading position');

  // Autosave is on by default (650 ms); the unsaved dot waits a second, so it never flickers.
  if (await page.locator('#edit-mode').getAttribute('aria-pressed') !== 'true') await page.locator('#edit-mode').click();
  await page.evaluate(() => {window.__dots = 0; new MutationObserver(() => {if (document.querySelector('.file-tab.unsaved')) window.__dots++;}).observe(document.getElementById('file-tabs'), {subtree: true, attributes: true, attributeFilter: ['class']});});
  await page.locator('#article .cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' Autosaved');
  for (let i = 0; i < 40 && !/Autosaved/.test(await fs.readFile(path.join(alpha, 'Long.md'), 'utf8')); i++) await page.waitForTimeout(100);
  assert.match(await fs.readFile(path.join(alpha, 'Long.md'), 'utf8'), /Autosaved/, 'changes save automatically');
  await page.waitForTimeout(1200); assert.equal(await page.evaluate(() => window.__dots), 0, 'no unsaved dot appears for a prompt autosave');
  // With autosave off, unsaved changes show a dot and stay with the article.
  if (await page.locator('.rail [data-panel="settings"]').getAttribute('aria-pressed') !== 'true') await page.locator('.rail [data-panel="settings"]').click();
  assert.equal(await page.locator('#autosave-delay').inputValue(), '650');
  await page.locator('#autosave-mode').selectOption('off');
  await page.locator('.rail [data-panel="files"]').click();
  await page.locator('#article .cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' Draft words');
  await page.waitForFunction(() => document.querySelector('.file-tab.active')?.classList.contains('unsaved'));
  await page.waitForTimeout(1500); assert.doesNotMatch(await fs.readFile(path.join(alpha, 'Long.md'), 'utf8'), /Draft words/, 'nothing is saved automatically');
  await page.screenshot({path: path.join(output, 'weave-workspaces-unsaved.png')});
  await page.locator('#file-tabs [role="tab"]').nth(1).click(); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Plan.md');
  assert(await page.locator('.file-tab').first().evaluate(node => node.classList.contains('unsaved')), 'the draft keeps its tab marked');
  await page.locator('#file-tabs [role="tab"]').first().click(); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Long.md');
  await page.waitForFunction(() => document.getElementById('article').textContent.includes('Draft words'));
  await page.waitForFunction(() => document.querySelector('.file-tab.active')?.classList.contains('unsaved'));
  await page.keyboard.press('Control+s'); await page.waitForFunction(() => !document.querySelector('.file-tab.active')?.classList.contains('unsaved'));
  for (let i = 0; i < 40 && !/Draft words/.test(await fs.readFile(path.join(alpha, 'Long.md'), 'utf8')); i++) await page.waitForTimeout(100);
  assert.match(await fs.readFile(path.join(alpha, 'Long.md'), 'utf8'), /Draft words/);

  // Find in article floats over the article pane, not the window controls.
  await page.locator('#article .cm-content').click(); await page.keyboard.press('Control+f'); await page.locator('#find-bar').waitFor();
  await page.locator('#find-query').fill('Paragraph 15'); await page.waitForFunction(() => /\/11$/.test(document.getElementById('find-count').textContent));
  const findBox = await page.locator('#find-bar').boundingBox(), controlsBox = await page.locator('#window-controls').boundingBox(), mainBox = await page.locator('main').boundingBox();
  assert(findBox.y > controlsBox.y + controlsBox.height && findBox.x + findBox.width <= mainBox.x + mainBox.width, 'find bar sits inside the article pane');
  const first = Number((await page.locator('#find-count').innerText()).split('/')[0]);
  await page.keyboard.press('Enter'); assert.equal(await page.locator('#find-count').innerText(), (first % 11 + 1) + '/11', 'Enter moves to the next match');
  await page.keyboard.press('Escape'); await page.locator('#find-bar').waitFor({state: 'hidden'});

  // Spell checking while editing: suggestions replace the word; Ignore remembers it.
  await page.locator('#article .cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' Teh recieve and `recieve` here');
  await page.waitForFunction(() => document.querySelectorAll('#article .spell-error').length >= 2);
  const misspelled = await page.locator('#article .spell-error').allInnerTexts();
  assert.deepEqual(misspelled.slice(-2), ['Teh', 'recieve'], 'prose is checked and inline code is not, by default: ' + misspelled);
  await page.locator('#article .spell-error', {hasText: 'recieve'}).last().click({button: 'right'});
  await page.locator('#spell-menu .spell-suggestion').first().waitFor();
  assert.equal(await page.locator('#spell-menu .spell-suggestion').first().innerText(), 'receive');
  const suggestion = await page.locator('#spell-menu .spell-suggestion').first().evaluate(node => ({focused: document.activeElement === node, outline: getComputedStyle(node).outlineStyle}));
  assert(suggestion.focused && suggestion.outline === 'none', 'the focused suggestion is highlighted without a clipped outline');
  const squiggle = await page.locator('#article .spell-error').first().evaluate(node => getComputedStyle(node).textDecorationColor);
  assert.match(squiggle, /color\(srgb [\d. ]+ \/ 0\.55\)|rgba\(\d+, \d+, \d+, 0\.55\)/, 'the underline is faint by default: ' + squiggle);
  const box = await page.locator('#article-menu').boundingBox();
  await page.screenshot({path: path.join(output, 'weave-spelling-menu.png'), clip: {x: box.x - 120, y: box.y - 30, width: box.width + 140, height: box.height + 40}});
  await page.locator('#spell-menu .spell-suggestion').first().click();
  await page.waitForFunction(() => document.getElementById('article').textContent.includes('Teh receive and'));
  await page.locator('#article .spell-error', {hasText: 'Teh'}).last().click({button: 'right'});
  assert.equal(await page.locator('#spell-menu .spell-suggestion').first().innerText(), 'The', 'suggestions keep capitalization');
  await page.locator('[data-spell-ignore]').click();
  await page.waitForFunction(() => ![...document.querySelectorAll('#article .spell-error')].some(node => node.textContent === 'Teh'));
  await page.locator('.rail [data-panel="settings"]').click();
  assert.match(await page.locator('#spell-ignored').innerText(), /teh/);
  await page.locator('[data-panel="appearance"]').click(); await ensureAppearanceSection(page, 'appearance-spelling');
  await page.locator('#spell-style').selectOption('dotted');
  assert.equal(await page.locator('#article .spell-error').first().evaluate(node => getComputedStyle(node).textDecorationStyle), 'dotted');
  await page.locator('#spell-style').selectOption('wavy'); await page.locator('.rail [data-panel="settings"]').click();
  await page.locator('#spell-code').check(); await page.waitForFunction(() => [...document.querySelectorAll('#article .spell-error')].some(node => node.textContent === 'recieve'));
  await page.locator('#spell-code').uncheck(); await page.locator('#spell-enabled').uncheck(); await page.waitForFunction(() => !document.querySelector('#article .spell-error'));
  await page.locator('#spell-enabled').check(); await page.locator('[data-unignore="teh"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#article .spell-error')].some(node => node.textContent === 'Teh'));
  // A word being typed is checked once it is finished, unless that is turned off.
  const flagged = word => page.evaluate(word => [...document.querySelectorAll('#article .spell-error')].some(node => node.textContent === word), word);
  await page.locator('#article .cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' wronng');
  await page.waitForTimeout(400); assert.equal(await flagged('wronng'), false, 'a half-typed word is not marked while the caret is in it');
  await page.keyboard.type(' '); await page.waitForFunction(() => [...document.querySelectorAll('#article .spell-error')].some(node => node.textContent === 'wronng'));
  await page.keyboard.type('nexd'); await page.waitForTimeout(400); assert.equal(await flagged('nexd'), false);
  await page.keyboard.press('Home'); await page.waitForFunction(() => [...document.querySelectorAll('#article .spell-error')].some(node => node.textContent === 'nexd'));
  if (!await page.locator('#spell-wait').isVisible()) await page.locator('.rail [data-panel="settings"]').click();
  await page.locator('#spell-wait').uncheck();
  await page.locator('#article .cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' badd');
  await page.waitForFunction(() => [...document.querySelectorAll('#article .spell-error')].some(node => node.textContent === 'badd'));
  await page.locator('#spell-wait').check();
  // Ignored words can be added and removed in Settings › Spellchecking.
  await page.locator('#spell-ignore-word').fill('Wronng'); await page.locator('#spell-ignore-word').press('Enter');
  await page.waitForFunction(() => ![...document.querySelectorAll('#article .spell-error')].some(node => node.textContent === 'wronng'));
  assert.match(await page.locator('#spell-ignored').innerText(), /wronng/);
  await page.locator('[data-unignore="wronng"]').click(); await page.waitForFunction(() => [...document.querySelectorAll('#article .spell-error')].some(node => node.textContent === 'wronng'));
  await page.locator('#open-settings').click(); await page.locator('#settings-dialog .settings-nav-item', {hasText: /^Spellchecking$/}).click();
  const spellingCategory = page.locator('#settings-dialog .settings-category:not([hidden])');
  assert.equal(await spellingCategory.locator('h2').innerText(), 'Spellchecking');
  for (const id of ['spell-wait', 'spell-ignore-word', 'spell-style', 'spell-color']) assert(await spellingCategory.locator('#' + id).isVisible(), id + ' is under the Spellchecking settings');
  assert.equal(await page.locator('#settings-dialog .settings-nav-item', {hasText: /^Spelling underline$/}).count(), 0, 'the underline settings are not a separate category');
  await page.keyboard.press('Escape'); await page.locator('#settings-dialog').waitFor({state: 'hidden'});
  // The dialog's close event, which restores the panels, follows its hiding.
  await page.waitForFunction(() => !!document.querySelector('#appearance-panel #appearance-spelling'), null, {timeout: 5000});
  assert.equal(await page.locator('#appearance-panel #appearance-spelling').count(), 1, 'closing Settings returns the underline settings to Appearance');
  // Interface text follows the system's English; article text never changes.
  for (const [locale, expected] of [['en-US', 'Colors and Themes'], ['en-GB', 'Colours and Themes'], ['en-NZ', 'Colours and Themes']]) {
    const context = await browser.newContext({locale}), lite = await context.newPage();
    await lite.goto(pathToFileURL(path.join(ROOT, 'weave_lite.html')).href);
    await lite.waitForFunction(text => document.querySelector('#appearance-colours > summary')?.textContent === text, expected);
    await context.close();
  }
  const variant = englishVariant(await page.evaluate(() => navigator.languages));
  assert.equal(await page.locator('#spell-dictionary option').first().innerText(), 'Follow system (' + (variant === 'en-US' ? 'English (US)' : 'English (UK)') + ')');
  assert.equal(await page.locator('#appearance-colours > summary').textContent(), localizeText('Colours and Themes', variant));
  await page.locator('.rail [data-panel="files"]').click();

  // Each workspace has its own collapse control, also in the Files context menu.
  await page.locator('[data-tree-path="Systems"]').click(); await page.locator('[data-tree-path="Systems/Store.md"]').waitFor();
  await page.locator(`[data-collapse-workspace="${alphaKey}"]`).click(); await page.locator('[data-tree-path="Systems/Store.md"]').waitFor({state: 'detached'});
  await page.locator('[data-tree-path="Systems"]').click(); await page.locator('[data-tree-path="Systems"]').click({button: 'right'});
  await page.locator('[data-file-action="collapse-workspace"]').click(); await page.locator('[data-tree-path="Systems/Store.md"]').waitFor({state: 'detached'});

  // Deleting needs no save and keeps no backup by default.
  await page.locator('#article .cm-content').click(); await page.keyboard.type(' unsaved');
  await page.waitForFunction(() => document.querySelector('.file-tab.active')?.classList.contains('unsaved'));
  await page.locator('[data-tree-path="Scratch.md"]').click({button: 'right'}); await page.locator('[data-file-action="delete"]').click();
  assert.match(await page.locator('#prompt-description').innerText(), /permanently removed/);
  await page.locator('#prompt-ok').click(); await page.locator('[data-tree-path="Scratch.md"]').waitFor({state: 'detached'});
  assert.equal(await fs.stat(path.join(alpha, 'Scratch.md')).catch(() => null), null);
  assert.equal(await fs.stat(path.join(temporary, '.weave', 'trash')).catch(() => null), null, 'no backup copy by default');
  assert(await page.locator('.file-tab.active').evaluate(node => node.classList.contains('unsaved')), 'unrelated unsaved changes are untouched');
  await page.waitForFunction(() => document.querySelector('.file-tab.active')?.classList.contains('unsaved'));
  await page.keyboard.press('Control+s'); await page.waitForFunction(() => !document.querySelector('.file-tab.active')?.classList.contains('unsaved'));

  // Back/Forward skip articles of deactivated workspaces.
  await page.locator('[data-tree-path="Plan.md"]').click(); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Plan.md');
  await page.locator('[data-tree-path="Overview.md"]').click(); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Overview.md');
  assert.equal(await page.locator('#file-tabs [role="tab"]').count(), 2);

  // Deactivating keeps the workspace's session; activating restores its tabs.
  if (await page.locator('.rail [data-panel="settings"]').getAttribute('aria-pressed') !== 'true') await page.locator('.rail [data-panel="settings"]').click();
  await page.evaluate(() => {window.__messages = []; new MutationObserver(() => window.__messages.push(document.getElementById('message').textContent)).observe(document.getElementById('message'), {childList: true, characterData: true, subtree: true});});
  await page.locator(`.workspace-card[data-ws="${betaKey}"] [data-ws-close]`).click();
  await page.waitForFunction(() => document.querySelectorAll('.tree-workspace').length === 1);
  assert.equal(await page.locator('#file-tabs [role="tab"]').count(), 1);
  assert.equal(await page.locator('#search-filter').isHidden(), true, 'the search filter appears only with several workspaces');
  await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Overview.md');
  await page.keyboard.press('Alt+ArrowLeft'); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Long.md');
  assert.equal(await page.locator('#file-tabs .tab-workspace').count(), 0);
  await page.locator('#recent-workspace-list [data-ws-reopen]').waitFor();
  assert.match(await page.locator('#recent-workspace-list').innerText(), /Team plans/);
  await page.locator('#recent-workspace-list [data-ws-reopen]').click();
  await page.waitForFunction(() => document.querySelectorAll('.tree-workspace').length === 2 && document.querySelectorAll('#file-tabs [role="tab"]').length === 2);
  await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Plan.md');
  assert.deepEqual(await page.evaluate(() => window.__blockedStyles), [], 'no inline style attribute is blocked by the desktop CSP');
  // Export a workspace as a portable read-only reader and open it like a recipient would.
  await page.locator('.rail [data-panel="export"]').click(); await page.locator('#export-run').waitFor();
  await page.locator('#export-workspace').selectOption(alphaKey);
  assert.equal(await page.locator('#export-run').innerText(), 'Export Alpha…');
  await page.locator('#export-run').click(); await page.waitForFunction(() => /^Exported/.test(document.getElementById('export-status').textContent));
  assert.equal(exportRequest.name, 'Alpha', 'the default file name comes from the workspace name');
  assert.match(await page.locator('#export-status').innerText(), /3 articles and 161 links/);
  await page.screenshot({path: path.join(output, 'weave-workspaces-export.png')});
  const reader = await browser.newPage({viewport: {width: 1300, height: 900}}), requests = [], readerErrors = [];
  reader.on('request', request => requests.push(request.url())); reader.on('pageerror', error => readerErrors.push(error.message));
  await reader.goto(pathToFileURL(exported).href);
  await reader.locator('[data-tree-path="Overview.md"]').waitFor();
  assert.equal(await reader.title(), 'Alpha · Weave');
  assert(await reader.locator('#choose-workspace').isHidden() && await reader.locator('#welcome-open').isHidden(), 'an export cannot open other folders');
  assert(await reader.locator('#edit-mode').isDisabled(), 'an export is read-only');
  await reader.locator('[data-tree-path="Overview.md"]').click(); await reader.locator('#article .cm-line').first().waitFor();
  assert.match(await reader.locator('#article').innerText(), /Alpha overview/);
  assert(await reader.locator('#graph-panel').isVisible(), 'an export opens articles with the graph showing');
  assert.equal(Math.round((await reader.locator('#sidebar').boundingBox()).width), 180, 'exports open with the narrowest Files panel');
  assert.match(await reader.locator('[data-tree-path="Overview.md"] .tree-secondary').innerText(), /\.md$/, 'exports show file extensions');
  for (const hidden of ['#graph-count', '.graph-scroll-hint', '#graph-spacing', '#graph-palette']) assert(await reader.locator(hidden).isHidden(), hidden + ' is hidden by default');
  await reader.waitForFunction(() => document.querySelectorAll('#graph-nodes [data-node]').length >= 2);
  await reader.getByRole('button', {name: 'Search', exact: true}).click(); await reader.locator('#search-query').fill('lighthouse');
  await reader.locator('#search-results .result').first().waitFor();
  await reader.keyboard.press('Control+o'); await reader.waitForTimeout(200);
  await reader.screenshot({path: path.join(output, 'weave-workspace-export-reader.png')});
  assert.deepEqual(requests.filter(url => !url.startsWith('file:') && !url.startsWith('data:')), [], 'the export makes no network requests');
  assert.deepEqual(readerErrors, []);
  await reader.close();

  // Files context menus export a whole workspace or a single folder.
  await page.locator('.rail [data-panel="files"]').click();
  await page.locator(`.tree-workspace[data-ws="${alphaKey}"] .tree-workspace-heading`).click({button: 'right'});
  assert(await page.locator('[data-file-action="export-workspace"]').isVisible()); assert(await page.locator('[data-file-action="export-folder"]').isHidden());
  await page.keyboard.press('Escape');
  await page.locator('[data-tree-path="Systems"]').click({button: 'right'});
  assert(await page.locator('[data-file-action="export-workspace"]').isHidden());
  await page.locator('[data-file-action="export-folder"]').click();
  await page.waitForFunction(() => /^Workspace|^Folder exported/.test(document.getElementById('message').textContent));
  assert.equal(exportRequest.folder, 'Systems'); assert.equal(exportRequest.name, 'Systems', 'a folder export is named after the folder');
  const folderReader = await browser.newPage();
  await folderReader.goto(pathToFileURL(folderExport).href); await folderReader.locator('[data-tree-path="Systems/Store.md"]').waitFor();
  assert.equal(await folderReader.locator('[data-tree-path="Overview.md"]').count(), 0, 'only the folder is exported');
  assert.equal(await folderReader.title(), 'Systems · Weave');
  await folderReader.close();

  // Saving records created_at and updated_at; neither has a property pill.
  const longText = await fs.readFile(path.join(alpha, 'Long.md'), 'utf8');
  assert.match(longText, /^---\ntype: Note\ncreated_at: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d\nupdated_at: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d\n---\n# Long article\n/, 'a saved article gains created_at and updated_at: ' + longText.slice(0, 120));
  if (await page.locator('.rail [data-panel="files"]').getAttribute('aria-pressed') !== 'true') await page.locator('.rail [data-panel="files"]').click();
  await page.locator('[data-tree-path="Long.md"]').click(); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Long.md');
  await page.locator('#okf-bar [data-okf-field="type"]').waitFor();
  assert.equal(await page.locator('#okf-bar [data-okf-field="created_at"], #okf-bar [data-okf-field="updated_at"]').count(), 0, 'the timestamps have no pills');
  const stampedOnce = longText.match(/created_at: (.+)/)[1];
  await page.locator('#article .cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' Stamped'); await page.keyboard.press('Control+s');
  for (let i = 0; i < 40 && !/Stamped/.test(await fs.readFile(path.join(alpha, 'Long.md'), 'utf8')); i++) await page.waitForTimeout(100);
  const restamped = await fs.readFile(path.join(alpha, 'Long.md'), 'utf8');
  assert.equal(restamped.match(/created_at: (.+)/)[1], stampedOnce, 'created_at is kept on later saves');
  assert.equal((restamped.match(/^updated_at:/gm) || []).length, 1);
  await page.waitForFunction(() => !document.querySelector('.file-tab.active')?.classList.contains('unsaved'));
  await page.waitForFunction(() => document.getElementById('save-status').textContent === 'Saved'); await page.waitForTimeout(800);
  assert.equal(await page.locator('#save-status').innerText(), 'Saved', 'stamping is not an unsaved edit');

  // Right-clicking an article link opens it in a new tab, while editing or reading.
  await page.locator('[data-tree-path="Overview.md"]').click(); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Overview.md');
  const tabCount = () => page.locator('#file-tabs [role="tab"]').count(), tabsBefore = await tabCount();
  await page.locator('#article [data-editor-link]').first().click({button: 'right'});
  assert(await page.locator('#article-link-actions').isVisible(), 'the editing menu offers Open in new tab on a link');
  await page.locator('#article-link-actions [data-link-action="open-tab"]').click();
  await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Systems/Store.md');
  assert.equal(await tabCount(), tabsBefore + 1, 'the link opens in a new tab');
  await page.locator('#file-tabs [role="tab"]', {hasText: 'Overview'}).click(); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Overview.md');
  await page.locator('#article .cm-content').click({button: 'right', position: {x: 4, y: 4}});
  assert(await page.locator('#article-link-actions').isHidden(), 'Open in new tab appears only on links');
  await page.keyboard.press('Escape');
  await page.locator('#edit-mode').click(); await page.waitForFunction(() => document.getElementById('article').dataset.editorMode === 'read');
  await page.locator('#article [data-editor-link]').first().click({button: 'right'});
  await page.locator('#link-menu').waitFor();
  assert.deepEqual(await page.locator('#link-menu button').allInnerTexts(), ['Open link', 'Open in new tab', 'Open to the right']);
  await page.locator('#link-menu [data-link-action="open-tab"]').click();
  await page.waitForFunction(count => document.getElementById('note-path').dataset.path === 'Systems/Store.md' && document.querySelectorAll('#file-tabs [role="tab"]').length === count, tabsBefore + 2);
  await page.locator('#edit-mode').click(); await page.waitForFunction(() => document.getElementById('article').dataset.editorMode === 'edit');
  for (let i = 2; i > 0; i--) {await page.locator('.file-tab', {hasText: 'Store'}).first().locator('.close-tab').click(); await page.waitForFunction(count => document.querySelectorAll('#file-tabs [role="tab"]').length === count, tabsBefore + i - 1);}
  await page.waitForFunction(count => document.querySelectorAll('#file-tabs [role="tab"]').length === count, tabsBefore);

  // Tabs can be dragged to a new position and keep their own Back/Forward history.
  const tabOrder = () => page.locator('#file-tabs [data-tab-id]').evaluateAll(nodes => nodes.map(node => node.dataset.tabId));
  // Measure in the page: Files and tabs re-render, so a located node can be replaced between steps.
  const measure = locator => locator.evaluate(node => {const box = node.getBoundingClientRect(); return {x: box.x, y: box.y, width: box.width, height: box.height};});
  const dragMouse = async (from, x, y) => {
    const box = await measure(from), sx = box.x + box.width / 2, sy = box.y + box.height / 2;
    await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(sx + 8, sy + 3, {steps: 2}); await page.mouse.move(x, y, {steps: 14}); await page.mouse.up();
  };
  await page.locator('#file-tabs [role="tab"]', {hasText: 'Overview'}).click(); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Overview.md');
  const order = await tabOrder(), overviewTab = await page.locator('.file-tab', {hasText: 'Overview'}).getAttribute('data-tab-id');
  assert(order.length >= 2, 'several tabs are open: ' + order);
  const tabAt = id => page.locator(`.file-tab[data-tab-id="${id}"] [role="tab"]`), edges = async () => {await page.waitForTimeout(150); return page.locator('#file-tabs .file-tab').evaluateAll(nodes => [nodes[0], nodes.at(-1)].map(node => {const box = node.getBoundingClientRect(); return {x: box.x, y: box.y, width: box.width, height: box.height};}));};
  const dragToEdge = async (id, end) => {const [first, last] = await edges(), box = end ? last : first; await dragMouse(tabAt(id), end ? box.x + box.width - 3 : box.x + 3, box.y + box.height / 2);};
  const toEnd = order[0] === overviewTab, without = id => order.filter(other => other !== id);
  await dragToEdge(overviewTab, toEnd);
  assert.deepEqual(await tabOrder(), toEnd ? [...without(overviewTab), overviewTab] : [overviewTab, ...without(overviewTab)], 'dragging moves the tab past the others');
  await page.keyboard.press('Alt+ArrowLeft'); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Long.md');
  await page.keyboard.press('Alt+ArrowRight'); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Overview.md');
  // Dragging an inactive tab reorders it without selecting it.
  const other = (await tabOrder()).find(id => id !== overviewTab);
  await dragToEdge(other, toEnd);
  const dragged = await tabOrder();
  assert.equal(dragged.at(toEnd ? -1 : 0), other, 'an inactive tab can be dragged too: ' + dragged);
  assert.equal(await page.evaluate(() => document.getElementById('note-path').dataset.path), 'Overview.md', 'dropping a tab does not also select it');
  await page.waitForTimeout(300); await page.reload(); await page.locator('[data-tree-path="Overview.md"]').waitFor();
  await page.waitForFunction(count => document.querySelectorAll('#file-tabs [data-tab-id]').length === count, dragged.length);
  assert.deepEqual(await tabOrder(), dragged, 'the new tab order is restored');
  await page.waitForFunction(() => !document.getElementById('note-panel').classList.contains('restoring') && /\S/.test(document.getElementById('article').innerText));
  await page.screenshot({path: path.join(output, 'weave-workspaces-tab-drag.png')});

  // Files and folders can be dragged to another folder. Links into them update
  // after a prompt whose Enter and Space keys mean Yes; No needs a click.
  if (await page.locator('#edit-mode').getAttribute('aria-pressed') !== 'true') await page.locator('#edit-mode').click();
  if (await page.locator('.rail [data-panel="files"]').getAttribute('aria-pressed') !== 'true') await page.locator('.rail [data-panel="files"]').click();
  const row = file => page.locator(`.tree-workspace[data-ws="${alphaKey}"] [data-tree-path="${file}"]`);
  const dragTo = async (from, to) => {await page.waitForTimeout(150); const box = await measure(to); await dragMouse(from, box.x + box.width / 2, box.y + box.height / 2);};
  await row('Systems').click(); await row('Systems/Store.md').waitFor();
  // Moves update the open article in place; reopening it would hide it and flicker.
  assert.equal(await page.evaluate(() => document.getElementById('note-path').dataset.path), 'Overview.md');
  await page.evaluate(() => {window.__reloads = 0; new MutationObserver(records => {for (const record of records) if (record.target.classList.contains('restoring') || record.target.hidden) window.__reloads++;}).observe(document.getElementById('note-panel'), {attributes: true, attributeFilter: ['class', 'hidden']});});
  await dragTo(row('Systems/Store.md'), page.locator(`.tree-workspace[data-ws="${alphaKey}"] .tree-workspace-heading`));
  await page.locator('#prompt-dialog[open]').waitFor();
  assert.equal(await page.locator('#prompt-title').innerText(), 'Update links?');
  assert.deepEqual([await page.locator('#prompt-ok').innerText(), await page.locator('#prompt-secondary').innerText()], ['Yes', 'No']);
  assert.match(await page.locator('#prompt-description').innerText(), /1 link across 1 note/);
  await page.keyboard.press('Enter'); await row('Store.md').waitFor();
  assert.match(await fs.readFile(path.join(alpha, 'Overview.md'), 'utf8'), /\[Store\]\(\.\/Store\.md "writes-to"\)/, 'Enter updates the links');
  await page.locator('#article [data-editor-link="Store.md"]').waitFor();
  assert.equal(await page.evaluate(() => window.__reloads), 0, 'the open article takes the updated link without reloading');
  assert.equal(await fs.stat(path.join(alpha, 'Systems/Store.md')).catch(() => null), null);
  await dragTo(row('Store.md'), row('Systems'));
  await page.locator('#prompt-dialog[open]').waitFor(); await page.keyboard.press('Tab'); await page.keyboard.press(' ');
  await row('Systems/Store.md').waitFor();
  assert.match(await fs.readFile(path.join(alpha, 'Overview.md'), 'utf8'), /\[Store\]\(\.\/Systems\/Store\.md "writes-to"\)/, 'Space means Yes even with another button focused');
  await dragTo(row('Systems/Store.md'), page.locator(`.tree-workspace[data-ws="${alphaKey}"] .tree-workspace-heading`));
  await page.locator('#prompt-dialog[open]').waitFor(); await page.locator('#prompt-secondary').click(); await row('Store.md').waitFor();
  assert.match(await fs.readFile(path.join(alpha, 'Overview.md'), 'utf8'), /\.\/Systems\/Store\.md/, 'clicking No moves without updating links');
  // A move with no affected links happens without a prompt; moves stay within a workspace.
  await fs.mkdir(path.join(beta, 'Archive')); await page.locator('#refresh').click();
  const betaRow = file => page.locator(`.tree-workspace[data-ws="${betaKey}"] [data-tree-path="${file}"]`);
  await betaRow('Archive').waitFor();
  await dragTo(betaRow('Plan.md'), page.locator(`.tree-workspace[data-ws="${alphaKey}"] .tree-workspace-heading`));
  await page.waitForFunction(() => /within their own workspace/.test(document.getElementById('message').textContent));
  assert(await betaRow('Plan.md').isVisible(), 'a drop on another workspace does nothing');
  await dragTo(betaRow('Plan.md'), betaRow('Archive'));
  await page.waitForFunction(() => /^Moved Plan\.md/.test(document.getElementById('message').textContent));
  assert(await page.locator('#prompt-dialog').evaluate(dialog => !dialog.open), 'no prompt without affected links');
  assert(await fs.stat(path.join(beta, 'Archive/Plan.md')));
  assert.equal(await page.evaluate(() => window.__reloads), 0, 'moving files never reloads the open article');

  // Split view: a tab opens on the right with tabs of its own. An article shown on
  // both sides shows edits from either, each side saves without conflicts, and the
  // layout is restored. Closing a side's last tab ends the split.
  const eventually = async (check, failure) => {for (let i = 0; i < 60; i++) {if (await check()) return; await page.waitForTimeout(100);} assert.fail(failure);};
  const overview = () => fs.readFile(path.join(alpha, 'Overview.md'), 'utf8'), focused = id => page.locator('#' + id).evaluate(node => node.classList.contains('focused'));
  const tabsOn = side => page.locator(`#file-tabs${side === 'right' ? '-2' : ''} [role="tab"]`).count();
  await page.locator('#file-tabs [role="tab"]', {hasText: 'Overview'}).click(); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Overview.md');
  const leftTabs = await tabsOn('left');
  assert(await page.locator('#editor-right').isHidden() && await page.locator('#split-resize').isHidden(), 'one side by default');
  await page.locator('#file-tabs [role="tab"]', {hasText: 'Overview'}).click({button: 'right'});
  assert.match(await page.locator('#context-split-tab').innerText(), /^Split right/);
  await page.locator('#context-split-tab').click();
  await page.locator('#file-tabs-2 [role="tab"]').waitFor();
  await page.waitForFunction(() => /lighthouse/.test(document.getElementById('article-2').innerText));
  assert.equal(await tabsOn('right'), 1); assert.equal(await tabsOn('left'), leftTabs, 'the left side keeps its tabs');
  assert(await focused('editor-right') && !await focused('editor-left'), 'the new side has the focus');
  const boxes = await page.evaluate(() => ['editor-left', 'editor-right'].map(id => {const box = document.getElementById(id).getBoundingClientRect(); return {x: box.x, width: box.width};}));
  assert(boxes[0].x < boxes[1].x && Math.abs(boxes[0].width - boxes[1].width) < 12, 'the sides sit left and right, equally wide: ' + JSON.stringify(boxes));
  await page.locator('#article-2 .cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' Mirrored words.');
  await page.waitForFunction(() => document.getElementById('article').innerText.includes('Mirrored words.'));
  // Autosave is off here: unsaved changes go with the focus to a side showing the same article.
  await page.locator('#article .cm-content').click(); assert(await focused('editor-left'), 'clicking a side focuses it');
  await page.keyboard.press('Control+End'); await page.keyboard.type(' Left words.');
  await page.waitForFunction(() => document.getElementById('article-2').innerText.includes('Left words.'));
  await page.waitForFunction(() => ['#file-tabs-2', '#file-tabs'].every(strip => document.querySelector(strip + ' .file-tab.active')?.classList.contains('unsaved')));
  assert.doesNotMatch(await overview(), /Mirrored words/, 'nothing is saved automatically');
  await page.keyboard.press('Control+s');
  await eventually(async () => /Mirrored words\. Left words\./.test(await overview()), 'one save writes the changes made on both sides');
  await page.waitForFunction(() => !document.querySelector('.file-tab.unsaved'));
  await page.locator('#article-2 .cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' Right again.'); await page.keyboard.press('Control+s');
  await eventually(async () => /Left words\. Right again\./.test(await overview()), 'the other side saves next without a conflict');
  assert.deepEqual(await page.evaluate(() => ['note-warning', 'note-warning-2'].map(id => document.getElementById(id).textContent)), ['', ''], 'neither side reports a conflict');
  await page.screenshot({path: path.join(output, 'weave-workspaces-split.png')});
  // Files and links open on the side opposite the focused one; tabs move between the sides.
  await page.locator(`.tree-workspace[data-ws="${alphaKey}"] [data-tree-path="Long.md"]`).click({button: 'right'});
  assert.equal(await page.locator('[data-file-action="open-side"]').innerText(), 'Open to the left'); await page.keyboard.press('Escape');
  await page.locator('#article .cm-content').click();
  await page.locator(`.tree-workspace[data-ws="${alphaKey}"] [data-tree-path="Long.md"]`).click({button: 'right'});
  assert.equal(await page.locator('[data-file-action="open-side"]').innerText(), 'Open to the right');
  await page.locator('[data-file-action="open-side"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#file-tabs-2 [role="tab"]').length === 2 && document.getElementById('note-path').dataset.path === 'Long.md');
  assert.equal(await tabsOn('left'), leftTabs);
  await page.locator('#file-tabs [role="tab"]', {hasText: 'Overview'}).click({button: 'right'});
  assert.equal(await page.locator('#context-move-tab').innerText(), 'Move to right side');
  await page.locator('#context-move-tab').click();
  await page.waitForFunction(count => document.querySelectorAll('#file-tabs-2 [role="tab"]').length === 3 && document.querySelectorAll('#file-tabs [role="tab"]').length === count, leftTabs - 1);
  assert.equal(await page.evaluate(() => document.getElementById('note-path').dataset.path), 'Overview.md', 'a moved tab is shown on its new side');
  await page.waitForTimeout(300); await page.reload(); await page.locator('[data-tree-path="Overview.md"]').waitFor();
  await page.waitForFunction(count => document.querySelectorAll('#file-tabs-2 [role="tab"]').length === 3 && document.querySelectorAll('#file-tabs [role="tab"]').length === count, leftTabs - 1);
  await page.waitForFunction(() => document.getElementById('editor-right').classList.contains('focused') && document.getElementById('note-path').dataset.path === 'Overview.md');
  await page.waitForFunction(() => /lighthouse/.test(document.getElementById('article-2').innerText) && /\S/.test(document.getElementById('article').innerText));
  // Dragging a tab onto the other side's tab bar moves it there.
  await page.waitForTimeout(500);
  const leftBar = await measure(page.locator('#tab-bar'));
  await dragMouse(page.locator('#file-tabs-2 .file-tab', {hasText: 'Long'}), leftBar.x + leftBar.width - 120, leftBar.y + leftBar.height / 2);
  await page.waitForFunction(count => document.querySelectorAll('#file-tabs-2 [role="tab"]').length === 2 && document.querySelectorAll('#file-tabs [role="tab"]').length === count, leftTabs);
  assert(await focused('editor-left') && await page.evaluate(() => document.getElementById('note-path').dataset.path) === 'Long.md', 'the dragged tab opens on its new side');
  await page.locator('#close-tabs-2').click();
  await page.waitForFunction(() => document.getElementById('editor-right').hidden && document.getElementById('split-resize').hidden);
  assert.equal(await tabsOn('left'), leftTabs, 'closing the right side keeps the left side\'s tabs');
  // Underlining is optional and off by default: <u> tags stay text until it is turned on.
  await page.locator('#article .cm-content').click(); await page.keyboard.press('Control+Home'); await page.keyboard.type('<u>lined</u> start ');
  assert.equal(await page.locator('#article .md-underline').count(), 0, 'underlines are off by default');
  assert(await page.locator('#format-underline').evaluate(item => item.hidden), 'the Format menu has no Underline while underlining is off');
  await page.locator('#underline-enabled').evaluate(box => box.click());
  await page.waitForFunction(() => /lined/.test(document.querySelector('#article .md-underline')?.textContent || ''));
  assert.equal(await page.locator('#format-underline').evaluate(item => item.hidden), false);
  assert.deepEqual(errors, []);
  console.log('Workspace verification passed: two open workspaces, divided Files, tinted tabs, focused Git sections, interleaved and filtered search, cross-workspace tab history, find in article, per-workspace collapse, delete without backup, scroll memory, unsaved drafts, names, colours, order, deactivate/activate, restore, portable export, timestamps, link menus, tab dragging, Files drag-and-drop moves without reloading, split view and optional underlining.');
} catch (error) {
  await page.screenshot({path: path.join(output, 'weave-workspaces-failure.png'), fullPage: true});
  console.error(await page.evaluate(() => ({path: document.getElementById('note-path').dataset.path, message: document.getElementById('message').textContent, back: document.getElementById('nav-back').disabled, focus: document.activeElement?.outerHTML.slice(0, 120), messages: window.__messages})));
  console.error(errors);
  throw error;
} finally {await browser.close(); await service.close(); await fs.rm(temporary, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});}
