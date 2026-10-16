import {parseLinks, createResolver} from './links.mjs';
import {randomId, readerCapabilities, articleResource, resource, decodeResourceArgs} from './platform.mjs';
import {articlePresentation} from './presentation.mjs';
import {lexicalFallback} from './text-retrieval.mjs';
import {kanbanSummary, kanbanBoard} from './kanban.mjs';

export function createReaderClient(initial) {
  let documents = initial.documents || [], graph = initial.graph || {entities: [], relationships: []};
  let root = initial.root || 'Local Markdown', folders = initial.folders || [], otherFiles = initial.otherFiles || [];
  let workspaceId = 'reader:initial';
  const workspace = () => ({id: workspaceId, name: root, displayPath: root, directory: resource(workspaceId, '/', 'directory')});
  const status = () => ({root, graph: 'ready', documents: documents.length, relationships: graph.relationships.length, unresolved: graph.relationships.filter(r => !r.resolved).length, revision: 1});
  const catalog = () => ({workspace: workspace(), root, caseSensitive: true, revision: 1, tree: {files: documents.map(d => ({path: d.path, title: d.title, resource: articleResource(workspaceId, d.path)})), folders, directories: folders.map(p => articleResource(workspaceId, p, 'directory')), otherFiles: otherFiles.map(f => ({...f, resource: articleResource(workspaceId, f.path)}))}, status: status()});
  function derive() {
    const resolve = createResolver(documents.map(d => d.path));
    graph = {entities: documents.map(d => ({id: d.path, name: d.title, file: d.path, type: d.type || 'note', tags: d.tags || [], stableId: d.stableId})), relationships: []};
    const missing = new Map();
    for (const doc of documents) for (const link of parseLinks(doc.text, doc.path).links) {
      const r = resolve(link.target, doc.path), to = r.resolvedPath || 'broken:' + r.reason + ':' + r.targetPath;
      if (!r.resolved) missing.set(to, {id: to, name: link.target, type: 'unresolved', tags: [r.reason], broken: true});
      graph.relationships.push({id: doc.path + ':' + link.start, from: doc.path, to, type: link.relationship, category: 'dependency', tags: [], description: link.raw, resolved: r.resolved,
        source_document_id: doc.path, target_document_id: r.resolvedPath, relationship_type: link.relationship, authored_target: link.target, source_line: link.line, start_offset: link.start, end_offset: link.end});
    }
    graph.entities.push(...missing.values());
  }
  return {capabilities: readerCapabilities, writable: false, initial: documents.length ? catalog() : null,
    get workspace() {return workspace();},
    file(path) {return resource(workspaceId, path, 'file');},
    directory(path = '/') {return resource(workspaceId, path, 'directory');},
    async choose() {
      // A portable workspace export shows only its own articles.
      if (initial.portable) return null;
      return new Promise(resolve => {
        const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.setAttribute('webkitdirectory', '');
        input.oncancel = () => resolve(null);
        input.onchange = async () => {
          const visible = [...input.files].filter(f => !f.webkitRelativePath.split('/').some(p => ['.weave', '.git', 'node_modules', '.agents', '.codex', 'dist', 'target', 'build', 'agents.md'].includes(p.toLowerCase()) || p.startsWith('.weave-')));
          const files = visible.filter(f => /\.md$/i.test(f.name));
          otherFiles = visible.filter(f => !/\.md$/i.test(f.name)).map(f => ({path: f.webkitRelativePath.split('/').slice(1).join('/')}));
          root = visible[0]?.webkitRelativePath.split('/')[0] || 'Empty folder'; documents = []; workspaceId = 'reader:' + randomId();
          for (const f of files) { const text = await f.text(), p = f.webkitRelativePath.split('/').slice(1).join('/'); documents.push({path: p, ...articlePresentation(text, p, root), text, body: text, hash: ''}); }
          folders = [...new Set([...documents, ...otherFiles].flatMap(d => {const parts=d.path.split('/'); return parts.slice(0,-1).map((_,i)=>parts.slice(0,i+1).join('/'));}))]; derive(); resolve(catalog());
        }; input.click();
      });
    },
    async call(op, args = {}) {
      args = decodeResourceArgs(op, args, workspaceId);
      if (op === 'health') return {ok: true};
      if (['catalog', 'refresh'].includes(op)) return catalog();
      if (op === 'status') return status();
      if (op === 'graph') return graph;
      if (op === 'getDocument') { const doc = documents.find(d => d.path === args.path); if (!doc) throw new Error('Note missing'); return {...doc, resource: articleResource(workspaceId, doc.path)}; }
      if (op === 'getOutgoingRelationships') return graph.relationships.filter(r => r.from === args.path);
      if (op === 'getIncomingRelationships') return graph.relationships.filter(r => r.to === args.path);
      // Read-only boards derived from the articles' frontmatter (kanban.mjs).
      if (op === 'kanban') return kanbanSummary(documents);
      if (op === 'kanbanBoard') return kanbanBoard(documents, args.path);
      if (op === 'searchKnowledge') {
        return {method:'text', results:lexicalFallback(new Map(documents.map(d => [d.path, d])), args.query, args.limit || 30), notices:[]};
      }
      throw new Error('This operation is available in the Weave desktop application.');
    }, dirty() {}, openResource(url) { window.open(url, '_blank', 'noopener,noreferrer'); }};
}
