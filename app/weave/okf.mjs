import YAML from 'yaml';
// Open Knowledge Format frontmatter: a leading `---` YAML block. `type` is the
// only required key; unknown keys are preserved when Weave edits the block.
// The core keys OKF defines: `type` is required; the others are recommended.
export const OKF_FIELDS = ['type', 'title', 'description', 'resource', 'tags'];
export const OKF_LIST_FIELDS = new Set(['tags']);
const pattern = /^(\uFEFF?)---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

// `frontmatter` keeps the original bytes (including a BOM and the closing
// newline), so frontmatter + body always reproduces the source exactly.
export function splitFrontmatter(text) {
  const source = String(text), match = source.match(pattern);
  if (!match) return {frontmatter: '', yaml: null, body: source};
  return {frontmatter: match[0], yaml: match[2] || '', body: source.slice(match[0].length)};
}
export function readFrontmatter(text) {
  const {frontmatter, yaml, body} = splitFrontmatter(text);
  if (!frontmatter) return {present: false, fields: {}, error: null, body};
  try {
    const document = YAML.parseDocument(yaml, {uniqueKeys: true});
    if (document.errors.length) throw new Error(document.errors[0].message);
    const fields = document.toJS({maxAliasCount: 0}) ?? {};
    if (typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Frontmatter must be a YAML mapping.');
    return {present: true, fields, error: null, body};
  } catch (error) {return {present: true, fields: {}, error: error.message, body};}
}
export const okfTitle = text => {const {fields} = readFrontmatter(text); return typeof fields.title === 'string' && fields.title.trim() ? fields.title.trim() : null;};
export const okfList = value => (Array.isArray(value) ? value : value == null || value === '' ? [] : [value]).filter(item => item != null && typeof item !== 'object').map(String);

function render(document, newline) {
  return '---' + newline + document.toString({lineWidth: 0, flowCollectionPadding: false}).replace(/\r?\n$/, '').replace(/\r?\n/g, newline) + newline + '---' + newline;
}
function listNode(document, values) {const node = document.createNode(values); node.flow = true; return node;}

/** Edits the frontmatter as a YAML document (`edit(document)`), keeping
 * comments, key order and untouched keys as authored. */
export function editFrontmatter(text, edit) {
  const source = String(text), {frontmatter, yaml, body} = splitFrontmatter(source);
  if (!frontmatter) throw new Error('This article has no frontmatter.');
  const document = YAML.parseDocument(yaml, {uniqueKeys: true});
  if (document.errors.length) throw new Error('Fix the frontmatter in Source mode first: ' + document.errors[0].message);
  if (document.contents === null) document.contents = document.createNode({});
  if (!YAML.isMap(document.contents)) throw new Error('Frontmatter must be a YAML mapping.');
  edit(document);
  const bom = frontmatter.startsWith('\uFEFF') ? '\uFEFF' : '', newline = frontmatter.match(/\r\n|\n/)?.[0] || '\n';
  return bom + render(document, newline) + body;
}
// Set (or with `undefined`, remove) one key. Comments, key order and every
// other key stay as authored. List fields are written as `[a, b]`.
export function setFrontmatterField(text, key, value) {
  const name = String(key).trim();
  if (!/^[A-Za-z_][\w.-]*$/.test(name)) throw new Error('Field names use letters, numbers, underscores, hyphens or dots.');
  if (name === 'type' && (value === undefined || !String(value).trim())) throw new Error('OKF requires a non-empty type.');
  return editFrontmatter(text, document => {
    if (value === undefined) document.delete(name);
    else document.set(name, Array.isArray(value) ? listNode(document, value) : value);
  });
}

// Weave records when an article was created and last saved. The fields are
// written automatically and have no property pill; Source mode can still edit them.
export const TIMESTAMP_FIELDS = ['created_at', 'updated_at'];
const pad = value => String(value).padStart(2, '0');
/** A local ISO 8601 timestamp with its UTC offset, to the second: 2026-10-07T14:03:22+13:00. */
export function isoTimestamp(date = new Date()) {
  const offset = -date.getTimezoneOffset(), sign = offset < 0 ? '-' : '+', hours = Math.floor(Math.abs(offset) / 60), minutes = Math.abs(offset) % 60;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(hours)}:${pad(minutes)}`;
}
/** Sets `updated_at` to now and supplies a missing `created_at` (the file's
 * creation time when known). An article without frontmatter gains a block with
 * `type: Note`; frontmatter that is not valid YAML is left untouched. */
export function stampArticle(text, {created = null, now = new Date()} = {}) {
  const source = String(text);
  let next = splitFrontmatter(source).frontmatter ? source : createFrontmatter(source);
  const {fields, error} = readFrontmatter(next);
  if (error) return source;
  const createdAt = Number.isFinite(created) && created > 0 && created <= now.getTime() ? new Date(created) : now;
  if (fields.created_at == null || fields.created_at === '') next = setFrontmatterField(next, 'created_at', isoTimestamp(createdAt));
  return setFrontmatterField(next, 'updated_at', isoTimestamp(now));
}

export function createFrontmatter(text, {type = 'Note', title} = {}) {
  const source = String(text);
  if (splitFrontmatter(source).frontmatter) throw new Error('This article already has frontmatter.');
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '', body = source.slice(bom.length), newline = body.match(/\r\n|\n/)?.[0] || '\n';
  const fields = {type};
  if (title) fields.title = title;
  const document = new YAML.Document(fields);
  return bom + render(document, newline) + body;
}
