// An Obsidian-style settings window: categories on the left, one category's
// settings on the right, and a search box that filters every category. The
// existing Control panel and Visual styling controls move into the window
// while it is open (keeping their state and handlers) and return on close.
// An Appearance section with `data-settings-category` joins the Options
// category of that name (Spelling underline joins Spellchecking). In the phone
// layout the window is a full-screen sheet showing either the category list or
// one category (data-view), with a back button between them.
import {isMobileLayout} from './mobile.mjs';

const expandable = '.search-options, #storage-form, details.appearance-section, form#save-colour-scheme';

export function createSettingsDialog({sources, onOpen = () => {}}) {
  const dialog = document.createElement('dialog');
  dialog.id = 'settings-dialog'; dialog.className = 'settings-dialog'; dialog.tabIndex = -1; dialog.setAttribute('aria-label', 'Settings');
  dialog.innerHTML = '<div class="settings-shell"><nav class="settings-nav" aria-label="Settings categories"><input id="settings-search" type="search" placeholder="Search settings…" aria-label="Search settings" autocomplete="off" spellcheck="false"><div id="settings-categories"></div></nav><div class="settings-content" id="settings-content" tabindex="-1"></div><button type="button" class="settings-back" aria-label="All settings">‹ Settings</button><button type="button" class="settings-close" aria-label="Close settings" title="Close (Esc)">×</button></div>';
  document.body.append(dialog);
  const search = dialog.querySelector('#settings-search'), nav = dialog.querySelector('#settings-categories'), content = dialog.querySelector('#settings-content');
  let categories = [], restore = [], selected = null, openSections = new Map();

  function collect() {
    categories = []; restore = []; openSections = new Map();
    for (const {panel, group, kind} of sources) {
      const nodes = [...panel.childNodes]; restore.push({panel, nodes});
      if (kind === 'headings') {
        // Each <h3> starts a category; status shown above them joins indexing.
        let current = null; const leading = [];
        for (const node of nodes) {
          if (node.nodeType === 1 && node.matches('h3')) {current = {title: node.textContent.trim(), group, nodes: [], hidden: node.hidden, panelClass: 'settings-options'}; categories.push(current); continue;}
          if (current) current.nodes.push(node); else leading.push(node);
        }
        const target = categories.find(c => c.group === group && /workspace/i.test(c.title)) || categories.find(c => c.group === group);
        target?.nodes.unshift(...leading);
      } else {
        const loose = {title: 'General', group, nodes: [], panelClass: 'settings-appearance'};
        for (const node of nodes) {
          if (node.nodeType === 1 && node.matches('details.appearance-section')) {
            openSections.set(node, node.open);
            const host = node.dataset.settingsCategory && categories.find(category => category.title === node.dataset.settingsCategory && !category.hidden);
            if (host) {node.classList.add('settings-merged'); host.nodes.push(node);}
            else categories.push({title: node.querySelector(':scope > summary')?.textContent.trim() || group, group, nodes: [node], panelClass: 'settings-appearance'});
          }
          else loose.nodes.push(node);
        }
        if (loose.nodes.some(node => node.nodeType === 1 || node.textContent.trim())) categories.push(loose);
      }
    }
    categories = categories.filter(category => !category.hidden);
  }
  function build() {
    nav.replaceChildren(); content.replaceChildren();
    let group = null;
    categories.forEach((category, index) => {
      if (category.group !== group) {group = category.group; const heading = document.createElement('div'); heading.className = 'settings-nav-group'; heading.textContent = group; nav.append(heading);}
      const button = document.createElement('button'); button.type = 'button'; button.className = 'settings-nav-item'; button.textContent = category.title; button.dataset.category = String(index);
      nav.append(button);
      const section = document.createElement('section'); section.className = 'settings-category ' + category.panelClass; section.dataset.category = String(index);
      const title = document.createElement('h2'); title.textContent = category.title; section.append(title, ...category.nodes);
      for (const node of category.nodes) if (node.matches?.('details.appearance-section')) node.open = true;
      content.append(section); category.section = section; category.button = button;
    });
  }
  function rows(container) {
    const result = [];
    for (const child of container.children) {
      if (child.matches('h2, summary')) continue;
      if (child.matches(expandable)) result.push(...rows(child)); else result.push(child);
    }
    return result;
  }
  function show(index) {
    selected = index;
    for (const category of categories) {
      const on = String(categories.indexOf(category)) === String(index);
      category.section.hidden = !on; category.button.classList.toggle('active', on); category.button.setAttribute('aria-current', on ? 'page' : 'false');
    }
    content.scrollTop = 0; dialog.dataset.view = 'detail';
  }
  // A group heading shows only while one of its categories is listed.
  function groupHeadings() {
    for (const heading of nav.querySelectorAll('.settings-nav-group')) {
      let item = heading.nextElementSibling, any = false;
      while (item && !item.matches('.settings-nav-group')) {if (!item.hidden) any = true; item = item.nextElementSibling;}
      heading.hidden = !any;
    }
  }
  function filter() {
    const query = search.value.trim().toLowerCase();
    dialog.classList.toggle('settings-searching', !!query);
    for (const element of content.querySelectorAll('.settings-miss')) element.classList.remove('settings-miss');
    if (!query) {for (const category of categories) category.button.hidden = false; groupHeadings(); show(selected ?? 0); return;}
    let first = true;
    for (const category of categories) {
      let previous = false, matches = 0;
      const titleMatch = category.title.toLowerCase().includes(query);
      for (const row of rows(category.section)) {
        const text = (row.textContent + ' ' + [...row.querySelectorAll('input[placeholder]')].map(input => input.placeholder).join(' ')).toLowerCase();
        // A hint stays with the setting it explains.
        const hint = row.matches('p.hint'), hit = titleMatch || text.includes(query) || hint && previous;
        row.classList.toggle('settings-miss', !hit); if (!hint) previous = hit;
        if (hit) {matches++; row.closest('details:not(.appearance-section)')?.setAttribute('open', '');}
      }
      category.section.hidden = !matches; category.button.hidden = !matches;
      category.button.classList.toggle('active', !!matches && first); if (matches) first = false;
    }
    groupHeadings();
    content.scrollTop = 0;
  }
  /** Opens the window, on the category titled `category` when given. */
  function open(category = null) {
    if (dialog.open) return;
    collect(); build();
    for (const {panel} of restore) {const note = document.createElement('p'); note.className = 'hint settings-moved'; note.textContent = 'These settings are open in the Settings window.'; panel.append(note);}
    search.value = ''; dialog.classList.remove('settings-searching');
    const named = category ? categories.findIndex(item => item.title === category) : -1;
    show(named >= 0 ? named : Math.min(selected ?? 0, categories.length - 1));
    // On a phone, start from the list and keep the keyboard closed.
    const phone = isMobileLayout(); if (phone && named < 0) dialog.dataset.view = 'list';
    dialog.showModal(); if (phone) dialog.focus(); else search.focus(); onOpen();
  }
  function close() {
    for (const element of content.querySelectorAll('.settings-miss')) element.classList.remove('settings-miss');
    for (const [node, wasOpen] of openSections) {node.open = wasOpen; node.classList.remove('settings-merged');}
    for (const {panel, nodes} of restore) {panel.querySelector('.settings-moved')?.remove(); panel.append(...nodes);}
    content.replaceChildren(); nav.replaceChildren(); restore = []; categories.forEach(category => {category.section = null; category.button = null;});
  }
  nav.addEventListener('click', event => {const button = event.target.closest('[data-category]'); if (!button) return; if (search.value) {search.value = ''; filter();} show(Number(button.dataset.category));});
  // A merged section's summary is a subheading, not a toggle.
  content.addEventListener('click', event => {if (event.target.closest('.settings-merged > summary')) event.preventDefault();});
  search.addEventListener('input', () => {filter(); if (search.value.trim()) dialog.dataset.view = 'detail';});
  const toList = () => {dialog.dataset.view = 'list'; nav.querySelector('.active')?.focus();};
  dialog.querySelector('.settings-back').onclick = toList;
  // Escape (and a phone's Back) returns from a category to the list first.
  dialog.addEventListener('cancel', event => {if (isMobileLayout() && dialog.dataset.view === 'detail') {event.preventDefault(); toList();}});
  search.addEventListener('keydown', event => {if (event.key === 'Escape' && search.value) {event.preventDefault(); event.stopPropagation(); search.value = ''; filter();}});
  dialog.querySelector('.settings-close').onclick = () => dialog.close();
  dialog.addEventListener('close', close);
  dialog.addEventListener('mousedown', event => {if (event.target === dialog) dialog.close();});
  return {open, close: () => dialog.close(), get isOpen() {return dialog.open;}};
}
