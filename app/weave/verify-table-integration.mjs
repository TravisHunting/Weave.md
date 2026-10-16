import assert from 'node:assert/strict';
import {menuItem} from './test-browser.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ensureAppearanceSection} from './verify-appearance.mjs';
import {unstamped} from './verify-stamps.mjs';

export async function verifyTableIntegration(page, output, workspaceRoot) {
  const file='Stable filename.md',disk=path.join(workspaceRoot,file);
  const panel=async name=>{const button=page.locator(`.rail [data-panel="${name}"]`);if(await button.getAttribute('aria-pressed')!=='true')await button.click();};
  const saved=()=>page.waitForFunction(()=>document.getElementById('save-status').textContent==='Saved');
  await panel('files');await page.locator(`[data-tree-path="${file}"]`).click();
  await page.waitForFunction(file=>document.getElementById('note-path').dataset.path===file,file);
  if(await page.locator('#source-mode').getAttribute('aria-pressed')==='true')await menuItem(page,'source-mode');
  if(await page.locator('#edit-mode').getAttribute('aria-pressed')!=='true')await page.locator('#edit-mode').click();
  if(await page.locator('#view-graph').getAttribute('aria-pressed')==='true')await page.locator('#view-graph').click();
  await panel('appearance');await ensureAppearanceSection(page,'appearance-tables');
  await page.locator('#table-editing').selectOption('visual');await page.locator('#table-auto-format').check();await panel('files');

  // Exercise the application's real context menu, not a table API. It inserts
  // an empty two-column table with one body row, without asking for a size.
  // The menu follows Obsidian's: Format, Paragraph and Insert submenus. Text
  // that is selected and right-clicked can be formatted but never replaced by
  // Insert › Table; right-clicking a highlight offers the highlight colours.
  await page.locator('#article .cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.press('End');await page.keyboard.press('Control+Shift+ArrowLeft');
  const selected=await page.evaluate(()=>{const box=getSelection().getRangeAt(0).getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2};});
  await page.mouse.click(selected.x,selected.y,{button:'right'});await page.locator('#article-menu').waitFor();
  await page.locator('[data-submenu="insert-menu"]').hover();await page.locator('#insert-menu').waitFor();
  assert(await page.locator('#insert-table').isHidden(),'Insert › Table is not offered for right-clicked selected text');
  await page.locator('[data-submenu="format-menu"]').hover();assert(await page.locator('#insert-menu').isHidden(),'submenus replace one another on hover');
  await page.locator('#format-menu [data-editor-command="highlight"]').click();
  await page.waitForFunction(()=>document.querySelector('#article .cm-line').textContent.endsWith('==title=='));await page.keyboard.press('Control+End');
  await page.waitForFunction(()=>document.querySelector('#article .md-highlight')?.textContent==='title');
  const highlight=await page.locator('#article .md-highlight').boundingBox();
  await page.mouse.click(highlight.x+highlight.width/2,highlight.y+highlight.height/2,{button:'right'});
  await page.locator('#highlight-menu').waitFor();await page.screenshot({path:path.join(output,'weave-editor-context-menu.png')});
  await page.locator('[data-highlight-color="#74c0fc"]').click();
  assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--highlight-color').trim()),'#74c0fc','a swatch sets the highlight colour');
  await page.locator('#article .cm-content').click();await page.keyboard.press('Control+z');
  await page.waitForFunction(()=>!document.querySelector('#article .md-highlight'));await page.keyboard.press('Control+End');
  await page.locator('#article .cm-line').last().click({button:'right',position:{x:30,y:10}});
  await page.locator('[data-submenu="insert-menu"]').hover();await page.locator('#insert-table').click();
  await page.locator('#article .cm-table-preview').waitFor();
  assert.equal(await page.locator('#article .cm-table-preview th').count(),2);
  assert.equal(await page.locator('#article .cm-table-preview tbody tr').count(),1);
  assert.deepEqual(await page.locator('#article .cm-table-preview th').allInnerTexts(),['',''],'the header row starts empty');
  await page.locator('#article .cm-table-preview tbody td').first().click();
  const cell=page.locator('#article .table-cell-input');await cell.fill('Saved through a visual table');await cell.press('Control+s');await saved();
  const initial=await fs.readFile(disk,'utf8');assert.match(initial,/(?:^|\n)# A readable title/);assert.match(initial,/\| Saved through a visual table\s+\|/);
  assert.equal(await page.locator('#article .cm-table-preview').count(),1,'saving a cell retains the rendered table');

  await page.reload();await page.locator(`[data-tree-path="${file}"]`).waitFor();await page.locator(`[data-tree-path="${file}"]`).click();
  await page.locator('#article .cm-table-preview tbody td').first().waitFor();
  // Opening the article again hides it until its restored viewport is parsed.
  await page.waitForFunction(()=>!document.getElementById('note-panel').classList.contains('restoring'));
  assert.equal(await page.locator('#article .cm-table-preview tbody td').first().innerText(),'Saved through a visual table');
  await page.screenshot({path:path.join(output,'weave-desktop-table-integration.png'),fullPage:true});

  // Table source mode and the global Source view share the save preference.
  await panel('appearance');await ensureAppearanceSection(page,'appearance-tables');
  await page.locator('#table-editing').selectOption('source');await page.locator('#table-auto-format').uncheck();await panel('files');
  await page.locator('#article .cm-table-preview tbody td').first().click();
  await page.locator('#article .md-table-line').first().waitFor();assert.equal(await page.locator('#article .table-cell-input').count(),0);
  await menuItem(page,'source-mode');await page.locator('#source-editor .cm-content').click();
  const unpadded='# A readable title\n\n| Name | Value |\n|---|---|\n| A | 1 |\n| Long name | 22 |\n';
  await page.keyboard.press('Control+a');await page.keyboard.insertText(unpadded);await page.keyboard.press('Control+s');await saved();
  assert.equal(unstamped(await fs.readFile(disk,'utf8')),unpadded,'autoformat off preserves manually authored table spacing on save');

  await panel('appearance');await ensureAppearanceSection(page,'appearance-tables');await page.locator('#table-auto-format').check();
  const canonical='# A readable title\n\n| Name      | Value |\n| --------- | ----- |\n| A         | 1     |\n| Long name | 22    |\n';
  assert.equal(await page.locator('#save-status').textContent(),'Saved','the existing compact source is clean before explicit save');
  await page.locator('#source-editor .cm-content').click();await page.keyboard.press('Control+s');await saved();
  assert.equal(unstamped(await fs.readFile(disk,'utf8')),canonical,'Ctrl+S pads clean compact source and extends delimiter hyphens without an extra edit');

  // Restore compact source with formatting disabled, then re-enable it without
  // making any document edits. Navigation and mode changes must leave it alone.
  await page.locator('#table-auto-format').uncheck();
  await page.locator('#source-editor .cm-content').click();await page.keyboard.press('Control+a');await page.keyboard.insertText(unpadded);await page.keyboard.press('Control+s');await saved();
  const untouched=await fs.readFile(disk,'utf8');assert.equal(unstamped(untouched),unpadded);
  await page.locator('#table-auto-format').check();await page.locator('#table-editing').selectOption('visual');
  await menuItem(page,'source-mode');await page.locator('#article .cm-table-preview').waitFor();
  assert.equal(await fs.readFile(disk,'utf8'),untouched,'switching from Source to visual view does not format untouched source');
  await page.locator('#edit-mode').click();await page.waitForFunction(()=>document.getElementById('edit-mode').getAttribute('aria-pressed')==='false');
  await page.locator('#edit-mode').click();await page.waitForFunction(()=>document.getElementById('edit-mode').getAttribute('aria-pressed')==='true');
  assert.equal(await fs.readFile(disk,'utf8'),untouched,'toggling Edit preserves untouched compact source');
  await panel('files');await page.locator('[data-tree-path="Overview.md"]').click();
  await page.waitForFunction(()=>document.getElementById('note-path').dataset.path==='Overview.md');
  assert.equal(await fs.readFile(disk,'utf8'),untouched,'ordinary navigation does not format or save an untouched article');
  await page.locator(`[data-tree-path="${file}"]`).click();await page.waitForFunction(file=>document.getElementById('note-path').dataset.path===file,file);
  await page.locator('#article .cm-table-preview').waitFor();assert.equal(await page.locator('#article .cm-table-preview tbody tr').count(),2);
  assert.equal(await page.locator('#save-status').textContent(),'Saved','the compact visual table is clean before explicit save');
  await menuItem(page,'save');await saved();
  assert.equal(unstamped(await fs.readFile(disk,'utf8')),canonical,'Save pads a clean compact table in visual view');
  await page.screenshot({path:path.join(output,'weave-desktop-table-clean-format.png'),fullPage:true});
  console.log('Desktop table integration passed: insert dialog, visual cell Ctrl+S, disk persistence, reload, source editing, clean explicit saves, untouched navigation and autoformat preference.');
}
