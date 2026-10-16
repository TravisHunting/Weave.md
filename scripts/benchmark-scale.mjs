// Scale benchmark for the native backend: cold indexing, warm restart,
// interactive latency while idle and during a full reindex, change propagation,
// payload sizes and memory. Drives the production Rust backend through the
// release-profile test host. Generated vaults are cached; databases are disposable.
//
//   node scripts/benchmark-scale.mjs --docs 100000 [--cache DIR] [--check] [--git]
//
// --check compares results with scripts/performance-budgets.json and exits 1 on
// a breach. Results are written to test-results/scale-benchmark-<docs>.json.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {NativeHarness} from '../app/weave/tests/native-harness.mjs';
import {ensureVault, vaultFile, SEARCH_TERMS} from './scale-vault.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => {const i = process.argv.indexOf('--' + name); return i < 0 ? fallback : process.argv[i + 1];};
const flag = name => process.argv.includes('--' + name);
const docs = Number(option('docs', 10000)), cache = option('cache', path.join(os.tmpdir(), 'weave-scale'));
const log = (...args) => console.log(...args);
const percentile = (values, p) => {const sorted = [...values].sort((a, b) => a - b); return sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] * 10) / 10 : null;};
const summary = values => ({n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: percentile(values, 1)});
const timed = async fn => {const start = performance.now(); const value = await fn(); return {ms: performance.now() - start, value};};
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const pick = (n, seed = 1) => Array.from({length: n}, (_, k) => (seed * 7919 + k * 104729) % docs);

function memory(pid) {
  try {
    if (process.platform === 'win32') {
      const [working, peak, privateBytes] = execFileSync('powershell.exe', ['-NoProfile', '-Command', `$p=Get-Process -Id ${pid}; "$($p.WorkingSet64) $($p.PeakWorkingSet64) $($p.PrivateMemorySize64)"`], {encoding: 'utf8'}).trim().split(/\s+/).map(Number);
      return {workingSetMB: Math.round(working / 1048576), peakWorkingSetMB: Math.round(peak / 1048576), privateMB: Math.round(privateBytes / 1048576)};
    }
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8'), kb = key => Number(status.match(new RegExp(key + ':\\s+(\\d+)'))?.[1] || 0);
    return {workingSetMB: Math.round(kb('VmRSS') / 1024), peakWorkingSetMB: Math.round(kb('VmHWM') / 1024)};
  } catch {return null;}
}

function buildHost() {
  log('Building the release test host…');
  execFileSync('cargo', ['build', '--offline', '--release', '--manifest-path', path.join(ROOT, 'src-tauri/Cargo.toml'), '--features', 'native-test-host', '--bin', 'weave-test-host'], {stdio: 'inherit'});
}

/** Polls status until the workspace is indexed, recording each status call's latency. */
async function waitReady(host, {timeout = 4 * 3600e3} = {}) {
  const latencies = [], start = performance.now();
  for (;;) {
    const {ms, value} = await timed(() => host.call('status', {}, {timeout}));
    latencies.push(ms);
    if (value.graph === 'ready' && value.search === 'ready') return {ms: performance.now() - start, status: value, statusLatency: summary(latencies)};
    if (performance.now() - start > timeout) throw new Error('Indexing did not finish in time');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

/** Repeats interactive requests until `busy` settles, recording their latencies. */
async function underLoad(host, busy, requests) {
  let done = false; const results = Object.fromEntries(Object.keys(requests).map(k => [k, []]));
  const settled = busy.then(v => {done = true; return v;}, e => {done = true; throw e;});
  await new Promise(resolve => setTimeout(resolve, 150));
  while (!done) for (const [name, request] of Object.entries(requests)) {
    if (done) break;
    const {ms} = await timed(request); results[name].push(ms);
  }
  const {ms} = await timed(() => settled);
  return Object.fromEntries(Object.entries(results).map(([k, v]) => [k, summary(v)]));
}

async function measure(name, n, fn) {
  const times = [];
  for (let i = 0; i < n; i++) {const {ms} = await timed(() => fn(i)); times.push(ms);}
  return summary(times);
}

const results = {docs, date: new Date().toISOString(), host: {platform: process.platform, cpus: os.cpus().length, cpu: os.cpus()[0]?.model, memoryGB: Math.round(os.totalmem() / 1073741824)}, phases: {}};
const record = (phase, value) => {results.phases[phase] = value; log(phase, JSON.stringify(value));};
const attempt = async (phase, fn) => {try {record(phase, await fn());} catch (error) {record(phase, {error: error.message.slice(0, 500)});}};

if (!flag('no-build')) buildHost();
log(`Preparing a ${docs.toLocaleString()}-article vault in ${cache}…`);
const vault = path.join(cache, `vault-${docs}`);
const generated = await ensureVault(vault, docs, {log});
results.vault = {reused: generated.reused};
const runtime = await fsp.mkdtemp(path.join(os.tmpdir(), 'weave-scale-runtime-'));
const timeout = 4 * 3600e3;
let host;
try {
  // Cold start: an empty database indexes every article.
  host = new NativeHarness(runtime, {profile: 'release', timeout});
  await host.call('health');
  await attempt('coldOpen', async () => {
    const opened = await timed(() => host.call('open', {root: vault}));
    if (opened.value?.scope == null) throw new Error('open failed');
    const ready = await waitReady(host, {timeout});
    return {openMs: Math.round(opened.ms), catalogBytes: bytes(opened.value), readyMs: Math.round(ready.ms), statusWhileIndexing: ready.statusLatency, documents: ready.status.documents, relationships: ready.status.relationships, chunks: ready.status.chunks, memory: memory(host.child.pid)};
  });
  await attempt('payloads', async () => {
    const catalog = await timed(() => host.call('catalog'));
    const graph = await timed(() => host.call('graph', {summaryOnly: true}));
    const kanban = await timed(() => host.call('kanban'));
    const status = await measure('status', 20, () => host.call('status'));
    return {catalogMs: Math.round(catalog.ms), catalogBytes: bytes(catalog.value), graphMs: Math.round(graph.ms), graphBytes: bytes(graph.value), kanbanMs: Math.round(kanban.ms), kanbanBytes: bytes(kanban.value), status};
  });
  const sample = pick(30).map(i => vaultFile(docs, i));
  await attempt('read', async () => ({
    getDocument: await measure('getDocument', sample.length, i => host.call('getDocument', {path: sample[i]})),
    outgoing: await measure('outgoing', 20, i => host.call('getOutgoingRelationships', {path: sample[i]})),
    incoming: await measure('incoming', 20, i => host.call('getIncomingRelationships', {path: sample[i]})),
    neighbors: await measure('neighbors', 10, i => host.call('getNeighbors', {path: sample[i], depth: 2, limit: 40})),
    graph: await measure('graph', 10, i => host.call('graphNeighborhood', {path: sample[i], depth: 3, direction: 'both', limit: 100, requestId: 'b'})),
  }));
  await attempt('search', async () => {
    const out = {};
    for (const [kind, query] of Object.entries({...SEARCH_TERMS, selective: 'uniqdoc' + Math.floor(docs / 2)})) {
      let hits = 0;
      out[kind] = await measure(kind, 12, async () => {const r = await host.call('searchKnowledge', {query}); hits = r.results.length;});
      out[kind].hits = hits;
    }
    out.deepSearch = await measure('deep', 5, () => host.call('buildEvidenceBundle', {question: 'warehouse lineage replication', connections: true}));
    return out;
  });
  await attempt('write', async () => {
    const saves = [];
    for (const file of sample.slice(0, 8)) {
      const doc = await host.call('getDocument', {path: file});
      const {ms, value} = await timed(() => host.call('save', {path: file, text: doc.text + '\nBenchmark edit.\n', hash: doc.hash}));
      saves.push(ms);
      await host.call('save', {path: file, text: doc.text, hash: value.hash});
    }
    const folder = vaultFile(docs, 0).split('/').slice(0, -1).join('/');
    const creates = [], deletes = [];
    for (let k = 0; k < 4; k++) {
      const file = `${folder}/benchmark-created-${k}.md`;
      creates.push((await timed(() => host.call('create', {path: file, text: `# Created ${k}\n\nbenchcreated${k}\n`}))).ms);
      deletes.push((await timed(() => host.call('delete', {path: file, confirmed: true}))).ms);
    }
    const from = sample[5], to = from.replace(/\.md$/, '-moved.md');
    const preview = await timed(() => host.call('renamePreview', {from, to}));
    const rename = await timed(() => host.call('rename', {token: preview.value.token, updateLinks: true}));
    const back = await host.call('renamePreview', {from: to, to: from});
    await host.call('rename', {token: back.token, updateLinks: true});
    return {save: summary(saves), create: summary(creates), delete: summary(deletes), renamePreviewMs: Math.round(preview.ms), renameMs: Math.round(rename.ms), renamedLinks: preview.value.links};
  });
  await attempt('changePropagation', async () => {
    const file = path.join(vault, vaultFile(docs, 0).split('/').slice(0, -1).join('/'), 'benchmark-external.md');
    const term = 'externalbench' + Date.now();
    const status = await host.call('status');
    const event = new Promise(resolve => {const listener = value => {if (value.scope === host.scope && value.status?.revision > status.revision) {host.off('changed', listener); resolve();}}; host.on('changed', listener);});
    const start = performance.now();
    fs.writeFileSync(file, `# External\n\n${term}\n`);
    await Promise.race([event, new Promise((_, reject) => setTimeout(() => reject(new Error('No change event within 120 s')), 120000))]);
    const eventMs = performance.now() - start;
    for (;;) {const r = await host.call('searchKnowledge', {query: term}); if (r.results.length) break; if (performance.now() - start > 120000) throw new Error('Change never became searchable'); await new Promise(r => setTimeout(r, 50));}
    const searchableMs = performance.now() - start;
    fs.rmSync(file);
    return {eventMs: Math.round(eventMs), searchableMs: Math.round(searchableMs)};
  });
  await attempt('responsivenessDuringReindex', async () => {
    const reindex = timed(() => host.call('refresh', {}, {timeout}));
    // Editing, searching and graph navigation continue while every article is read again.
    const edited = sample[3], original = await host.call('getDocument', {path: edited});
    let hash = original.hash, edits = 0;
    const latencies = await underLoad(host, reindex, {
      getDocument: () => host.call('getDocument', {path: sample[1]}),
      status: () => host.call('status'),
      search: () => host.call('searchKnowledge', {query: SEARCH_TERMS.medium, searchChannel: 'live'}),
      save: async () => {hash = (await host.call('save', {path: edited, text: `${original.text}\nEdit ${++edits}\n`, hash})).hash;},
      graph: () => host.call('graphNeighborhood', {path: sample[2], depth: 2, direction: 'both', limit: 100, requestId: 'r'}),
    });
    await host.call('save', {path: edited, text: original.text, hash});
    return {reindexMs: Math.round((await reindex).ms), ...latencies, memory: memory(host.child.pid)};
  });
  if (flag('git')) await attempt('responsivenessDuringGit', async () => {
    if (!fs.existsSync(path.join(vault, '.git'))) {
      log('Initialising a Git repository for the vault (one-off)…');
      for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=Bench', '-c', 'user.email=bench@example.invalid', 'commit', '-qm', 'Benchmark vault']]) execFileSync('git', args, {cwd: vault, stdio: 'ignore', maxBuffer: 1 << 30});
    }
    const status = timed(() => host.call('gitStatus', {}, {timeout}));
    const latencies = await underLoad(host, status, {getDocument: () => host.call('getDocument', {path: sample[2]}), search: () => host.call('searchKnowledge', {query: SEARCH_TERMS.rare})});
    return {gitStatusMs: Math.round((await status).ms), ...latencies};
  });
  results.phases.memoryAfterRun = memory(host.child.pid);
  results.metrics = await host.call('metrics').catch(() => null);
  await host.close(); host = null;
  // Warm restart: the database already describes every article.
  host = new NativeHarness(runtime, {profile: 'release', timeout});
  await attempt('warmRestart', async () => {
    const restored = await timed(() => host.call('restore', {}, {timeout}));
    host.scope = restored.value?.scope ?? host.scope;
    const ready = await waitReady(host, {timeout});
    const search = await timed(() => host.call('searchKnowledge', {query: SEARCH_TERMS.rare}));
    return {restoreMs: Math.round(restored.ms), restoreBytes: bytes(restored.value), readyMs: Math.round(ready.ms), statusWhileReconciling: ready.statusLatency, firstSearchMs: Math.round(search.ms), memory: memory(host.child.pid)};
  });
  await host.close(); host = null;
  const database = path.join(runtime, 'weave.sqlite');
  results.databaseMB = fs.existsSync(database) ? Math.round(fs.statSync(database).size / 1048576) : null;
} finally {
  await host?.close().catch(() => {});
  await fsp.rm(runtime, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
}

await fsp.mkdir(path.join(ROOT, 'test-results'), {recursive: true});
const output = path.join(ROOT, 'test-results', `scale-benchmark-${docs}.json`);
await fsp.writeFile(output, JSON.stringify(results, null, 2));
log('Results written to ' + path.relative(ROOT, output));

if (flag('check')) {
  const budgets = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/performance-budgets.json'), 'utf8'));
  const tier = Object.keys(budgets.tiers).map(Number).sort((a, b) => a - b).find(n => docs <= n) ?? Math.max(...Object.keys(budgets.tiers).map(Number));
  const failures = [];
  for (const [key, limit] of Object.entries(budgets.tiers[tier])) {
    const value = key.split('.').reduce((v, part) => v?.[part], results.phases);
    if (value == null || typeof value !== 'number') failures.push(`${key}: missing (${JSON.stringify(value)})`);
    else if (value > limit) failures.push(`${key}: ${value} exceeds ${limit}`);
  }
  if (failures.length) {console.error(`Performance budgets (tier ${tier}) breached:\n  ` + failures.join('\n  ')); process.exit(1);}
  log(`All performance budgets for tier ${tier} met.`);
}
