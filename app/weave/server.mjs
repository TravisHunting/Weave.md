import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {Workspace} from './workspace.mjs';
import {renderPage, ROOT} from './build.mjs';
import {kanbanSummary, kanbanBoard} from './kanban.mjs';
export async function createServer({root = path.join(ROOT, 'knowledge'), port = 4174, runtime = path.join(ROOT, '.weave/browser')} = {}) {
  const service = new Workspace(runtime, {}); await service.open(root); await service.ready;
  const html = await renderPage({mode: 'dynamic'}, {dynamic: true});
  const send = (response, status, value) => {response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}); response.end(JSON.stringify(value));};
  const server = http.createServer(async (req, res) => {
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || req.headers.origin && req.headers.origin !== 'http://' + host) return send(res, 403, {error: 'Only same-origin loopback requests are allowed'});
    if (req.method !== 'GET') return send(res, 405, {error: 'Read-only server'});
    const url = new URL(req.url, 'http://' + host);
    if (url.pathname === '/' || url.pathname === '/index.html') {res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});res.end(html);return;}
    if (url.pathname !== '/api/weave') return send(res, 404, {error: 'Not found'});
    try {
      const op = url.searchParams.get('op'), args = JSON.parse(url.searchParams.get('args') || '{}'); let result;
      switch (op) {
        case 'health': result = {ok: true}; break;
        case 'catalog': case 'refresh': await service.mutate(() => service.reconcile()); result = service.catalog(); break;
        case 'status': result = service.status(); break;
        case 'graph': result = service.graph.snapshot(); break;
        case 'getDocument': result = await service.getDocument(args.path); break;
        case 'getOutgoingRelationships': result = service.getOutgoingRelationships(args.path); break;
        case 'getIncomingRelationships': result = service.getIncomingRelationships(args.path); break;
        case 'searchKnowledge': result = await service.searchKnowledge(args.query); break;
        case 'kanban': result = kanbanSummary([...service.documents.values()], {caseSensitive: service.caseSensitive}); break;
        case 'kanbanBoard': result = kanbanBoard([...service.documents.values()], args.path, {caseSensitive: service.caseSensitive}); break;
        case 'buildEvidenceBundle': result = await service.buildEvidenceBundle(args.question, {connections: args.connections !== false, seedLimit: Math.max(1, Math.min(5, Number(args.seedLimit) || 5)), maxDocuments: Math.max(1, Math.min(20, Number(args.maxDocuments) || 20))}); break;
        default: return send(res, 403, {error: 'Read-only operation not available'});
      }
      send(res, 200, result);
    } catch (e) {send(res, 400, {error: e.message});}
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return {url: 'http://127.0.0.1:' + server.address().port, service, close: async () => {await service.close(); await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});}};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--workspace');
  const app = await createServer({root: at >= 0 ? path.resolve(process.argv[at + 1]) : path.join(ROOT, 'knowledge')}); console.log('Weave read-only preview: ' + app.url);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {await app.close();process.exit(0);});
}
