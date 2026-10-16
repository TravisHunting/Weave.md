// Development/browser preview service only. Desktop operations live in Rust.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {setImmediate as yieldTask} from 'node:timers/promises';
import {GraphIndex} from './graph.mjs';
import {parseLinks, createResolver, rewriteTargets} from './links.mjs';
import {noteMetadata} from './metadata.mjs';
import {relativePath, prepareRuntime} from './files.mjs';
import {DirectoryStorage} from './directory-storage.mjs';
import {lexicalFallback, passageFor, buildEvidenceBundle} from './text-retrieval.mjs';
import {articleResource} from './platform.mjs';
import {registerWorkspace, collectionId} from './storage.mjs';
import {monitoringSettings} from './monitoring-settings.mjs';
import {lexicalSearchQuery} from './search-query.mjs';

export class Workspace extends EventEmitter {
  constructor(runtime, {storage = new DirectoryStorage(runtime)} = {}) {
    super(); this.fileStorage = storage; this.runtime = runtime; this.documents = new Map(); this.tree = {files: [], folders: []};
    this.revision = 0; this.graphState = 'closed'; this.plans = new Map(); this.queue = Promise.resolve(); this.lastError = null; this.closed = false; this.indexing = monitoringSettings();
  }
  mutate(action) { const work = this.queue.then(action); this.queue = work.catch(() => {}); return work; }
  async open(root) {
    await prepareRuntime(this.runtime);
    const location = await this.fileStorage.open(root);
    this.location = location;
    this.root = location.nativeDirectory || location.displayPath; this.caseSensitive = location.caseSensitive;
    this.identity = location.identity || this.root;
    const opaqueIdentity = !location.nativeDirectory;
    this.storage = await registerWorkspace(this.runtime, this.root, {identity: this.identity, opaqueIdentity}); this.collection = collectionId(this.identity, {opaque: opaqueIdentity});
    this.indexing = monitoringSettings(this.storage.collections.find(c => c.id === this.collection)?.indexing);
    this.graphFile = path.join(this.storage.weaveDirectory, this.collection + '.sqlite');
    try { this.graph = new GraphIndex(this.graphFile, this.root, this.caseSensitive); this.graphState = 'reconciling'; }
    catch (e) { this.graphState = 'error'; this.lastError = e.message; }
    this.tree = await this.fileStorage.scan();
    this.ready = this.mutate(() => this.reconcile(true));
    this.ready.catch(e => this.report(e));
    this.startMonitoring();
    return this.catalog();
  }
  startMonitoring() {
    clearInterval(this.poll); this.poll = null; this.watcher?.close(); this.watcher = null;
    if (this.closed) return;
    if (this.indexing.watchChanges) try {
      this.watcher = this.fileStorage.subscribe(file => this.scheduleReconcile(file?.slice(1)), e => this.report(e));
    } catch (e) { this.report(new Error('Native watcher unavailable. ' + (this.indexing.autoRefresh ? 'Periodic workspace refresh is active. ' : 'Enable automatic workspace refresh to detect external edits. ') + e.message)); }
    if (this.indexing.autoRefresh) {
      this.poll = setInterval(() => this.scheduleReconcile(null, this.indexing.scanMode === 'content'), this.indexing.refreshSeconds * 1000);
      this.poll.unref();
    }
  }
  report(error) { this.lastError = error.message; this.emit('changed', this.status()); }
  scheduleReconcile(file = null, force = false) {
    if (this.closed) return;
    if (!file) this.rescanPending = true;
    else {this.changedPaths ||= new Set(); this.changedPaths.add(file);}
    this.forceScanPending ||= force;
    clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => this.mutate(async () => {
      const paths = [...(this.changedPaths || [])]; this.changedPaths?.clear();
      if (this.rescanPending || this.forceScanPending || paths.some(p => !/\.md$/i.test(p))) {const force = this.forceScanPending; this.rescanPending = this.forceScanPending = false; await this.reconcile(force); return;}
      let changed = false;
      for (const file of paths) {
        try {
          const doc = await this.fileStorage.read('/' + file);
          if (this.documents.get(file)?.hash === doc.hash) continue;
          this.documents.set(file, {...doc, ...noteMetadata(doc.text, file)}); this.graph?.upsert(file, doc.text, doc.mtime);
          this.tree.files = this.tree.files.filter(f => f.path !== file); this.tree.files.push({path:file, mtime:doc.mtime, size:doc.size});
          changed = true;
        } catch (e) {
          if (e.code !== 'ENOENT') {this.report(e);continue;}
          if (this.documents.delete(file)) {this.graph?.remove(file); this.tree.files = this.tree.files.filter(f => f.path !== file); changed = true;}
        }
      }
      if (changed) {this.revision++; this.emit('changed', this.status());}
    }).catch(e => this.report(e)), 250);
  }
  async reconcile(force = false) {
    if (this.closed) return;
    const next = await this.fileStorage.scan(), paths = new Set(next.files.map(f => f.path)); let changed = false;
    if (this.graph) this.graph.deferResolution = true;
    const beforeTree = JSON.stringify(this.tree); this.tree = next;
    this.graphProgress = {current: 0, total: next.files.length};
    for (const file of next.files) {
      this.graphProgress.current++;
      const old = this.documents.get(file.path);
      if (!force && old?.mtime === file.mtime && old.size === file.size) continue;
      try {
        const doc = await this.fileStorage.read('/' + file.path), meta = noteMetadata(doc.text, doc.path);
        this.documents.set(doc.path, {...doc, ...meta});
        if (old?.hash !== doc.hash) { this.graph?.upsert(doc.path, doc.text, doc.mtime); changed = true; }
      } catch (e) { this.report(new Error(file.path + ': ' + e.message)); }
      await yieldTask();
    }
    for (const file of [...this.documents.keys()]) if (!paths.has(file)) { this.documents.delete(file); this.graph?.remove(file); changed = true; }
    // Reopened caches may contain deleted notes absent from the memory cache.
    for (const doc of this.graph?.documents() || []) if (!paths.has(doc.relative_path)) { this.graph.remove(doc.relative_path); changed = true; }
    if (this.graph) {this.graph.deferResolution = false; this.graph.transaction(() => this.graph.resolve()); this.graphState = 'ready';}
    if (changed || beforeTree !== JSON.stringify(next) || force) { this.revision++; this.emit('changed', this.status()); }
  }
  catalog() { return {workspace: {id: this.collection, name: path.basename(this.root), displayPath: this.root, directory: articleResource(this.collection, '', 'directory')}, root: this.root, caseSensitive: this.caseSensitive, tree: {...this.tree, directories: this.tree.folders.map(p => articleResource(this.collection, p, 'directory')), otherFiles: (this.tree.otherFiles || []).map(f => ({...f, resource: articleResource(this.collection, f.path)})), files: this.tree.files.map(f => ({...f, resource: articleResource(this.collection, f.path), title: this.documents.get(f.path)?.title}))}, revision: this.revision, status: this.status()}; }
  status() { return {root: this.root, runtime: this.runtime, revision: this.revision, graph: this.graphState,
    ...(this.graph?.status() || {documents: this.documents.size, relationships: 0, unresolved: 0}),
    lastError: this.lastError,
    collection: this.collection, graphFile: this.graphFile, graphProgress: this.graphProgress, indexing: {...this.indexing}}; }
  async getDocument(file) {
    file = relativePath(file); const doc = await this.fileStorage.read('/' + file), metadata = noteMetadata(doc.text, file);
    const resolve = createResolver(this.tree.files.map(f => f.path), {caseSensitive: this.caseSensitive});
    const parsed = parseLinks(doc.text, file);
    return {...doc, resource: articleResource(this.collection, file), ...metadata, links: parsed.links.map(link => ({...link, ...resolve(link.target, file)})), diagnostics: parsed.diagnostics};
  }
  getOutgoingRelationships(file) { return this.graph?.outgoing(file) || []; }
  getIncomingRelationships(file) { return this.graph?.incoming(file) || []; }
  getNeighbors(file, depth = 1, limit = 40) { return this.graph?.neighbors(file, depth, limit) || {documents: [{path: file, depth: 0}], truncated: false}; }
  async save(file, text, expectedHash) {
    return this.mutate(async () => {
      const previous = await this.fileStorage.read('/' + file), doc = await this.fileStorage.write('/' + file, text, expectedHash, {encoding:previous.encoding,bom:previous.bom});
      this.documents.set(file, {...doc, ...noteMetadata(doc.text, file)});
      try { this.graph?.upsert(file, text, doc.mtime); } catch (e) { this.graphState = 'error'; this.report(e); }
      this.revision++; this.emit('changed', this.status()); return this.getDocument(file);
    });
  }
  async create(file, folder = false, text = null) {
    return this.mutate(async () => {
      file = relativePath(file);
      await this.fileStorage.create('/' + file, folder, typeof text === 'string' ? text : null);
      await this.reconcile(); return {path: file};
    });
  }
  async renamePreview(from, to) {
    return this.mutate(async () => {
      await this.reconcile(true);
      if (this.tree.files.length !== this.documents.size) throw new Error('Some notes could not be read. Resolve the workspace diagnostics before renaming.');
      from = relativePath(from); to = relativePath(to);
      if (from === to || to.startsWith(from + '/')) throw new Error('Choose a different destination outside this folder.');
      const storagePlan = await this.fileStorage.prepareMove('/' + from, '/' + to);
      const mapping = new Map(this.tree.files.filter(f => f.path === from || f.path.startsWith(from + '/')).map(f => [f.path, to + f.path.slice(from.length)]));
      const resolve = createResolver(this.tree.files.map(f => f.path), {caseSensitive: this.caseSensitive});
      const changes = []; let links = 0;
      for (const doc of this.documents.values()) {
        const parsed = parseLinks(doc.text, doc.path).links.map(l => ({...l, ...resolve(l.target, doc.path)}));
        // Moving a target changes links to it; moving the source changes its
        // own relative links. Only links whose written destination changes count.
        const nextPath = mapping.get(doc.path) || doc.path, options = {source: doc.path, nextSource: nextPath};
        const affected = parsed.filter(l => l.resolvedPath && (mapping.has(l.resolvedPath) || nextPath !== doc.path && !String(l.target).startsWith('/')) && rewriteTargets(l.raw, [{...l, targetStart: l.targetStart - l.start, targetEnd: l.targetEnd - l.start}], mapping, options) !== l.raw);
        if (!affected.length) continue;
        changes.push({path: doc.path, nextPath, text: rewriteTargets(doc.text, affected, mapping, options), original: doc}); links += affected.length;
      }
      const token = randomUUID(); this.plans.clear();

      const snapshot = JSON.stringify([...this.documents].map(([file, doc]) => [file, doc.hash]).sort());
      this.plans.set(token, {from, to, storagePlan, changes, mapping, snapshot, created: Date.now()});
      return {token, from, to, links, notes: changes.length, paths: changes.map(c => c.path)};
    });
  }
  async rename(token, updateLinks) {
    return this.mutate(async () => {
      const plan = this.plans.get(token); this.plans.delete(token);
      if (!plan || Date.now() - plan.created > 300000) throw new Error('Rename preview expired. Preview it again.');
      await this.reconcile(true);
      if (JSON.stringify([...this.documents].map(([file, doc]) => [file, doc.hash]).sort()) !== plan.snapshot) throw new Error('The workspace changed since the rename preview. Preview it again to include current incoming links.');
      let result;
      const changes = plan.changes.map(change => ({...change, path: '/' + change.path, nextPath: '/' + change.nextPath, original: {...change.original, path: '/' + change.original.path}}));
      try {result = await this.fileStorage.move(plan.storagePlan, {changes, updateLinks});}
      catch (error) {await this.reconcile(true); throw error;}
      await this.reconcile(true); return {path: plan.to, linksUpdated: updateLinks ? plan.changes.length : 0, recovery: result.recovery};
    });
  }
  async delete(file, confirmed) {
    if (!confirmed) throw new Error('Deletion requires confirmation.');
    return this.mutate(async () => {
      const result = await this.fileStorage.delete('/' + file); await this.reconcile(true); return result;
    });
  }
  async rebuildGraph() {
    return this.mutate(async () => {
      this.graphState = 'rebuilding'; this.emit('changed', this.status()); this.graph?.close(); this.graph = null;
      const file = this.graphFile;
      for (const suffix of ['', '-wal', '-shm']) await fs.rename(file + suffix, file + suffix + '.old-' + Date.now()).catch(e => { if (e.code !== 'ENOENT') throw e; });
      this.graph = new GraphIndex(file, this.root, this.caseSensitive); this.documents.clear(); this.lastError = null; await this.reconcile(true); return this.status();
    });
  }
  async searchKnowledge(query, {limit = 30} = {}) {
    return {results: lexicalFallback(this.documents, lexicalSearchQuery(query), limit), method:'text', notices:[]};
  }
  async getPassage(file, query, doc) {return {...passageFor(doc.text, query), method:'current Markdown'};}
  buildEvidenceBundle(question, options) { return buildEvidenceBundle(this, question, options); }
  async close() { this.closed = true; clearTimeout(this.watchTimer); clearInterval(this.poll); this.watcher?.close(); await this.queue; this.graph?.close(); this.graph = null; }
}
