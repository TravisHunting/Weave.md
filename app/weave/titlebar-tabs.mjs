// Tabs in the title bar (Settings › Appearance › Tabs, root data-titlebar-tabs).
// The article column runs to the top of the window, so each pane's tab strip
// shares the title-bar row with the title bar's two control clusters, which
// float at either end. Each strip reserves room (--reserve-left/--reserve-right,
// painted by its ::before/::after) so tabs never pass under the controls, and
// empty strip space and the band above the sidebars move and maximise the
// window as the title bar itself does. Tab behaviour is untouched: the strips
// stay inside their panes.
const GAP = 6;

export function initTitlebarTabs({root = document.documentElement, titlebar, shell, start, end, tabBars, onDrag = () => {}, onMaximize = () => {}}) {
  // The phone layout (mobile.mjs) gives tabs their own row: the row has no room.
  const enabled = () => root.dataset.titlebarTabs === 'true' && root.dataset.layout !== 'mobile';
  let frame = 0;
  function measure() {
    frame = 0;
    const bars = tabBars();
    if (!enabled()) {
      for (const bar of bars) {bar.style.removeProperty('--reserve-left'); bar.style.removeProperty('--reserve-right');}
      return;
    }
    const startRight = start.getBoundingClientRect().right + GAP, endLeft = end.getBoundingClientRect().left - GAP;
    for (const bar of bars) {
      const box = bar.getBoundingClientRect();
      if (!box.width) continue;
      bar.style.setProperty('--reserve-left', Math.max(0, Math.ceil(startRight - box.left)) + 'px');
      bar.style.setProperty('--reserve-right', Math.max(0, Math.ceil(box.right - endLeft)) + 'px');
    }
  }
  const schedule = () => {if (!frame) frame = requestAnimationFrame(measure);};
  // Resize callbacks run after layout and before paint, so measuring there keeps
  // tabs from showing under the controls for a frame while a sidebar collapses.
  const sizes = new ResizeObserver(() => {cancelAnimationFrame(frame); measure();});
  for (const element of [shell, start, end, ...tabBars()]) sizes.observe(element);
  new MutationObserver(schedule).observe(root, {attributes: true, attributeFilter: ['data-titlebar-tabs', 'data-skin', 'data-layout']});
  addEventListener('resize', schedule);
  // Empty title-bar row space: the strip around the tabs, or the band above the
  // sidebars (the shell itself, since the sidebars start below the row).
  const emptyRow = event => {
    if (!enabled() || event.clientY > titlebar.getBoundingClientRect().bottom) return false;
    const target = event.target;
    if (target === shell) return true;
    return !!target.closest?.('.tab-bar') && !target.closest('.file-tab, button, input, [role=tab]');
  };
  document.addEventListener('mousedown', event => {if (event.button === 0 && event.detail < 2 && emptyRow(event)) onDrag(event);});
  document.addEventListener('dblclick', event => {if (emptyRow(event)) onMaximize(event);});
  schedule();
  return {refresh: schedule};
}
