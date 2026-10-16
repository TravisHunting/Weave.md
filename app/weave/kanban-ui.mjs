import {hydrateMermaid} from './mermaid.mjs';
import {esc, renderNote} from './render.mjs';
import {readFrontmatter, stampArticle} from './okf.mjs';
import {createBoardView, boardLanes, cardProblem} from './kanban-view.mjs';
import {DEFAULT_COLUMNS, isBoardText, boardColumns, cardReference, planMove, setCardFields, removeCardFields, setBoardColumns, columnId, columnsFromTitles, boardText, cardText, filename} from './kanban.mjs';
// Kanban in the window: a board article shows as a board in its tab (its
// Markdown stays one click away), the Kanban sidebar lists each workspace's
// boards and the cards they cannot place, and clicking a card shows it in the
// right sidebar. Every change is written to the cards' or board's frontmatter
// with `kanbanSave`; the index then follows the files.

const SETTINGS = [['kanban-show-description', 'kanban-show-description', 'true'], ['kanban-show-tags', 'kanban-show-tags', 'true'], ['kanban-show-folder', 'kanban-show-folder', 'false'], ['kanban-require-edit', 'kanban-require-edit', 'false']];
const folderOf = path => path.split('/').slice(0, -1).join('/');
const join = (...parts) => parts.filter(Boolean).join('/');
const safeName = value => String(value).replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');

export function createKanban(ctx) {
  const {client, prefs, $, message, promptUser} = ctx;
  // Kanban changes wait for the boards, sidebar and preview to show them.
  const refreshWorkspace = async ws => {await ctx.refreshWorkspace(ws); await workspaceChanged(ws);};
  const documentMode = new Set();
  let preview = null, previewSerial = 0, menuItems = [];
  const setting = key => prefs.get(key) ?? SETTINGS.find(item => item[1] === key)?.[2];
  const settings = () => ({showDescription: setting('kanban-show-description') !== 'false', showTags: setting('kanban-show-tags') !== 'false', showFolder: setting('kanban-show-folder') === 'true', columnWidth: [240, 280, 340].includes(Number(prefs.get('kanban-column-width'))) ? Number(prefs.get('kanban-column-width')) : 280});
  /** Cards can be moved whenever the workspace is writable, or only while Edit is on. */
  const writable = () => !!client.writable && (setting('kanban-require-edit') !== 'true' || ctx.editing());
  const requireWritable = () => {if (!writable()) throw new Error(client.writable ? 'Turn on Edit to change Kanban boards, or allow it in Settings › Kanban.' : 'Kanban boards are read-only here.');};
  const fold = (ws, value) => ws.catalog.caseSensitive ? value : value.toLowerCase();
  const boards = ws => ws?.kanban?.boards || [];
  const boardOf = (ws, path) => boards(ws).find(board => board.path === path) || null;
  const cardOf = (ws, path) => ws?.kanban?.cards.find(card => card.path === path) || null;
  /** The `board` value a card should write: the filename, or a root path while
   * another board shares the filename. */
  const boardValue = board => board.duplicates?.length ? '/' + board.path : board.name;

  // Board view per editor pane.
  const views = ctx.panes.map(pane => {
    pane.kanbanSerial = 0;
    const container = pane.el['kanban-view'];
    container.addEventListener('click', event => {
      if (!event.target.closest('[data-kanban-show-board]')) return;
      // Source shows the board's Markdown; leaving it shows the board again.
      if (ctx.paneSource(pane)) {ctx.leaveSource(pane); return;}
      const doc = ctx.paneActive(pane); if (doc) documentMode.delete(ctx.docKey(doc)); update(pane);
    });
    return createBoardView(container, {
      canMove: writable, settings, selected: () => preview && ctx.paneWs(pane) === preview.ws ? preview.path : null,
      onOpen: (card, event) => ctx.run(() => openCard(ctx.paneWs(pane), card, event, pane))(),
      onMove: move => ctx.run(() => moveCard(pane, move))(),
      onMenu: (event, target) => boardMenu(pane, event, target),
      onAction: (name, detail) => ctx.run(() => boardAction(pane, name, detail))(),
    });
  });
  const viewOf = pane => views[ctx.panes.indexOf(pane)];
  const isBoardDoc = doc => !!doc && !doc.external && isBoardText(doc.text);
  /** Whether `pane` shows a board rather than its article (Source always shows the Markdown). */
  const boardShown = pane => {const doc = ctx.paneActive(pane); return isBoardDoc(doc) && !documentMode.has(ctx.docKey(doc)) && !ctx.paneSource(pane);};
  function update(pane) {
    const doc = ctx.paneActive(pane), container = pane.el['kanban-view'], board = isBoardDoc(doc), shown = boardShown(pane);
    pane.el['note-panel'].classList.toggle('kanban-mode', shown);
    container.hidden = !board; container.classList.toggle('kanban-document', board && !shown);
    if (!board) {pane.kanbanSerial++; viewOf(pane).clear(); return;}
    if (!shown) {pane.kanbanSerial++; viewOf(pane).clear(); container.innerHTML = `<div class="kanban-document-bar"><span>This article is a Kanban board${ctx.paneSource(pane) ? ', shown as Markdown source' : ''}.</span><button type="button" data-kanban-show-board>Show board</button></div>`; return;}
    void load(pane);
  }
  async function load(pane) {
    const doc = ctx.paneActive(pane), ws = ctx.paneWs(pane), serial = ++pane.kanbanSerial;
    if (!ws) return;
    try {
      const model = await ws.api.call('kanbanBoard', {path: doc.path});
      if (serial === pane.kanbanSerial && ctx.paneActive(pane)?.path === doc.path) viewOf(pane).render(model, {ws});
    } catch (error) {
      if (serial === pane.kanbanSerial) {viewOf(pane).clear(); pane.el['kanban-view'].innerHTML = `<div class="kanban-notice warning">${esc(error.message)}</div>`;}
    }
  }
  const updateAll = () => {for (const pane of ctx.shownPanes()) update(pane);};
  /** After a workspace's files change: its board summary, boards, sidebar and preview. */
  async function workspaceChanged(ws) {
    const serial = ws.kanbanSerial = (ws.kanbanSerial || 0) + 1;
    let summary = null;
    try {summary = await ws.api.call('kanban');} catch {}
    if (serial !== ws.kanbanSerial || !ctx.workspaces().includes(ws)) return;
    // Files shows board icons: draw it again only when the boards change, so a
    // background refresh never replaces the tree under a pointer.
    const icons = JSON.stringify(boards({kanban: summary}).map(board => board.path)), redraw = icons !== ws.kanbanIcons;
    ws.kanban = summary; ws.kanbanIcons = icons;
    renderBadge(); renderSidebar(); if (redraw) ctx.renderTree();
    for (const pane of ctx.shownPanes()) if (ctx.paneWs(pane) === ws) update(pane);
    if (preview?.ws === ws) await renderPreview();
  }
  function forget(ws) {if (preview?.ws === ws) {preview = null; void renderPreview();} renderBadge(); renderSidebar();}

  // Writing frontmatter. Unsaved text of the articles is saved first.
  async function writeArticles(ws, items, action) {
    requireWritable();
    const keys = new Set(items.map(item => ctx.draftKey(ws.key, item.path)));
    if (!await ctx.ensureDraftsSaved(key => keys.has(key), action)) return false;
    const writes = [];
    for (const item of items) {
      const doc = await ws.api.call('getDocument', {path: item.path}), text = item.edit(doc.text);
      if (text !== doc.text) writes.push({path: item.path, text: stampArticle(text, {created: doc.created}), hash: doc.hash});
    }
    try {if (writes.length) await ws.api.call('kanbanSave', {writes});}
    finally {await refreshWorkspace(ws);}
    return true;
  }
  /** Puts a card in `column` of `board` at `index` (default: the end). */
  async function assignCard(ws, path, boardPath, column, index = Infinity, {keepReference = false} = {}) {
    const model = await ws.api.call('kanbanBoard', {path: boardPath}), lane = boardLanes(model).lanes.find(item => item.id === column);
    if (!lane) throw new Error('That column is no longer on the board.');
    const others = lane.cards.filter(card => card.path !== path), plan = planMove(others, Math.min(index, others.length), path);
    const value = keepReference ? undefined : boardValue(model.board);
    return writeArticles(ws, plan.map(item => ({path: item.path, edit: text => setCardFields(text, item.path === path ? {board: value, column, rank: item.rank} : {rank: item.rank})})), 'moving cards');
  }
  async function moveCard(pane, {card, column, index, element, keyboard}) {
    const ws = ctx.paneWs(pane), model = viewOf(pane).model; if (!ws || !model) return;
    // Show the move at once; the board is drawn again from the files after saving.
    const target = [...pane.el['kanban-view'].querySelectorAll('.kanban-lane')].find(lane => lane.dataset.column === column);
    if (element && target && !keyboard) {const list = target.querySelector('.kanban-cards'), others = [...list.querySelectorAll('.kanban-card')].filter(node => node !== element); list.querySelector('.kanban-empty')?.remove(); list.insertBefore(element, others[index] || null); element.classList.add('saving');}
    // A card already on this board keeps its board value as written.
    const keep = ['ok', 'unknown-column', 'no-column'].includes(card.status);
    try {await assignCard(ws, card.path, model.board.path, column, index, {keepReference: keep});}
    catch (error) {viewOf(pane).invalidate(); await load(pane); throw error;}
    if (keyboard) viewOf(pane).focusCard(card.path);
    message(`Moved “${card.title}” to ${model.board.columns.find(item => item.id === column)?.title || column}.`);
  }
  /** The board lane under (x, y) for an article dragged from Files, marked as
   * a drop target: {pane, ws, board, column, index}. Null when no board shown
   * in the article's workspace can take it there. */
  function dropTarget(x, y, {ws, path}) {
    let found = null;
    for (const pane of ctx.shownPanes()) {
      const view = viewOf(pane), board = view.model?.board;
      const fits = !found && writable() && boardShown(pane) && ctx.paneWs(pane) === ws && board && board.path !== path && /\.md$/i.test(path) && !ws.index.isFolder(path);
      const at = fits ? view.externalAt(x, y) : (view.clearExternal(), null);
      if (at) found = {pane, ws, board: board.path, ...at};
    }
    return found;
  }
  /** Whether (x, y) is over a board, whichever workspace it shows. */
  const boardAt = (x, y) => {const element = document.elementFromPoint(x, y); return ctx.shownPanes().some(pane => boardShown(pane) && pane.el['kanban-view'].contains(element));};
  const clearDrops = () => {for (const pane of ctx.panes) viewOf(pane).clearExternal();};
  /** Places an article dropped from Files on a board: a new card gains its
   * `weave.kanban` fields (and OKF frontmatter when it has none), a card of
   * this board moves, and a card of another board moves to this one. */
  async function dropArticle({pane, ws, board: boardPath, column, index}, path) {
    requireWritable();
    const model = viewOf(pane).model;
    if (!model || model.board.path !== boardPath) return;
    const card = cardOf(ws, path), same = card?.boardPath === boardPath, title = card?.title || ctx.titles(ws)?.get?.(path) || filename(path).replace(/\.md$/i, '');
    const keep = same && ['ok', 'unknown-column', 'no-column'].includes(card.status);
    if (!await assignCard(ws, path, boardPath, column, index, {keepReference: keep})) return;
    const lane = model.board.columns.find(item => item.id === column)?.title || column;
    message(same ? `Moved “${title}” to ${lane}.` : card?.boardPath ? `Moved “${title}” from ${boardOf(ws, card.boardPath)?.title || card.boardPath} to ${lane}.` : `Added “${title}” to ${lane}.`);
  }
  async function removeCard(ws, path) {
    await writeArticles(ws, [{path, edit: removeCardFields}], 'changing the card');
    message('Removed from its Kanban board. The article is unchanged otherwise.');
  }
  async function editColumns(ws, boardPath, change, action = 'changing the board') {
    requireWritable();
    const doc = await ws.api.call('getDocument', {path: boardPath}), {columns, warnings} = boardColumns(readFrontmatter(doc.text).fields);
    if (warnings.length) {
      const answer = await promptUser('Rewrite the column list?', 'Some column entries cannot be read (' + warnings.join(' ') + ') Changing columns here writes the list without them. Correct them in the board article to keep them.', {ok: 'Rewrite columns'});
      if (answer.action !== 'ok') return false;
    }
    const next = await change(columns.map(column => ({...column})));
    if (!next) return false;
    return writeArticles(ws, [{path: boardPath, edit: text => setBoardColumns(text, next)}], action);
  }
  const askTitle = async (title, description, value, ok) => {const answer = await promptUser(title, description, {value, ok}); return answer.action === 'ok' ? answer.value.trim() : null;};
  async function addColumn(ws, boardPath, after = null) {
    const title = await askTitle('New column', 'Enter a column title. Weave gives the column a stable id; renaming the column later keeps its cards.', 'New column', 'Add column');
    if (!title) return;
    await editColumns(ws, boardPath, columns => {const at = after === null ? columns.length : columns.findIndex(column => column.id === after) + 1; columns.splice(at, 0, {id: columnId(title, columns.map(column => column.id)), title}); return columns;});
  }
  async function renameColumn(ws, boardPath, id) {
    const column = boardOf(ws, boardPath)?.columns.find(item => item.id === id);
    const title = await askTitle('Rename column', `Enter a new title. The column id “${id}” stays the same, so its cards do not change.`, column?.title || id, 'Rename');
    if (!title) return;
    await editColumns(ws, boardPath, columns => columns.map(item => item.id === id ? {...item, title} : item));
  }
  async function moveColumn(ws, boardPath, id, offset) {
    await editColumns(ws, boardPath, columns => {const from = columns.findIndex(column => column.id === id), to = from + offset; if (from < 0 || to < 0 || to >= columns.length) return null; columns.splice(to, 0, columns.splice(from, 1)[0]); return columns;});
  }
  async function deleteColumn(ws, boardPath, id) {
    const model = await ws.api.call('kanbanBoard', {path: boardPath}), lanes = boardLanes(model).lanes, at = lanes.findIndex(lane => lane.id === id), lane = lanes[at];
    if (!lane) return;
    const neighbour = lanes[at - 1] || lanes[at + 1];
    if (!lane.cards.length) {
      const answer = await promptUser(`Delete column “${lane.title}”?`, 'The column is empty. It is removed from the board article.', {ok: 'Delete column'});
      if (answer.action === 'ok') await editColumns(ws, boardPath, columns => columns.filter(column => column.id !== id));
      return;
    }
    const answer = await promptUser(`Delete column “${lane.title}”?`, `${lane.cards.length} ${lane.cards.length === 1 ? 'card is' : 'cards are'} in this column.` + (neighbour ? ` Move ${lane.cards.length === 1 ? 'it' : 'them'} to “${neighbour.title}” first, or keep the cards as written: they then show under Needs attention until you place them.` : ' Their column is kept as written, so they show under Needs attention until you place them.'), {ok: neighbour ? `Move to ${neighbour.title} and delete` : 'Delete column', secondary: neighbour ? 'Delete and keep cards as written' : undefined});
    if (answer.action === 'cancel') return;
    if (answer.action === 'ok' && neighbour) {
      const base = neighbour.cards.at(-1)?.rank, start = Number.isFinite(base) ? Math.floor(base) : 0;
      const moved = await writeArticles(ws, lane.cards.map((card, i) => ({path: card.path, edit: text => setCardFields(text, {column: neighbour.id, rank: start + (i + 1) * 1000})})), 'moving cards');
      if (!moved) return;
    }
    await editColumns(ws, boardPath, columns => columns.filter(column => column.id !== id));
  }
  /** A new card article in the board's folder (or a folder named after the board). */
  async function addCard(ws, boardPath, column) {
    requireWritable();
    const title = await askTitle('New card', 'Enter the card title. The card is a new Markdown article; write its details there.', 'New card', 'Add card');
    if (!title) return;
    const name = safeName(title); if (!name) throw new Error('Enter a title with letters or numbers.');
    const board = boardOf(ws, boardPath) || (await ws.api.call('kanbanBoard', {path: boardPath})).board;
    const folder = setting('kanban-card-location') === 'subfolder' ? join(folderOf(boardPath), filename(boardPath).replace(/\.md$/i, '')) : folderOf(boardPath);
    if (folder && !ws.index.isFolder(folder)) await ws.api.call('create', {path: folder, folder: true});
    const path = join(folder, name + '.md');
    if (ws.index.find(path)) throw new Error(`${path} already exists. Use Add to Kanban board on that article, or choose another title.`);
    const lane = boardLanes(await ws.api.call('kanbanBoard', {path: boardPath})).lanes.find(item => item.id === column);
    const plan = planMove(lane?.cards || [], Infinity, path), own = plan.find(item => item.path === path);
    await ws.api.call('create', {path, text: stampArticle(cardText(title, {board: boardValue(board), column, rank: own.rank}))});
    const others = plan.filter(item => item.path !== path);
    if (others.length) await writeArticles(ws, others.map(item => ({path: item.path, edit: text => setCardFields(text, {rank: item.rank})})), 'adding the card');
    else await refreshWorkspace(ws);
    await showPreview(ws, path);
    message(`Added “${title}”: ${path}`);
  }
  async function createBoard(ws, folder = '') {
    requireWritable();
    if (!ws) throw new Error('Open a workspace first.');
    const title = await askTitle('New Kanban board', 'Enter a board name. The board is a Markdown article (type: Kanban Board) in ' + (folder ? '“' + folder + '”' : ctx.multi() ? 'the root of ' + ctx.workspaceName(ws) : 'the workspace root') + '. Board names must be unique in a workspace.', 'New board', 'Create board');
    if (!title) return;
    const name = safeName(title); if (!name) throw new Error('Enter a name with letters or numbers.');
    const path = join(folder, name + '.md'), clash = boards(ws).find(board => fold(ws, board.name) === fold(ws, name + '.md'));
    if (clash) throw new Error(`A board named “${clash.name}” already exists (${clash.path}). Board names must be unique in a workspace; choose another name.`);
    if (ws.index.find(path)) throw new Error(path + ' already exists.');
    const titles = (prefs.get('kanban-default-columns') || DEFAULT_COLUMNS.join(', ')).split(',');
    await ws.api.call('create', {path, text: stampArticle(boardText(title, columnsFromTitles(titles).length ? columnsFromTitles(titles) : columnsFromTitles(DEFAULT_COLUMNS)))});
    for (const parts = path.split('/').slice(0, -1); parts.length; parts.pop()) ws.expanded.add(parts.join('/'));
    await refreshWorkspace(ws);
    await ctx.openNote(path, null, {ws});
    message(`Board created: ${path}. Add cards with + or right-click any article › Add to Kanban board.`);
  }
  /** Asks for a board and column (Add to Kanban board…). */
  async function chooseBoard(ws, path, {title = 'Add to Kanban board', ok = 'Add card'} = {}) {
    const list = boards(ws).filter(board => board.path !== path);
    if (!list.length) throw new Error('This workspace has no Kanban boards. Right-click a folder and choose New Kanban board here.');
    const label = board => board.title + (board.duplicates.length || board.title !== board.name.replace(/\.md$/i, '') ? ' — ' + board.path : '');
    const card = cardOf(ws, path), initial = list.find(board => board.path === card?.boardPath) || list.find(board => board.path === preview?.board) || list[0];
    const columnsOf = boardPath => (list.find(board => board.path === boardPath)?.columns || []).map(column => ({value: column.id, label: column.title}));
    const answer = await promptUser(title, 'Choose the board and column. Weave writes them to the article’s frontmatter (weave.kanban).', {ok, choices: [
      {label: 'Board', options: list.map(board => ({value: board.path, label: label(board)})), value: initial.path},
      {label: 'Column', options: columnsOf(initial.path), value: card?.boardPath === initial.path && card.column ? card.column : columnsOf(initial.path)[0]?.value, dependsOn: 0, optionsFor: columnsOf},
    ]});
    if (answer.action !== 'ok') return null;
    const [boardPath, column] = answer.choices;
    if (!column) throw new Error('That board has no columns yet. Open it and add a column first.');
    return {boardPath, column};
  }
  async function addToBoard(ws, path) {
    requireWritable();
    const chosen = await chooseBoard(ws, path); if (!chosen) return;
    await assignCard(ws, path, chosen.boardPath, chosen.column);
    message(`Added to ${boardOf(ws, chosen.boardPath)?.title || chosen.boardPath}.`);
  }

  // Opening cards and boards.
  async function openCard(ws, card, event, pane = ctx.focusedPane()) {
    if (!ws || !card) return;
    const inTab = (setting('kanban-open') === 'tab') !== !!(event?.ctrlKey || event?.metaKey);
    if (inTab) {await ctx.openNote(card.path, null, {ws}); return;}
    await showPreview(ws, card.path, pane);
  }
  async function showPreview(ws, path) {
    preview = {ws, path};
    for (const view of ctx.panes.map(pane => pane.el['kanban-view'])) for (const node of view.querySelectorAll('.kanban-card')) node.classList.toggle('selected', node.dataset.card === path);
    ctx.sidebars().select('right', 'card');
    await renderPreview();
  }
  async function openBoard(ws, path, {tab = false, side = false} = {}) {
    const key = ctx.draftKey(ws.key, path); documentMode.delete(key);
    if (side) await ctx.openToSide(path, {ws});
    else await ctx.openNote(path, null, {ws, ...(tab ? {tabId: null} : {})});
  }
  async function openBoardArticle(ws, path) {documentMode.add(ctx.draftKey(ws.key, path)); await ctx.openNote(path, null, {ws}); for (const pane of ctx.shownPanes()) update(pane);}
  async function renderPreview() {
    const box = $('card-preview');
    if (!preview || !ctx.workspaces().includes(preview.ws)) {box.innerHTML = '<p class="hint">Click a card on a Kanban board to read it here.</p>'; return;}
    const {ws, path} = preview, serial = ++previewSerial;
    let doc;
    try {doc = await ws.api.call('getDocument', {path});}
    catch {if (serial === previewSerial) box.innerHTML = `<p class="hint">${esc(path)} was moved or deleted.</p>`; return;}
    if (serial !== previewSerial) return;
    const {fields, body} = readFrontmatter(doc.text), reference = cardReference(fields), card = cardOf(ws, path), board = card?.boardPath ? boardOf(ws, card.boardPath) : null;
    preview.board = board?.path || null;
    const canWrite = writable(), list = boards(ws).filter(item => item.path !== path);
    const boardOptions = '<option value="">Not on a board</option>' + (reference && !board ? `<option value="__current" selected>“${esc(reference.board)}” (${card?.status === 'ambiguous-board' ? 'several boards' : 'not found'})</option>` : '') + list.map(item => `<option value="${esc(item.path)}" ${board?.path === item.path ? 'selected' : ''}>${esc(item.title + (item.duplicates.length ? ' — ' + item.path : ''))}</option>`).join('');
    const columns = board?.columns || [], known = columns.some(column => column.id === reference?.column);
    const columnOptions = (reference?.column && !known ? `<option value="__current" selected>“${esc(reference.column)}” (unknown)</option>` : !reference?.column && board ? '<option value="__current" selected>No column</option>' : '') + columns.map(column => `<option value="${esc(column.id)}" ${column.id === reference?.column ? 'selected' : ''}>${esc(column.title)}</option>`).join('');
    const problem = card && card.status !== 'ok' ? cardProblem(card) : '';
    const tags = Array.isArray(fields.tags) ? fields.tags.filter(tag => typeof tag === 'string') : [];
    box.innerHTML = `<div class="card-preview" data-ws="${esc(ws.key)}"><div class="card-preview-head"><span class="kanban-eyebrow">${board ? esc(board.title) : 'Article'}</span><h2>${esc(card?.title || doc.title || filename(path))}</h2><small>${esc(path)}</small>${typeof fields.description === 'string' && fields.description.trim() ? `<p class="card-preview-description">${esc(fields.description.trim())}</p>` : ''}${tags.length ? `<div class="kanban-card-tags">${tags.map(tag => `<span>#${esc(tag)}</span>`).join('')}</div>` : ''}</div>`
      + `<div class="card-preview-actions"><button type="button" data-card-action="open-side" title="Open the article beside the board">Open to the side</button><button type="button" data-card-action="open-tab">New tab</button><button type="button" data-card-action="open">Open here</button></div>`
      + `<div class="card-preview-fields"><label>Board<select data-card-field="board" ${canWrite ? '' : 'disabled'}>${boardOptions}</select></label><label>Column<select data-card-field="column" ${canWrite && board ? '' : 'disabled'}>${columnOptions}</select></label></div>`
      + (problem ? `<p class="kanban-notice warning">${esc(problem)}. The card's frontmatter is kept as written; choose a ${card.status.endsWith('board') ? 'board' : 'column'} to correct it.</p>` : '')
      + `<div class="card-preview-body evidence-passage">${renderNote(body, ws.index, ws.catalog.caseSensitive, new Map(), path, {titles: ctx.titles(ws), underline: ctx.underlineEnabled()}) || '<p class="hint">This card has no text yet.</p>'}</div></div>`;
    for (const node of box.querySelectorAll('[data-open]')) node.dataset.ws = ws.key;
    hydrateMermaid(box);
  }
  $('card-preview').addEventListener('click', event => {
    const button = event.target.closest('[data-card-action]'); if (!button || !preview) return;
    const {ws, path} = preview;
    ctx.run(async () => {
      if (button.dataset.cardAction === 'open-side') await ctx.openToSide(path, {ws});
      else await ctx.openNote(path, null, {ws, ...(button.dataset.cardAction === 'open-tab' ? {tabId: null} : {})});
    })();
  });
  $('card-preview').addEventListener('change', event => {
    const field = event.target.closest('[data-card-field]'); if (!field || !preview) return;
    const {ws, path} = preview;
    ctx.run(async () => {
      try {
        if (field.dataset.cardField === 'board') {
          if (field.value === '') await removeCard(ws, path);
          else if (field.value !== '__current') {const column = boardOf(ws, field.value)?.columns[0]?.id; if (!column) throw new Error('That board has no columns yet.'); await assignCard(ws, path, field.value, column);}
        } else if (field.value !== '__current' && preview.board) await assignCard(ws, path, preview.board, field.value, Infinity, {keepReference: true});
      } finally {await renderPreview();}
    })();
  });

  // Context menus.
  function showMenu(event, items) {
    const menu = $('kanban-menu');
    menuItems = items.filter(Boolean);
    menu.innerHTML = menuItems.map((item, index) => item === '-' ? '<div class="context-separator" role="separator"></div>' : item.heading ? `<div class="context-label">${esc(item.heading)}</div>` : `<button role="menuitem" data-kanban-item="${index}" class="${item.indent ? 'kanban-menu-indent' : ''}" ${item.disabled ? 'disabled' : ''}${item.checked ? ' aria-checked="true"' : ''}>${esc(item.label)}${item.kbd ? `<kbd>${esc(item.kbd)}</kbd>` : ''}</button>`).join('');
    menu.hidden = false;
    menu.style.left = Math.max(0, Math.min(event.clientX, innerWidth - menu.offsetWidth)) + 'px'; menu.style.top = Math.max(0, Math.min(event.clientY, innerHeight - menu.offsetHeight)) + 'px';
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  const hideMenu = () => {$('kanban-menu').hidden = true;};
  $('kanban-menu').addEventListener('click', event => {const button = event.target.closest('[data-kanban-item]'); if (!button) return; hideMenu(); const item = menuItems[Number(button.dataset.kanbanItem)]; if (item?.run) ctx.run(item.run)();});
  $('kanban-menu').addEventListener('keydown', event => {
    const items = [...$('kanban-menu').querySelectorAll('button:not(:disabled)')], index = items.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();}
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); hideMenu();}
  });
  document.addEventListener('click', event => {if (!event.target.closest('#kanban-menu')) hideMenu();}, true);
  document.addEventListener('contextmenu', event => {if (!event.target.closest('#kanban-menu')) hideMenu();}, true);
  function cardItems(ws, card, {boardPath = null, column = null} = {}) {
    const canWrite = writable(), board = boardPath ? boardOf(ws, boardPath) : card.boardPath ? boardOf(ws, card.boardPath) : null, placed = card.status === 'ok' && board;
    const lane = placed && column ? board.columns.find(item => item.id === column) : null;
    return [
      {label: 'Preview in sidebar', run: () => showPreview(ws, card.path)},
      {label: 'Open', run: () => ctx.openNote(card.path, null, {ws})},
      {label: 'Open in new tab', run: () => ctx.openNote(card.path, null, {ws, tabId: null})},
      {label: ctx.sideLabel(), run: () => ctx.openToSide(card.path, {ws})},
      ...board?.columns.length && canWrite ? ['-', {heading: 'Move to'}, ...board.columns.map(item => ({label: item.title, indent: true, disabled: placed && card.column === item.id, run: () => assignCard(ws, card.path, board.path, item.id, Infinity, {keepReference: card.status !== 'ambiguous-board' && card.status !== 'missing-board'})}))] : [],
      ...lane && canWrite ? [{label: 'Move to top of column', run: () => assignCard(ws, card.path, board.path, lane.id, 0, {keepReference: true})}, {label: 'Move to bottom of column', run: () => assignCard(ws, card.path, board.path, lane.id, Infinity, {keepReference: true})}] : [],
      '-',
      canWrite && {label: board ? 'Move to another board…' : 'Assign to a board…', run: () => addToBoard(ws, card.path)},
      canWrite && {label: 'Remove from board', run: () => removeCard(ws, card.path)},
      {label: 'Show in Files', run: () => ctx.revealInFiles(ws, card.path)},
      canWrite && ctx.editing() && {label: 'Delete article…', run: () => ctx.deleteEntry(ws, card.path)},
    ];
  }
  function boardItems(ws, boardPath, {inView = false} = {}) {
    const canWrite = writable();
    return [
      ...inView ? [] : [{label: 'Open board', run: () => openBoard(ws, boardPath)}, {label: 'Open board in new tab', run: () => openBoard(ws, boardPath, {tab: true})}, {label: ctx.sideLabel(), run: () => openBoard(ws, boardPath, {side: true})}],
      {label: 'Open board as article', run: () => openBoardArticle(ws, boardPath)},
      canWrite && '-',
      canWrite && {label: 'Add column…', run: () => addColumn(ws, boardPath)},
      canWrite && ctx.editing() && {label: 'Rename board file…', run: () => ctx.renameEntry(ws, boardPath)},
      '-',
      {label: 'Show in Files', run: () => ctx.revealInFiles(ws, boardPath)},
    ];
  }
  function boardMenu(pane, event, target) {
    const ws = ctx.paneWs(pane), model = viewOf(pane).model; if (!ws || !model) return;
    const boardPath = model.board.path, canWrite = writable();
    if (target.type === 'card') {showMenu(event, cardItems(ws, {...target.card, boardPath: target.card.status === 'ok' ? boardPath : null}, {boardPath, column: target.column})); return;}
    if (target.type === 'column') {
      const columns = model.board.columns, at = columns.findIndex(column => column.id === target.column);
      showMenu(event, canWrite ? [
        {label: 'Add card', run: () => addCard(ws, boardPath, target.column)},
        '-',
        {label: 'Rename column…', run: () => renameColumn(ws, boardPath, target.column)},
        {label: 'Add column after…', run: () => addColumn(ws, boardPath, target.column)},
        {label: 'Move column left', disabled: at <= 0, run: () => moveColumn(ws, boardPath, target.column, -1)},
        {label: 'Move column right', disabled: at >= columns.length - 1, run: () => moveColumn(ws, boardPath, target.column, 1)},
        '-',
        {label: 'Delete column…', run: () => deleteColumn(ws, boardPath, target.column)},
      ] : [{label: 'Column id: ' + target.column, disabled: true}]);
      return;
    }
    showMenu(event, [...canWrite && model.board.columns.length ? [{label: 'Add card to ' + model.board.columns[0].title, run: () => addCard(ws, boardPath, model.board.columns[0].id)}] : [], ...boardItems(ws, boardPath, {inView: true}), {label: 'Refresh board', run: () => load(pane)}]);
  }
  async function boardAction(pane, name, {column, path, event} = {}) {
    const ws = ctx.paneWs(pane), model = viewOf(pane).model; if (!ws || !model) return;
    if (name === 'add-card') await addCard(ws, model.board.path, column);
    if (name === 'add-column') await addColumn(ws, model.board.path);
    if (name === 'column-menu') {const box = event.target.getBoundingClientRect(); boardMenu(pane, {clientX: box.left, clientY: box.bottom}, {type: 'column', column});}
    if (name === 'document') {documentMode.add(ctx.docKey(ctx.paneActive(pane))); update(pane);}
    if (name === 'refresh') {await refreshWorkspace(ws); await load(pane);}
    if (name === 'rename-board') await ctx.renameEntry(ws, model.board.path);
    if (name === 'open-board') await openBoard(ws, path);
  }

  // The Kanban sidebar: boards per workspace, duplicate names and cards whose board is unknown.
  function renderBadge() {
    const total = ctx.workspaces().reduce((sum, ws) => sum + (ws.kanban?.cards.filter(card => card.status !== 'ok').length || 0), 0), badge = $('kanban-attention-badge');
    badge.textContent = String(total); badge.hidden = !total;
    badge.parentElement.title = total ? `Kanban boards · ${total} ${total === 1 ? 'card needs' : 'cards need'} attention` : 'Kanban boards';
  }
  function renderSidebar() {
    if (!ctx.sidebars()?.visible('kanban')) return;
    const list = ctx.workspaces(), here = ctx.paneActive(ctx.focusedPane());
    $('kanban-new-board').disabled = !writable() || !list.length;
    $('kanban-boards').innerHTML = list.map(ws => {
      const summary = ws.kanban, all = summary?.boards || [], names = new Map();
      for (const board of all) if (board.duplicates.length) names.set(fold(ws, board.name), [...names.get(fold(ws, board.name)) || [], board]);
      // Cards naming a shared filename are counted with their duplicate boards.
      const orphans = (summary?.cards || []).filter(card => card.status === 'missing-board');
      const waiting = group => (summary?.cards || []).filter(card => card.status === 'ambiguous-board' && group.some(board => card.candidates.includes(board.path))).length;
      return `<section class="kanban-ws" data-ws="${esc(ws.key)}" data-workspace-color="${ctx.workspaceColor(ws)}">${ctx.multi() ? `<h3 class="kanban-ws-title"><span class="workspace-dot" aria-hidden="true"></span>${esc(ctx.workspaceName(ws))}</h3>` : ''}`
        + (summary ? all.map(board => `<button type="button" class="kanban-sidebar-board${board.duplicates.length ? ' duplicate' : ''}${here && !here.external && here.ws === ws.key && here.path === board.path ? ' current' : ''}" data-kanban-board="${esc(board.path)}" title="${esc(board.path + (board.duplicates.length ? '\nAnother board has the same filename.' : ''))}"><span class="kanban-sidebar-title">${board.duplicates.length ? '<span class="kanban-warning-icon" aria-label="Duplicate name">⚠</span>' : ''}${esc(board.title)}</span><small>${esc(board.path)}</small><span class="kanban-sidebar-meta">${board.cards} ${board.cards === 1 ? 'card' : 'cards'}${board.attention ? ` · <strong>${board.attention} need attention</strong>` : ''}</span></button>`).join('') || '<p class="hint">No boards yet. Right-click a folder in Files and choose New Kanban board here.</p>' : '<p class="hint">Boards are not available for this workspace yet.</p>')
        + (names.size ? `<div class="kanban-issue"><h4>Duplicate board names</h4><p class="hint">Board names must be unique. Cards that name these boards by filename cannot be placed until all but one are renamed.</p>${[...names.values()].map(group => `<div class="kanban-issue-group"><strong>${esc(group[0].name)}</strong>${group.map(board => `<button type="button" class="wiki-link" data-kanban-board="${esc(board.path)}" title="Right-click to rename">${esc(board.path)}</button>`).join('')}${waiting(group) ? `<small>${waiting(group)} ${waiting(group) === 1 ? 'card is' : 'cards are'} waiting under Needs attention</small>` : ''}</div>`).join('')}</div>` : '')
        + (orphans.length ? `<div class="kanban-issue"><h4>Cards with an unknown board</h4><p class="hint">These articles name a board that does not exist. Their frontmatter is kept; right-click one to assign it to a board.</p>${orphans.map(card => `<button type="button" class="kanban-orphan" data-kanban-card="${esc(card.path)}" title="${esc(card.path)}"><span>${esc(card.title)}</span><small>${esc(cardProblem(card))}</small></button>`).join('')}</div>` : '')
        + '</section>';
    }).join('') || '<p class="hint">Open a workspace to see its Kanban boards.</p>';
  }
  const sidebarWs = node => ctx.wsByKey(node.closest('[data-ws]')?.dataset.ws);
  $('kanban-boards').addEventListener('click', event => {
    const ws = sidebarWs(event.target); if (!ws) return;
    const board = event.target.closest('[data-kanban-board]'), card = event.target.closest('[data-kanban-card]');
    if (board) ctx.run(() => openBoard(ws, board.dataset.kanbanBoard))();
    else if (card) ctx.run(() => showPreview(ws, card.dataset.kanbanCard))();
  });
  $('kanban-boards').addEventListener('contextmenu', event => {
    const ws = sidebarWs(event.target), board = event.target.closest('[data-kanban-board]'), card = event.target.closest('[data-kanban-card]');
    if (!ws || !board && !card) return;
    event.preventDefault();
    if (board) showMenu(event, boardItems(ws, board.dataset.kanbanBoard));
    else {const item = cardOf(ws, card.dataset.kanbanCard); if (item) showMenu(event, cardItems(ws, item));}
  });
  $('kanban-new-board').onclick = ctx.run(async () => {const {ws, folder} = ctx.selection(); await createBoard(ws, folder);});
  $('kanban-open-settings').onclick = () => ctx.settingsDialog().open('Kanban');

  // Files: right-click menu entries and board icons.
  const FILE_ACTIONS = ['open-board', 'open-board-article', 'show-card', 'preview-card', 'add-card', 'remove-card', 'new-board'];
  function fileMenu(ws, path, {folder = false, blank = false} = {}) {
    const article = !folder && !blank && /\.md$/i.test(path), board = article && !!boardOf(ws, path), card = article ? cardOf(ws, path) : null, canWrite = writable();
    return {'open-board': board, 'open-board-article': board, 'show-card': !!card?.boardPath, 'preview-card': !!card, 'add-card': article && !board && canWrite && !card, 'remove-card': !!card && canWrite, 'new-board': (folder || blank) && canWrite};
  }
  async function fileAction(action, ws, path, {folder = false} = {}) {
    if (action === 'open-board') await openBoard(ws, path);
    if (action === 'open-board-article') await openBoardArticle(ws, path);
    if (action === 'show-card') {const card = cardOf(ws, path); if (card?.boardPath) {await openBoard(ws, card.boardPath); await showPreview(ws, path);}}
    if (action === 'preview-card') await showPreview(ws, path);
    if (action === 'add-card') await addToBoard(ws, path);
    if (action === 'remove-card') await removeCard(ws, path);
    if (action === 'new-board') await createBoard(ws, folder ? path : '');
  }
  /** Board names must stay unique: renaming a board onto another board's name is refused. */
  function checkRename(ws, from, to) {
    const moving = boards(ws).filter(board => board.path === from || board.path.startsWith(from + '/'));
    for (const board of moving) {
      const next = to + board.path.slice(from.length), clash = boards(ws).find(other => !moving.includes(other) && fold(ws, other.name) === fold(ws, filename(next)));
      if (clash) throw new Error(`A board named “${clash.name}” already exists (${clash.path}). Board names must be unique in a workspace.`);
    }
  }
  /** Extra words for the delete confirmation of a board or a folder holding boards. */
  function deleteNote(ws, path) {
    const removed = boards(ws).filter(board => board.path === path || board.path.startsWith(path + '/'));
    const cards = (ws.kanban?.cards || []).filter(card => removed.some(board => card.boardPath === board.path) && !(card.path === path || card.path.startsWith(path + '/'))).length;
    return cards ? ` ${cards} ${cards === 1 ? 'card names' : 'cards name'} ${removed.length === 1 ? 'this board' : 'these boards'}; ${cards === 1 ? 'it keeps its' : 'they keep their'} frontmatter and ${cards === 1 ? 'appears' : 'appear'} in the Kanban sidebar under Cards with an unknown board.` : '';
  }

  // Settings (Control panel › Kanban).
  for (const [id, key, fallback] of SETTINGS) {
    $(id).checked = (prefs.get(key) ?? fallback) === 'true';
    $(id).onchange = () => {prefs.set(key, String($(id).checked)); refreshViews();};
  }
  for (const [id, key, fallback] of [['kanban-open', 'kanban-open', 'sidebar'], ['kanban-card-location', 'kanban-card-location', 'board'], ['kanban-column-width', 'kanban-column-width', '280']]) {
    $(id).value = prefs.get(key) ?? fallback;
    $(id).onchange = () => {prefs.set(key, $(id).value); refreshViews();};
  }
  $('kanban-default-columns').value = prefs.get('kanban-default-columns') || '';
  $('kanban-default-columns').placeholder = DEFAULT_COLUMNS.join(', ');
  $('kanban-default-columns').onchange = () => prefs.set('kanban-default-columns', $('kanban-default-columns').value.trim());
  function refreshViews() {for (const pane of ctx.panes) {const view = viewOf(pane); if (view.model) view.render(view.model, view.context);} renderSidebar(); void renderPreview();}

  return {
    update, updateAll, workspaceChanged, forget, renderSidebar, renderPreview, writable, createBoard, refreshViews,
    boardShown, fileMenu, fileAction, checkRename, deleteNote, hideMenu, dropTarget, boardAt, clearDrops, dropArticle,
    /** Whether a board in `ws` already has the filename `name`. */
    boardNamed: (ws, name) => boards(ws).some(board => fold(ws, board.name) === fold(ws, name)),
    fileActions: new Set(FILE_ACTIONS),
    isBoard: (ws, path) => !!boardOf(ws, path),
    isCard: (ws, path) => !!cardOf(ws, path),
  };
}
