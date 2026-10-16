// Kanban boards in the desktop page against the Rust backend: the board view,
// dragging cards within and between columns (persisted to frontmatter), the
// Needs attention lane, the card preview in the right sidebar, column editing,
// the Kanban sidebar, Files context menus and duplicate board names.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {NativeHarness} from './tests/native-harness.mjs';
import {buildDesktop, ROOT} from './build.mjs';
import {readFrontmatter} from './okf.mjs';
import {launchBrowser, recordBlockedStyleAttributes, blockedStyleElementMessage, menuItem} from './test-browser.mjs';
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-kanban-')), root = path.join(temporary, 'Team'), output = path.join(ROOT, 'test-results');
const board = `---
type: Kanban Board
title: Development Board

weave:
  kanban:
    columns:
      - id: backlog
        title: Backlog
      - id: todo
        title: Todo
      - id: in-progress
        title: In Progress
      - id: review
        title: Review
      - id: done
        title: Done
---
# Development Board

Work in flight for the team.
`;
const card = (title, column, rank, extra = '') => `---\ntype: Note\ntitle: ${title}\n${extra}weave:\n  kanban:\n    board: Development-Board.md\n    column: ${column}\n    rank: ${rank}\n---\n# ${title}\n\nDetails about ${title.toLowerCase()} and the [plain note](../Notes/Plain.md).\n`;
const files = {
  'Boards/Development-Board.md': board,
  'Work/Login.md': card('Login', 'todo', 1000, 'description: Sign in with the corporate account.\ntags: [auth, web]\n'),
  'Work/Search.md': card('Search', 'todo', 2000),
  'Work/Export.md': card('Export', 'in-progress', 1000),
  'Work/Typo.md': card('Typo', 'in-progres', 1000),
  'Work/Lost.md': '---\ntype: Note\nweave:\n  kanban:\n    board: Missing-Board.md\n    column: todo\n---\n# Lost card\n',
  'Notes/Plain.md': '# Plain note\n\nNot on a board.\n',
};
for (const [file, text] of Object.entries(files)) {await fs.mkdir(path.dirname(path.join(root, file)), {recursive: true}); await fs.writeFile(path.join(root, file), text);}
await fs.mkdir(output, {recursive: true});
await buildDesktop();
const service = new NativeHarness(path.join(temporary, '.weave'));
const browser = await launchBrowser(), page = await browser.newPage({viewport: {width: 1900, height: 1000}}), errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', m => {if (m.type() === 'error' && !blockedStyleElementMessage(m.text())) errors.push(m.text());});
await page.addInitScript(recordBlockedStyleAttributes);
await page.exposeFunction('__WEAVE_TEST_INVOKE__', async (command, input) => {
  if (command === 'choose_workspace') return service.open(root);
  if (command === 'window_action') return {maximized: false, decorated: false};
  if (['editor_state', 'open_resource', 'choose_storage_directory'].includes(command)) return null;
  const {op, args} = input;
  if (op === 'revealPath') return {revealed: true};
  return service.call(op, args);
});
const read = file => fs.readFile(path.join(root, file), 'utf8');
const kanbanOf = async file => readFrontmatter(await read(file)).fields.weave?.kanban;
async function until(check, message, timeout = 8000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {try {last = await check(); if (last) return last;} catch (error) {last = error;} await new Promise(resolve => setTimeout(resolve, 100));}
  throw new Error(message + (last instanceof Error ? ': ' + last.message : ''));
}
const lane = id => page.locator(`#kanban-view .kanban-lane[data-column="${id}"]`);
const cardIn = (id, title) => lane(id).locator('.kanban-card', {hasText: title});
const titlesIn = id => lane(id).locator('.kanban-card-title').allInnerTexts();
async function drag(from, to, {position = 'center'} = {}) {
  // The board is drawn again after each change; wait until both ends are on screen.
  const [a, b] = await until(async () => {const boxes = [await from.boundingBox(), await to.boundingBox()]; return boxes.every(Boolean) && boxes;}, 'drag ends are visible');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, {steps: 3});
  const y = position === 'top' ? b.y + 4 : position === 'bottom' ? b.y + b.height - 4 : b.y + b.height / 2;
  await page.mouse.move(b.x + b.width / 2, y, {steps: 12}); await page.mouse.up();
}
try {
  const shell = path.join(output, 'weave-kanban-csp.html');
  await fs.writeFile(shell, (await fs.readFile(path.join(ROOT, 'dist/desktop/index.html'), 'utf8')).replace('<style>', `<meta http-equiv="Content-Security-Policy" content="style-src 'unsafe-inline' 'nonce-weave-test'"><style nonce="weave-test">`));
  await page.goto(pathToFileURL(shell).href);
  await page.locator('#welcome-open').click(); await page.locator('[data-tree-path="Boards"]').waitFor();
  await page.locator('[data-tree-path="Boards"]').click();
  await until(() => page.locator('[data-tree-path="Boards/Development-Board.md"]').evaluate(node => node.classList.contains('tree-board')), 'Files marks boards');

  // Opening the board article shows the board, columns in board order and cards by rank.
  await page.locator('[data-tree-path="Boards/Development-Board.md"]').click();
  await page.locator('#kanban-view .kanban-board').waitFor();
  assert.deepEqual(await page.locator('#kanban-view .kanban-lane-title').allInnerTexts(), ['Needs attention', 'Backlog', 'Todo', 'In Progress', 'Review', 'Done']);
  assert.deepEqual(await titlesIn('todo'), ['Login', 'Search']);
  assert.equal(await page.locator('#article').isVisible(), false, 'the board replaces the article');
  assert.match(await page.locator('#kanban-view .kanban-attention .kanban-card').innerText(), /Typo[\s\S]*Unknown column “in-progres”/);
  assert.equal(await page.locator('#kanban-view .kanban-card', {hasText: 'Lost card'}).count(), 0, 'cards of other boards stay off this board');
  assert.match(await page.locator('#kanban-view .kanban-lane[data-column="todo"] .kanban-card').first().innerText(), /Sign in with the corporate account[\s\S]*#auth/);
  await page.screenshot({path: path.join(output, 'kanban-board.png')});

  // Reordering within a column writes one new rank; the other cards are untouched.
  const loginBefore = await read('Work/Login.md');
  await drag(cardIn('todo', 'Search'), cardIn('todo', 'Login'), {position: 'top'});
  await until(async () => (await kanbanOf('Work/Search.md')).rank === 500, 'Search moves above Login with a midpoint rank');
  assert.equal(await read('Work/Login.md'), loginBefore, 'only the moved card is written');
  await until(async () => JSON.stringify(await titlesIn('todo')) === JSON.stringify(['Search', 'Login']), 'the board shows the new order');
  assert.match(await read('Work/Search.md'), /updated_at: /, 'moves are stamped like other saves');

  // Moving between columns, including into an empty column.
  await drag(cardIn('todo', 'Login'), lane('review').locator('.kanban-cards'));
  await until(async () => {const k = await kanbanOf('Work/Login.md'); return k.column === 'review' && k.rank === 1000 && k.board === 'Development-Board.md';}, 'Login moves to the empty Review column');
  await until(async () => (await titlesIn('review')).includes('Login'), 'Review shows Login');

  // A card under Needs attention is corrected by dragging it to a column.
  await drag(page.locator('#kanban-view .kanban-attention .kanban-card'), lane('in-progress').locator('.kanban-cards'), {position: 'bottom'});
  await until(async () => {const k = await kanbanOf('Work/Typo.md'); return k.column === 'in-progress' && k.rank === 2000;}, 'Typo is placed after Export');
  await until(async () => await page.locator('#kanban-view .kanban-attention').count() === 0, 'the attention lane disappears once empty');
  assert.match(await read('Boards/Development-Board.md'), /title: Development Board\n\nweave:/, 'card moves never rewrite the board');

  // Clicking a card shows it in the right sidebar; its column can be changed there.
  await cardIn('in-progress', 'Export').click();
  await page.locator('#card-preview .card-preview h2', {hasText: 'Export'}).waitFor();
  assert.equal(await page.locator('#right-sidebar #card-panel').isVisible(), true, 'the preview opens in the right sidebar');
  assert.match(await page.locator('#card-preview .card-preview-body').innerText(), /Details about export/);
  assert.equal(await page.locator('#card-preview .card-preview-body [data-open]').getAttribute('data-open'), 'Notes/Plain.md', 'preview links open articles');
  await page.locator('#card-preview [data-card-field="column"]').selectOption('done');
  await until(async () => (await kanbanOf('Work/Export.md')).column === 'done', 'the preview moves the card to Done');
  await until(async () => (await titlesIn('done')).includes('Export'), 'the board follows');
  await page.screenshot({path: path.join(output, 'kanban-preview.png')});

  // Right-clicking a card offers Move to; columns are edited from their menus.
  await cardIn('todo', 'Search').click({button: 'right'});
  await page.locator('#kanban-menu').waitFor();
  assert.ok((await page.locator('#kanban-menu').innerText()).includes('Move to'), 'card menu lists the columns');
  await page.locator('#kanban-menu button', {hasText: 'Backlog'}).click();
  await until(async () => (await kanbanOf('Work/Search.md')).column === 'backlog', 'the menu moves the card');
  await lane('review').locator('.kanban-lane-head').click({button: 'right'});
  await page.locator('#kanban-menu button', {hasText: 'Rename column…'}).click();
  await page.locator('#prompt-value').fill('Code review'); await page.locator('#prompt-ok').click();
  await until(async () => (await read('Boards/Development-Board.md')).includes('title: Code review'), 'renaming a column writes its title');
  assert.equal((await kanbanOf('Work/Login.md')).column, 'review', 'renaming a column keeps its id, so cards are unchanged');
  await page.locator('#kanban-view [data-kanban-action="add-column"]').first().click();
  await page.locator('#prompt-value').fill('Blocked'); await page.locator('#prompt-ok').click();
  await until(async () => (await read('Boards/Development-Board.md')).includes('id: blocked'), 'a new column gets a stable id');
  await lane('blocked').waitFor();

  // + adds a new card article in the board's folder.
  await lane('backlog').locator('.kanban-lane-add').click();
  await page.locator('#prompt-value').fill('Write docs'); await page.locator('#prompt-ok').click();
  await until(async () => {const k = await kanbanOf('Boards/Write docs.md'); return k?.column === 'backlog' && k.board === 'Development-Board.md' && k.rank === 2000;}, 'a new card is created after the last card');

  // The Kanban sidebar lists boards and cards whose board is unknown.
  await page.locator('.rail [data-panel="kanban"]').click();
  await page.locator('#kanban-boards .kanban-sidebar-board').first().waitFor();
  assert.match(await page.locator('#kanban-boards').innerText(), /Development Board[\s\S]*Cards with an unknown board[\s\S]*Lost card[\s\S]*No board named “Missing-Board.md”/);
  assert.equal(await page.locator('#kanban-attention-badge').innerText(), '1');

  // Right-click a folder › New Kanban board here.
  await page.locator('.rail [data-panel="files"]').click();
  await page.locator('[data-tree-path="Notes"]').click({button: 'right'});
  await page.locator('#file-menu [data-file-action="new-board"]').click();
  await page.locator('#prompt-value').fill('Operations'); await page.locator('#prompt-ok').click();
  await until(async () => (await read('Notes/Operations.md')).includes('type: Kanban Board'), 'the board is created in the folder');
  await page.locator('#kanban-view .kanban-board-title', {hasText: 'Operations'}).waitFor();
  assert.deepEqual(await page.locator('#kanban-view .kanban-lane-title').allInnerTexts(), ['Backlog', 'To do', 'In progress', 'Done']);
  // Board names are unique: a second board with an existing name is refused.
  await page.locator('[data-tree-path="Notes"]').click({button: 'right'});
  await page.locator('#file-menu [data-file-action="new-board"]').click();
  await page.locator('#prompt-value').fill('Development-Board'); await page.locator('#prompt-ok').click();
  await until(async () => /already exists[\s\S]*unique/.test(await page.locator('#message').innerText()), 'duplicate board names are refused');

  // Right-click an article › Add to Kanban board.
  await page.locator('[data-tree-path="Notes/Plain.md"]').click({button: 'right'});
  await page.locator('#file-menu [data-file-action="add-card"]').click();
  await page.locator('#prompt-choice').selectOption('Boards/Development-Board.md');
  await page.locator('#prompt-choice-2').selectOption('todo'); await page.locator('#prompt-ok').click();
  await until(async () => (await kanbanOf('Notes/Plain.md'))?.column === 'todo', 'Add to Kanban board writes the card fields');

  // A board with the same filename created outside Weave is reported, not merged.
  await fs.mkdir(path.join(root, 'Archive'), {recursive: true});
  await fs.writeFile(path.join(root, 'Archive/Development-Board.md'), '---\ntype: Kanban Board\n---\n# Old board\n');
  await page.locator('#refresh').click();
  await page.locator('.rail [data-panel="kanban"]').click();
  await until(async () => /Duplicate board names/.test(await page.locator('#kanban-boards').innerText()), 'the sidebar reports duplicate board names');
  await page.locator('#kanban-boards .kanban-sidebar-board', {hasText: 'Development Board'}).click();
  await page.locator('#kanban-view .kanban-notice.warning', {hasText: 'Duplicate board name'}).waitFor();
  assert.ok(await page.locator('#kanban-view .kanban-attention .kanban-card').count() >= 4, 'cards that name the shared filename are kept under Needs attention');
  await page.screenshot({path: path.join(output, 'kanban-duplicates.png')});
  await fs.rm(path.join(root, 'Archive'), {recursive: true}); await page.locator('#refresh').click();
  await until(async () => await page.locator('#kanban-view .kanban-attention').count() === 0, 'removing the duplicate restores the board');

  // The board's article is one click away and back.
  await page.locator('#kanban-view [data-kanban-action="document"]').click();
  await page.locator('#article').waitFor({state: 'visible'});
  await page.locator('#kanban-view [data-kanban-show-board]').click();
  await page.locator('#kanban-view .kanban-board').waitFor();

  // Source shows the board's raw Markdown, as for any article; leaving it shows the board.
  await page.locator('.rail [data-panel="files"]').click();
  await menuItem(page,'source-mode');
  await page.locator('#source-editor').waitFor({state: 'visible'});
  assert.match(await page.locator('#source-editor .cm-content').innerText(), /type: Kanban Board[\s\S]*id: backlog/);
  assert.equal(await page.locator('#kanban-view .kanban-board').count(), 0, 'no board is drawn over the source');
  await page.locator('#kanban-view [data-kanban-show-board]').click();
  await page.locator('#kanban-view .kanban-board').waitFor();
  assert.equal(await page.locator('#source-mode').getAttribute('aria-pressed'), 'false', 'Show board leaves Source');

  // An ordinary article may share a board's filename: only boards must be unique.
  await fs.writeFile(path.join(root, 'Notes/Development-Board.md'), '---\ntype: Note\n---\n# Board notes\n');
  await page.locator('#refresh').click();
  await page.locator('[data-tree-path="Notes/Development-Board.md"]').waitFor();
  await until(async () => await page.locator('#kanban-view .kanban-attention').count() === 0 && await page.locator('#kanban-view .kanban-notice.warning').count() === 0, 'a non-board with the same filename is not a duplicate board');
  assert.equal(await page.locator('[data-tree-path="Notes/Development-Board.md"]').evaluate(node => node.classList.contains('tree-board')), false);

  // Dragging an article from Files onto a column makes it a card there, adding OKF frontmatter.
  await fs.writeFile(path.join(root, 'Notes/Idea.md'), '# Idea\n\nA loose thought.\n');
  await page.locator('#refresh').click();
  await page.locator('[data-tree-path="Notes/Idea.md"]').waitFor();
  await drag(page.locator('[data-tree-path="Notes/Idea.md"]'), lane('backlog').locator('.kanban-lane-head'), {position: 'bottom'});
  await until(async () => {const k = await kanbanOf('Notes/Idea.md'); return k?.column === 'backlog' && k.board === 'Development-Board.md' && Number.isFinite(k.rank);}, 'the dropped article joins the Backlog column (' + await page.locator('#message').innerText() + ')');
  const idea = await read('Notes/Idea.md');
  assert.match(idea, /^---\ntype: Note\n[\s\S]*created_at: [\s\S]*---\n# Idea\n\nA loose thought.\n$/, 'the article gains OKF frontmatter and keeps its text');
  await until(async () => (await titlesIn('backlog'))[0] === 'Idea', 'the board shows the dropped article first in its column');
  // Dropping a card of this board moves it (here above Idea).
  await drag(page.locator('[data-tree-path="Notes/Plain.md"]'), cardIn('backlog', 'Idea'), {position: 'top'});
  await until(async () => {const k = await kanbanOf('Notes/Plain.md'); return k?.column === 'backlog' && k.rank < (await kanbanOf('Notes/Idea.md')).rank;}, 'a card dropped from Files moves within the board');
  assert.equal(await read('Notes/Idea.md'), idea, 'only the dropped card is written');

  // The OKF bar hides the weave block, which Weave maintains itself.
  await page.locator('[data-tree-path="Notes/Idea.md"]').click();
  await page.locator('#okf-bar [data-okf-field="type"]').waitFor();
  assert.equal(await page.locator('#okf-bar [data-okf-field="weave"]').count(), 0, 'no weave pill');

  // Copy and paste in Files: names already taken gain “copy”, as do boards whose name another board has.
  if (await page.locator('#edit-mode').getAttribute('aria-pressed') !== 'true') await page.locator('#edit-mode').click();
  await page.locator('[data-tree-path="Notes/Idea.md"]').click({button: 'right'});
  await page.locator('#file-menu [data-file-action="copy"]').click();
  await page.locator('[data-tree-path="Notes"]').click({button: 'right'});
  await page.locator('#file-menu [data-file-action="paste"]').click();
  await until(async () => (await read('Notes/Idea copy.md')) === idea, 'a pasted copy keeps the article byte for byte');
  await page.locator('[data-tree-path="Notes/Idea copy.md"]').waitFor();
  await page.locator('[data-tree-path="Work"]').click();
  await page.keyboard.press('Control+C');
  await page.locator('[data-tree-path="Notes"]').click();
  await page.keyboard.press('Control+V');
  await until(async () => (await read('Notes/Work/Login.md')).includes('title: Login'), 'folders are pasted with their contents');
  await page.locator('[data-tree-path="Notes/Work"]').waitFor();
  await page.locator('[data-tree-path="Boards/Development-Board.md"]').click({button: 'right'});
  await page.locator('#file-menu [data-file-action="copy"]').click();
  await page.locator('[data-tree-path="Work"]').click();
  await page.keyboard.press('Control+V');
  await until(async () => (await read('Work/Development-Board copy.md')).includes('type: Kanban Board'), 'a pasted board keeps board names unique');
  await page.locator('[data-tree-path="Notes/Work"]').click(); await page.keyboard.press('Control+C');
  await page.locator('[data-tree-path="Notes/Work"]').click(); await page.keyboard.press('Control+V');
  await until(async () => /inside itself/.test(await page.locator('#message').innerText()), 'a folder is not pasted inside itself');

  // The editor menu's Paste converts formatted HTML; Paste as plain text keeps the text.
  await page.locator('[data-tree-path="Notes/Idea copy.md"]').click();
  await page.locator('#article .cm-content').waitFor();
  await page.evaluate(() => {
    const data = {'text/html': '<p>See <a href="https://example.com">the site</a> <b>now</b></p>', 'text/plain': 'See the site now'};
    navigator.clipboard.read = async () => [{types: Object.keys(data), getType: async type => new Blob([data[type]], {type})}];
    navigator.clipboard.readText = async () => data['text/plain'];
  });
  const endOfArticle = async () => {await page.locator('#article .cm-line').last().click(); await page.keyboard.press('Control+End');};
  for (const [command, expected] of [['paste', 'See [the site](https://example.com) **now**'], ['pastePlain', 'See the site now']]) {
    await endOfArticle(); await page.keyboard.press('Enter');
    const box = await page.locator('#article .cm-line').last().boundingBox();
    await page.mouse.click(box.x + 4, box.y + box.height / 2, {button: 'right'});
    await page.locator(`#article-menu [data-editor-command="${command}"]`).click();
    await until(async () => (await read('Notes/Idea copy.md')).includes(expected), command + ' inserts ' + expected);
  }
  // Ctrl+V converts the same way through the paste event.
  await endOfArticle(); await page.keyboard.press('Enter');
  await page.evaluate(() => {
    const data = new DataTransfer(); data.setData('text/html', '<ul><li>Item <i>one</i></li></ul>'); data.setData('text/plain', 'Item one');
    document.querySelector('#article .cm-content').dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
  });
  await until(async () => (await read('Notes/Idea copy.md')).includes('- Item *one*'), 'Ctrl+V converts lists');

  assert.deepEqual(await page.evaluate(() => window.__blockedStyles), [], 'no inline style attributes under the packaged CSP');
  assert.deepEqual(errors, []);
  console.log('Kanban verification passed. Screenshots: test-results/kanban-*.png');
} finally {
  await browser.close(); await service.close();
  await fs.rm(temporary, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}
