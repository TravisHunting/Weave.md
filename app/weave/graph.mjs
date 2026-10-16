import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {parseLinks, createResolver} from './links.mjs';
import {noteMetadata} from './metadata.mjs';

export const hash = text => createHash('sha256').update(text).digest('hex');
export class GraphIndex {
  constructor(file, workspace, caseSensitive = true) {
    this.caseSensitive = caseSensitive;
    this.rootName = workspace.replaceAll('\\', '/').split('/').at(-1);
    this.db = new DatabaseSync(file);
    try {
      const db = this.db;
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
      if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Graph index is corrupt. Rebuild graph index.');
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) throw new Error('Graph schema is newer than this Weave build.');
      db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, relative_path TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
          content_hash TEXT NOT NULL, mtime REAL NOT NULL, exists_on_disk INTEGER NOT NULL DEFAULT 1, metadata TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS relationships (id TEXT PRIMARY KEY, source_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          target_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL, target_path TEXT NOT NULL, authored_target TEXT NOT NULL,
          relationship_type TEXT NOT NULL, source_line INTEGER NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
          raw TEXT NOT NULL, resolved INTEGER NOT NULL, reason TEXT, candidates TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS outgoing ON relationships(source_document_id);
        CREATE INDEX IF NOT EXISTS incoming ON relationships(target_document_id);
        CREATE INDEX IF NOT EXISTS relationship_type ON relationships(relationship_type);
        CREATE INDEX IF NOT EXISTS target_lookup ON relationships(target_path);
        PRAGMA user_version=1;`);
      if (db.prepare("SELECT value FROM settings WHERE key='workspace'").get()?.value !== workspace || db.prepare("SELECT value FROM settings WHERE key='parser'").get()?.value !== '4') {
        db.exec('BEGIN; DELETE FROM relationships; DELETE FROM documents;');
        db.prepare("INSERT OR REPLACE INTO settings VALUES ('workspace', ?)").run(workspace);
        db.prepare("INSERT OR REPLACE INTO settings VALUES ('parser', '4')").run(); db.exec('COMMIT');
      }
    } catch (error) { this.db.close(); throw error; }
  }
  transaction(action) { this.db.exec('BEGIN IMMEDIATE'); try { const value = action(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  documents() { return this.db.prepare('SELECT * FROM documents ORDER BY relative_path').all().map(d => ({...d, ...JSON.parse(d.metadata)})); }
  upsert(file, text, mtime = 0) {
    const contentHash = hash(text), old = this.db.prepare('SELECT content_hash FROM documents WHERE id=?').get(file);
    if (old?.content_hash === contentHash) return false;
    const parsed = parseLinks(text, file), {body, ...metadata} = noteMetadata(text, file, this.rootName);
    this.transaction(() => {
      this.db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, content_hash=excluded.content_hash, mtime=excluded.mtime, metadata=excluded.metadata').run(file, file, metadata.title, contentHash, mtime, JSON.stringify({...metadata, diagnostics: parsed.diagnostics}));
      this.db.prepare('DELETE FROM relationships WHERE source_document_id=?').run(file);
      const insert = this.db.prepare('INSERT INTO relationships VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)');
      for (const link of parsed.links) insert.run(`${file}:${link.start}`, file, link.target, link.target, link.relationship, link.line, link.start, link.end, link.raw, 'missing', '[]');
      // Path-set changes can resolve broken targets or introduce shorthand ambiguity.
      if (!this.deferResolution) this.resolve(old ? file : null);
    });
    return true;
  }
  resolve(source = null) {
    const resolve = createResolver(this.db.prepare('SELECT relative_path FROM documents').all().map(d => d.relative_path), {caseSensitive: this.caseSensitive});
    const rows = source ? this.db.prepare('SELECT * FROM relationships WHERE source_document_id=?').all(source) : this.db.prepare('SELECT * FROM relationships').all();
    const update = this.db.prepare('UPDATE relationships SET target_document_id=?, target_path=?, resolved=?, reason=?, candidates=? WHERE id=?');
    for (const row of rows) { const r = resolve(row.authored_target, row.source_document_id); update.run(r.resolvedPath, r.targetPath, Number(r.resolved), r.reason, JSON.stringify(r.candidates), row.id); }
  }
  remove(file) { this.transaction(() => { this.db.prepare('DELETE FROM documents WHERE id=?').run(file); if (!this.deferResolution) this.resolve(); }); }
  outgoing(file) { return this.db.prepare('SELECT * FROM relationships WHERE source_document_id=? ORDER BY source_line').all(file); }
  incoming(file) { return this.db.prepare('SELECT * FROM relationships WHERE target_document_id=? ORDER BY source_document_id, source_line').all(file); }
  snapshot() {
    const entities = this.documents().map(d => ({...d, id: d.relative_path, file: d.relative_path, name: d.title}));
    const relationships = this.db.prepare('SELECT * FROM relationships ORDER BY source_document_id, start_offset').all().map(r => ({...r, from: r.source_document_id,
      to: r.target_document_id || `broken:${r.reason}:${r.target_path}`, type: r.relationship_type, description: r.raw, tags: [], category: 'dependency'}));
    const missing = new Map();
    for (const r of relationships) if (!r.resolved) missing.set(r.to, {id: r.to, name: r.authored_target, type: 'unresolved', tags: [r.reason], broken: true, candidates: JSON.parse(r.candidates)});
    return {entities: [...entities, ...missing.values()], relationships};
  }
  neighbors(file, depth = 1, limit = 40) {
    depth = Math.max(0, Math.min(3, Number(depth) || 0)); limit = Math.max(1, Math.min(100, Number(limit) || 40));
    const included = new Map([[file, {path: file, depth: 0, via: null}]]), queue = [file]; let truncated = false;
    for (const at of queue) {
      const distance = included.get(at).depth; if (distance >= depth) continue;
      for (const edge of [...this.outgoing(at), ...this.incoming(at)]) {
        if (!edge.resolved) continue;
        const next = edge.source_document_id === at ? edge.target_document_id : edge.source_document_id;
        if (!included.has(next)) { if (included.size >= limit) { truncated = true; continue; } included.set(next, {path: next, depth: distance + 1, via: edge}); queue.push(next); }
      }
    }
    return {documents: [...included.values()], truncated};
  }
  status() {
    return {documents: this.db.prepare('SELECT count(*) AS n FROM documents').get().n, relationships: this.db.prepare('SELECT count(*) AS n FROM relationships').get().n,
      unresolved: this.db.prepare('SELECT count(*) AS n FROM relationships WHERE resolved=0').get().n, schema: 1};
  }
  close() { this.db.close(); }
}
