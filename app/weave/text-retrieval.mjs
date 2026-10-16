import {lexicalSearchQuery, lexicalQueryTerms, literalSearchQuery} from './search-query.mjs';

export function passageFor(text, query) {
  const lines = text.split(/\r?\n/), terms = lexicalQueryTerms(query).positive;
  let best = 0, score = -1;
  lines.forEach((line, i) => { const rank = terms.reduce((n, t) => n + Number(line.toLowerCase().includes(t)), 0); if (rank > score) { score = rank; best = i; } });
  const start = Math.max(0, best - 1); return {text: lines.slice(start, start + 6).join('\n').slice(0, 900), line: start + 1};
}
export function lexicalFallback(documents, query, limit = 30) {
  query = lexicalSearchQuery(query);
  const {positive: terms, negative} = lexicalQueryTerms(query); if (!terms.length) return [];
  return [...documents.values()].map(doc => {
    const title = (doc.title || doc.path).toLowerCase(), text = doc.text.toLowerCase(), file = doc.path.toLowerCase();
    const matched = terms.filter(t => title.includes(t) || file.includes(t) || text.includes(t));
    const score = matched.reduce((n, t) => n + (title.includes(t) ? 100 : file.includes(t) ? 70 : 1), 0) + (title === literalSearchQuery(query).toLowerCase() ? 1000 : 0);
    const excluded = negative.some(t => title.includes(t) || file.includes(t) || text.includes(t));
    return {path: doc.path, title: doc.title || doc.path, score, matched: matched.length, excluded, excerpt: passageFor(doc.text, query), method: 'text'};
  }).filter(r => !r.excluded && r.matched === terms.length).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

// Stable retrieval boundary for future generation tools. This returns sources,
// relevance and explicit edges, never a fabricated answer.
export async function buildEvidenceBundle(service, question, {seedLimit = 5, maxDocuments = 20, connections = true} = {}) {
  const found = await service.searchKnowledge(question, {enrich: true, limit: seedLimit, searchChannel:'evidence'});
  const seeds = found.results.slice(0, seedLimit), selected = new Map();
  for (const seed of seeds) selected.set(seed.path, {path: seed.path, kind: 'seed', score: seed.score, method: seed.method, reason: 'Matched the question'});
  let truncated = false;
  for (const seed of connections ? seeds : []) {
    const expansion = service.getNeighbors(seed.path, 1, maxDocuments);
    truncated ||= expansion.truncated;
    for (const item of expansion.documents) if (!selected.has(item.path)) {
      if (selected.size >= maxDocuments) { truncated = true; break; }
      selected.set(item.path, {path: item.path, kind: 'related', reason: 'Connected by an explicit Markdown link', via: item.via});
    }
  }
  const documents = [];
  for (const item of selected.values()) {
    try {
      const doc = await service.getDocument(item.path), supporting = await service.getPassage(item.path, question, doc);
      documents.push({...item, title: doc.title, passage: supporting, contentHash: doc.hash, relationships: service.getOutgoingRelationships(item.path)});
    } catch (e) { documents.push({...item, error: e.message}); }
  }
  return {version: 1, question, generated: false, retrieval: found.method, notices: found.notices, truncated, documents};
}
