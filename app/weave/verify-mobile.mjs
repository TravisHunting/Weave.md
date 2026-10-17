// Phone layout (mobile.mjs, mobile.css): drawers, touch sizes, Back handling,
// the Settings sheet, and the return to the desktop layout on a wide window.
// The page runs as on a phone reaching Weave Server over plain HTTP on a LAN:
// that origin is not a secure context, so crypto.randomUUID is absent.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ROOT} from './build.mjs';
import {createServer} from './server.mjs';
import {launchBrowser, blockedStyleElementMessage, menuItem} from './test-browser.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-mobile-')), output = path.join(ROOT, 'test-results');
await fs.mkdir(output, {recursive: true}); await fs.mkdir(path.join(root, 'Systems'));
await fs.writeFile(path.join(root, 'Overview.md'), '# Data platform\n\nPolicy records travel through typed connections.\n\n[Azure Data Factory](<Systems/Azure Data Factory.md> "depends-on")\n\n' + 'More prose about the platform. '.repeat(120));
await fs.writeFile(path.join(root, 'Systems/Azure Data Factory.md'), '# Azure Data Factory\n\nADF copies policy records into the reporting warehouse.');
const server = await createServer({root, port: 0, runtime: path.join(root, '.weave')});
const browser = await launchBrowser(), errors = [];
const context = await browser.newContext({locale: 'en-GB', viewport: {width: 393, height: 851}, deviceScaleFactor: 2, isMobile: true, hasTouch: true});
await context.addInitScript(() => {delete Crypto.prototype.randomUUID;});
const page = await context.newPage();
page.on('pageerror', e => errors.push(e.message)); page.on('console', m => {if (m.type() === 'error' && !blockedStyleElementMessage(m.text())) errors.push(m.text());});
const shot = name => page.screenshot({path: path.join(output, `mobile-${name}.png`)});
const box = selector => page.locator(selector).boundingBox();
const current = () => page.locator('#note-path').evaluate(e => e.dataset.path);
const leftOpen = () => page.evaluate(() => !document.body.classList.contains('sidebar-collapsed'));
const rightOpen = () => page.evaluate(() => document.body.classList.contains('right-sidebar-open'));
try {
  await page.goto(server.url);
  await page.locator('[data-tree-path="Overview.md"]').waitFor({state: 'attached'});
  assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined', 'the page runs without crypto.randomUUID');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.layout), 'mobile');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.skin), 'aurora aurora-thin aurora-flow', 'the default skin applies');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.scheme), 'grey', 'the default scheme applies');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 393, 'nothing scrolls sideways');
  // Without an article to show, the phone starts on the welcome screen with its actions in view, no drawer over them.
  await page.locator('#welcome [data-welcome="browse"]').waitFor();
  assert.equal(await leftOpen(), false, 'no drawer covers the start'); assert.equal(await rightOpen(), false);
  for (const action of ['random-article', 'browse', 'open-workspace']) {
    const button = page.locator(`#welcome [data-welcome="${action}"]`); assert(await button.isVisible(), action + ' is offered');
    assert((await button.boundingBox()).height >= 40, action + ' is a touch target');
  }
  await page.waitForTimeout(400); await shot('start');
  // Browse files opens the Files drawer.
  await page.locator('#welcome [data-welcome="browse"]').tap();
  await page.waitForFunction(() => !document.body.classList.contains('sidebar-collapsed'));
  assert(await page.locator('#files-panel').isVisible(), 'Browse files shows Files');
  await page.waitForTimeout(400);
  // The article column fills the window behind it; the scrim puts the drawer away.
  assert.equal((await box('main')).width, 393, 'the article column is the whole width');
  await page.locator('#mobile-scrim').tap({position: {x: 380, y: 400}}); assert.equal(await leftOpen(), false);
  await page.waitForTimeout(400);
  assert(!await page.locator('#sidebar').isVisible() || (await box('#sidebar')).x + (await box('#sidebar')).width <= 0, 'the drawer is off screen');
  assert(await page.locator('#mobile-scrim').isHidden());
  for (const id of ['mobile-drawer', 'app-menu-button', 'nav-back', 'nav-forward', 'view-graph', 'toggle-right-sidebar', 'edit-mode']) {
    const size = await box('#' + id); assert(size.width >= 40 && size.height >= 40, id + ' is a touch target');
  }
  await shot('welcome');
  // The drawer holds the rail and the sidebar; opening an article closes it.
  await page.locator('#mobile-drawer').tap();
  assert.equal(await leftOpen(), true); assert(await page.locator('#mobile-scrim').isVisible());
  assert.equal(await page.locator('#mobile-drawer').getAttribute('aria-expanded'), 'true');
  await page.waitForTimeout(400);
  assert.equal(Math.round((await box('.rail')).x), 0, 'the rail slides in at the edge');
  assert((await box('[data-tree-path="Overview.md"]')).height >= 40, 'file rows are touch targets');
  await shot('drawer');
  await page.locator('[data-tree-path="Overview.md"]').tap();
  await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Overview.md');
  assert.equal(await leftOpen(), false, 'opening an article closes the drawer');
  const article = await box('#article');
  assert(article.x >= 0 && article.x + article.width <= 393, 'the article fits the window');
  await shot('article');
  // Reading down slides the tab bar away and the article takes its place; scrolling up brings it back.
  const tabsHidden = () => page.locator('#editor-left').evaluate(e => e.hasAttribute('data-tabs-hidden'));
  await page.mouse.move(200, 500); for (let i = 0; i < 5; i++) {await page.mouse.wheel(0, 60); await page.waitForTimeout(60);}
  await page.waitForFunction(() => document.getElementById('editor-left').hasAttribute('data-tabs-hidden')); await page.waitForTimeout(400);
  assert((await box('#note-panel')).y <= (await box('#titlebar')).height + 1, 'the article rises into the tab bar\'s place');
  assert(await page.locator('#tab-bar').isHidden(), 'the hidden tab bar cannot be tapped');
  await shot('tabs-hidden');
  await page.mouse.wheel(0, -60); await page.waitForFunction(() => !document.getElementById('editor-left').hasAttribute('data-tabs-hidden'));
  await page.waitForTimeout(400); assert(await page.locator('#tab-bar').isVisible());
  await page.locator('#note-panel').evaluate(e => {e.scrollTop = 0;});
  // Typing in the article hides the tab bar too (this server is read-only, so the edit is only announced);
  // leaving the editor brings it back, as a short article cannot be scrolled up.
  await page.locator('#article .cm-content').dispatchEvent('beforeinput', {inputType: 'insertText', data: 'x'});
  assert.equal(await tabsHidden(), true, 'typing hides the tab bar');
  await page.waitForTimeout(400); await page.locator('#article .cm-content').dispatchEvent('focusout');
  await page.waitForFunction(() => !document.getElementById('editor-left').hasAttribute('data-tabs-hidden'));
  // Two fingers pinch the graph about their midpoint, and a touchpad pinch (Ctrl+wheel) zooms too.
  await page.locator('#view-graph').tap(); await page.locator('#graph [data-node]').first().waitFor();
  const zoom = async () => parseInt(await page.locator('#zoom-label').textContent());
  const graph = await box('#graph'), x = graph.x + graph.width / 2, y = graph.y + graph.height / 2, before = await zoom();
  if (browser.browserType().name() === 'chromium') {
    const cdp = await context.newCDPSession(page);
    const touch = (type, d) => cdp.send('Input.dispatchTouchEvent', {type, touchPoints: type === 'touchEnd' ? [] : [{x: x - d, y, id: 1}, {x: x + d, y, id: 2}]});
    await touch('touchStart', 20); for (let d = 25; d <= 60; d += 5) await touch('touchMove', d); await touch('touchEnd');
    const after = await zoom(); assert(Math.abs(after / before - 3) < .1, `a pinch zooms with the fingers (${before}% to ${after}%)`);
    assert.equal(await current(), 'Overview.md', 'a pinch opens nothing');
  }
  const pinched = await zoom();
  await page.mouse.move(x, y); await page.keyboard.down('Control'); await page.mouse.wheel(0, -50); await page.keyboard.up('Control');
  assert(await zoom() / pinched > 1.15, `a touchpad pinch zooms at the pace of the fingers (${pinched}% to ${await zoom()}%)`);
  await shot('graph-pinched');
  await page.locator('#view-graph').tap();
  await page.locator('#mobile-drawer').tap(); await page.locator('#tree [data-tree-path="Systems"]').tap();
  await page.locator('[data-tree-path="Systems/Azure Data Factory.md"]').tap();
  await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Systems/Azure Data Factory.md');
  // Back closes the drawer first, then goes Back in the tab, staying in Weave.
  await page.locator('#mobile-drawer').tap(); assert.equal(await leftOpen(), true);
  await page.goBack({waitUntil: 'commit'}); await page.waitForFunction(() => document.body.classList.contains('sidebar-collapsed'));
  assert.equal(await current(), 'Systems/Azure Data Factory.md', 'Back closed the drawer without leaving the article');
  await page.goBack({waitUntil: 'commit'}); await page.waitForFunction(() => document.getElementById('note-path').dataset.path === 'Overview.md');
  assert(page.url().startsWith(server.url), 'Back stayed in Weave');
  await page.waitForURL(/#note=Overview\.md$/); // the address names the shown article
  // One drawer at a time; the scrim closes either.
  await page.locator('#mobile-drawer').tap(); await page.locator('#toggle-right-sidebar').tap();
  assert.equal(await rightOpen(), true); assert.equal(await leftOpen(), false, 'opening the right drawer closes the left');
  const right = await box('#right-sidebar'); assert(right.x >= 0 && right.x + right.width <= 393.5, 'the right drawer fits');
  await shot('right-drawer');
  await page.locator('#mobile-scrim').tap({position: {x: 8, y: 400}}); assert.equal(await rightOpen(), false);
  // Settings: a full-screen list, then one category; Back returns to the list, then closes.
  await menuItem(page, 'menu-settings');
  const sheet = page.locator('#settings-dialog');
  assert.equal(await sheet.getAttribute('data-view'), 'list');
  assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'settings-search', 'opening Settings does not raise the keyboard');
  const dialog = await box('#settings-dialog'); assert(dialog.width >= 392 && dialog.height >= 850, 'Settings fills the screen');
  await shot('settings-list');
  await page.locator('.settings-nav-item').nth(1).tap(); assert.equal(await sheet.getAttribute('data-view'), 'detail');
  assert(await page.locator('.settings-nav').isHidden()); assert(await page.locator('.settings-back').isVisible());
  await shot('settings-detail');
  await page.goBack({waitUntil: 'commit'}); await page.waitForFunction(() => document.getElementById('settings-dialog').dataset.view === 'list');
  assert(await sheet.evaluate(e => e.open), 'Back returned to the list');
  await page.goBack({waitUntil: 'commit'}); await page.waitForFunction(() => !document.getElementById('settings-dialog').open);
  assert.equal(await current(), 'Overview.md');
  // Split view shows only the focused side and is not offered.
  await page.locator('#file-tabs [role="tab"]').first().dispatchEvent('contextmenu', {clientX: 40, clientY: 100});
  assert(await page.locator('#context-split-tab').isHidden(), 'split view is not offered');
  await page.keyboard.press('Escape');
  // A wide window returns to the desktop layout.
  await page.setViewportSize({width: 1200, height: 800});
  await page.waitForFunction(() => !document.documentElement.dataset.layout);
  assert.equal(await page.locator('#mobile-drawer').count(), 0); assert.equal(await page.locator('#mobile-scrim').count(), 0);
  assert(await page.locator('.rail').isVisible()); assert.equal(await page.locator('.rail').evaluate(e => getComputedStyle(e).position), 'static');
  await page.locator('.rail [data-panel="files"]').click(); assert.equal(await leftOpen(), true);
  assert((await box('main')).x > (await box('#sidebar')).x, 'the sidebar sits beside the article again');
  // A phone turned sideways keeps the phone layout.
  await page.setViewportSize({width: 851, height: 393});
  await page.waitForFunction(() => document.documentElement.dataset.layout === 'mobile');
  await shot('landscape');
  assert.deepEqual(errors, []);
  console.log('Mobile layout checks passed.');
} finally {
  await browser.close(); await server.close(); await fs.rm(root, {recursive: true, force: true});
}
