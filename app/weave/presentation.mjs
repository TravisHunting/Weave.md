import {plainText} from './links.mjs';
import {readFrontmatter, okfList} from './okf.mjs';
// Shared by the desktop index, browser reader and link autocomplete. An OKF
// `title` takes precedence over the body's first-line heading.
export function articlePresentation(text, file, rootName = 'Workspace') {
  const {fields, body} = readFrontmatter(text);
  const first = String(body).replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0];
  const heading = first.match(/^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/)?.[1];
  const okfTitle = typeof fields.title === 'string' && fields.title.trim() ? fields.title.trim() : typeof fields.title === 'number' ? String(fields.title) : null;
  const parts = file.replaceAll('\\', '/').split('/'), filename = parts.at(-1).replace(/\.md$/i, '');
  const tags = okfList(fields.tags).map(tag => tag.trim()).filter(Boolean); let fence = null;
  for (const line of String(body).split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {if (!fence) fence = marker[1][0]; else if (fence === marker[1][0]) fence = null; continue;}
    if (fence) continue;
    const match = line.match(/^\s*(?:\*\*)?(?:Topics|Tags)(?:\*\*)?:\s*(.+?)\s*$/i);
    if (match) for (let tag of match[1].replace(/\.$/, '').split(/[,;]|\s+(?=#)/)) {tag = plainText(tag.trim()).replace(/^#+/, ''); if (tag && !tags.includes(tag)) tags.push(tag);}
  }
  return {title: okfTitle || (heading ? plainText(heading) : filename), heading: heading ? plainText(heading) : null, filename, type: parts.length > 1 ? parts.at(-2) : rootName, tags};
}
