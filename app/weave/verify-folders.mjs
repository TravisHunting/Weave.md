import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyFolders(page, output, mode) {
  const left = async name => {const button=page.locator(`.rail [data-panel="${name}"]`);if(await button.getAttribute('aria-pressed')!=='true')await button.click();};
  const folder = name => page.locator(`[data-tree-path="${name}"]`);
  const heading = () => page.locator('#files-panel').evaluate(element=>element.parentElement.querySelector('.panel-heading').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:100,clientY:80})));
  const toggle = () => page.locator('[data-file-action="show-hidden"]').click();
  await left('settings');assert.equal(await page.locator('#hide-dot-folders').isChecked(),true);
  await left('files');assert.equal(await folder('.obsidian').count(),0,'dot folders hidden by default');
  if(mode==='desktop') {for(const name of ['Overview.md','Teams']) {await folder(name).click({button:'right'});await page.locator('[data-file-action="reveal"]').click();}}
  await folder('Overview.md').click({button:'right'});
  assert(await page.locator('[data-file-action="show-hidden"]').isHidden(),'file menus exclude folder visibility');
  const count=await page.locator('.file-tab').count();
  await page.locator('[data-file-action="open-tab"]').click();await page.waitForFunction(count=>document.querySelectorAll('.file-tab').length===count+1,count);
  assert.equal(await page.locator('.file-tab.active [data-tab]').innerText(),'Overview');
  await page.keyboard.press('Control+w');await page.waitForFunction(count=>document.querySelectorAll('.file-tab').length===count,count);
  await page.locator('#file-tabs').evaluate(element=>element.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:600,clientY:65})));
  assert(await page.locator('#context-close-tab').isHidden());await page.locator('#context-new-tab').click();
  await page.locator('#welcome').waitFor({state:'visible'});assert.equal(await page.locator('.file-tab').count(),count+1);await page.keyboard.press('Control+w');await page.waitForFunction(count=>document.querySelectorAll('.file-tab').length===count,count);
  await folder('Teams').click({button:'right'});await page.locator('[data-file-action="hide-folder"]').click();
  assert.equal(await folder('Teams').count(),0,'Hide folder removes its whole subtree');
  await page.reload();await folder('Overview.md').waitFor();assert.equal(await folder('Teams').count(),0,'hidden folders persist after reload');
  await heading();assert.equal(await page.locator('[data-file-action="show-hidden"]').getAttribute('aria-checked'),'false');
  const marker=await page.locator('[data-file-action="show-hidden"]').evaluate(node=>({before:getComputedStyle(node,'::before').content,after:getComputedStyle(node,'::after').content,align:getComputedStyle(node).textAlign}));
  assert.equal(marker.before,'none');assert.equal(marker.after,'"×"');assert.equal(marker.align,'left');await toggle();
  assert(await folder('Teams').isVisible());assert(await folder('.obsidian').isVisible());
  assert.match(await folder('Teams').getAttribute('class'),/tree-hidden-folder/);
  await folder('Teams').click({button:'right'});assert.equal(await page.locator('[data-file-action="hide-folder"]').innerText(),'Unhide folder');await page.locator('[data-file-action="hide-folder"]').click();
  await heading();assert.equal(await page.locator('[data-file-action="show-hidden"]').getAttribute('aria-checked'),'true');await toggle();
  assert(await folder('Teams').isVisible());assert.equal(await folder('.obsidian').count(),0);
  await left('settings');await page.locator('#hide-dot-folders').uncheck();await left('files');assert(await folder('.obsidian').isVisible(),'dot-folder preference applies immediately');
  await left('settings');await page.locator('#hide-dot-folders').check();await left('files');
  // Folder menus and the show-hidden toggle also work in the right dock.
  await page.locator('#toggle-right-sidebar').click();await page.locator('[data-right-panel="files"]').click();
  await heading();await toggle();assert(await page.locator('#right-sidebar [data-tree-path=".obsidian"]').isVisible());
  await page.screenshot({path:path.join(output,`weave-${mode}-hidden-folders.png`),fullPage:true});
  // Trigger from actual blank Files space rather than from an article row.
  await page.locator('#files-panel').evaluate(element=>element.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:innerWidth-120,clientY:400})));
  await toggle();assert.equal(await folder('.obsidian').count(),0);
  await left('files');await page.locator('#toggle-right-sidebar').click();
}
