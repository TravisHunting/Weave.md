import {esc} from './render.mjs';
import {compareCards} from './kanban.mjs';
// The board view: columns in board order, cards ordered by rank, and a
// "Needs attention" lane for cards the board cannot place (unknown or missing
// column, or a filename that several boards share). Cards move with pointer
// events, because the desktop host's native file-drop handling stops HTML5
// drag events in WebView2. A drag never also clicks; Escape cancels it.

const PROBLEMS = {
  'unknown-column': card => `Unknown column “${card.column}”`,
  'no-column': () => 'No column',
  'ambiguous-board': card => `Several boards are named “${card.board}”`,
  'missing-board': card => `No board named “${card.board}”`,
};
export const cardProblem = card => PROBLEMS[card.status]?.(card) || '';
/** Columns with their placed cards in display order, and the cards needing attention. */
export function boardLanes(model) {
  const lanes = model.board.columns.map(column => ({...column, cards: model.cards.filter(card => card.status === 'ok' && card.column === column.id).sort(compareCards)}));
  return {lanes, attention: model.cards.filter(card => card.status !== 'ok').sort(compareCards)};
}
const folderOf = path => path.split('/').slice(0, -1).join('/');

export function createBoardView(container, {canMove, onOpen, onMove, onMenu, onAction, settings, selected = () => null}) {
  let model = null, drag = null, context = {};
  function cardHtml(card, attention) {
    const options = settings(), folder = folderOf(card.path), problem = attention ? cardProblem(card) : '';
    return `<div class="kanban-card${selected() === card.path ? ' selected' : ''}${problem ? ' kanban-problem' : ''}" data-card="${esc(card.path)}" tabindex="0" role="button" aria-label="${esc(card.title + (problem ? ', ' + problem : ''))}" title="${esc(card.path + (canMove() ? '\nDrag to move. Ctrl+arrow keys move it with the keyboard.' : ''))}">`
      + `<div class="kanban-card-title">${esc(card.title)}</div>`
      + (options.showDescription && card.description ? `<p class="kanban-card-description">${esc(card.description)}</p>` : '')
      + (options.showTags && card.tags?.length ? `<div class="kanban-card-tags">${card.tags.map(tag => `<span>#${esc(tag)}</span>`).join('')}</div>` : '')
      + (options.showFolder && folder ? `<small class="kanban-card-folder">${esc(folder)}</small>` : '')
      + (problem ? `<span class="kanban-card-issue">${esc(problem)}</span>` : '')
      + '</div>';
  }
  function laneHtml(lane, attention = false) {
    const writable = canMove();
    return `<section class="kanban-lane${attention ? ' kanban-attention' : ''}" data-column="${attention ? '' : esc(lane.id)}" aria-label="${esc(lane.title)}">`
      + `<div class="kanban-lane-head"${attention ? '' : ` title="${esc('Column id: ' + lane.id)}"`}><h2 class="kanban-lane-title">${esc(lane.title)}</h2><span class="kanban-count">${lane.cards.length}</span>`
      + (attention || !writable ? '' : `<button type="button" class="kanban-lane-add" data-kanban-action="add-card" data-column="${esc(lane.id)}" title="Add a card to ${esc(lane.title)}" aria-label="Add a card to ${esc(lane.title)}">+</button>`)
      + (attention ? '' : `<button type="button" class="kanban-lane-menu" data-kanban-action="column-menu" data-column="${esc(lane.id)}" title="Column actions" aria-label="Actions for ${esc(lane.title)}">⋯</button>`)
      + `</div>`
      + (attention ? '<p class="kanban-attention-hint">These cards are kept as written. Drag one to a column, or right-click it, to correct its assignment.</p>' : '')
      + `<div class="kanban-cards" data-lane="${attention ? '' : esc(lane.id)}">${lane.cards.map(card => cardHtml(card, attention)).join('') || `<p class="kanban-empty">${writable ? 'No cards. Drop a card here or use +.' : 'No cards'}</p>`}</div>`
      + (attention || !writable ? '' : `<button type="button" class="kanban-add-card" data-kanban-action="add-card" data-column="${esc(lane.id)}">+ Add card</button>`)
      + '</section>';
  }
  function notices() {
    const board = model.board, list = [];
    if (board.duplicates.length) list.push(`<div class="kanban-notice warning" role="alert"><strong>Duplicate board name.</strong> ${esc(board.duplicates.length === 1 ? 'Another board is' : board.duplicates.length + ' other boards are')} also named “${esc(board.name)}”: ${board.duplicates.map(path => `<button type="button" class="wiki-link" data-kanban-board-link="${esc(path)}">${esc(path)}</button>`).join(', ')}. Board names must be unique, so cards that name the board by filename cannot be placed until one is renamed. ${canMove() ? '<button type="button" data-kanban-action="rename-board">Rename this board…</button>' : ''}</div>`);
    for (const warning of board.warnings) list.push(`<div class="kanban-notice">${esc(warning)} Edit the board's frontmatter to correct it.</div>`);
    if (!board.columns.length) list.push(`<div class="kanban-notice">This board has no columns yet.${canMove() ? ' <button type="button" data-kanban-action="add-column">Add a column</button>' : ''}</div>`);
    return list.join('');
  }
  let drawn = '', pending = null;
  function render(next, extra = {}) {
    // A board drawn again mid-drag would detach the dragged card: draw it after the drop.
    if (drag?.active) {pending = [next, extra]; return;}
    // Unchanged boards are not redrawn, so background refreshes do not disturb them.
    const signature = JSON.stringify([next, settings(), canMove(), selected()]);
    if (signature === drawn && container.querySelector('.kanban-board')) {model = next; context = extra; return;}
    drawn = signature;
    // Keep the board's scroll positions when it is drawn again.
    const lanesBox = container.querySelector('.kanban-lanes'), scrolls = {left: lanesBox?.scrollLeft || 0, lanes: Object.fromEntries([...container.querySelectorAll('.kanban-lane')].map(lane => [lane.dataset.column, lane.querySelector('.kanban-cards').scrollTop]))};
    const same = model?.board.path === next.board.path;
    model = next; context = extra;
    const {lanes, attention} = boardLanes(model), placed = lanes.reduce((sum, lane) => sum + lane.cards.length, 0), writable = canMove();
    container.innerHTML = `<div class="kanban-board" data-board="${esc(model.board.path)}">`
      + `<div class="kanban-head"><div class="kanban-heading"><span class="kanban-eyebrow">Kanban board</span><h1 class="kanban-board-title">${esc(model.board.title)}</h1><small class="kanban-board-meta">${esc(model.board.path)} · ${placed} ${placed === 1 ? 'card' : 'cards'}${attention.length ? ' · ' + attention.length + ' need attention' : ''}</small></div>`
      + `<div class="kanban-tools">${writable ? '<button type="button" data-kanban-action="add-column" title="Add a column at the end of the board">+ Column</button>' : ''}<button type="button" data-kanban-action="document" title="Show the board's Markdown article">Article</button><button type="button" data-kanban-action="refresh" title="Read the board again" aria-label="Refresh board">↻</button></div></div>`
      + notices()
      // Cards the board cannot place come first, so they are seen rather than scrolled past.
      + `<div class="kanban-lanes">${attention.length ? laneHtml({title: 'Needs attention', cards: attention}, true) : ''}${lanes.map(lane => laneHtml(lane)).join('')}</div></div>`;
    container.style.setProperty('--kanban-column-width', settings().columnWidth + 'px');
    if (same) {
      container.querySelector('.kanban-lanes').scrollLeft = scrolls.left;
      for (const lane of container.querySelectorAll('.kanban-lane')) {const top = scrolls.lanes[lane.dataset.column]; if (top) lane.querySelector('.kanban-cards').scrollTop = top;}
    }
  }
  const cardAt = path => model?.cards.find(card => card.path === path);
  // Pointer dragging between and within columns.
  function laneAt(x, y) {
    const lane = document.elementFromPoint(x, y)?.closest('.kanban-lane');
    return lane && container.contains(lane) && lane.dataset.column ? lane : null;
  }
  function indexAt(lane, y) {
    return [...lane.querySelectorAll('.kanban-card:not(.dragging)')].filter(node => {const box = node.getBoundingClientRect(); return box.top + box.height / 2 < y;}).length;
  }
  function placeMarker(lane, index) {
    drag.marker ||= Object.assign(document.createElement('div'), {className: 'kanban-drop-marker'});
    if (!lane) {drag.marker.remove(); return;}
    const cards = [...lane.querySelectorAll('.kanban-card:not(.dragging)')], list = lane.querySelector('.kanban-cards');
    list.querySelector('.kanban-empty')?.classList.add('hidden-by-drag');
    list.insertBefore(drag.marker, cards[index] || null);
  }
  function autoScroll(x, y) {
    cancelAnimationFrame(drag.frame);
    const lanesBox = container.querySelector('.kanban-lanes'), box = lanesBox.getBoundingClientRect(), list = laneAt(x, y)?.querySelector('.kanban-cards'), inner = list?.getBoundingClientRect();
    const dx = x < box.left + 40 ? -14 : x > box.right - 40 ? 14 : 0, dy = inner ? (y < inner.top + 30 ? -12 : y > inner.bottom - 30 ? 12 : 0) : 0;
    if (!dx && !dy) return;
    const step = () => {if (!drag?.active) return; lanesBox.scrollLeft += dx; if (list) list.scrollTop += dy; drag.frame = requestAnimationFrame(step);};
    drag.frame = requestAnimationFrame(step);
  }
  function endDrag() {
    if (!drag) return;
    cancelAnimationFrame(drag.frame);
    if (drag.active) {drag.ghost?.remove(); drag.marker?.remove(); drag.node.classList.remove('dragging'); document.body.classList.remove('kanban-dragging'); for (const node of container.querySelectorAll('.hidden-by-drag, .drop-target')) node.classList.remove('hidden-by-drag', 'drop-target'); try {container.releasePointerCapture(drag.pointer);} catch {}}
    drag = null;
    if (pending) {const [next, extra] = pending; pending = null; queueMicrotask(() => render(next, extra));}
  }
  container.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag || !canMove()) return;
    const node = event.target.closest('.kanban-card'); if (!node || !container.contains(node)) return;
    drag = {path: node.dataset.card, node, x: event.clientX, y: event.clientY, pointer: event.pointerId, active: false};
  });
  container.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
      drag.active = true; container.setPointerCapture(event.pointerId); document.body.classList.add('kanban-dragging');
      const box = drag.node.getBoundingClientRect(), ghost = drag.ghost = drag.node.cloneNode(true);
      ghost.classList.add('kanban-ghost'); ghost.removeAttribute('tabindex'); ghost.style.setProperty('width', box.width + 'px');
      drag.offset = {x: event.clientX - box.left, y: event.clientY - box.top}; document.body.append(ghost); drag.node.classList.add('dragging');
    }
    drag.ghost.style.setProperty('left', event.clientX - drag.offset.x + 'px'); drag.ghost.style.setProperty('top', event.clientY - drag.offset.y + 'px');
    const lane = laneAt(event.clientX, event.clientY);
    for (const node of container.querySelectorAll('.kanban-lane.drop-target')) if (node !== lane) node.classList.remove('drop-target');
    lane?.classList.add('drop-target');
    drag.target = lane ? {column: lane.dataset.column, index: indexAt(lane, event.clientY)} : null;
    drag.ghost.classList.toggle('blocked', !lane);
    placeMarker(lane, drag.target?.index);
    autoScroll(event.clientX, event.clientY);
  });
  container.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const done = drag; endDrag();
    if (!done.active) return;
    suppressClick(container);
    const card = cardAt(done.path), target = done.target;
    if (!card || !target) return;
    // Dropping a card where it already is changes nothing.
    const {lanes} = boardLanes(model), lane = lanes.find(item => item.id === target.column), from = lane?.cards.findIndex(item => item.path === card.path) ?? -1;
    if (from >= 0 && card.status === 'ok' && from === target.index) return;
    onMove({card, column: target.column, index: target.index, element: done.node});
  });
  container.addEventListener('pointercancel', endDrag);
  // An article dragged from Files: the lane under the pointer and the drop
  // position are marked as for a card, and returned as {column, index}.
  let external = null;
  function clearExternal() {
    if (!external) return;
    external.remove(); external = null;
    for (const node of container.querySelectorAll('.hidden-by-drag, .drop-target')) node.classList.remove('hidden-by-drag', 'drop-target');
  }
  function externalAt(x, y) {
    const lane = model && canMove() && !drag ? laneAt(x, y) : null;
    if (!lane) {clearExternal(); return null;}
    for (const node of container.querySelectorAll('.kanban-lane.drop-target')) if (node !== lane) node.classList.remove('drop-target');
    for (const node of container.querySelectorAll('.hidden-by-drag')) if (!lane.contains(node)) node.classList.remove('hidden-by-drag');
    lane.classList.add('drop-target');
    external ||= Object.assign(document.createElement('div'), {className: 'kanban-drop-marker'});
    const index = indexAt(lane, y), list = lane.querySelector('.kanban-cards');
    list.querySelector('.kanban-empty')?.classList.add('hidden-by-drag');
    list.insertBefore(external, [...lane.querySelectorAll('.kanban-card')][index] || null);
    return {column: lane.dataset.column, index};
  }
  document.addEventListener('keydown', event => {if (event.key === 'Escape' && drag?.active) {event.preventDefault(); event.stopPropagation(); endDrag();}}, true);
  container.addEventListener('click', event => {
    if (!model) return;
    const action = event.target.closest('[data-kanban-action]');
    if (action) {onAction(action.dataset.kanbanAction, {column: action.dataset.column, event}); return;}
    const link = event.target.closest('[data-kanban-board-link]'); if (link) {onAction('open-board', {path: link.dataset.kanbanBoardLink, event}); return;}
    const node = event.target.closest('.kanban-card'); if (node) onOpen(cardAt(node.dataset.card), event);
  });
  container.addEventListener('contextmenu', event => {
    if (!model) return;
    const node = event.target.closest('.kanban-card'), lane = event.target.closest('.kanban-lane');
    event.preventDefault();
    if (node) onMenu(event, {type: 'card', card: cardAt(node.dataset.card), column: lane?.dataset.column || null});
    else if (lane?.dataset.column && event.target.closest('.kanban-lane-head, .kanban-empty, .kanban-cards, .kanban-add-card')) onMenu(event, {type: 'column', column: lane.dataset.column});
    else onMenu(event, {type: 'board'});
  });
  // Keyboard: Enter opens; Ctrl+Left/Right moves a card between columns and
  // Ctrl+Up/Down within its column; the context-menu key opens its menu.
  container.addEventListener('keydown', event => {
    const node = event.target.closest?.('.kanban-card'); if (!node || !model) return;
    const card = cardAt(node.dataset.card);
    if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); onOpen(card, event); return;}
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {event.preventDefault(); const box = node.getBoundingClientRect(); onMenu({clientX: box.left + 12, clientY: box.bottom - 4, preventDefault() {}}, {type: 'card', card}); return;}
    if (!(event.ctrlKey || event.metaKey) || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !canMove()) return;
    event.preventDefault(); event.stopPropagation();
    const {lanes} = boardLanes(model), at = lanes.findIndex(lane => card.status === 'ok' && lane.id === card.column);
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (at < 0) return;
      const index = lanes[at].cards.findIndex(item => item.path === card.path) + (event.key === 'ArrowUp' ? -1 : 1);
      if (index < 0 || index >= lanes[at].cards.length) return;
      onMove({card, column: card.column, index, element: node, keyboard: true});
    } else {
      const next = at < 0 ? (event.key === 'ArrowRight' ? 0 : -1) : at + (event.key === 'ArrowLeft' ? -1 : 1);
      if (next < 0 || next >= lanes.length) return;
      onMove({card, column: lanes[next].id, index: lanes[next].cards.length, element: node, keyboard: true});
    }
  });
  return {
    render, get model() {return model;}, get context() {return context;}, externalAt, clearExternal,
    focusCard(path) {[...container.querySelectorAll('.kanban-card')].find(node => node.dataset.card === path)?.focus({preventScroll: false});},
    /** Draws the next model even when it equals the last (after an optimistic move failed). */
    invalidate() {drawn = '';},
    clear() {model = null; drawn = ''; endDrag(); clearExternal(); pending = null; container.replaceChildren();},
  };
}
function suppressClick(element) {
  const swallow = event => {event.stopImmediatePropagation(); event.preventDefault();};
  element.addEventListener('click', swallow, {capture: true, once: true});
  setTimeout(() => element.removeEventListener('click', swallow, {capture: true}), 0);
}
