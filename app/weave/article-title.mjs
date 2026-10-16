import {splitFrontmatter, readFrontmatter, setFrontmatterField} from './okf.mjs';
// The first body line holds the heading. An OKF `title` is the display title
// when present, so retitling updates it as well. Preserve the rest byte-for-byte.
export function retitleArticle(text, title) {
  const name = String(title).trim();
  if (!name || /[\r\n\u0000]/.test(name)) throw new Error('Enter a title on one line.');
  let source = String(text);
  const okf = readFrontmatter(source), okfTitle = okf.present && !okf.error && 'title' in okf.fields;
  if (okfTitle) source = setFrontmatterField(source, 'title', name);
  const {frontmatter, body: rest} = splitFrontmatter(source);
  const bom = !frontmatter && rest.startsWith('\uFEFF') ? '\uFEFF' : '', body = rest.slice(bom.length);
  const newline = (frontmatter || body).match(/\r\n|\n|\r/)?.[0] || '\n';
  const end = body.search(/[\r\n]/), first = end < 0 ? body : body.slice(0,end);
  const heading = first.match(/^( {0,3}#{1,6})[ \t]+/);
  const escaped = name.replace(/([\\`*_~\[\]<>#])/g, '\\$1');
  if (!heading && okfTitle) return source;
  return frontmatter + bom + (heading ? heading[1] + ' ' + escaped + (end < 0 ? '' : body.slice(end)) : '# ' + escaped + newline + newline + body);
}
