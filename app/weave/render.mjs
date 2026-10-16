import {parseLinks, createResolver} from './links.mjs';
import {renderChatMarkdown, articleResolver} from '../chat-markdown.mjs';
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
export function resolveMarkdownLink(authored, paths, caseSensitive = true, sourcePath = '') {
  let target;try {target=decodeURIComponent(authored.split('#')[0]);} catch {return null;}
  if(!/\.md$/i.test(target) || /^[a-z]+:|^\//i.test(target)) return null;
  const pieces=[...sourcePath.split('/').slice(0,-1)];
  for(const part of target.replaceAll('\\','/').split('/')) {if(part==='..') {if(!pieces.length)return null;pieces.pop();} else if(part!=='.' && part)pieces.push(part);}
  return createResolver(paths,{caseSensitive})(pieces.join('/')).resolvedPath;
}
const aliases = new WeakMap();
export function renderNote(text, paths, caseSensitive = true, legacyIds = new Map(), sourcePath = '', {titles = new Map(), showRelationships = false, underline = true} = {}) {
  const resolve = createResolver(paths, {caseSensitive});
  const parsed = parseLinks(text), placeholders = [];
  let replaced = text;
  for (const link of [...parsed.links].reverse()) {
    const r = resolve(link.target, sourcePath), label = (link.label || titles.get(r.resolvedPath) || link.target.split('/').at(-1).replace(/\.md$/i, '')) + (link.typed && showRelationships ? ' @@' + link.relationship : '');
    const html = r.resolved ? `<button class="wiki-link" data-open="${esc(r.resolvedPath)}" title="Ctrl click to open">${esc(label)}</button>`
      : `<button class="wiki-link broken" data-broken="${esc(link.target)}" title="${esc(r.reason + (r.candidates.length ? ': ' + r.candidates.join(', ') : ''))}">${esc(label)} <span>?</span></button>`;
    const marker = 'WEAVELINK' + placeholders.length + 'TOKEN'; placeholders.push({marker, html});
    replaced = replaced.slice(0, link.start) + marker + replaced.slice(link.end);
  }
  // Entity aliases of the article paths are built once per path list.
  const list = Array.isArray(paths) ? paths : paths?.paths || [];
  let {entities, legacyResolve} = legacyIds.size ? {} : aliases.get(list) || {};
  if (!entities) {
    entities = list.map(file => ({id: file, file, name: file}));
    for (const [id, file] of legacyIds) entities.push({id, file, name: file});
    legacyResolve = articleResolver(entities);
    if (!legacyIds.size) aliases.set(list, {entities, legacyResolve});
  }
  const resolveMarkdown = authored => {
    const known = legacyResolve(authored); if (known) return known;
    return resolveMarkdownLink(authored,paths,caseSensitive,sourcePath);
  };
  let html = renderChatMarkdown(replaced, entities, resolveMarkdown, {headingSpacing:true,linkTitle:'Ctrl click to open',underline});
  for (const item of placeholders) html = html.replaceAll(item.marker, item.html);
  return html;
}
