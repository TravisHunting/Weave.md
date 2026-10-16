// Phone layout (root data-layout="mobile" while the viewport is narrow). Like
// tabs in the title bar it is layout, not a skin: it works with every skin and
// changes no appearance preference. mobile.css (loaded after the skins) does
// most of the work; this module keeps the state that CSS cannot:
// - The rail and the left sidebar form one drawer that slides over the
//   article; a title-bar button opens it. The right sidebar slides over from
//   the other side. Only one drawer is open at a time, a scrim closes either,
//   and opening an article closes both.
// - The browser's Back (Android's back gesture) first closes the topmost
//   dialog, menu or drawer, then goes Back in the active tab, and only leaves
//   Weave when there is nothing left to go back to.
// - Tab bars slide away while reading down or typing, and return on scrolling up.
// Split view shows only the focused side (CSS); its tabs keep their sides.

// Narrow windows, and phones turned sideways (short, with a touch screen).
export const MOBILE_QUERY = '(max-width: 760px), (pointer: coarse) and (max-height: 500px)';
export const isMobileLayout = () => document.documentElement.dataset.layout === 'mobile';

const MENUS = '#app-menu, #file-menu, #tab-menu, #link-menu, #kanban-menu, #article-menu, .article-context-menu';

export function initMobileLayout({sidebars, back, onChange = () => {}}) {
  const root = document.documentElement, body = document.body, query = matchMedia(MOBILE_QUERY);
  const titlebarStart = document.querySelector('.titlebar-start');
  const toggle = document.createElement('button');
  toggle.id = 'mobile-drawer'; toggle.type = 'button'; toggle.setAttribute('aria-label', 'Show sidebar'); toggle.title = 'Sidebar';
  toggle.setAttribute('aria-controls', 'sidebar'); toggle.setAttribute('aria-expanded', 'false');
  toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  toggle.onclick = () => {if (sidebars.leftOpen) sidebars.collapse(); else sidebars.select('left', sidebars.leftPanel);};
  const scrim = document.createElement('div'); scrim.id = 'mobile-scrim'; scrim.hidden = true;
  scrim.onclick = () => closeDrawers();
  let mobile = false, last = {left: false, right: false};

  function closeDrawers() {
    if (sidebars.rightOpen) sidebars.closeRight();
    if (sidebars.leftOpen) sidebars.collapse();
  }
  // One drawer at a time: the one just opened wins.
  function sync() {
    if (!mobile) return;
    const left = sidebars.leftOpen, right = sidebars.rightOpen;
    if (left && right) {if (last.left) sidebars.collapse(); else sidebars.closeRight(); return;}
    last = {left, right};
    scrim.hidden = !left && !right; toggle.setAttribute('aria-expanded', String(left));
    // A drawer opened by the page itself (Files at start-up) waits for the first touch.
    if ((left || right) && navigator.userActivation?.hasBeenActive !== false) guard();
  }
  new MutationObserver(sync).observe(body, {attributes: true, attributeFilter: ['class']});

  function apply() {
    const next = query.matches;
    if (next === mobile) return;
    mobile = next;
    // Drawers slide only once the layout has settled, not while it changes.
    root.dataset.layoutSettling = ''; requestAnimationFrame(() => requestAnimationFrame(() => delete root.dataset.layoutSettling));
    if (mobile) {
      root.dataset.layout = 'mobile';
      titlebarStart.prepend(toggle); document.querySelector('.shell').append(scrim); // inside the drawers' stacking context
      // Open on the article: a drawer left open on a wide window would cover it.
      closeDrawers(); last = {left: false, right: false}; sync();
    } else {
      delete root.dataset.layout; toggle.remove(); scrim.remove(); scrim.hidden = true;
    }
    onChange(mobile);
  }
  query.addEventListener('change', apply);

  // Back closes what is open before it leaves the page. A guard entry sits on
  // top of the history; Back pops it and the page handles the step, then puts
  // the guard back. Browsers skip entries added without a user gesture, so the
  // guard is placed on the first touch rather than at load.
  // The guard carries the shown article's address (addressChanged), so
  // putting the guard back after a Back step keeps the address current.
  let guarded = false, shown = location.href;
  function guard() {if (mobile && !guarded) {history.pushState({weaveGuard: true}, '', shown); guarded = true;}}
  addEventListener('pointerdown', guard, true);
  function closeTopmost() {
    const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
    if (dialog) {
      const cancel = new Event('cancel', {cancelable: true});
      if (dialog.dispatchEvent(cancel)) dialog.close();
      return true;
    }
    if ([...document.querySelectorAll(MENUS)].some(menu => !menu.hidden)) {
      document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
      return true;
    }
    if (sidebars.leftOpen || sidebars.rightOpen) {closeDrawers(); return true;}
    return false;
  }
  addEventListener('popstate', () => {
    if (!guarded) return;
    guarded = false;
    if (!mobile) return;
    if (closeTopmost() || back()) {guard(); return;}
    history.back();
  });

  // Like a phone browser's toolbar, each side's tab bar slides away while its
  // article is read downwards or typed in, and returns on scrolling up or at
  // the top. Hiding it resizes the scroller, which can clamp its position near
  // the end, so scrolls are ignored until the bar has finished moving.
  const lastTop = new WeakMap(), settleUntil = new WeakMap();
  function setTabs(group, hidden) {
    if (group.hasAttribute('data-tabs-hidden') === hidden) return;
    group.toggleAttribute('data-tabs-hidden', hidden); settleUntil.set(group, performance.now() + 350);
  }
  const showTabs = () => {for (const group of document.querySelectorAll('.editor-group[data-tabs-hidden]')) setTabs(group, false);};
  addEventListener('scroll', event => {
    const target = event.target;
    if (!mobile || !(target instanceof Element)) return;
    const group = target.closest('.editor-group'); if (!group || target.closest('[id^="graph-panel"]')) return;
    const top = target.scrollTop, delta = top - (lastTop.get(target) ?? top); lastTop.set(target, top);
    if (performance.now() < (settleUntil.get(group) || 0)) return;
    if (top <= 8) setTabs(group, false);
    else if (delta > 4) setTabs(group, true);
    else if (delta < -4) setTabs(group, false);
  }, {capture: true, passive: true});
  // Typing hides it as well; leaving the editor brings it back, since a short article cannot be scrolled up.
  const editorOf = target => target instanceof Element ? target.closest('.editor-group .cm-editor') : null;
  addEventListener('beforeinput', event => {if (mobile && editorOf(event.target)) setTabs(event.target.closest('.editor-group'), true);}, true);
  addEventListener('focusout', event => {const editor = editorOf(event.target); if (mobile && editor && !editor.contains(event.relatedTarget)) setTabs(editor.closest('.editor-group'), false);}, true);
  query.addEventListener('change', () => {if (!mobile) showTabs();});

  apply();
  return {
    get active() {return mobile;},
    /** An article or Deep search is being shown: put the drawers away so it can be read. */
    dismiss() {if (mobile) {closeDrawers(); showTabs();}},
    /** The address changed to name the shown article. */
    addressChanged() {shown = location.href;},
  };
}
