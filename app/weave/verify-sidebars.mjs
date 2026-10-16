import assert from 'node:assert/strict';
import path from 'node:path';
import {ensureAppearanceSection} from './verify-appearance.mjs';

export async function verifySidebars(page, output, mode) {
  const leftPanel = async name => {
    const button=page.locator(`.rail [data-panel="${name}"]`);
    if(await button.getAttribute('aria-pressed')!=='true')await button.click();
  };
  const rightPanel = name => page.locator(`[data-right-panel="${name}"]`).click();
  const dockWidth = () => page.locator('#right-sidebar').evaluate(node => {const css=getComputedStyle(node);return node.getBoundingClientRect().width+parseFloat(css.marginLeft)+parseFloat(css.marginRight);});
  const labelMode=await page.locator('#file-labels').inputValue();
  const defaultName=mode==='desktop'?'Source control':'Control panel';
  assert.equal(await page.locator('#right-sidebar').isVisible(),false,'right sidebar starts closed');
  await leftPanel('files');await page.locator('[data-tree-path="Systems"]').click();
  assert.equal(await page.locator('#tree .selected').getAttribute('data-tree-path'),'Systems');
  await page.locator('#toggle-right-sidebar').click();
  assert.equal(await page.locator('#right-panel-title').innerText(),defaultName,'right sidebar chooses an available default panel');
  assert.equal(await page.locator('#tree .selected').getAttribute('data-tree-path'),'Systems','opening another dock preserves the selected destination folder');
  await leftPanel('appearance');
  await rightPanel('files');
  assert.equal(await page.locator('#right-sidebar > #files-panel').count(),1);
  assert.equal(await page.locator('#sidebar > #appearance-panel').count(),1);
  assert.equal(await page.locator('#right-sidebar #file-actions').count(),1,'file actions follow the Files panel');
  assert.equal(await page.locator('#files-panel').count(),1,'there is only one Files panel');

  const alignment=page.locator('#right-align-file-labels');
  await ensureAppearanceSection(page,'appearance-files');
  assert.equal(await alignment.isChecked(),true,'secondary labels align right by default');
  await page.locator('#file-labels').selectOption('title-first');
  const row=page.locator('[data-tree-path="Overview.md"]');
  const gaps=()=>row.evaluate(element=>{const label=element.querySelector('.tree-labels').getBoundingClientRect(),secondary=element.querySelector('.tree-secondary').getBoundingClientRect();return {right:label.right-secondary.right,left:secondary.left};});
  const aligned=await gaps();assert(Math.abs(aligned.right)<2,'secondary label reaches the right edge');
  await alignment.uncheck();
  assert.equal(await page.locator('body').evaluate(element=>element.classList.contains('file-labels-right')),false);
  assert((await gaps()).left<aligned.left,'alignment toggle places secondary text beside the primary');

  // Moving an already-visible panel swaps the two singleton instances.
  await rightPanel('appearance');
  assert.equal(await page.locator('#right-sidebar > #appearance-panel').count(),1);
  assert.equal(await page.locator('#sidebar > #files-panel').count(),1);
  await leftPanel('appearance');
  assert.equal(await page.locator('#right-sidebar > #files-panel').count(),1);
  assert.equal(await alignment.isChecked(),false,'moving a panel retains its input state');

  const divider=page.locator('#right-sidebar-resize');await divider.focus();
  for(let i=0;i<10;i++)await page.keyboard.press('ArrowRight');
  assert(Math.abs(await dockWidth()-200)<2);
  const rail=await page.locator('.right-rail').evaluate(element=>{
    const bounds=element.getBoundingClientRect(),buttons=[...element.querySelectorAll('button')].filter(button=>button.getClientRects().length).map(button=>button.getBoundingClientRect());
    return {rows:new Set(buttons.map(button=>Math.round(button.y))).size,within:buttons.every(button=>button.left>=bounds.left&&button.right<=bounds.right+1)};
  });
  assert(rail.rows>1&&rail.within,'right sidebar icons wrap within a narrow pane');
  await page.screenshot({path:path.join(output,'weave-'+mode+'-sidebars.png'),fullPage:true});

  const grip=await divider.boundingBox();
  await page.mouse.move(grip.x+grip.width/2,grip.y+100);await page.mouse.down();
  await page.mouse.move(page.viewportSize().width-1,grip.y+100,{steps:12});await page.mouse.up();
  assert.equal(await page.locator('#right-sidebar').isVisible(),false,'dragging right closes the sidebar completely');
  assert.equal(await page.locator('#toggle-right-sidebar').getAttribute('aria-pressed'),'false');
  await page.locator('#toggle-right-sidebar').click();
  assert(Math.abs(await dockWidth()-200)<2,'drag-close preserves a useful reopening width');

  await page.locator('#toggle-right-sidebar').click();assert.equal(await page.locator('#right-sidebar').isVisible(),false);
  await page.locator('#toggle-right-sidebar').click();
  assert.equal(await page.locator('#right-panel-title').innerText(),'Files','reopening remembers the selected panel');
  await page.reload();
  await page.locator('#right-sidebar [data-tree-path="Overview.md"]').waitFor();
  assert.equal(await page.locator('#right-panel-title').innerText(),'Files','reload restores the right panel');
  assert.equal(await page.locator('#toggle-right-sidebar').getAttribute('aria-pressed'),'true','reload restores open state');
  assert(Math.abs(await dockWidth()-200)<2,'reload restores width');
  await leftPanel('appearance');
  assert.equal(await alignment.isChecked(),false,'alignment preference survives reload');
  assert.equal(await page.locator('#file-labels').inputValue(),'title-first','label choice survives reload');

  await ensureAppearanceSection(page,'appearance-files');await alignment.check();await page.locator('#file-labels').selectOption(labelMode);
  await leftPanel('files');
  await page.locator('#toggle-right-sidebar').click();
  assert.equal(await page.locator('#right-sidebar').isVisible(),false);
  assert.equal(await page.locator('#sidebar > #files-panel').count(),1);
  assert.equal(await page.locator('.rail [data-panel="files"]').getAttribute('aria-pressed'),'true');
}
