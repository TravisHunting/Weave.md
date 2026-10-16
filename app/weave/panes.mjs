// Split view shows two editor groups side by side. The left group's elements
// keep their ids; the right group is a copy whose per-pane ids end in `-2`.
export const PANE_IDS = ['tab-bar', 'file-tabs', 'new-tab', 'close-tabs', 'welcome', 'note-panel', 'note-warning', 'kanban-view', 'okf-bar', 'article', 'source-editor', 'connections', 'relationships', 'article-resize'];
export const paneId = (id, index) => index ? id + '-2' : id;
const selector = new RegExp('#(' + PANE_IDS.join('|') + ')(?![\\w-])', 'g');
/** Styles written for a per-pane id also apply to the right group's copy;
 * `:is()` keeps the id's specificity, so the cascade is unchanged. */
export const paneStyles = css => css.replace(selector, (_, id) => `:is(#${id},#${id}-2)`);
