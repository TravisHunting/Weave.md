import {readFrontmatter, splitFrontmatter, createFrontmatter, editFrontmatter} from './okf.mjs';
import {articlePresentation} from './presentation.mjs';
// Kanban boards and cards live in OKF frontmatter, so Markdown stays the source
// of truth. A board is any article with `type: Kanban Board`; its ordered
// columns are `weave.kanban.columns`. Any article joins a board with
// `weave.kanban.board` (the board's filename, or a path to it), `column` (a
// column id of that board) and a sparse numeric `rank` within the column.
// The desktop index (src-tauri/src/kanban.rs) derives the same model in SQLite;
// browser readers derive it here. Keep the two in step (parity is tested).

export const BOARD_TYPE = 'Kanban Board';
export const RANK_STEP = 1000;
export const DEFAULT_COLUMNS = ['Backlog', 'To do', 'In progress', 'Done'];
const KANBAN = ['weave', 'kanban'];

const mapping = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const section = fields => mapping(mapping(mapping(fields)?.weave)?.kanban);
const scalar = value => typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
export const isBoardType = type => typeof type === 'string' && type.trim().toLowerCase() === BOARD_TYPE.toLowerCase();
export const isBoardText = text => isBoardType(readFrontmatter(text).fields.type);

/** A board's columns in board order, with warnings for entries Weave skips. */
export function boardColumns(fields) {
  const columns = [], warnings = [], seen = new Set(), list = section(fields)?.columns;
  if (list != null && !Array.isArray(list)) warnings.push('weave.kanban.columns must be a list.');
  (Array.isArray(list) ? list : []).forEach((entry, index) => {
    const item = mapping(entry), id = scalar(item ? item.id : entry), title = (item ? scalar(item.title) : '') || id;
    if (!id) warnings.push(`Column ${index + 1} has no id.`);
    else if (seen.has(id)) warnings.push(`Column id “${id}” is used more than once; only the first is shown.`);
    else {seen.add(id); columns.push({id, title});}
  });
  return {columns, warnings};
}
/** The card fields of an article, or null when it is on no board. */
export function cardReference(fields) {
  const kanban = section(fields), board = scalar(kanban?.board);
  if (!board) return null;
  const raw = kanban.rank, number = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw.trim()) : NaN;
  return {board, column: scalar(kanban.column) || null, rank: Number.isFinite(number) ? number : null};
}
function normalize(base, path) {
  const parts = base ? base.split('/').filter(Boolean) : [];
  for (const part of path.split('/')) {
    if (part === '..') {if (!parts.length) return null; parts.pop();}
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}
const fold = (value, caseSensitive) => caseSensitive ? value : value.toLowerCase();
export const filename = path => path.split('/').at(-1);
/** How a card's `board` value finds its board: a bare filename matches any
 * board with that filename (board names are unique in a workspace); a value
 * containing `/` is a path, relative to the card or (with a leading `/`) to the
 * workspace root. `key` is null when a path leaves the workspace. */
export function boardReference(reference, source, caseSensitive = true) {
  let value = String(reference).trim().replaceAll('\\', '/');
  if (!/\.md$/i.test(value)) value += '.md';
  const byPath = value.includes('/'), parent = source.split('/').slice(0, -1).join('/');
  const key = byPath ? normalize(value.startsWith('/') ? '' : parent, value) : value;
  return {byPath, key: key === null || key === '' ? null : fold(key, caseSensitive)};
}
/** The board model of a workspace: boards with their columns and every card.
 * Card status: ok, unknown-column, no-column, missing-board or ambiguous-board. */
function derive(documents, caseSensitive) {
  const boards = [], cards = [];
  for (const doc of documents) {
    const {fields} = readFrontmatter(doc.text), presentation = articlePresentation(doc.text, doc.path);
    const description = typeof fields.description === 'string' ? fields.description.trim() : '';
    const updated = typeof fields.updated_at === 'string' ? fields.updated_at : null;
    if (isBoardType(fields.type)) boards.push({path: doc.path, title: presentation.title, name: filename(doc.path), ...boardColumns(fields), nameKey: fold(filename(doc.path), caseSensitive), pathKey: fold(doc.path, caseSensitive)});
    const card = cardReference(fields);
    if (card) cards.push({path: doc.path, title: presentation.title, description, tags: presentation.tags.slice(0, 3), updated, ...card, reference: boardReference(card.board, doc.path, caseSensitive)});
  }
  for (const card of cards) {
    const {byPath, key} = card.reference, matches = key === null ? [] : boards.filter(board => (byPath ? board.pathKey : board.nameKey) === key);
    card.candidates = matches.map(board => board.path);
    card.boardPath = matches.length === 1 ? matches[0].path : null;
    card.status = !matches.length ? 'missing-board' : matches.length > 1 ? 'ambiguous-board' : !card.column ? 'no-column' : matches[0].columns.some(column => column.id === card.column) ? 'ok' : 'unknown-column';
  }
  return {boards, cards};
}
const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const duplicatesOf = (board, boards) => boards.filter(other => other !== board && other.nameKey === board.nameKey).map(other => other.path).sort();
const onBoard = (card, board) => card.candidates.includes(board.path);
export function kanbanSummary(documents, {caseSensitive = true} = {}) {
  const {boards, cards} = derive(documents, caseSensitive);
  return {
    boards: boards.sort(byPath).map(board => ({path: board.path, title: board.title, name: board.name, columns: board.columns, warnings: board.warnings, duplicates: duplicatesOf(board, boards), cards: cards.filter(card => onBoard(card, board)).length, attention: cards.filter(card => onBoard(card, board) && card.status !== 'ok').length})),
    cards: cards.sort(byPath).map(card => ({path: card.path, title: card.title, board: card.board, boardPath: card.boardPath, candidates: card.candidates, column: card.column, rank: card.rank, status: card.status})),
  };
}
export function kanbanBoard(documents, path, {caseSensitive = true} = {}) {
  const {boards, cards} = derive(documents, caseSensitive), board = boards.find(item => item.path === path);
  if (!board) throw new Error('This article is not a Kanban board.');
  return {
    board: {path: board.path, title: board.title, name: board.name, columns: board.columns, warnings: board.warnings, duplicates: duplicatesOf(board, boards)},
    cards: cards.filter(card => onBoard(card, board)).sort(byPath).map(card => ({path: card.path, title: card.title, description: card.description, tags: card.tags, updated: card.updated, board: card.board, column: card.column, rank: card.rank, status: card.status})),
  };
}

/** Display order within a column: rank (cards without one last), then title and path. */
export function compareCards(a, b) {
  const ra = Number.isFinite(a.rank) ? a.rank : Infinity, rb = Number.isFinite(b.rank) ? b.rank : Infinity;
  if (ra !== rb) return ra < rb ? -1 : 1;
  return String(a.title).localeCompare(String(b.title)) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
/** The shortest decimal strictly between `low` and `high`, or null when the
 * space is too small to stay readable (then the column is rebalanced). */
export function rankBetween(low, high) {
  if (!(Number.isFinite(low) && Number.isFinite(high) && high > low)) return null;
  const middle = (low + high) / 2;
  for (let places = 0; places <= 4; places++) {
    const value = Number(middle.toFixed(places));
    if (value > low && value < high) return value;
  }
  return null;
}
/** Ranks to write when a card moves to `index` among `ordered` (the column's
 * other cards in display order). Usually only the moved card changes; when
 * there is no readable rank between its neighbours, or a neighbour has no rank,
 * the column alone is renumbered 1000, 2000, 3000… Returns [{path, rank}]. */
export function planMove(ordered, index, moving) {
  const at = Math.max(0, Math.min(index, ordered.length)), previous = ordered[at - 1], next = ordered[at];
  const ranked = card => !card || Number.isFinite(card.rank);
  let rank = null;
  if (ranked(previous) && ranked(next)) {
    if (!previous && !next) rank = RANK_STEP;
    else if (!previous) rank = next.rank > 1 ? rankBetween(0, next.rank) : next.rank - RANK_STEP;
    else if (!next) rank = Math.floor(previous.rank) + RANK_STEP;
    else rank = rankBetween(previous.rank, next.rank);
  }
  if (rank !== null) return [{path: moving, rank}];
  const order = [...ordered.slice(0, at).map(card => card.path), moving, ...ordered.slice(at).map(card => card.path)];
  const current = new Map(ordered.map(card => [card.path, card.rank]));
  return order.map((path, i) => ({path, rank: (i + 1) * RANK_STEP})).filter(item => item.path === moving || current.get(item.path) !== item.rank);
}

/** Sets (or with null, removes) card fields under `weave.kanban`. An article
 * without frontmatter gains an OKF block first. Comments and other keys stay. */
export function setCardFields(text, values) {
  let source = String(text);
  if (!splitFrontmatter(source).frontmatter) source = createFrontmatter(source);
  return editFrontmatter(source, document => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      if (value === null) {if (document.hasIn([...KANBAN, key])) document.deleteIn([...KANBAN, key]);}
      else document.setIn([...KANBAN, key], value);
    }
  });
}
/** Takes an article off its board, removing empty `weave.kanban`/`weave` maps. */
export function removeCardFields(text) {
  return editFrontmatter(text, document => {
    for (const key of ['board', 'column', 'rank']) if (document.hasIn([...KANBAN, key])) document.deleteIn([...KANBAN, key]);
    const empty = path => {const node = document.getIn(path, true); return node && Array.isArray(node.items) && !node.items.length;};
    if (empty(KANBAN)) document.deleteIn(KANBAN);
    if (empty(['weave'])) document.delete('weave');
  });
}
/** Replaces a board's column list (ids and titles, in order). */
export function setBoardColumns(text, columns) {
  return editFrontmatter(text, document => document.setIn([...KANBAN, 'columns'], document.createNode(columns.map(({id, title}) => ({id, title})))));
}
/** A stable column id from a title, unique among `existing` ids. */
export function columnId(title, existing = []) {
  const base = String(title).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'column';
  let id = base;
  for (let n = 2; existing.includes(id); n++) id = base + '-' + n;
  return id;
}
export function columnsFromTitles(titles) {
  const columns = [];
  for (const title of titles.map(value => String(value).trim()).filter(Boolean)) columns.push({id: columnId(title, columns.map(column => column.id)), title});
  return columns;
}
const escapeHeading = text => text.replace(/([\\`*_\[\]<>#])/g, '\\$1');
/** A new board article: OKF frontmatter with the columns, and a heading. */
export function boardText(title, columns) {
  const text = createFrontmatter('# ' + escapeHeading(title) + '\n\nWhat this board tracks, and how cards move across it.\n', {type: BOARD_TYPE, title});
  return setBoardColumns(text, columns);
}
/** A new card article on `board` in `column`. */
export function cardText(title, {board, column, rank}) {
  return setCardFields(createFrontmatter('# ' + escapeHeading(title) + '\n\n', {title}), {board, column, rank});
}
