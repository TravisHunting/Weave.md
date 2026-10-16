import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {NativeHarness} from './native-harness.mjs';
import {readFrontmatter} from '../okf.mjs';
import {boardColumns, cardReference, boardReference, kanbanSummary, kanbanBoard, planMove, rankBetween, setCardFields, removeCardFields, setBoardColumns, columnId, columnsFromTitles, boardText, cardText, compareCards, isBoardText, RANK_STEP} from '../kanban.mjs';

test('board columns and card references come from weave.kanban frontmatter', () => {
  const {columns, warnings} = boardColumns({weave: {kanban: {columns: [{id: 'todo', title: 'To do'}, 'Done', {title: 'No id'}, {id: 'todo'}, {id: 2}]}}});
  assert.deepEqual(columns, [{id: 'todo', title: 'To do'}, {id: 'Done', title: 'Done'}, {id: '2', title: '2'}]);
  assert.equal(warnings.length, 2);
  assert.deepEqual(cardReference({weave: {kanban: {board: ' Dev.md ', column: 'todo', rank: '2500.5'}}}), {board: 'Dev.md', column: 'todo', rank: 2500.5});
  assert.equal(cardReference({weave: {kanban: {column: 'todo'}}}), null, 'a card names its board');
  assert.deepEqual(boardReference('Dev', 'a/b.md', false), {byPath: false, key: 'dev.md'});
  assert.deepEqual(boardReference('../Boards/Dev.md', 'a/b.md'), {byPath: true, key: 'Boards/Dev.md'});
  assert.deepEqual(boardReference('/x/Dev.md', 'a/b.md'), {byPath: true, key: 'x/Dev.md'});
  assert.deepEqual(boardReference('../../Dev.md', 'a/b.md'), {byPath: true, key: null});
});

test('ranks stay sparse: one card changes per move until a column needs renumbering', () => {
  const card = (path, rank) => ({path, rank});
  assert.deepEqual(planMove([], 0, 'a'), [{path: 'a', rank: RANK_STEP}]);
  assert.deepEqual(planMove([card('b', 2000), card('c', 3000)], 1, 'a'), [{path: 'a', rank: 2500}]);
  assert.deepEqual(planMove([card('b', 2000)], 1, 'a'), [{path: 'a', rank: 3000}]);
  assert.deepEqual(planMove([card('b', 1000)], 0, 'a'), [{path: 'a', rank: 500}]);
  assert.deepEqual(planMove([card('b', 0.5)], 0, 'a'), [{path: 'a', rank: -999.5}]);
  // Repeated midpoint insertion keeps working, then renumbers only that column.
  let column = [card('x', 1000), card('y', 2000)], inserted = 0;
  for (; inserted < 40; inserted++) {
    const plan = planMove(column, 1, 'n' + inserted);
    if (plan.length > 1) break;
    column = [column[0], {path: 'n' + inserted, rank: plan[0].rank}, ...column.slice(1)];
  }
  assert(inserted >= 10, 'midpoints last for many insertions: ' + inserted);
  const rebalance = planMove(column, 1, 'last');
  assert.deepEqual(rebalance.find(item => item.path === 'last').rank, 2000);
  assert(rebalance.every(item => item.rank % RANK_STEP === 0));
  // A neighbour without a rank renumbers the column, writing only changed ranks.
  assert.deepEqual(planMove([card('b', 1000), card('c', null)], 2, 'a'), [{path: 'c', rank: 2000}, {path: 'a', rank: 3000}]);
  assert.equal(rankBetween(1, 1), null);
  assert.equal(rankBetween(1, 2), 1.5);
  assert.deepEqual([{title: 'b', rank: null, path: 'b'}, {title: 'a', rank: 5, path: 'a'}, {title: 'c', rank: 1, path: 'c'}].sort(compareCards).map(c => c.path), ['c', 'a', 'b']);
});

test('card and column edits keep comments, other keys and line endings', () => {
  const text = '---\r\ntype: Note # kept\r\nweave:\r\n  other: 1\r\n---\r\n# Card\r\n';
  const moved = setCardFields(text, {board: 'Dev.md', column: 'todo', rank: 2000});
  assert.match(moved, /type: Note # kept\r\n/);
  assert.deepEqual(readFrontmatter(moved).fields.weave, {other: 1, kanban: {board: 'Dev.md', column: 'todo', rank: 2000}});
  assert.ok(!/[^\r]\n/.test(moved), 'CRLF retained');
  assert.deepEqual(readFrontmatter(removeCardFields(moved)).fields.weave, {other: 1});
  assert.equal(readFrontmatter(removeCardFields(setCardFields('# Plain\n', {board: 'Dev.md'}))).fields.weave, undefined, 'empty maps are removed');
  assert.equal(readFrontmatter(setCardFields('# Plain\n', {board: 'Dev.md'})).fields.type, 'Note', 'an article without frontmatter gains OKF');
  const board = boardText('Dev [team]', columnsFromTitles(['To do', 'In progress', 'In progress']));
  assert.ok(isBoardText(board));
  assert.deepEqual(boardColumns(readFrontmatter(board).fields).columns, [{id: 'to-do', title: 'To do'}, {id: 'in-progress', title: 'In progress'}, {id: 'in-progress-2', title: 'In progress'}]);
  assert.match(board, /\n# Dev \\\[team\\\]\n/);
  assert.deepEqual(boardColumns(readFrontmatter(setBoardColumns(board, [{id: 'done', title: 'Done'}])).fields).columns, [{id: 'done', title: 'Done'}]);
  assert.equal(columnId('Ünder Review!', ['under-review']), 'under-review-2');
  assert.deepEqual(cardReference(readFrontmatter(cardText('New', {board: 'Dev.md', column: 'todo', rank: 3000})).fields), {board: 'Dev.md', column: 'todo', rank: 3000});
});

test('Rust indexes the same Kanban model as the browser reader', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-kanban-parity-')), root = path.join(temp, 'Notes');
  const files = {
    'Boards/Dev.md': '---\ntype: Kanban Board\ntitle: Development\nweave:\n  kanban:\n    columns:\n      - id: todo\n        title: Todo\n      - id: done\n      - Review\n      - {title: no id}\n---\n# Development\n',
    'Boards/Ops.md': '---\ntype: kanban board\n---\n# Operations\n',
    'Other/Ops.md': '---\ntype: Kanban Board\nweave:\n  kanban:\n    columns: nope\n---\n',
    'Work/A.md': '---\ntype: Note\ndescription: First card.\ntags: [alpha, beta, gamma, delta]\nupdated_at: 2026-10-08T10:00:00+13:00\nweave:\n  kanban:\n    board: Dev.md\n    column: todo\n    rank: 2000\n---\n# Card A\n',
    'Work/B.md': '---\nweave:\n  kanban:\n    board: dev\n    column: in-progres\n    rank: "1500.5"\n---\n',
    'Work/C.md': '---\nweave:\n  kanban:\n    board: ../Boards/Dev.md\n---\n# No column\n',
    'Work/D.md': '---\nweave:\n  kanban:\n    board: Ops.md\n    column: x\n---\n',
    'Work/E.md': '---\nweave:\n  kanban:\n    board: /Boards/Missing.md\n    column: todo\n---\n',
    'Work/F.md': '---\nweave:\n  kanban:\n    board: Dev.md\n    column: 2\n    rank: 7\n---\n',
    'Plain.md': '# Not on a board\n',
  };
  for (const [file, text] of Object.entries(files)) {await fs.mkdir(path.dirname(path.join(root, file)), {recursive: true}); await fs.writeFile(path.join(root, file), text);}
  const host = new NativeHarness(path.join(temp, '.weave'));
  t.after(async () => {await host.close(); await fs.rm(temp, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});});
  const catalog = await host.open(root), documents = Object.entries(files).map(([file, text]) => ({path: file, text})), options = {caseSensitive: catalog.caseSensitive};
  const native = await host.call('kanban'), reference = kanbanSummary(documents, options);
  assert.deepEqual(native, reference);
  assert.deepEqual(native.cards.map(card => [card.path, card.status]), [['Work/A.md', 'ok'], ['Work/B.md', catalog.caseSensitive ? 'missing-board' : 'unknown-column'], ['Work/C.md', 'no-column'], ['Work/D.md', 'ambiguous-board'], ['Work/E.md', 'missing-board'], ['Work/F.md', 'unknown-column']]);
  for (const board of ['Boards/Dev.md', 'Boards/Ops.md', 'Other/Ops.md']) assert.deepEqual(await host.call('kanbanBoard', {path: board}), kanbanBoard(documents, board, options), board);
  await assert.rejects(host.call('kanbanBoard', {path: 'Plain.md'}), /not a Kanban board/);
});
