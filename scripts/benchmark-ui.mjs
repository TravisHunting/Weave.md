// Interface responsiveness at scale: the desktop page in Edge (Playwright),
// driven against the release Rust backend on a generated vault. Measures time
// to the first restored article, typing (long tasks), search, Files expansion,
// opening articles, external changes reaching the tree, and JS heap.
//
//   node scripts/benchmark-ui.mjs --docs 100000 [--cache DIR] [--check]
//
// The indexed runtime is cached beside the vault, so later runs restore it.
// Results go to test-results/ui-benchmark-<docs>.json; --check applies the
// `ui` budgets in scripts/performance-budgets.json.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {NativeHarness} from '../app/weave/tests/native-harness.mjs';
import {buildDesktop} from '../app/weave/build.mjs';
import {ensureVault, vaultFile, SEARCH_TERMS} from './scale-vault.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => {const i = process.argv.indexOf('--' + name); return i < 0 ? fallback : process.argv[i + 1];};
const flag = name => process.argv.includes('--' + name);
const docs = Number(option('docs', 10000)), cache = option('cache', path.join(os.tmpdir(), 'weave-scale'));
import {launchBrowser} from '../app/weave/test-browser.mjs';
const log = (...args) => console.log(...args);
const round = value => Math.round(value * 10) / 10;

if (!flag('no-build')) execFileSync('cargo', ['build', '--offline', '--release', '--manifest-path', path.join(ROOT, 'src-tauri/Cargo.toml'), '--features', 'native-test-host', '--bin', 'weave-test-host'], {stdio: 'inherit'});
const vault = path.join(cache, `vault-${docs}`);
await ensureVault(vault, docs, {log});
const runtime = path.join(cache, `ui-runtime-${docs}`);
await fsp.mkdir(runtime, {recursive: true});
await buildDesktop();
const host = new NativeHarness(runtime, {profile: 'release', timeout: 4 * 3600e3});
const results = {docs, date: new Date().toISOString(), phases: {}};
const record = (phase, value) => {results.phases[phase] = value; log(phase, JSON.stringify(value));};
const article = vaultFile(docs, Math.floor(docs / 3)), other = vaultFile(docs, Math.floor(docs / 3) + 1);
try {
  // Index once (cached runtime), then save a layout with one open article.
  let catalog = await host.call('restore');
  if (!catalog?.workspaces?.length) catalog = await host.call('open', {root: vault});
  for (;;) {const status = await host.call('status'); if (status.graph === 'ready') break; await new Promise(r => setTimeout(r, 500));}
  const id = catalog.workspace.id;
  await host.call('workspaceLayout', {order: [id], tabOrder: ['tab-a'], activeTab: 'tab-a', tabs: [{id: 'tab-a', at: 0, history: [{workspace: id, path: article}]}]});
  const browser = await launchBrowser({args: ['--enable-precise-memory-info']});
  const page = await browser.newPage({viewport: {width: 1500, height: 1000}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // As in the desktop app, graph neighbourhoods stream over a Channel and the
  // host pushes change events; without them the reader would fall back to
  // loading the whole graph and to polling, which the app never does.
  await page.addInitScript(() => {
    window.__channels = new Map(); window.__listeners = [];
    class Channel {constructor() {this.id = window.__channels.size + 1; window.__channels.set(this.id, this);} toJSON() {return {channel: this.id};}}
    window.__TAURI__ = {core: {Channel}, event: {listen: (name, callback) => {window.__listeners.push(callback); return Promise.resolve(() => {});}}};
    localStorage.setItem('weave:edit', 'true');
    window.__longTasks = [];
    new PerformanceObserver(list => {for (const entry of list.getEntries()) window.__longTasks.push({start: entry.startTime, duration: entry.duration});}).observe({type: 'longtask', buffered: true});
  });
  await page.exposeFunction('__WEAVE_TEST_INVOKE__', async (command, input) => {
    if (command === 'window_action') return {maximized: false, decorated: false};
    if (['editor_state', 'open_resource', 'reveal_export', 'choose_storage_directory'].includes(command)) return null;
    if (command === 'weave_graph_neighborhood') {
      const {summary, chunks} = await host.call('graphNeighborhood', input.args);
      await page.evaluate(({id, chunks}) => {for (const chunk of chunks) window.__channels.get(id).onmessage(chunk);}, {id: input.onChunk.channel, chunks});
      return summary;
    }
    const {op, args} = input;
    return host.call(op, args);
  });
  host.on('changed', event => page.evaluate(payload => {for (const listener of window.__listeners) listener({payload});}, event).catch(() => {}));
  const longTasks = async since => (await page.evaluate(() => window.__longTasks)).filter(t => t.start >= since);
  const blocking = tasks => ({count: tasks.length, maxMs: round(Math.max(0, ...tasks.map(t => t.duration))), totalBlockingMs: round(tasks.reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0))});
  const now = () => page.evaluate(() => performance.now());
  const heap = () => page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);

  // Restore: the window opens on the saved article.
  const start = Date.now();
  await page.goto(pathToFileURL(path.join(ROOT, 'dist/desktop/index.html')).href);
  await page.waitForFunction(file => document.getElementById('note-path').dataset.path === file, article, {timeout: 600000});
  const firstArticle = Date.now() - start;
  await page.locator('[data-tree-path]').first().waitFor({timeout: 600000});
  const treeShown = Date.now() - start;
  await page.waitForTimeout(1500);
  record('restore', {firstArticleMs: firstArticle, treeMs: treeShown, startupBlocking: blocking(await longTasks(0)), heapMB: await heap()});

  // Typing in the article: every keystroke decorates links against the workspace.
  const editor = page.locator('#article .cm-content');
  await editor.click(); await page.keyboard.press('Control+End');
  let since = await now(); let t = Date.now();
  await page.keyboard.type(' Typing into a large workspace with links and words.', {delay: 0});
  const typing = Date.now() - t;
  await page.waitForTimeout(2500); // autosave, catalog sync and redraws
  record('typing', {charsPerSecond: Math.round(52 / (typing / 1000)), msPerKey: round(typing / 52), ...blocking(await longTasks(since))});

  // Search as you type.
  await page.locator('.rail [data-panel="search"]').click();
  since = await now(); t = Date.now();
  await page.locator('#search-query').fill(SEARCH_TERMS.broad);
  await page.locator('#search-results .result, #search-results [data-open]').first().waitFor({timeout: 120000});
  const broad = Date.now() - t;
  t = Date.now();
  await page.locator('#search-query').fill('uniqdoc' + Math.floor(docs / 2));
  await page.waitForFunction(term => document.getElementById('search-results').textContent.includes(term), 'uniqdoc' + Math.floor(docs / 2), {timeout: 120000});
  record('search', {broadMs: broad, selectiveMs: Date.now() - t, ...blocking(await longTasks(since))});

  // Files: expand a folder of a few hundred articles, then open one.
  await page.locator('.rail [data-panel="files"]').click();
  await page.locator('#collapse-all').click();
  const area = article.split('/')[0], topic = article.split('/').slice(0, 2).join('/');
  since = await now(); t = Date.now();
  await page.locator(`[data-tree-path="${area}"]`).click();
  await page.locator(`[data-tree-path="${topic}"]`).click();
  await page.locator(`[data-tree-path="${other}"]`).waitFor();
  const expand = Date.now() - t; t = Date.now();
  await page.locator(`[data-tree-path="${other}"]`).click();
  await page.waitForFunction(file => document.getElementById('note-path').dataset.path === file, other);
  record('files', {expandMs: expand, openMs: Date.now() - t, rows: await page.locator('[data-tree-path]').count(), ...blocking(await longTasks(since))});

  // A file added outside Weave reaches the open folder.
  const added = path.join(vault, topic, 'ui-benchmark-external.md');
  since = await now(); t = Date.now();
  fs.writeFileSync(added, '# External UI benchmark\n');
  await page.locator(`[data-tree-path="${topic}/ui-benchmark-external.md"]`).waitFor({timeout: 120000});
  const external = Date.now() - t;
  fs.rmSync(added);
  await page.locator(`[data-tree-path="${topic}/ui-benchmark-external.md"]`).waitFor({state: 'detached', timeout: 120000});
  record('externalChange', {appearMs: external, roundTripMs: Date.now() - t, ...blocking(await longTasks(since))});
  results.heapMB = await heap();
  results.errors = errors;
  // Restore the edited article.
  const doc = await host.call('getDocument', {path: article});
  await host.call('save', {path: article, text: doc.text.replace(' Typing into a large workspace with links and words.', ''), hash: doc.hash});
  await browser.close();
} finally {
  await host.close();
}
await fsp.mkdir(path.join(ROOT, 'test-results'), {recursive: true});
const output = path.join(ROOT, 'test-results', `ui-benchmark-${docs}.json`);
await fsp.writeFile(output, JSON.stringify(results, null, 2));
log('Results written to ' + path.relative(ROOT, output));
if (results.errors?.length) {console.error('Page errors:\n  ' + results.errors.join('\n  ')); process.exitCode = 1;}
if (flag('check')) {
  const budgets = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/performance-budgets.json'), 'utf8')).ui;
  const tier = Object.keys(budgets).map(Number).sort((a, b) => a - b).find(n => docs <= n) ?? Math.max(...Object.keys(budgets).map(Number));
  const failures = Object.entries(budgets[tier]).flatMap(([key, limit]) => {const value = key.split('.').reduce((v, part) => v?.[part], results.phases); return typeof value !== 'number' ? [`${key}: missing`] : value > limit ? [`${key}: ${value} exceeds ${limit}`] : [];});
  if (failures.length) {console.error(`UI budgets (tier ${tier}) breached:\n  ` + failures.join('\n  ')); process.exit(1);}
  log(`All UI budgets for tier ${tier} met.`);
}
