import {esc} from './render.mjs';

// Escape every piece independently: a literal query is never markup or a regex.
export function highlightSearch(text, query) {
  text = String(text ?? '');
  const term = String(query ?? '').trim();
  if (!term) return esc(text);
  const expression = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  let result = '', previous = 0;
  for (const match of text.matchAll(expression)) {
    result += esc(text.slice(previous, match.index)) + '<mark class="search-match">' + esc(match[0]) + '</mark>';
    previous = match.index + match[0].length;
  }
  return result + esc(text.slice(previous));
}
