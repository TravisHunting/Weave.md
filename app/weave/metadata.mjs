import YAML from 'yaml';
import {articlePresentation} from './presentation.mjs';
export function metadataBlock(text) {
  const front = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  const tail = text.match(/(?:^|\r?\n)```yaml[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  const match = front || tail;
  if (!match) return null;
  const contentStart = match.index + match[0].indexOf(match[1]);
  return {start: match.index, end: match.index + match[0].length, contentStart, contentEnd: contentStart + match[1].length,
    text: match[1], document: YAML.parseDocument(match[1], {uniqueKeys: true})};
}
export function noteMetadata(text, file, rootName) {
  let metadata = {}, body = text, warning = null, legacyRelationships = 0;
  try {
    const block = metadataBlock(text);
    if (block) {
      if (block.document.errors.length) throw new Error(block.document.errors[0].message);
      metadata = block.document.toJS({maxAliasCount: 0}) || {};
      if (typeof metadata !== 'object' || Array.isArray(metadata)) metadata = {};
      body = text.slice(0, block.start) + text.slice(block.end);
      legacyRelationships = Array.isArray(metadata.relationships) ? metadata.relationships.length : 0;
    }
  } catch (e) { warning = e.message; }
  // YAML relationships are intentionally never returned to the graph engine.
  const {relationships, ...fields} = metadata;
  const presentation = articlePresentation(text, file, rootName);
  return {...presentation,
    tags: [...new Set([...presentation.tags, ...[fields.tags, fields.topics].flatMap(v => Array.isArray(v) ? v.filter(t => typeof t === 'string') : [])])],
    stableId: typeof fields.id === 'string' ? fields.id : null, body, metadata: fields, warning, legacyRelationships};
}
