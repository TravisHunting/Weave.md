const names = {files:'Files', search:'Search', kanban:'Kanban', card:'Card', git:'Source control', appearance:'Visual styling', settings:'Control panel', export:'Export workspace'};

// Panels retain one DOM instance (and their drafts) when moved between docks.
export function createSidebars({prefs, onActivate = () => {}}) {
  const $ = id => document.getElementById(id), left = $('sidebar');
  const divider = document.createElement('div');
  divider.id = 'right-sidebar-resize'; divider.role = 'separator'; divider.tabIndex = 0;
  divider.setAttribute('aria-label', 'Resize right sidebar'); divider.setAttribute('aria-orientation', 'vertical');
  const right = document.createElement('aside'); right.id = 'right-sidebar';
  right.innerHTML = '<nav class="right-rail" aria-label="Right sidebar actions"></nav><div class="panel-heading"><h2 id="right-panel-title"></h2><div class="panel-end"><button id="close-right-sidebar" aria-label="Close right sidebar">›</button></div></div>';
  document.querySelector('.shell').append(divider, right);
  const rail = right.querySelector('nav');
  for (const original of document.querySelectorAll('.rail button')) {
    const button = original.cloneNode(true); button.removeAttribute('id');
    button.querySelector('.git-pending-badge')?.remove();
    if (original.dataset.panel) {
      button.removeAttribute('data-panel'); button.dataset.rightPanel = original.dataset.panel;
      button.onclick = () => select('right', original.dataset.panel);
    } else {
      button.dataset.mirrorAction = original.id;
      button.onclick = () => {original.click(); syncActions();};
    }
    rail.append(button);
  }
  let leftPanel = 'files', rightPanel = prefs.get('right-panel') || 'git', opened = prefs.get('right-sidebar-open') === 'true';
  const available = name => Object.hasOwn(names, name) && !document.querySelector(`.rail [data-panel="${name}"]`).hidden;
  if (!available(rightPanel)) rightPanel = available('git') ? 'git' : 'settings';
  if (opened && rightPanel === leftPanel) leftPanel = available('git') ? 'git' : 'settings';
  const heading = left.querySelector('.panel-heading'), rightHeading = right.querySelector('.panel-heading');
  const fileActions = $('file-actions'), collapseAll = $('collapse-all');
  let dragging = null;
  function setWidth(width) {
    const value = Math.max(200, Math.min(650, width));
    document.documentElement.style.setProperty('--right-sidebar', value + 'px'); prefs.set('right-sidebar-width', String(value));
  }
  setWidth(Number(prefs.get('right-sidebar-width')) || 340);
  function syncActions() {
    for (const button of rail.querySelectorAll('[data-mirror-action]')) {
      const original = $(button.dataset.mirrorAction);
      button.disabled = original.disabled; button.title = original.title;
      if (original.hasAttribute('aria-pressed')) button.setAttribute('aria-pressed', original.getAttribute('aria-pressed'));
    }
  }
  new MutationObserver(syncActions).observe(document.querySelector('.rail'), {subtree:true, attributes:true, attributeFilter:['aria-pressed','title','disabled']});
  function render() {
    const collapsed = document.body.classList.contains('sidebar-collapsed');
    document.body.classList.toggle('right-sidebar-open', opened);
    right.hidden = divider.hidden = !opened; right.inert = !opened; left.inert = collapsed;
    $('toggle-right-sidebar').setAttribute('aria-pressed', String(opened));
    $('panel-title').textContent = names[leftPanel]; $('right-panel-title').textContent = names[rightPanel];
    for (const name of Object.keys(names)) {
      const section = $(name + '-panel'), dock = opened && name === rightPanel ? right : left;
      if (section.parentNode !== dock) dock.append(section);
      section.hidden = !(opened && name === rightPanel || !collapsed && name === leftPanel);
    }
    const filesHeading = opened && rightPanel === 'files' ? rightHeading : heading;
    filesHeading.append(fileActions); fileActions.append(collapseAll);
    fileActions.hidden = !visible('files');
    for (const button of document.querySelectorAll('.rail [data-panel]')) button.setAttribute('aria-pressed', String(!collapsed && button.dataset.panel === leftPanel));
    for (const button of rail.querySelectorAll('[data-right-panel]')) button.setAttribute('aria-pressed', String(button.dataset.rightPanel === rightPanel));
    prefs.set('right-panel', rightPanel); prefs.set('right-sidebar-open', String(opened)); syncActions();
  }
  function visible(name) {return opened && rightPanel === name || !document.body.classList.contains('sidebar-collapsed') && leftPanel === name;}
  function select(side, next, {toggle = false} = {}) {
    if (!available(next)) return;
    if (side === 'left') {
      if (toggle && next === leftPanel && !document.body.classList.contains('sidebar-collapsed')) {collapse(); return;}
      if (opened && next === rightPanel) rightPanel = leftPanel;
      leftPanel = next; document.body.classList.remove('sidebar-collapsed');
    } else {
      if (next === leftPanel) leftPanel = rightPanel;
      rightPanel = next; opened = true;
    }
    render(); onActivate(next, side);
    const other = side === 'left' ? rightPanel : leftPanel;
    if (visible(other)) onActivate(other, 'passive');
  }
  function collapse() {
    if (left.contains(document.activeElement)) document.querySelector(`.rail [data-panel="${leftPanel}"]`)?.focus();
    document.body.classList.add('sidebar-collapsed'); render();
  }
  function toggleRight() {
    opened = !opened;
    if (opened && rightPanel === leftPanel) leftPanel = Object.keys(names).find(name => name !== rightPanel && available(name));
    if (!opened && right.contains(document.activeElement)) $('toggle-right-sidebar').focus();
    render(); if (opened) {onActivate(rightPanel, 'right'); if (visible(leftPanel)) onActivate(leftPanel, 'passive');}
  }
  $('toggle-right-sidebar').onclick = toggleRight; $('close-right-sidebar').onclick = toggleRight;
  divider.title = 'Drag right to close the sidebar';
  divider.onpointerdown = event => {
    if (event.button !== 0) return;
    dragging = {x:event.clientX, width:right.getBoundingClientRect().width, saved:prefs.get('right-sidebar-width')};
    divider.setPointerCapture(event.pointerId); event.preventDefault();
  };
  divider.onpointermove = event => {
    if (!dragging) return;
    const width = dragging.width + dragging.x - event.clientX;
    // Allow the dock to follow the pointer all the way to the edge. Preserve
    // the last usable width so reopening remains useful.
    document.documentElement.style.setProperty('--right-sidebar', Math.max(0, Math.min(650, width)) + 'px');
  };
  divider.onpointerup = event => {
    if (!dragging) return;
    const width = dragging.width + dragging.x - event.clientX, saved = dragging.saved;
    dragging = null;
    if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
    if (width < 100) {setWidth(Number(saved) || 340); toggleRight();}
    else setWidth(width);
  };
  divider.onpointercancel = event => {
    if (dragging) setWidth(Number(dragging.saved) || dragging.width);
    dragging = null;
    if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
  };
  divider.onkeydown = event => {if (['ArrowLeft','ArrowRight'].includes(event.key)) {event.preventDefault(); setWidth(right.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 15 : -15));}};
  render(); if (opened) queueMicrotask(() => {onActivate(rightPanel, 'right'); if (visible(leftPanel)) onActivate(leftPanel, 'passive');});
  const closeRight = () => {if (opened) toggleRight();};
  return {select, collapse, visible, closeRight, get leftPanel() {return leftPanel;}, get leftOpen() {return !document.body.classList.contains('sidebar-collapsed');}, get rightOpen() {return opened;}};
}
