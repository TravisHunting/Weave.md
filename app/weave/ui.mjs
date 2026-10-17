import {articleScrollbar} from './article-scrollbar.mjs';
import {serverSettings} from './server-settings.mjs';
import {createClient} from './client.mjs';
import {createGraph} from './graph-view.mjs';
import {renderNote, esc} from './render.mjs';
import {LiveEditor, literalMatches} from './live-editor.mjs';
import {createGitPanel} from './git-ui.mjs';
import {openGitSetup} from './git-setup.mjs';
import {initAppearance} from './appearance.mjs';
import {createSidebars} from './sidebars.mjs';
import {retitleArticle} from './article-title.mjs';
import {articlePresentation} from './presentation.mjs';
import {highlightSearch} from './search-highlight.mjs';
import {hiddenFolderPaths, folderIsHidden, moveHiddenFolders} from './folder-visibility.mjs';
import {searchHighlightQuery} from './search-query.mjs';
import {createOkfBar} from './okf-bar.mjs';
import {createFrontmatter, splitFrontmatter, stampArticle} from './okf.mjs';
import {createSettingsDialog} from './settings-dialog.mjs';
import {englishVariant, localizeMarked, localizeText, ui} from './locale.mjs';
import {createSpellChecker} from './spellcheck.mjs';
import {formatCommands, clearFormatting, setBlockFormat, insertMarkdownLink, insertHorizontalRule, insertCodeBlock} from './editor-formatting.mjs';
import {PANE_IDS, paneId} from './panes.mjs';
import {randomId} from './platform.mjs';
import {createKanban} from './kanban-ui.mjs';
import {CatalogIndex} from './catalog-index.mjs';
import {pasteText, hasFormatting} from './paste-markdown.mjs';
import {initTitlebarTabs} from './titlebar-tabs.mjs';
import {initMobileLayout} from './mobile.mjs';

const $ = id => document.getElementById(id), client = await createClient();
const serverControls = serverSettings(client, $, {choose: () => choose()});
// A portable workspace export is a fixed, read-only library: no opening other folders or files.
const pageData = JSON.parse($('weave-data').textContent || '{}'), portable = pageData.portable === true, graphFeature = pageData.features?.graph !== false;
// Split view (left and right): the right editor group copies the left one's tab
// bar, welcome and article pane, with `-2` ids (panes.mjs).
{
  const group = document.createElement('div'); group.className = 'editor-group'; group.id = 'editor-right'; group.dataset.pane = '1'; group.hidden = true;
  for (const id of ['tab-bar', 'welcome', 'note-panel']) {
    const copy = $(id).cloneNode(true);
    for (const node of copy.querySelectorAll('#welcome-open, #welcome-recent, #welcome-available')) node.remove();
    for (const node of [copy, ...copy.querySelectorAll('[id]')]) if (PANE_IDS.includes(node.id)) node.id = paneId(node.id, 1); else node.removeAttribute('id');
    group.append(copy);
  }
  const divider = document.createElement('div'); divider.id = 'split-resize'; divider.hidden = true; divider.tabIndex = 0; divider.setAttribute('role', 'separator'); divider.setAttribute('aria-orientation', 'vertical'); divider.setAttribute('aria-label', 'Resize split view');
  $('editor-left').after(divider, group);
}
for (const element of document.querySelectorAll('[data-capability]')) element.hidden = !client.capabilities[element.dataset.capability];
document.querySelector('[data-panel="git"]').hidden = !client.capabilities.git;
if (pageData.mode === 'server') $('choose-workspace').textContent = 'Open server workspace…';
if (portable) $('choose-workspace').hidden = true;
$('create-workspace').hidden = portable || !client.writable || !client.createWorkspace;
$('menu-git-setup').hidden = portable || !client.writable || !client.capabilities.git;
if (!graphFeature) {for (const id of ['toggle-graph', 'view-graph']) $(id).hidden = true; for (const index of [0, 1]) $(paneId('connections', index)).hidden = true;}
if (portable && pageData.root) document.title = pageData.root + ' · Weave';
if (portable) document.documentElement.style.setProperty('--sidebar', '180px');
// Exports show file extensions unless the reader chose otherwise.
const showExtensions = () => (prefs.get('show-extensions') ?? String(portable)) === 'true';
const prefs = {get(key) {try {return localStorage.getItem('weave:' + key);} catch {return null;}}, set(key, value) {try {localStorage.setItem('weave:' + key, value);} catch {}}};
let active = null, selected = '', selectedWs = null, focusKey = null, dirty = false, saving = null, saveTimer, pollBusy = false;
let edit = client.writable && prefs.get('edit') === 'true', sidebars, showGraph = portable && graphFeature /* exports open articles with the graph showing, so first-time readers see it */, openSerial = 0, searchSerial = 0, evidenceSerial = 0;
let tabs = [], activeTab = null, source = false, showArticle = true, sessionWrite = Promise.resolve(), layoutPersisted = '';
// Kanban boards, the Kanban sidebar and card previews (kanban-ui.mjs).
let kanban = null;
// Open workspaces in display order. Each has its own catalog, graph, Files tree
// state and Git panel; desktop requests are bound to the workspace's scope.
let workspaces = [];
// Each editor group ("pane") has its own tabs, editor, Back/Forward histories and
// reading positions. The focused pane's state is held in the variables above
// (tabs, activeTab, active, source, live, raw, okfBar); the other pane keeps its
// own copy in its pane object until `focusPane` swaps them. Only the focused pane
// holds unsaved text: leaving it hands the changes to the other side when that
// shows the same article, or keeps them as a draft.
const panes = [$('editor-left'), $('editor-right')].map((group, index) => ({index, group, el: Object.fromEntries(PANE_IDS.map(id => [id, $(paneId(id, index))])), tabs: [], activeTab: null, active: null, source: false}));
let P = panes[0], split = false, sides = [panes[0], panes[1]], graphPane = P, evidencePane = P;
/** An element of the focused pane, by its left-pane id. */
const $p = id => P.el[id];
const paneTabs = pane => pane === P ? tabs : pane.tabs;
const paneTabId = pane => pane === P ? activeTab : pane.activeTab;
const paneActive = pane => pane === P ? active : pane.active;
const paneSource = pane => pane === P ? source : pane.source;
const paneWs = pane => {const doc = paneActive(pane); return doc && !doc.external ? wsByKey(doc.ws) : null;};
const paneOfTab = id => panes.find(pane => paneTabs(pane).some(tab => tab.id === id)) || null;
const paneAt = node => panes[Number(node?.closest?.('.editor-group')?.dataset.pane)] || null;
const otherPane = () => split ? panes.find(pane => pane !== P) : null;
const shownPanes = () => split ? sides : [P];
const allTabs = () => panes.flatMap(paneTabs);
const docKey = doc => doc ? draftKey(doc.external ? null : doc.ws, doc.path) : null;
const currentTab = () => tabs.find(tab => tab.id === activeTab);
const workspaceKey = value => client.capabilities.resources ? value.workspace?.id || value.root : value.root;
const wsByKey = key => key ? workspaces.find(ws => ws.key === key) || null : null;
const multi = () => workspaces.length > 1;
/** The workspace of the open article, or null for an external file. */
const activeWs = () => active && !active.external ? wsByKey(active.ws) : null;
/** The workspace the user is working in: the active tab's, else the last one used. */
const current = () => wsByKey(currentTab()?.ws) || wsByKey(focusKey) || workspaces[0] || null;
const workspaceName = ws => ws?.catalog.workspace?.label || ws?.catalog.workspace?.name || ws?.catalog.root.split(/[\\/]/).filter(Boolean).at(-1) || 'Workspace';
const workspaceColor = ws => /^#[0-9a-f]{6}$/i.test(ws?.catalog.workspace?.color || '') ? ws.catalog.workspace.color : '#7c8594';
const withWs = (doc, ws) => ({...doc, ws: ws.key});
// Unsaved text of articles that are not in the editor, keyed by workspace and
// path. With autosave off, leaving an article keeps its changes here until saved.
const drafts = new Map(), draftKey = (wsKey, path) => (wsKey || '') + '\n' + path;
const activeKey = () => active ? draftKey(active.external ? null : active.ws, active.path) : null;
// Autosave after a pause in typing is the default (650 ms).
const autosaveMode = () => ['off', 'delay', 'leave'].includes(prefs.get('autosave')) ? prefs.get('autosave') : 'delay';
const autosaveDelay = () => Math.max(100, Math.min(60000, Math.round(Number(prefs.get('autosave-delay-ms'))) || 650));
const tabKey = tab => draftKey(isExternal(tab.path) ? null : tab.ws, tab.path);
const tabUnsaved = tab => !!tab.path && (dirty && tabKey(tab) === activeKey() || drafts.has(tabKey(tab)));
// The unsaved dot appears only when changes stay unsaved for over a second, so
// ordinary autosaves do not make it flicker; drafts left with autosave off show at once.
const DOT_DELAY = 1000; let dirtySince = 0, dotTimer;
const draftShowsDot = draft => !!draft && (autosaveMode() === 'off' || Date.now() - (draft.since || 0) >= DOT_DELAY);
const tabShowsDot = tab => !!tab.path && (dirty && tabKey(tab) === activeKey() && Date.now() - dirtySince >= DOT_DELAY || draftShowsDot(drafts.get(tabKey(tab))));
function scheduleSave() {clearTimeout(saveTimer); if (autosaveMode() === 'delay') saveTimer = setTimeout(run(save), autosaveDelay());}
// A tab's history entries name their workspace (draftKey: workspace key, or
// none for an external file), so one tab can move between workspaces.
const makeTab = (file = null, ws = null) => ({id: randomId(), ws, path: file, history: file ? [draftKey(ws, file)] : [], at: file ? 0 : -1});
const entryParts = entry => {const i = entry.indexOf('\n'); return {ws: entry.slice(0, i) || null, path: entry.slice(i + 1)};};
const entryAvailable = entry => {if (!entry) return false; const {ws, path} = entryParts(entry); return ws ? !!wsByKey(ws) : isExternal(path) && externalDocs.has(path);};
function setTabAt(tab, at) {tab.at = at; const entry = tab.history[at]; if (entry) {const {ws, path} = entryParts(entry); tab.ws = ws; tab.path = path;}}
/** History positions that Back/Forward can visit: entries of deactivated
 * workspaces are skipped (they return when the workspace is reactivated). */
function nextAvailable(tab, direction) {for (let i = tab.at + direction; i >= 0 && i < tab.history.length; i += direction) if (entryAvailable(tab.history[i])) return i; return -1;}
/** A tab showing a deactivated workspace moves to its nearest available entry;
 * a tab with none is hidden until that workspace is active again. */
function settleTabs() {
  for (const tab of allTabs()) {
    if (!tab.path || entryAvailable(tab.history[tab.at])) continue;
    const at = [nextAvailable(tab, -1), nextAvailable(tab, 1)].find(i => i >= 0);
    if (at !== undefined) setTabAt(tab, at);
  }
}
const tabVisible = tab => tab.path ? entryAvailable(tab.history[tab.at]) : !tab.ws || !!wsByKey(tab.ws);
const visibleTabs = (pane = P) => paneTabs(pane).filter(tabVisible);
const titles = (ws = activeWs() || current()) => ws?.index?.titles || new Map();
// Files opened with Ctrl+O or dropped on the window live outside the workspace:
// their tabs use an `external:` key, are never indexed, searched or graphed,
// and are not restored with the workspace session.
const EXTERNAL = 'external:', isExternal = file => typeof file === 'string' && file.startsWith(EXTERNAL), externalDocs = new Map();
const canEditDoc = doc => edit && client.writable && (!doc?.external || doc.writable);
const canEdit = () => canEditDoc(active);
// Underlining with <u> tags is optional (Settings › Editing) and off by default.
const underlineEnabled = () => prefs.get('underline') === 'true';
// Spell checking (desktop, while editing): nspell with the embedded Hunspell
// dictionary for the system's English, or the one chosen in Settings.
const dictionaries = (() => {try {return JSON.parse($('weave-dictionaries')?.textContent || 'null');} catch {return null;}})();
const spellAvailable = !!dictionaries && client.writable;
const spellVariant = () => ['en-GB', 'en-US'].includes(prefs.get('spell-dictionary')) ? prefs.get('spell-dictionary') : englishVariant();
let spellChecker = null, spellCheckerVariant = null, spellIgnoredWords = null;
const spellIgnored = () => spellIgnoredWords ||= new Set((() => {try {return JSON.parse(prefs.get('spell-ignored') || '[]');} catch {return [];}})().filter(word => typeof word === 'string'));
function spellingConfig() {
  if (!spellAvailable || prefs.get('spell-enabled') === 'false' || spellCheckerVariant !== spellVariant()) return null;
  return {checker: spellChecker, prose: prefs.get('spell-prose') !== 'false', code: prefs.get('spell-code') === 'true', waitForWord: prefs.get('spell-wait') !== 'false', ignored: spellIgnored()};
}
/** Loads the dictionary (about 70 ms) when the app is idle, then re-checks. */
function loadSpelling() {
  if (!spellAvailable || prefs.get('spell-enabled') === 'false' || spellCheckerVariant === spellVariant()) {refreshSpelling(); return;}
  const variant = spellVariant(), idle = window.requestIdleCallback || (callback => setTimeout(callback, 50));
  idle(() => {if (variant !== spellVariant()) return; spellChecker = createSpellChecker(dictionaries[variant]); spellCheckerVariant = variant; refreshSpelling();});
}
const paneEditors = () => panes.flatMap(pane => [pane.live, pane.raw]);
function refreshSpelling() {for (const editor of paneEditors()) editor.refreshSpelling();}
// Each pane's editors resolve links against the article that pane shows.
for (const pane of panes) {
  const ws = () => paneWs(pane), options = {spelling: spellingConfig, underline: underlineEnabled, paths: () => ws()?.index || [], titles: () => titles(ws() || current()), caseSensitive: () => ws()?.catalog.caseSensitive, sourcePath: () => paneActive(pane)?.path || '', changed: () => {if (pane !== P) return; setDirty(true); scheduleSave(); scheduleMirror();}};
  pane.live = new LiveEditor(pane.el.article, {...options, workspace: () => ws()?.catalog.root || ''});
  pane.raw = new LiveEditor(pane.el['source-editor'], {...options, raw: true});
  pane.okfBar = createOkfBar(pane.el['okf-bar'], {editor: () => pane.live, path: () => paneActive(pane)?.path || '', visible: () => !!paneActive(pane) && !paneSource(pane), editable: () => canEditDoc(paneActive(pane)), message: text => message(text)});
}
let live = P.live, raw = P.raw, okfBar = P.okfBar;
$p('note-panel').parentNode.insertBefore($('graph-panel'), $p('note-panel'));
// The desktop CSP adds hashes to style-src, so browsers ignore inline style
// attributes. Workspace colours are written as data attributes and applied through
// the CSSOM, which CSP does not restrict.
const paintWorkspaceColors = root => {for (const node of [root, ...root.querySelectorAll?.('[data-workspace-color]') || []]) if (node.dataset?.workspaceColor) node.style.setProperty('--workspace-color', node.dataset.workspaceColor);};
new MutationObserver(records => {for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) paintWorkspaceColors(node);}).observe(document.body, {childList: true, subtree: true});
function message(text) { $('message').textContent = text; }
const run = fn => (...args) => {try {return Promise.resolve(fn(...args)).catch(e => message(e.message || String(e)));} catch (e) {message(e.message || String(e));}};
// The article pane scrolls; with the graph above it, its editor group does.
for (const pane of panes) {articleScrollbar(pane.el['note-panel'], pane.el.article); articleScrollbar(pane.group, pane.el['note-panel']);}
// Source control: one expandable section per open workspace.
const gitList = document.createElement('div'); gitList.id = 'git-workspaces'; $('git-panel').append(gitList);
let gitPanelCount = 0, gitSectionsShown = 0;
function createWorkspaceGit(ws) {
  const section = document.createElement('details'); section.className = 'git-workspace'; section.dataset.ws = ws.key;
  section.innerHTML = '<summary><span class="workspace-dot" aria-hidden="true"></span><span class="git-workspace-name"></span><span class="git-workspace-incoming" hidden></span><span class="git-workspace-count" hidden></span></summary><div class="git-workspace-body"></div>';
  ws.gitSection = section; ws.gitCount = 0; ws.gitBusy = false; ws.gitIncoming = 0; ws.incomingFiles = new Set();
  ws.git = createGitPanel({client: ws.api, container: section.querySelector('.git-workspace-body'), idSuffix: gitPanelCount++ ? '-' + gitPanelCount : '',
    openFile: file => openNote(file, null, {ws}),
    currentPath: () => active?.ws === ws.key && active.path ? active.path : null,
    onPendingCount: count => {ws.gitCount = count; renderGitSections();},
    onBusy: busy => {ws.gitBusy = busy; $('git-panel').setAttribute('aria-busy', String(workspaces.some(w => w.gitBusy)));},
    onStatus: state => {
      ws.gitIncoming = state?.repository ? state.behind || 0 : 0; ws.incomingFiles = new Set(state?.repository ? state.incomingFiles || [] : []);
      renderGitSections(); updateIncoming(); renderWelcome();
    },
    onSetup: () => run(setupGit)(ws),
    beforeAction: async () => {
      if (!workspaces.includes(ws)) throw new Error('This workspace is inactive.');
      if (!await ensureDraftsSaved(key => key.startsWith(ws.key + '\n'), 'using Git')) throw new Error('Save or discard unsaved articles before using Git.');
      if (dirty || saving) throw new Error('Finish saving the current article before continuing.');
    },
    afterMutation: async name => {
      await applyCatalog(ws, await ws.api.call('catalog'));
      if (active?.ws === ws.key && ['pull','sync','switch','createBranch','stash','applyStash','discard','resolveConflict','restoreFile','restoreSnapshot'].includes(name)) {
        if (dirty || saving) {$p('note-warning').textContent = 'Git changed this workspace. Your draft is retained; save or reload after reviewing the changes.'; return;}
        if (ws.index.has(active.path)) await openNote(active.path, undefined, {record:false, ws});
        else $p('note-warning').textContent = 'This article is absent from the current Git version. Its open text is retained.';
      }
      await reloadChangedPanes(ws);
    }
  });
  section.addEventListener('toggle', () => {if (section.open) void ws.git.refresh({quiet:true});});
}
function renderGitSections() {
  let total = 0;
  for (const ws of workspaces) {
    gitList.append(ws.gitSection); total += ws.gitCount;
    ws.gitSection.style.setProperty('--workspace-color', workspaceColor(ws));
    ws.gitSection.querySelector('.git-workspace-name').textContent = workspaceName(ws);
    ws.gitSection.querySelector('summary').title = ws.catalog.root;
    const incoming = ws.gitSection.querySelector('.git-workspace-incoming'); incoming.hidden = !ws.gitIncoming; incoming.textContent = '↓' + ws.gitIncoming; incoming.title = ws.gitIncoming + ' incoming ' + (ws.gitIncoming === 1 ? 'commit' : 'commits') + ' to pull';
    const count = ws.gitSection.querySelector('.git-workspace-count'); count.hidden = !ws.gitCount; count.textContent = String(ws.gitCount); count.title = ws.gitCount + ' pending ' + (ws.gitCount === 1 ? 'file' : 'files');
  }
  // A single workspace's section opens by default.
  if (workspaces.length === 1 && gitSectionsShown !== 1) workspaces[0].gitSection.open = true;
  gitSectionsShown = workspaces.length;
  let hint = gitList.querySelector(':scope > .hint');
  if (!workspaces.length && !hint) {hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = client.capabilities.git ? 'Open a workspace to manage its Git repository.' : 'Source control is available in the desktop application.'; gitList.append(hint);}
  if (workspaces.length) hint?.remove();
  const badge = $('git-pending-badge');
  const behind = workspaces.reduce((sum, ws) => sum + (ws.gitIncoming || 0), 0), incomingBadge = $('git-incoming-badge');
  if (incomingBadge) {incomingBadge.textContent = '↓' + behind; incomingBadge.hidden = !behind;}
  if (badge) {badge.textContent = String(total); badge.hidden = !total; badge.parentElement.title = ['Source control', total ? total + ' pending ' + (total === 1 ? 'file' : 'files') : '', behind ? behind + ' incoming ' + (behind === 1 ? 'commit' : 'commits') + ' to pull' : ''].filter(Boolean).join(' · ');}
}
/** Expands the Git section of the workspace whose article is active; others collapse. */
function focusGitSection(ws) {
  if (!ws || !multi()) return;
  for (const other of workspaces) other.gitSection.open = other === ws;
}
function addWorkspace(next) {
  const key = workspaceKey(next); let ws = wsByKey(key);
  if (!ws) {
    ws = {key, catalog: next, status: next.status, api: client.bind ? client.bind(next) : client, graphData: {entities: [], relationships: []}, expanded: new Set(), treeLimit: 1000, persisted: '', lastTab: null};
    workspaces.push(ws); createWorkspaceGit(ws);
    // A folder export starts with the folders every article shares expanded.
    if (portable) {const paths = next.tree.files.map(f => f.path.split('/').slice(0, -1)); for (let i = 1; paths.length && paths.every(parts => parts.length >= i && parts[i - 1] === paths[0][i - 1]); i++) ws.expanded.add(paths[0].slice(0, i).join('/'));}
  }
  setCatalog(ws, next);
  return ws;
}
/** Adopts a full catalog: the index of its paths and titles is built once here
 * and then kept current by catalog deltas. */
function setCatalog(ws, next) {
  // A large workspace's catalog leaves its file list out (`tree.partial`); it
  // follows in pages (`loadPartialTrees`). A list already shown stays until then.
  if (next.tree?.partial && ws.index && !ws.partial) ws.stale = true;
  else if (ws.catalog !== next || !ws.index) {ws.index = new CatalogIndex(next.tree, {caseSensitive: next.caseSensitive}); ws.partial = next.tree?.partial === true;}
  ws.catalog = next; ws.revision = next.revision; ws.status = next.status || ws.status;
}
let loadingTrees = null;
/** Loads the file lists a catalog left out, after the first articles are shown. */
function loadPartialTrees() {
  return loadingTrees ||= (async () => {
    try {for (const ws of [...workspaces]) if (ws.partial || ws.stale) await loadTree(ws);}
    finally {loadingTrees = null;}
  })();
}
/** Builds a workspace's file list from pages of 20,000 rows, yielding between
 * pages, then swaps it in: a large list never blocks the interface. */
async function loadTree(ws) {
  const index = new CatalogIndex({}, {caseSensitive: ws.catalog.caseSensitive});
  let after = '', revision = null;
  for (;;) {
    const page = await ws.api.call('catalogPage', {after, limit: 20000}); if (!workspaces.includes(ws)) return;
    revision ??= page.revision; index.apply(page.tree);
    if (!page.next) break;
    after = page.next; await new Promise(resolve => setTimeout(resolve));
  }
  Object.assign(ws, {index, partial: false, stale: false, revision});
  // Changes made while loading arrive with the next change event or poll.
  renderTree(); renderTabs(); updatePath(); refreshLinks(ws); void kanban?.workspaceChanged(ws);
}
/** Open articles of `ws` draw their links again (paths were added or removed). */
function refreshLinks(ws) {for (const pane of shownPanes()) if (paneWs(pane) === ws) {pane.live.refreshLinks(); pane.raw.refreshLinks();}}
/** `confirmKeys`: Enter and Space always choose the primary button, wherever
 * focus is, so the secondary choice (such as not updating links) needs a click.
 * `choices` (up to two) adds selects: {label, options: [{value, label}], value};
 * a second select can list `optionsFor(first value)`. Their values are returned. */
function promptUser(title, description, {value, ok = 'Continue', secondary, confirmKeys = false, choices = []} = {}) {
  return new Promise(resolve => {
    const dialog = $('prompt-dialog'); $('prompt-title').textContent = title; $('prompt-description').textContent = description;
    const selects = ['prompt-choice', 'prompt-choice-2'].map((id, index) => {
      const choice = choices[index], select = $(id); $(id + '-label').hidden = !choice;
      const fill = (options, chosen) => {select.innerHTML = options.map(option => `<option value="${esc(option.value)}">${esc(option.label)}</option>`).join(''); if (chosen !== undefined) select.value = chosen;};
      if (choice) {$(id + '-text').textContent = choice.label; fill(choice.options, choice.value);}
      return {select, choice, fill};
    });
    selects[0].select.onchange = () => {const next = selects[1]; if (next.choice?.optionsFor) next.fill(next.choice.optionsFor(selects[0].select.value));};
    // Listen on the document: Tab can move focus out of the dialog's buttons.
    const confirm = event => {if ((event.key === 'Enter' || event.key === ' ') && !event.isComposing && dialog.open) {event.preventDefault(); event.stopPropagation(); dialog.close('ok');}};
    if (confirmKeys) document.addEventListener('keydown', confirm, true);
    $('prompt-value').hidden = value === undefined; $('prompt-value').value = value || ''; $('prompt-ok').textContent = ok;
    $('prompt-secondary').hidden = !secondary; $('prompt-secondary').textContent = secondary || '';
    $('prompt-value').onkeydown = event => {if (event.key === 'Enter' && !event.isComposing) {event.preventDefault(); dialog.close('ok');}};
    dialog.returnValue = 'cancel'; dialog.onclose = () => {document.removeEventListener('keydown', confirm, true); resolve({action: dialog.returnValue, value: $('prompt-value').value.trim(), choices: selects.filter(item => item.choice).map(item => item.select.value)});}; dialog.showModal();
    if (value !== undefined) { $('prompt-value').focus(); $('prompt-value').select(); }
    else if (choices.length) selects[0].select.focus();
    else $('prompt-ok').focus();
  });
}
const count = (value, noun) => (value || 0) + ' ' + noun + ((value || 0) === 1 ? '' : 's');
function setDirty(value) { if (value && !dirty) warnIncoming(); if (value && !dirty) {dirtySince = Date.now(); clearTimeout(dotTimer); dotTimer = setTimeout(updateTabDots, DOT_DELAY + 20);} if (!value) clearTimeout(dotTimer); dirty = value; client.dirty(dirty || drafts.size > 0)?.catch?.(() => {}); $('save-status').textContent = value ? 'Unsaved' : drafts.size ? count(drafts.size, 'other unsaved article') : 'Saved'; updateTabDots(); updateIncoming(); }
/** The open article's fetched incoming changes that are not pulled yet: a
 * banner above it, which becomes a warning once it is being edited. */
function updateIncoming() {
  for (const pane of panes) {
    const doc = paneActive(pane), ws = paneWs(pane), banner = pane.el['incoming-banner'];
    const status = ws?.git?.status, incoming = !!(doc && ws?.incomingFiles?.has(doc.path));
    // Unsaved, drafted or saved-but-uncommitted edits all risk a merge conflict.
    const editing = incoming && ((pane === P ? dirty : drafts.has(docKey(doc))) || !!status?.files?.some(file => file.path === doc.path));
    banner.hidden = !incoming; banner.classList.toggle('editing', editing); if (!incoming) continue;
    const upstream = status?.upstream || 'the remote', blocked = editing || !!status?.files?.length || status?.ahead > 0;
    banner.querySelector('.incoming-text').textContent = editing
      ? `You are changing an article that also changed on ${upstream}, and those changes are not pulled yet. This can lead to a merge conflict: commit and sync in Source control to combine them.`
      : `${upstream} has newer changes to this article that are not pulled yet. Pull before editing to avoid a merge conflict.`;
    banner.querySelector('[data-incoming="pull"]').disabled = blocked || ws.gitBusy;
    banner.querySelector('[data-incoming="pull"]').title = blocked ? 'This workspace has its own changes or commits: use Commit all & sync in Source control to combine them.' : 'Pull the incoming changes into this workspace';
  }
}
const warnedIncoming = new Set();
/** Warns once per fetched version when editing starts on an article with incoming changes. */
function warnIncoming() {
  const ws = paneWs(P), status = ws?.git?.status;
  if (!active || !ws?.incomingFiles?.has(active.path)) return;
  const key = [ws.key, active.path, status.upstream, status.behind].join('\n'); if (warnedIncoming.has(key)) return;
  warnedIncoming.add(key); message(`${active.path} has incoming changes on ${status.upstream} that are not pulled yet. Pull first to avoid a merge conflict.`);
}
/** A dot replaces the close button of a tab whose article has unsaved changes. */
function updateTabDots() {
  for (const node of panes.flatMap(pane => [...pane.el['file-tabs'].querySelectorAll('[data-tab-id]')])) {
    const tab = allTabs().find(t => t.id === node.dataset.tabId), unsaved = !!tab && tabShowsDot(tab), close = node.querySelector('.close-tab');
    node.classList.toggle('unsaved', unsaved);
    if (close) close.title = unsaved ? 'Unsaved changes. Close' : 'Close';
  }
}
function updateMode() {
  $('edit-mode').textContent = 'Edit'; $('edit-mode').setAttribute('aria-pressed', String(edit)); $('edit-mode').title = edit ? 'Editing enabled' : 'Editing disabled'; $('edit-mode').setAttribute('aria-label', edit ? 'Edit — enabled' : 'Edit — disabled');
  $('edit-mode').disabled = !client.writable;
  for (const control of document.querySelectorAll('[data-mutation]')) control.disabled = !edit || !workspaces.length;
  $('save').disabled = !canEdit() || !active; $('source-mode').disabled = $('reload-note').disabled = !active;
  $('source-mode').setAttribute('aria-pressed', String(source)); $('source-mode').setAttribute('aria-checked', String(source));
  $('source-toggle').disabled = !active; $('source-toggle').setAttribute('aria-pressed', String(source)); $('source-toggle').title = source ? 'Show the formatted article' : 'Show the Markdown source';
  for (const pane of panes) {
    const editable = canEditDoc(paneActive(pane)), inSource = paneSource(pane);
    pane.live.setEnabled(editable); pane.raw.setEnabled(editable);
    pane.el['source-editor'].hidden = !inSource; pane.el.article.hidden = inSource;
    pane.okfBar.render();
  }
  (source ? raw : live).requestMeasure();
  document.body.classList.toggle('editing', edit);
  $('format-underline').hidden = !underlineEnabled();
}
function updateStatus(status) {
  // A first index of a large workspace reports its progress; searches meanwhile cover what is indexed.
  const progress = status.progress?.total ? ` · Indexing ${Math.min(100, Math.floor(100 * status.progress.indexed / status.progress.total))}%` : '';
  $('index-status').textContent = `${count(status.documents, 'article')} · ${count(status.relationships, 'link')} · ${status.unresolved || 0} broken` + (client.capabilities.fts ? ` · Search: ${status.search || 'indexing'}` : ' · Local text search') + progress;
  $('diagnostics').textContent = JSON.stringify(status, null, 2);
  if (status.lastError) message(status.lastError);
  renderOperation(status);
}
function collapseSidebar() {
  sidebars.collapse();
}
function setPanel(next, {toggle = false} = {}) {
  sidebars.select('left', next, {toggle});
}
function folderPreferences(ws) {
  let hiddenFolders = [];
  try {hiddenFolders = hiddenFolderPaths(JSON.parse(prefs.get('hidden-folders:' + ws.key)));} catch {}
  return {hiddenFolders, hideDotFolders:prefs.get('hide-dot-folders') !== 'false', showHiddenFolders:prefs.get('show-hidden-folders:' + ws.key) === 'true'};
}
function storeHiddenFolders(ws, folders) {prefs.set('hidden-folders:' + ws.key, JSON.stringify(hiddenFolderPaths(folders)));}
function treeRows(ws) {
  const catalog = ws.catalog, visibility = folderPreferences(ws), titleMap = titles(ws), allFiles = prefs.get('show-all-files') === 'true';
  let html = '', count = 0, total = 0;
  const walk = (parent = '', depth = 0) => {
    for (const item of ws.index.childrenOf(parent)) {
      if (item.other && !allFiles) continue;
      const hiddenFolder = item.folder && folderIsHidden(item.path, visibility, catalog.caseSensitive);
      if (hiddenFolder && !visibility.showHiddenFolders) continue;
      const filename = item.path.split('/').at(-1), name = item.folder || showExtensions() ? filename : filename.replace(/\.[^.]+$/, '');
      const title = titleMap.get(item.path) || item.title || name, mode = prefs.get('file-labels') || 'title-first';
      const labels = item.folder || mode === 'filename' ? [name] : mode === 'title-first' ? [title, name] : mode === 'filename-first' ? [name, title] : [title];
      const board = !item.folder && !!kanban?.isBoard(ws, item.path);
      total++; if (count++ < ws.treeLimit) html += `<button class="tree-row ${item.folder ? 'tree-folder' : ''} ${board ? 'tree-board' : ''} ${hiddenFolder ? 'tree-hidden-folder' : ''} ${selected === item.path && selectedWs === ws.key ? 'selected' : ''}" data-ws="${esc(ws.key)}" data-tree-path="${esc(item.path)}" data-folder="${item.folder}" title="${esc(labels.join(' · ') + '\n' + item.path + (hiddenFolder ? '\nHidden folder' : '') + (board ? '\nKanban board' : ''))}" ${item.folder ? 'aria-expanded="' + ws.expanded.has(item.path) + '"' : ''}>${'<span class="tree-indent" aria-hidden="true"></span>'.repeat(depth)}<span class="tree-icon" aria-hidden="true">${item.folder ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4l6 6-6 6"/></svg>' : board ? '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="4" height="12" rx="1"/><rect x="8.5" y="4" width="4" height="8" rx="1"/><rect x="14" y="4" width="3.5" height="10" rx="1"/></svg>' : '▧'}</span><span class="tree-labels"><span class="tree-name">${esc(labels[0])}</span>${labels.length > 1 ? `<span class="tree-secondary">${esc(labels[1])}</span>` : ''}</span></button>`;
      if (item.folder && ws.expanded.has(item.path)) walk(item.path, depth + 1);
    }
  }; walk();
  if (ws.partial) return '<p class="hint">Loading files…</p>';
  return (html || '<p class="hint">No visible files. Right-click here to show hidden folders, or turn on Edit to create an article.</p>') + (total > ws.treeLimit ? `<button class="tree-more" data-tree-more="${esc(ws.key)}">Show more files</button>` : '');
}
function renderTree() {
  if (!workspaces.length) { $('tree').innerHTML = '<p class="hint">Choose a Markdown workspace.</p>'; return; }
  // Each workspace lists its own files; a horizontal bar separates workspaces.
  $('tree').innerHTML = workspaces.map((ws, index) => `${index ? '<hr class="tree-workspace-divider" aria-hidden="true">' : ''}<div class="tree-workspace" data-ws="${esc(ws.key)}" role="group" aria-label="${esc(workspaceName(ws))}" data-workspace-color="${workspaceColor(ws)}">${multi() ? `<div class="tree-workspace-title"><button class="tree-workspace-heading ${selectedWs === ws.key && !selected ? 'selected' : ''}" data-workspace-root="${esc(ws.key)}" title="${esc(workspaceName(ws) + '\n' + ws.catalog.root + '\nSelect this workspace root')}"><span class="workspace-dot" aria-hidden="true"></span><span>${esc(workspaceName(ws))}</span></button><button class="tree-workspace-collapse" data-collapse-workspace="${esc(ws.key)}" title="${esc('Collapse all folders in ' + workspaceName(ws))}" aria-label="${esc('Collapse all folders in ' + workspaceName(ws))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4l5 5 5-5M7 20l5-5 5 5"/></svg></button></div>` : ''}${treeRows(ws)}</div>`).join('');
}
async function refreshGraph(ws = activeWs()) {
  if (!ws) return;
  ws.graphData = await ws.api.call('graph');
  // The graph shows the article of the pane it is in.
  if (showGraph && paneWs(graphPane) === ws) graph.update(ws.graphData, paneActive(graphPane).path);
}
async function applyCatalog(ws, next) {
  setCatalog(ws, next); updatePath();
  void ws.git.refresh({quiet:true});
  if (ws === current()) updateStatus(ws.status);
  renderTree(); renderTabs(); renderGitSections(); updateMode(); await refreshGraph(ws);
  // Boards follow in the background, so opening and restoring articles never waits for them.
  void kanban?.workspaceChanged(ws);
  if (ws.partial || ws.stale) void run(loadPartialTrees)();
}
/** Reads a workspace's files again after Weave changed them, updating open articles in place. */
async function refreshWorkspace(ws) {await syncWorkspace(ws, null, {force: true});}
let graphTimer;
/** Brings a workspace's catalog up to date: the paths and titles that changed
 * since its revision, or the whole catalog when the backend no longer lists
 * them. Work is proportional to the change, not to the workspace. */
async function syncWorkspace(ws, status, {force = false} = {}) {
  if (status) {ws.status = status; if (ws === current()) updateStatus(status);}
  if (status && status.revision === ws.revision && !force) return;
  if (client.capabilities.catalogChanges) {
    const changes = await ws.api.call('catalogChanges', {since: ws.revision}); if (!workspaces.includes(ws)) return;
    if (!changes.reset) {
      const {paths, changed} = ws.index.apply(changes); ws.revision = changes.revision; ws.status = changes.status || ws.status;
      if (ws === current()) updateStatus(ws.status);
      if (changed) {renderTree(); renderTabs();}
      if (paths) {updatePath(); refreshLinks(ws);}
      if (changes.files.length || changes.removed.length || changes.otherFiles.length) {
        void ws.git.refresh({quiet: true}); void kanban?.workspaceChanged(ws);
        // The graph follows a burst of changes once.
        if (showGraph && paneWs(graphPane) === ws) {clearTimeout(graphTimer); graphTimer = setTimeout(run(() => refreshGraph(ws)), 400);}
      }
      await reloadChangedPanes(ws); return;
    }
  }
  // Too far behind for a delta: native hosts reload the list in pages.
  if (client.capabilities.catalogChanges) {await loadTree(ws); await reloadChangedPanes(ws); return;}
  const next = await ws.api.call('catalog'); if (!workspaces.includes(ws)) return;
  await applyCatalog(ws, next); await reloadChangedPanes(ws);
}
function updatePath() {
  const ws = activeWs() || current(), root = ws?.catalog.root || '', separator = /^[a-z]:|\\/i.test(root) ? '\\' : '/';
  const workspace = root.replace(/[\\/]/g, separator).replace(/[\\/]$/, '');
  $('workspace-name').textContent = active?.external ? 'Outside workspace' : workspace || 'No workspace open';
  $('workspace-name').classList.toggle('workspace-badge', multi() && !!ws && !active?.external);
  $('workspace-name').style.setProperty('--workspace-color', workspaceColor(ws));
  $('workspace-name').dataset.workspace = multi() && ws && !active?.external ? workspaceName(ws) : '';
  $('note-path').style.marginLeft = active?.external ? '6px' : '';
  $('note-path').textContent = active?.external ? '· ' + (active.osPath || active.name) : active ? separator + active.path.replaceAll('/', separator) : '';
  $('note-path').dataset.path = active?.path || '';
  $('current-path').title = (multi() && ws && !active?.external ? workspaceName(ws) + ' · ' : '') + workspace + $('note-path').textContent;
}
function revealFile() {
  const ws = activeWs();
  if (!ws || !sidebars?.visible('files')) return;
  const pieces = active.path.split('/'); for (let i = 1; i < pieces.length; i++) ws.expanded.add(pieces.slice(0, i).join('/'));
  selected = active.path; selectedWs = ws.key; ws.treeLimit = Math.max(ws.treeLimit, ws.index.size + ws.index.folders.size); renderTree();
  [...$('tree').querySelectorAll('[data-tree-path]')].find(row => row.dataset.treePath === active.path && row.dataset.ws === ws.key)?.scrollIntoView({block: 'nearest'});
}
function renderTabs() {
  // With several workspaces open, each tab is tinted in its workspace colour and names it.
  const labelled = multi(), named = labelled && prefs.get('tab-workspace-names') !== 'false';
  for (const pane of panes) {
    const chosen = paneTabId(pane);
    pane.el['file-tabs'].innerHTML = visibleTabs(pane).map(tab => {
      const external = isExternal(tab.path), ws = labelled && !external ? wsByKey(tab.ws) : null, label = tab.path?.split(/[\\/]/).at(-1).replace(/\.(md|markdown)$/i, '') || 'New tab';
      const hint = external ? tab.path.slice(EXTERNAL.length) + '\nOutside the workspace' : (tab.path || label) + (ws ? '\nWorkspace: ' + workspaceName(ws) : '');
      return `<div class="file-tab ${chosen === tab.id ? 'active' : ''} ${tabDrag?.active && tabDrag.id === tab.id ? 'dragging' : ''} ${external ? 'external-tab' : ''} ${ws ? 'workspace-tab' : ''} ${ws && named ? 'named-tab' : ''}" data-tab-id="${esc(tab.id)}"${ws ? ` data-workspace-color="${workspaceColor(ws)}"` : ''}><button role="tab" aria-selected="${chosen === tab.id}" data-tab="${esc(tab.id)}" title="${esc(hint)}"><span class="tab-title">${esc(label)}</span>${ws && named ? `<small class="tab-workspace">${esc(workspaceName(ws))}</small>` : ''}</button><button class="close-tab" data-close-tab="${esc(tab.id)}" aria-label="Close ${esc(label)}">×</button></div>`;
    }).join('');
    pane.el['close-tabs'].disabled = !visibleTabs(pane).length;
  }
  const tab = currentTab(); $('nav-back').disabled = !tab || nextAvailable(tab, -1) < 0; $('nav-forward').disabled = !tab || nextAvailable(tab, 1) < 0;
  updateTabDots(); renderSearchFilter();
}
function sessionValue(ws) {
  // Files outside the workspace are not part of its session.
  const tabState = allTabs().filter(t => t.ws === ws.key && !isExternal(t.path)).map(t => {const {history, at} = entriesFor(t, entry => entryParts(entry).ws === ws.key); return {id: t.id, path: t.path, history: history.map(entry => entryParts(entry).path), at};});
  const own = active && !active.external && active.ws === ws.key;
  return {tabs: tabState.map(t => t.path).filter(Boolean), active: own ? active.path : null, tabState, activeTab: tabState.some(t => t.id === activeTab) ? activeTab : null, source};
}
/** The entries of a tab that match `keep`, with its position mapped onto them. */
function entriesFor(tab, keep) {
  const history = []; let at = -1;
  tab.history.forEach((entry, i) => {if (keep(entry)) {history.push(entry); if (i <= tab.at) at = history.length - 1;}});
  return {history, at: history.length ? Math.max(0, at) : -1};
}
function persistSession() {
  if (!workspaces.length) return Promise.resolve();
  const writes = [];
  for (const ws of workspaces) {
    const value = sessionValue(ws), json = JSON.stringify(value);
    if (json === ws.persisted) continue;
    ws.persisted = json;
    if (client.capabilities.session) writes.push(ws.api.call('workspaceSession', value).catch(e => {ws.persisted = ''; message('Session was not saved: ' + e.message);}));
    else prefs.set('session:' + ws.key, json);
  }
  // The window remembers tab order and the active tab across workspaces.
  if (client.capabilities.workspaces) {
    // Every tab, including those hidden with a deactivated workspace; files
    // outside the workspaces are not restored.
    // With split view, tabs of the right side are marked and each side keeps its active tab.
    const [left, right] = shownPanes(), side = pane => split && pane === right ? 'right' : null;
    const saved = [left, ...split ? [right] : []].flatMap(pane => paneTabs(pane).map(t => {const {history, at} = entriesFor(t, entry => !!entryParts(entry).ws); return {id: t.id, at, workspace: history.length ? null : t.ws, side: side(pane), history: history.map(entry => ({workspace: entryParts(entry).ws, path: entryParts(entry).path}))};})).filter(t => t.history.length || t.workspace);
    const activeOf = pane => saved.some(t => t.id === paneTabId(pane)) ? paneTabId(pane) : null;
    const layout = {tabOrder: saved.map(t => t.id), tabs: saved, activeTab: activeOf(left), rightActiveTab: split ? activeOf(right) : null, focus: split && P === right ? 'right' : 'left'};
    if (JSON.stringify(layout) !== layoutPersisted) {layoutPersisted = JSON.stringify(layout); writes.push(client.call('workspaceLayout', layout).catch(e => {layoutPersisted = ''; message('Session was not saved: ' + e.message);}));}
  }
  sessionWrite = Promise.all(writes);
  return sessionWrite;
}
function savedTabs(ws) {
  let saved = ws.catalog.session;
  if (!saved && !client.capabilities.session) try {saved = JSON.parse(prefs.get('session:' + ws.key));} catch {}
  const available = ws.partial ? {has: () => true} : ws.index;
  const list = saved?.tabState ? saved.tabState.filter(t => !t.path || available.has(t.path)).map(t => ({id: t.id, ws: ws.key, path: t.path, history: (t.history || []).map(file => draftKey(ws.key, file)), at: t.at ?? -1})) : [...new Set((saved?.tabs || []).filter(f => available.has(f)))].map(f => makeTab(f, ws.key));
  ws.persisted = '';
  return {list, saved, pick: list.find(t => t.id === saved?.activeTab) || list.find(t => t.path === saved?.active) || list.at(-1)};
}
async function restoreWorkspaces(initial) {
  const catalogs = initial.workspaces?.length ? initial.workspaces : [initial];
  for (const next of catalogs) addWorkspace(next);
  renderGitSections();
  for (const ws of [...workspaces]) await applyCatalog(ws, ws.catalog);
  tabs = []; let fallback = null; const rightTabs = new Set();
  if (Array.isArray(initial.layout?.tabs)) {
    // Window-wide tabs whose histories may span workspaces.
    const exists = (wsKey, path) => {const ws = wsByKey(wsKey); return !ws || ws.partial || ws.index.has(path);};
    for (const saved of initial.layout.tabs) {
      const entries = (saved.history || []).map(e => ({entry: draftKey(e.workspace, e.path), keep: exists(e.workspace, e.path)}));
      const tab = {id: saved.id, ws: saved.workspace || null, path: null, history: [], at: -1};
      let at = -1; entries.forEach((e, i) => {if (e.keep) {tab.history.push(e.entry); if (i <= (saved.at ?? 0)) at = tab.history.length - 1;}});
      if (tab.history.length) setTabAt(tab, Math.max(0, at)); else if (!tab.ws) continue;
      if (saved.side === 'right') rightTabs.add(tab.id);
      tabs.push(tab);
    }
    settleTabs();
  } else for (const ws of workspaces) {const {list, saved, pick} = savedTabs(ws); tabs.push(...list); if (!fallback && pick) fallback = {pick, saved};}
  const order = initial.layout?.tabOrder || [];
  const rank = tab => {const index = order.indexOf(tab.id); return index < 0 ? order.length : index;};
  tabs = tabs.map((tab, index) => ({tab, index})).sort((a, b) => rank(a.tab) - rank(b.tab) || a.index - b.index).map(item => item.tab);
  // Tabs saved on the right side reopen the split view when the right side has tabs to show.
  const right = tabs.filter(t => rightTabs.has(t.id));
  if (right.some(tabVisible) && tabs.some(t => !rightTabs.has(t.id) && tabVisible(t))) {
    tabs = tabs.filter(t => !rightTabs.has(t.id));
    Object.assign(panes[1], {tabs: right, activeTab: right.filter(tabVisible).find(t => t.id === initial.layout.rightActiveTab)?.id || right.filter(tabVisible).at(-1).id});
    setSplit(true);
  }
  activeTab = visibleTabs().find(t => t.id === initial.layout?.activeTab)?.id || fallback?.pick?.id || visibleTabs().at(-1)?.id || null;
  source = (wsByKey(tabs.find(t => t.id === activeTab)?.ws)?.catalog.session || fallback?.saved)?.source === true;
  renderTabs(); if (activeTab) await selectTab(activeTab);
  if (split) {
    panes[1].source = source; focusPane(panes[1]); await selectTab(panes[1].activeTab);
    if (initial.layout.focus !== 'right') focusPane(panes[0]);
  }
  void run(loadPartialTrees)();
}
function showEmptyTab() {
  openSerial++; active = null; selected = ''; live.setText(''); raw.setText(''); updatePath(); updateMode();
  if (evidencePane === P) {evidenceSerial++; $('evidence-panel').hidden = true;}
  $p('note-panel').hidden = true; $p('welcome').hidden = false; kanban?.update(P); renderWelcome();
  history.replaceState(null, '', location.pathname + location.search); updatePanes();
}
async function selectTab(id) {
  // A tab of the other side is shown there, and that side takes the focus.
  const owner = paneOfTab(id); if (owner && owner !== P) focusPane(owner);
  if (!await leaveArticle()) return;
  const tab = tabs.find(t => t.id === id); if (!tab) return;
  if (tab.path) await openNote(tab.path, null, {record: false, tabId: id, ws: wsByKey(tab.ws)});
  else {
    activeTab = id; const ws = wsByKey(tab.ws); if (ws) {focusKey = ws.key; ws.lastTab = id; focusGitSection(ws); updateStatus(ws.status);}
    showEmptyTab(); renderTabs(); renderTree(); renderWorkspaceManager(); await persistSession();
  }
}
async function newTab() {
  if (!await leaveArticle()) return;
  const tab = makeTab(null, current()?.key || null); tabs.push(tab); activeTab = tab.id; showEmptyTab(); renderTabs(); renderTree(); await persistSession();
}
async function closeTab(id, all = false) {
  if (!all) {const owner = paneOfTab(id); if (owner && owner !== P) focusPane(owner);}
  // Close all closes the visible tabs; tabs hidden with a deactivated workspace stay.
  const shownTabs = visibleTabs(), closing = all ? shownTabs : tabs.filter(t => t.id === id), remaining = tabs.filter(t => !closing.includes(t));
  if (closing.some(t => t.id === activeTab) && autosaveMode() !== 'off' && !await canLeave()) return;
  // Ask about unsaved articles that no remaining tab, on either side, shows.
  const keyOf = tabKey;
  const shown = new Set([...remaining, ...otherPane()?.tabs || []].filter(t => t.path).map(keyOf));
  const pending = closing.filter(t => tabUnsaved(t) && !shown.has(keyOf(t)));
  if (pending.length) {
    const name = pending.length === 1 ? '"' + pending[0].path.split(/[\\/]/).at(-1).replace(/\.(md|markdown)$/i, '') + '"' : count(pending.length, 'article');
    const answer = await promptUser('Save changes?', name + (pending.length === 1 ? ' has' : ' have') + ' unsaved changes. Save before closing?', {ok: 'Save', secondary: "Don't save"});
    if (answer.action === 'cancel') return;
    for (const tab of pending) {
      const key = keyOf(tab), isActive = key === activeKey() && dirty;
      if (answer.action === 'ok') {if (isActive) await save({explicit: true}); else await saveDraft(key);}
      else {drafts.delete(key); if (isActive) setDirty(false);}
    }
  }
  openSerial++;
  const index = shownTabs.findIndex(t => t.id === id); tabs = remaining;
  const left = visibleTabs();
  // Closing the last tab of one side ends the split view.
  if (!left.length && split) {await collapsePane(P); return;}
  if (!left.length) {activeTab = null; showEmptyTab();}
  else if (!left.some(t => t.id === activeTab)) await selectTab(left[Math.min(Math.max(0, index), left.length - 1)].id);
  renderTabs(); renderTree(); await persistSession();
}
async function navigate(direction) {
  const tab = currentTab(), next = tab ? nextAvailable(tab, direction) : -1; if (next < 0) return;
  const {ws, path} = entryParts(tab.history[next]);
  if (await openNote(path, null, {record: false, ws: wsByKey(ws), at: next, tabId: tab.id})) {renderTabs(); await persistSession();}
}
// Split view. Tabs, histories and reading positions belong to one side; an
// article open on both sides shows the same text, and edits appear on the
// other side as they are typed.
/** Makes `pane` the focused side: its tabs drive Back/Forward, Files, the path
 * bar and saving. The side being left gives up its unsaved changes: to the new
 * side when that shows the same article, otherwise as a draft that autosave
 * saves at once (with autosave off it waits, like an article left in a tab). */
function focusPane(pane) {
  if (!pane || pane === P) return;
  flushMirror(); rememberScroll(); (source ? raw : live).commitTableEdit(); clearTimeout(saveTimer);
  const key = activeKey(), carried = dirty && !!active && docKey(pane.active) === key, hash = active?.hash, since = dirtySince;
  if (dirty && active && !carried) keepDraft(key);
  if (!$('find-bar').hidden) hideFind();
  Object.assign(P, {tabs, activeTab, active, source});
  P = pane; ({tabs, activeTab, active, source} = pane); live = pane.live; raw = pane.raw; okfBar = pane.okfBar;
  openSerial++; dirty = false;
  if (carried) {active = {...active, hash}; setDirty(true); dirtySince = since; scheduleSave();} else {setDirty(false); claimDraft();}
  for (const each of panes) each.group.classList.toggle('focused', each === P);
  $p('tab-bar').after($('find-bar'));
  const ws = activeWs() || wsByKey(currentTab()?.ws);
  if (active && !active.external) {selected = active.path; selectedWs = active.ws;}
  if (ws) {focusKey = ws.key; focusGitSection(ws); updateStatus(ws.status);}
  updatePath(); updateMode(); renderTabs(); renderTree(); revealFile(); renderWorkspaceManager();
  if (active && !active.external) history.replaceState(null, '', '#note=' + encodeURIComponent(active.path));
}
function keepDraft(key) {
  drafts.set(key, {text: (source ? raw : live).text, hash: active.hash, created: active.created, since: dirtySince});
  if (autosaveMode() !== 'off') run(() => saveDraft(key))();
  setTimeout(updateTabDots, DOT_DELAY + 20);
}
/** The focused side takes back unsaved changes it left as a draft. */
function claimDraft() {
  const key = activeKey(), draft = key && drafts.get(key); if (!draft) return;
  drafts.delete(key); refreshPaneText(P, draft.text); active = {...active, hash: draft.hash};
  setDirty(true); dirtySince = draft.since || 0; updateTabDots(); scheduleSave();
}
let mirrorFrame = 0;
function scheduleMirror() {if (split && !mirrorFrame) mirrorFrame = requestAnimationFrame(flushMirror);}
/** Shows the focused side's text on the other side when both show the same article. */
function flushMirror() {
  cancelAnimationFrame(mirrorFrame); mirrorFrame = 0;
  const other = otherPane(); if (!other || !active || docKey(other.active) !== activeKey()) return;
  refreshPaneText(other, (source ? raw : live).text);
}
/** Shows a side's article text in place, keeping its reading position. */
function refreshPaneText(pane, text = paneActive(pane).text) {for (const editor of [pane.live, pane.raw]) editor.mirrorText(text); pane.okfBar.render();}
/** After an article is saved, each side showing it takes the new hash, and a side
 * without unsaved changes of it shows the saved text (with Weave's timestamps). */
function syncSaved(key, doc, previousHash) {
  const draft = drafts.get(key); if (draft && draft.hash === previousHash) draft.hash = doc.hash;
  for (const pane of panes) {
    const shown = paneActive(pane); if (docKey(shown) !== key) continue;
    if (pane === P) {active = {...active, hash: doc.hash, created: doc.created ?? active.created, ...dirty || draft ? {} : {text: doc.text}}; if (!dirty && !draft) refreshPaneText(P); continue;}
    pane.active = {...shown, hash: doc.hash, created: doc.created ?? shown.created, text: doc.text};
    if (drafts.has(key)) continue;
    if (docKey(active) === key) flushMirror(); else refreshPaneText(pane);
  }
}
/** Re-reads the articles the sides show from `ws` and shows changes made on disk
 * in place. A side holding unsaved changes keeps them and shows a warning. */
async function reloadChangedPanes(ws) {
  for (const pane of shownPanes()) {
    const doc = paneActive(pane); if (!doc || doc.external || doc.ws !== ws.key) continue;
    let disk;
    try {disk = await ws.api.call('getDocument', {path: doc.path});}
    catch {if (paneActive(pane) === doc) pane.el['note-warning'].textContent = 'This note was moved or deleted outside Weave. Your open text is retained.'; continue;}
    if (paneActive(pane) !== doc || disk.hash === doc.hash) continue;
    const key = docKey(doc);
    if (docKey(active) === key && (dirty || saving) || drafts.has(key)) {pane.el['note-warning'].textContent = 'This note changed on disk. Your draft is retained; reload or copy it before resolving the conflict.'; continue;}
    const next = withWs(disk, ws); if (pane === P) active = next; else pane.active = next;
    refreshPaneText(pane); kanban?.update(pane); if (pane === P) await renderConnections();
  }
}
/** Runs `fn` with `pane` focused, then returns the focus. */
async function inPane(pane, fn) {
  const back = P; focusPane(pane);
  try {return await fn();} finally {if (shownPanes().includes(back)) focusPane(back);}
}
const splitRatio = () => Math.max(20, Math.min(80, Number(prefs.get('split-ratio')) || 50));
/** Shows one side, or both side by side (`sides` gives their order). */
function setSplit(on) {
  split = on;
  if (!on) sides = [P, panes.find(pane => pane !== P)];
  const [left, right] = sides, main = $('editor-left').parentElement;
  main.classList.toggle('split', split); main.style.setProperty('--split', splitRatio() + '%');
  left.group.hidden = false; right.group.hidden = !split; $('split-resize').hidden = !split;
  left.group.classList.add('side-left'); right.group.classList.remove('side-left');
  left.group.style.setProperty('order', '0'); right.group.style.setProperty('order', '2');
  for (const pane of panes) pane.group.classList.toggle('focused', pane === P);
  for (const pane of panes) pane.el['file-tabs'].setAttribute('aria-label', split ? 'Open articles, ' + (pane === left ? 'left' : 'right') + ' side' : 'Open articles');
}
/** The other side, opened empty beside the focused one when there is no split yet. */
function sidePane() {
  if (split) return otherPane();
  const pane = panes.find(each => each !== P);
  Object.assign(pane, {tabs: [], activeTab: null, active: null, source}); sides = [P, pane]; setSplit(true);
  return pane;
}
/** Opens an article in a new tab on the other side (Open to the right). */
async function openToSide(file, {ws = null, line = null, searchTerm = ''} = {}) {
  const pane = sidePane(); focusPane(pane);
  try {await openNote(file, line, {tabId: null, ws, searchTerm});}
  finally {if (split && !visibleTabs(pane).length) await collapsePane(pane);}
}
/** Opens a tab's article in a new tab on the other side (Split right/left). */
async function splitTab(id) {
  const tab = allTabs().find(t => t.id === id); if (!tab?.path) return;
  focusPane(paneOfTab(id)); await openToSide(tab.path, {ws: wsByKey(tab.ws)});
}
/** Moves a tab, with its history and reading positions, to the other side.
 * A side left without tabs closes. */
async function moveTabToSide(id, target = null, index = null) {
  const from = paneOfTab(id); if (!from) return;
  focusPane(from);
  if (!target && !split && visibleTabs().length < 2) return;
  if (id === activeTab && !await leaveArticle()) return;
  target ||= sidePane(); if (target === from) return;
  const tab = tabs.find(t => t.id === id), at = visibleTabs().indexOf(tab);
  tabs = tabs.filter(t => t !== tab);
  const rest = visibleTabs();
  if (activeTab === id && rest.length) await selectTab(rest[Math.min(at, rest.length - 1)].id);
  focusPane(target);
  const before = index === null ? null : visibleTabs()[index];
  tabs.splice(before ? tabs.indexOf(before) : tabs.length, 0, tab);
  await selectTab(id);
  if (!visibleTabs(from).length) await collapsePane(from);
  renderTabs(); await persistSession();
}
/** Closes one side of the split view. Tabs it kept for deactivated workspaces
 * move to the other side. */
async function collapsePane(pane) {
  if (!split) return;
  const keep = panes.find(each => each !== pane);
  focusPane(keep);
  tabs.push(...pane.tabs.filter(tab => !tabVisible(tab)));
  Object.assign(pane, {tabs: [], activeTab: null, active: null});
  pane.live.setText(''); pane.raw.setText(''); pane.el['note-warning'].textContent = '';
  if (graphPane === pane) placeGraph(keep);
  if (evidencePane === pane) {evidencePane = keep; if (!$('evidence-panel').hidden) {evidenceSerial++; $('evidence-panel').hidden = true;} $p('note-panel').after($('evidence-panel'));}
  setSplit(false);
  if (!active) showEmptyTab();
  renderTabs(); updatePanes(); await persistSession();
}
async function collapseEmptyPane() {const empty = split && panes.find(pane => !visibleTabs(pane).length); if (empty) await collapsePane(empty);}
// Clicking or tabbing into a side focuses it before anything there handles the event.
for (const type of ['pointerdown', 'focusin']) document.addEventListener(type, event => {if (split) {const pane = paneAt(event.target); if (pane && pane !== P) focusPane(pane);}}, true);
// Drag the bar between the sides to resize them; the ratio is remembered.
{
  const divider = $('split-resize'), main = divider.parentElement, place = ratio => {const value = Math.max(20, Math.min(80, ratio)); main.style.setProperty('--split', value + '%'); return value;};
  let dragging = null;
  divider.onpointerdown = event => {if (event.button !== 0) return; event.preventDefault(); dragging = splitRatio(); divider.setPointerCapture(event.pointerId); document.body.classList.add('split-resizing');};
  divider.onpointermove = event => {if (dragging === null) return; const box = main.getBoundingClientRect(); dragging = place((event.clientX - box.left) / box.width * 100);};
  divider.onpointerup = divider.onpointercancel = () => {if (dragging === null) return; prefs.set('split-ratio', String(Math.round(dragging))); dragging = null; document.body.classList.remove('split-resizing');};
  divider.onkeydown = event => {if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); prefs.set('split-ratio', String(place(splitRatio() + (event.key === 'ArrowRight' ? 2 : -2))));};
}
// Each tab remembers the reading position of every article in its history, so
// Back/Forward and switching tabs return to the same place.
const scroller = () => $p('note-panel'), mainScroll = () => P.group;
function rememberScroll() {
  const tab = currentTab(); if (!tab || !active || tab.path !== active.path || $p('note-panel').hidden) return;
  tab.scroll ||= {}; tab.scroll[tab.at] = {entry: tab.history[tab.at], top: scroller().scrollTop, main: mainScroll().scrollTop};
}
/** The article stays hidden until the editor has measured its rows and the
 * saved position is applied, so it appears in place without a visible jump. */
function restoreScroll(tab) {
  const saved = tab?.scroll?.[tab.at], panel = scroller();
  if (!saved || saved.entry !== tab.history[tab.at]) {panel.classList.remove('restoring'); panel.scrollTop = 0; return;}
  const serial = openSerial, editor = source ? raw : live, current = () => currentTab() === tab && serial === openSerial;
  const apply = () => {if (current()) {panel.scrollTop = saved.top; mainScroll().scrollTop = saved.main || 0;}};
  // Parse through the restored screen (plus a margin) so its Markdown is fully
  // styled when revealed; the cost is bounded and limited to what will be shown.
  const prepare = () => {
    if (!current() || !editor.view) return;
    const top = editor.view.contentDOM.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;
    editor.parseThrough(editor.positionAtOffset(saved.top + panel.clientHeight - top + 800) + 3000);
  };
  panel.classList.add('restoring'); apply(); prepare();
  requestAnimationFrame(() => {apply(); prepare(); requestAnimationFrame(() => {apply(); panel.classList.remove('restoring');});});
}
async function save({explicit = false} = {}) {
  (source ? raw : live).commitTableEdit();
  clearTimeout(saveTimer);
  if (saving) { await saving; if (dirty || explicit) return save({explicit}); return; }
  if (!active || (!dirty && !explicit)) return;
  (source ? raw : live).formatTablesForSave();
  clearTimeout(saveTimer);
  if (!dirty) return;
  if (!active.external) stampEditor();
  const note = active, pane = P, text = source ? raw.text : live.text; $('save-status').textContent = 'Saving…';
  const failed = error => {if (P === pane) $('save-status').textContent = 'Save failed'; pane.el['note-warning'].textContent = error.message; throw error;};
  if (note.external) {
    if (!note.writable || !client.saveExternal) throw new Error('This file is open read-only.');
    saving = client.saveExternal(note.osPath, note.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text, note.hash).then(result => {
      const saved = {...note, text, hash: result.hash}; externalDocs.set(note.path, saved); syncSaved(docKey(saved), saved, note.hash);
      if (active?.path !== note.path) return;
      active = saved; setDirty((source ? raw.text : live.text) !== text); $p('note-warning').textContent = '';
      if (dirty) scheduleSave();
    }).catch(failed).finally(() => {saving = null;});
    return saving;
  }
  const ws = wsByKey(note.ws);
  if (!ws) throw new Error('This article\'s workspace is inactive. Copy your changes before discarding them.');
  saving = ws.api.call('save', {path: note.path, text, hash: note.hash}).then(async result => {
    const doc = withWs(result, ws); syncSaved(docKey(doc), doc, note.hash);
    if (active?.path !== note.path || active?.ws !== note.ws) return;
    active = doc; setDirty((source ? raw.text : live.text) !== text); $p('note-warning').textContent = '';
    if (dirty) scheduleSave();
    await refreshGraph(ws); await renderConnections();
    void ws.git.refresh({quiet:true});
  }).catch(failed).finally(() => {saving = null;});
  return saving;
}
/** Saving records `created_at` (the file's creation time when absent) and
 * `updated_at` in the article's frontmatter. The open editor takes the new
 * block without counting it as an edit or an undo step. */
function stampEditor() {
  const editor = source ? raw : live, text = editor.text, stamped = stampArticle(text, {created: active.created});
  if (stamped === text) return;
  editor.setFrontmatterQuietly(splitFrontmatter(stamped).frontmatter); okfBar.render();
}
async function canLeave() {
  try { await save(); return true; } catch (e) {
    const result = await promptUser('Keep your draft?', e.message + ' Cancel keeps the draft open. Discard loses these unsaved changes.', {ok: 'Discard draft'});
    if (result.action !== 'ok') return false; setDirty(false); return true;
  }
}
/** Leaves the open article for another. Autosave modes save it first; with
 * autosave off its unsaved text stays with the article as a draft. */
async function leaveArticle() {
  rememberScroll();
  if (!active || !dirty || autosaveMode() !== 'off') return canLeave();
  (source ? raw : live).commitTableEdit(); clearTimeout(saveTimer);
  if (saving) await saving.catch(() => {});
  if (!dirty) return true;
  drafts.set(activeKey(), {text: source ? raw.text : live.text, hash: active.hash, created: active.created}); setDirty(false); return true;
}
async function saveDraft(key) {
  // A save of the same article may still be running (its pane was left mid-save).
  if (saving) await saving.catch(() => {});
  const draft = drafts.get(key); if (!draft) return;
  const [wsKey, path] = key.split('\n');
  let saved;
  if (!wsKey) {
    const doc = externalDocs.get(path); if (!doc?.writable || !client.saveExternal) throw new Error(path.split(/[\\/]/).at(-1) + ' is open read-only.');
    const result = await client.saveExternal(doc.osPath, doc.eol === '\r\n' ? draft.text.replace(/\n/g, '\r\n') : draft.text, draft.hash);
    saved = {...doc, text: draft.text, hash: result.hash}; externalDocs.set(path, saved);
  } else {
    const ws = wsByKey(wsKey); if (!ws) throw new Error('An unsaved article belongs to an inactive workspace.');
    saved = withWs(await ws.api.call('save', {path, text: stampArticle(draft.text, {created: draft.created}), hash: draft.hash}), ws);
  }
  // A newer draft of the article, kept while this one was saving, stays.
  if (drafts.get(key) === draft) drafts.delete(key);
  syncSaved(key, saved, draft.hash); setDirty(dirty);
}
/** Saves the open article and every draft (Ctrl+Shift+S). */
async function saveAll() {
  if (dirty) await save({explicit: true});
  for (const key of [...drafts.keys()]) await saveDraft(key);
  renderTabs(); message('All changes saved.');
}
/** Before operations that change files on disk, offer to save pending drafts. */
async function ensureDraftsSaved(filter = () => true, action = 'continuing') {
  if (!await canLeave()) return false;
  const pending = [...drafts.keys()].filter(filter); if (!pending.length) return true;
  const answer = await promptUser('Save unsaved articles?', count(pending.length, 'article') + (pending.length === 1 ? ' has' : ' have') + ' unsaved changes. Save them before ' + action + '?', {ok: 'Save all and continue'});
  if (answer.action !== 'ok') return false;
  for (const key of pending) await saveDraft(key);
  renderTabs(); return true;
}
/** Adds a workspace beside those already open (or switches to it when it is open)
 * and restores its saved tabs. Hosts without multi-workspace support replace it. */
async function choose() {
  await persistSession();
  const next = await client.choose(); if (!next) return;
  if (!client.capabilities.workspaces) resetWorkspaces();
  await adoptWorkspace(next);
  message(client.writable ? (multi() ? workspaceName(wsByKey(workspaceKey(next))) + ' is open.' : 'Workspace open.') : 'Read-only browser view.');
}
/** Creates an empty workspace folder (the desktop asks where; the server
 * creates it in its workspace directory) and opens it. */
async function createWorkspace() {
  if (!client.createWorkspace || !client.writable) throw new Error('This host cannot create workspaces.');
  if (panelInfo?.managedWorkspaces) throw new Error('This server shows workspaces chosen in the desktop app. Create workspaces there.');
  const server = pageData.mode === 'server';
  const answer = await promptUser('Create workspace', (server ? 'Name the new workspace. Weave creates an empty folder with this name on the server' : 'Name the new workspace. Next, choose the folder to create it in. Weave creates an empty folder with this name') + ' and keeps its history with Git, taking automatic snapshots.', {value: '', ok: server ? 'Create workspace' : 'Choose location…'});
  if (answer.action !== 'ok') return;
  if (!answer.value) throw new Error('Enter a workspace name.');
  await persistSession();
  const next = await client.createWorkspace(answer.value); if (!next) return;
  if (!client.capabilities.workspaces) resetWorkspaces();
  const ws = await adoptWorkspace(next); message(workspaceName(ws) + ' created. Add your first article.' + (next.historyError ? ' Git history is unavailable: ' + next.historyError : ''));
}
/** Opens a workspace folder listed on a server's start page. */
async function openServerFolder(name) {
  await persistSession();
  const next = await client.openServerFolder(name); if (!next) return;
  const ws = await adoptWorkspace(next); message(workspaceName(ws) + ' is open.');
}
/** Workspace folders on the server (null on other hosts, when the desktop
 * manages the server's workspaces, or before they are listed). */
let serverFolders = null;
const listsServerFolders = () => pageData.mode === 'server' && !panelInfo?.managedWorkspaces && Array.isArray(serverFolders);
/** Opens an article of `ws` chosen at random. */
async function randomArticle(ws) {
  const paths = ws.index.paths; if (!paths.length) throw new Error(workspaceName(ws) + ' has no articles yet.');
  const others = paths.length > 1 ? paths.filter(path => path !== paneActive(P)?.path) : paths;
  await openNote(others[Math.floor(Math.random() * others.length)], null, {ws});
}
/** Opens the guided Git setup for a workspace (repository, author, remote, deploy key). */
async function setupGit(ws) {
  if (!ws) throw new Error('Open a workspace to set up Git.');
  if (!client.capabilities.git) throw new Error('Git is unavailable on this host.');
  if (!ws.git.status) await ws.git.refresh();
  if (ws.git.status && ws.git.status.available === false) throw new Error(ws.git.status.error || 'Git is unavailable. Install Git and reopen Weave.');
  openGitSetup({git: ws.git, name: workspaceName(ws), server: pageData.mode === 'server', openResource: url => client.openResource(url),
    showSourceControl: () => {sidebars.select('right', 'git'); focusGitSection(ws); ws.gitSection.open = true;},
    ask: async (title, text, ok) => (await promptUser(title, text, {ok})).action === 'ok'});
}
/** Git is set up when the workspace is a repository with a remote. */
const needsGitSetup = ws => {const s = ws?.git?.status; return !!(client.capabilities.git && client.writable && s && s.available !== false && !s.parentRepository && (!s.repository || !s.remotes?.length));};
const welcomeRendered = ['', '', ''];
/** The empty tab's starting points, showing only what can be done now: workspace
 * actions; with a workspace New article, Random article (two or more articles),
 * Set up Git when it is not connected yet and, on phones, Browse files. A server
 * lists its other workspace folders to open with one click. */
function renderWelcome() {
  const server = pageData.mode === 'server', managed = !!panelInfo?.managedWorkspaces, writable = client.writable && !portable;
  const listed = listsServerFolders(), open = new Set(workspaces.map(ws => ws.catalog.root));
  const available = listed ? serverFolders.filter(name => !open.has(name)) : [];
  for (const pane of panes) {
    const box = pane.el.welcome.querySelector('.welcome-actions'), lead = pane.el.welcome.querySelector('p'); if (!box) continue;
    const ws = portable ? null : wsByKey(paneTabs(pane).find(tab => tab.id === paneTabId(pane))?.ws) || current();
    const items = [], articles = ws?.index?.size || 0, git = ws?.git?.status;
    if (ws) {
      if (writable) items.push({action: 'new-article', title: 'New article', text: 'Start writing in ' + workspaceName(ws), primary: true});
      if (articles > 1) items.push({action: 'random-article', title: 'Random article', text: 'Rediscover one of ' + count(articles, 'article')});
      if (needsGitSetup(ws)) items.push(git.repository ? {action: 'setup-git', title: 'Connect to GitHub', text: 'Back up and sync this workspace'} : {action: 'setup-git', title: 'Set up Git', text: 'Keep history and sync with GitHub'});
      if (articles && document.documentElement.dataset.layout === 'mobile') items.push({action: 'browse', title: 'Browse files', text: 'Show the articles of ' + workspaceName(ws)});
    }
    if (writable && client.createWorkspace && !managed) items.push({action: 'create-workspace', title: 'Create new workspace', text: server ? 'An empty folder on this server, with history' : 'An empty folder for new articles, with history', primary: !ws, secondary: !!ws});
    // Listed server folders open from the list below; the picker would only repeat it.
    if (!portable && !listed) items.push({action: 'open-workspace', title: 'Open existing workspace', text: managed ? 'One shared by the desktop app' : server ? 'A folder on this server' : 'A folder of Markdown files', primary: !ws && !writable, secondary: !!ws, id: pane.index === 0 ? 'welcome-open' : ''});
    lead.textContent = portable ? 'Select an article from Files or Search to open it.' : ws ? (articles ? 'Select an article from Files or Search, or start here.' : 'This workspace is empty. Write its first article.') : available.length ? 'Create a workspace for new articles, or open one on this server.' : listed ? 'Create your first workspace to start writing.' : 'Create a workspace for new articles, or open one you already have.';
    const html = items.map(item => `<button type="button" class="welcome-action${item.primary ? ' primary' : ''}${item.secondary ? ' secondary' : ''}" data-welcome="${item.action}"${ws ? ` data-ws="${esc(ws.key)}"` : ''}${item.id ? ` id="${item.id}"` : ''}><strong>${esc(item.title)}</strong><small>${esc(item.text)}</small></button>`).join('');
    if (html !== welcomeRendered[pane.index]) {box.innerHTML = html; welcomeRendered[pane.index] = html;}
  }
  const list = available.map(name => {
    const known = panelInfo?.workspaces?.find(w => w.root === name), color = /^#[0-9a-f]{6}$/i.test(known?.color || '') ? known.color : '#7c8594';
    return `<li class="workspace-recent" data-workspace-color="${color}"><span class="workspace-dot" aria-hidden="true"></span><span class="workspace-recent-label"><strong>${esc(known?.name || name)}</strong><small>${esc(known ? 'Used before on this server' : 'Folder on this server')}</small></span><button type="button" data-welcome="open-folder" data-folder="${esc(name)}" title="Open ${esc(known?.name || name)}">Open</button></li>`;
  }).join('');
  if (list !== welcomeRendered[2]) {$('welcome-available-list').innerHTML = list; welcomeRendered[2] = list;}
  $('welcome-available').hidden = !available.length;
}
async function adoptWorkspace(next) {
  const existing = wsByKey(workspaceKey(next));
  if (existing) {await applyCatalog(existing, next); await showWorkspace(existing); return existing;}
  const ws = addWorkspace(next); focusKey = selectedWs = ws.key; selected = '';
  renderGitSections(); await applyCatalog(ws, next); void run(loadPartialTrees)();
  const known = allTabs().filter(t => t.ws === ws.key || t.history.some(entry => entryParts(entry).ws === ws.key));
  const {list, saved, pick} = known.length ? {list: [], pick: allTabs().findLast(t => t.ws === ws.key && tabVisible(t))} : savedTabs(ws);
  tabs.push(...list);
  if (pick) {if (workspaces.length === 1) source = saved?.source === true; await selectTab(pick.id);}
  else {
    // An empty tab of no particular workspace can show this one.
    const tab = currentTab(); if (tab && !tab.path && !tab.history.length) {tab.ws = ws.key; ws.lastTab = tab.id;}
    renderTabs(); renderWelcome(); updateStatus(ws.status); focusGitSection(ws);
  }
  await persistSession(); void loadControlPanel();
  return ws;
}
/** Makes a workspace current: its most recently used tab, or a new empty tab for it. */
async function showWorkspace(ws) {
  focusKey = selectedWs = ws.key; selected = '';
  const tab = allTabs().find(t => t.id === ws.lastTab && t.ws === ws.key) || allTabs().findLast(t => t.ws === ws.key), owner = tab && paneOfTab(tab.id);
  if (tab && owner !== P && paneTabId(owner) === tab.id) focusPane(owner);
  else if (tab) {if (tab.id !== activeTab) await selectTab(tab.id); else focusGitSection(ws);}
  else {
    if (!await leaveArticle()) return;
    const created = makeTab(null, ws.key); tabs.push(created); activeTab = created.id; ws.lastTab = created.id; showEmptyTab(); renderTabs(); focusGitSection(ws); updateStatus(ws.status); await persistSession();
  }
  renderTree(); updatePath(); renderWorkspaceManager(); message('Showing ' + workspaceName(ws) + '.');
}
/** Deactivates a workspace: it stops being watched and its tabs, Files and Git
 * section are hidden. Its session is kept, and Control panel reactivates it. */
async function closeWorkspace(ws) {
  if (!await ensureDraftsSaved(key => key.startsWith(ws.key + '\n'), 'deactivating ' + workspaceName(ws))) return;
  await persistSession(); await sessionWrite;
  const showing = new Set(shownPanes().filter(pane => {const doc = paneActive(pane); return !!doc && !doc.external && doc.ws === ws.key;}));
  if (showing.has(P)) {active = null; setDirty(false);}
  for (const pane of showing) if (pane !== P) {pane.active = null; kanban?.update(pane);}
  workspaces = workspaces.filter(w => w !== ws); ws.git.destroy(); ws.gitSection.remove(); kanban?.forget(ws);
  settleTabs();
  if (selectedWs === ws.key) {selected = ''; selectedWs = null;}
  if (focusKey === ws.key) focusKey = null;
  if (client.capabilities.workspaces) await client.call('close', {scope: ws.api.scope});
  // Each side moves to another of its tabs; a side left without tabs closes.
  for (const pane of shownPanes()) await inPane(pane, async () => {
    const shown = visibleTabs();
    if (!shown.some(t => t.id === activeTab)) {activeTab = null; if (shown.length) await selectTab(shown.at(-1).id); else showEmptyTab();}
    else if (showing.has(pane)) await selectTab(activeTab);
  });
  await collapseEmptyPane();
  renderTabs(); renderTree(); renderGitSections(); updatePath(); updateMode();
  if (current()) updateStatus(current().status); else {$('index-status').textContent = 'Local Markdown workspace'; renderOperation({});}
  await persistSession(); await loadControlPanel(); message(workspaceName(ws) + ' deactivated. Reactivate it in Control panel › Workspaces.');
}
async function moveWorkspace(ws, offset) {
  const from = workspaces.indexOf(ws), to = from + offset;
  if (from < 0 || to < 0 || to >= workspaces.length) return;
  workspaces.splice(from, 1); workspaces.splice(to, 0, ws);
  renderTree(); renderGitSections(); renderWorkspaceManager();
  if (client.capabilities.workspaces) await client.call('workspaceLayout', {order: workspaces.map(w => w.catalog.workspace.id)});
}
async function configureWorkspace(ws, change) {
  const label = await client.call('configureWorkspace', {id: ws.catalog.workspace.id, ...change});
  ws.catalog = {...ws.catalog, workspace: {...ws.catalog.workspace, label: label.name, customName: label.customName, color: label.color}};
  renderTree(); renderTabs(); renderGitSections(); updatePath(); renderWorkspaceManager(); await loadControlPanel();
}
function renderArticle() {
  updatePath();
  live.setText(active.text); live.setEnabled(canEdit());
  raw.setText(active.text); raw.setEnabled(canEdit());
  okfBar.render();
}
function readablePassage(text, file = '', ws = activeWs() || current()) {
  const clean = String(text).replace(/^@@\s+-\d+(?:,\d+)?\s+\+?\d*(?:,\d+)?\s*@@[^\r\n]*(?:\r?\n)?/gm, '').replace(/^@@\s+-\d+(?:,\d+)?\s+@@[^\r\n]*(?:\r?\n)?/gm, '');
  return renderNote(clean, ws?.index || [], ws?.catalog.caseSensitive, new Map(), file, {titles: titles(ws), underline: underlineEnabled()});
}
function passageText(text, ws) {const node = document.createElement('div'); node.innerHTML = readablePassage(text, '', ws); for (const block of node.querySelectorAll('p,li,h1,h2,h3,pre')) block.append(' '); return node.textContent.trim();}
async function renderConnections() {
  if (!active) return; const at = active.path, ws = activeWs();
  if (active.external) {$p('relationships').innerHTML = '<span class="hint">This file is outside the workspace, so its links are not part of the graph.</span>'; return;}
  const [outgoing, incoming] = await Promise.all([ws.api.call('getOutgoingRelationships', {path: at}), ws.api.call('getIncomingRelationships', {path: at})]); if (active?.path !== at || activeWs() !== ws) return;
  const edge = (e, incoming) => {const target = incoming ? e.source_document_id : e.target_document_id || e.authored_target; return `<div class="relationship">${incoming ? '←' : '→'} <strong>${esc(e.relationship_type || e.type)}</strong> <button class="wiki-link ${e.resolved ? '' : 'broken'}" title="${esc(target)}" ${e.resolved ? 'data-open="' + esc(target) + '"' : 'data-broken="' + esc(e.authored_target) + '"'}>${esc(titles(ws).get(target) || target)}</button>${e.resolved ? '' : ' · unresolved'}</div>`;};
  $p('relationships').innerHTML = outgoing.map(e => edge(e, false)).join('') + incoming.map(e => edge(e, true)).join('') || '<span class="hint">No article links yet.</span>';
}
async function openNote(file, line, {record = true, tabId = activeTab, searchTerm = '', ws = null, at = null} = {}) {
  if (!await leaveArticle()) return;
  // A deep search started while this article loads is not cancelled by it.
  const external = isExternal(file), evidenceAtStart = evidenceSerial;
  ws = external ? null : ws || activeWs() || current();
  if (!external && !ws) throw new Error('Open a workspace first.');
  const serial = ++openSerial, doc = external ? await loadExternal(file) : withWs(await ws.api.call('getDocument', {path: file}), ws); if (serial !== openSerial) return;
  if (ws?.partial && !external) {ws.index.addFile(file); for (const link of doc.links || []) if (link.resolvedPath) ws.index.addFile(link.resolvedPath);}
  // Articles from any active workspace load into the same tab.
  let tab = tabs.find(t => t.id === tabId);
  active = doc; if (!external) {selected = file; selectedWs = focusKey = ws.key;} setDirty(false); updatePath();
  const entry = draftKey(external ? null : ws.key, file);
  if (!tab) {tab = makeTab(null, ws?.key || null); tabs.push(tab);} activeTab = tab.id; tab.path = file; tab.ws = external ? null : ws.key; if (ws) ws.lastTab = tab.id;
  if (at !== null) tab.at = at;
  else if (record && tab.history[tab.at] !== entry) {
    tab.history = [...tab.history.slice(0, tab.at + 1), entry]; const dropped = Math.max(0, tab.history.length - 200); tab.history = tab.history.slice(dropped);
    if (tab.scroll) tab.scroll = Object.fromEntries(Object.entries(tab.scroll).map(([i, v]) => [Number(i) - dropped, v]).filter(([i]) => i >= 0 && i < tab.history.length - 1));
    tab.at = tab.history.length - 1;
  }
  // Restore unsaved changes kept when this article was left with autosave off.
  const key = draftKey(external ? null : ws.key, file), draft = drafts.get(key);
  if (draft) {drafts.delete(key); active = {...doc, text: draft.text, hash: draft.hash};}
  if (evidenceSerial === evidenceAtStart && evidencePane === P) {evidenceSerial++; $('evidence-panel').hidden = true;}
  $p('welcome').hidden = true; $p('note-panel').hidden = false; mobileLayout.dismiss();
  $p('note-warning').textContent = [doc.warning || '', ...(doc.diagnostics || []).slice(0, 10).map(d => 'Line ' + d.line + ': ' + d.message)].filter(Boolean).join(' ');
  updateIncoming();
  if (ws) {focusGitSection(ws); updateStatus(ws.status);}
  renderArticle(); kanban?.update(P); live.setSearchTerm(searchTerm); raw.setSearchTerm(searchTerm);
  if (draft) {setDirty(true); if (draft.hash !== doc.hash) $p('note-warning').textContent = 'This article changed on disk after your unsaved edits. Saving will report a conflict; copy your changes or reload.';}
  updateMode(); renderTabs(); renderTree(); revealFile(); updatePanes(); if (!line) restoreScroll(tab); renderWorkspaceManager(); await renderConnections(); if (showGraph && ws && graphPane === P) graph.update(ws.graphData, file);
  if (!external) {history.replaceState(history.state, '', '#note=' + encodeURIComponent(file)); mobileLayout.addressChanged();}
  if (line && edit) {const position = doc.text.split('\n').slice(0, Math.max(0, line - 1)).join('\n').length + (line > 1 ? 1 : 0); (source ? raw : live).focusPosition(position);}
  await persistSession(); return true;
}
// Read (or re-read) a file opened from outside the workspace.
async function loadExternal(key) {
  let doc = externalDocs.get(key);
  if (!doc) throw new Error('This file is no longer open. Open it again with Ctrl+O.');
  if (doc.osPath && client.readExternal) doc = {...doc, ...await client.readExternal(doc.osPath), path: key};
  doc = {...doc, eol: doc.text.includes('\r\n') ? '\r\n' : '\n', diagnostics: []};
  externalDocs.set(key, doc); return doc;
}
// `file` is {path, name, text, hash} from the host, or a browser File's text.
async function openExternal(file, {key = EXTERNAL + file.path, osPath = file.path, writable = !!client.saveExternal} = {}) {
  externalDocs.set(key, {...file, path: key, osPath, name: file.name, external: true, writable});
  const open = allTabs().find(tab => tab.path === key);
  if (open) {focusPane(paneOfTab(open.id)); await openNote(key, null, {record: false, tabId: open.id}); return;}
  await openNote(key, null, {tabId: null}); message('Opened outside the workspace: ' + file.name + (writable ? '' : ' (read-only)'));
}
async function openBrowserFile(file) {
  if (portable) {message('This is a read-only workspace export.'); return;}
  if (!/\.(md|markdown)$/i.test(file.name)) {message('Only Markdown (.md) files can be opened.'); return;}
  await openExternal({path: file.name, name: file.name, text: await file.text(), hash: ''}, {key: EXTERNAL + 'browser/' + file.lastModified + '/' + file.name, osPath: null, writable: false});
}
async function openFileDialog() {
  if (portable) return;
  if (client.chooseMarkdownFile) {
    const file = await client.chooseMarkdownFile(current()?.catalog.root || null); if (!file) return;
    // A file inside an active workspace opens as that workspace's article.
    const norm = value => value.replace(/[\\/]+/g, '/').replace(/\/$/, '');
    for (const ws of workspaces) {
      const root = norm(ws.catalog.root) + '/', chosen = norm(file.path), same = ws.catalog.caseSensitive ? chosen.startsWith(root) : chosen.toLowerCase().startsWith(root.toLowerCase());
      const relative = same ? chosen.slice(root.length) : null;
      if (relative && ws.index.has(relative)) {await openNote(relative, null, {ws}); return;}
    }
    await openExternal(file); return;
  }
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.md,.markdown,text/markdown'; input.multiple = true;
  input.onchange = run(async () => {for (const file of input.files) await openBrowserFile(file);}); input.click();
}
async function create(folder, {atRoot = false} = {}) {
  const ws = atRoot ? current() : wsByKey(selectedWs) || current();
  if (!edit || !ws) return;
  const within = !atRoot && selectedWs === ws.key ? selected : '';
  let base = within && ws.index.isFolder(within) ? within + '/' : within.split('/').slice(0, -1).join('/'); if (base && !base.endsWith('/')) base += '/';
  const place = base || (multi() ? 'Root of ' + workspaceName(ws) : 'Workspace root');
  const answer = await promptUser(folder ? 'New folder' : 'New article', (folder ? 'Enter a folder name. ' : 'Enter an article name. Saved as Markdown (.md). ') + 'Location: ' + place, {value: folder ? 'New folder' : 'Untitled', ok: 'Create'});
  if (answer.action !== 'ok') return;
  if (!answer.value || /[\\/]/.test(answer.value)) throw new Error('Enter a filename without a folder path.');
  const name = folder ? answer.value : answer.value.replace(/\.md$/i, '').trim();
  if (!name) throw new Error('Enter an article name.');
  const file = base + name + (folder ? '' : '.md');
  // New articles start with OKF frontmatter whose title matches the heading.
  const text = folder ? null : stampArticle(createFrontmatter('# ' + name.replace(/([\\`*_\[\]<>#])/g, '\\$1') + '\n\n', {title: name}));
  await ws.api.call('create', {path: file, folder, text}); ws.catalog = await ws.api.call('catalog'); selected = file; selectedWs = ws.key;
  for (const p of file.split('/').slice(0, -1).map((_,i) => file.split('/').slice(0,i+1).join('/'))) ws.expanded.add(p);
  renderTree(); if (!folder) await openNote(file, null, {ws}); else message('Folder created.');
}
async function rename(move = false) {
  const ws = wsByKey(selectedWs);
  if (!edit || !selected || !ws || !await ensureDraftsSaved(key => key.startsWith(ws.key + '\n'), 'renaming')) return;
  const from = selected, parent = from.split('/').slice(0, -1).join('/'), filename = from.split('/').at(-1);
  const folder = ws.index.isFolder(from), extension = !folder && filename.match(/\.md$/i)?.[0];
  const answer = await promptUser(move ? 'Move to folder' : folder ? 'Rename folder' : 'Rename file', move ? 'Enter an existing workspace folder path, or leave empty for the workspace root.' : folder ? 'Enter a new folder name.' : 'Enter a new filename in the same folder.' + (extension ? ' The Markdown extension (.md) is kept.' : ''), {value: move ? parent : extension ? filename.slice(0, -extension.length) : filename, ok: 'Continue'});
  if (answer.action !== 'ok') return;
  if (!move && (!answer.value || /[\\/]/.test(answer.value))) throw new Error('Enter a filename without a folder path. Use Move to change folders.');
  const name = !move && extension ? answer.value.replace(/\.md$/i, '').trim() : answer.value;
  if (!move && !name) throw new Error('Enter a filename.');
  const to = move ? [answer.value.replaceAll('\\', '/').replace(/\/$/, ''), filename].filter(Boolean).join('/') : [parent, name + (extension || '')].filter(Boolean).join('/');
  if (to === from) return;
  const action = move ? 'Move' : folder ? 'Rename folder' : 'Rename file';
  if (await relocate(ws, from, to, plan => promptUser('Update links?', `${action} affects ${affected(plan)}. Update ${plan.links && plan.cards ? 'them' : plan.cards ? 'the cards' : 'those links'}?`, {ok: action + ' and update links', secondary: action + ' without updating', confirmKeys: true}))) message(move ? 'Move complete.' : 'Rename complete.');
}
/** “3 links across 2 notes and 4 Kanban cards” for a rename/move preview. */
function affected(plan) {
  const links = plan.links ? count(plan.links, 'link') + (plan.cards ? '' : ' across ' + count(plan.notes, 'note')) : '';
  const cards = plan.cards ? count(plan.cards, 'Kanban card') + (plan.cards === 1 ? ' that names a moved board' : ' that name a moved board') : '';
  return [links, cards].filter(Boolean).join(' and ');
}
/** Renames or moves a file or folder within its workspace. When links point
 * into it, `ask(plan)` chooses whether they are updated (or cancels); with no
 * affected links nothing is asked. Returns false when cancelled. */
async function relocate(ws, from, to, ask) {
  const folder = ws.index.isFolder(from);
  kanban?.checkRename(ws, from, to);
  const plan = await ws.api.call('renamePreview', {from, to});
  // Links and Kanban cards that name a moved board are updated together.
  const choice = plan.links + (plan.cards || 0) > 0 ? await ask(plan) : {action:'secondary'};
  if (choice.action === 'cancel') return false;
  await ws.api.call('rename', {token: plan.token, updateLinks: choice.action === 'ok'});
  if (folder) storeHiddenFolders(ws, moveHiddenFolders(folderPreferences(ws).hiddenFolders, from, to));
  const moved = file => file === from || file.startsWith(from + '/') ? to + file.slice(from.length) : file;
  const movedEntry = entry => {const p = entryParts(entry); return p.ws === ws.key ? draftKey(ws.key, moved(p.path)) : entry;};
  const movedTab = t => ({...t, path: t.ws === ws.key && t.path ? moved(t.path) : t.path, history: t.history.map(movedEntry), scroll: t.scroll && Object.fromEntries(Object.entries(t.scroll).map(([i, v]) => [i, {...v, entry: movedEntry(v.entry)}]))});
  for (const pane of panes) if (pane === P) tabs = tabs.map(movedTab); else pane.tabs = pane.tabs.map(movedTab);
  for (const [key, draft] of [...drafts]) if (movedEntry(key) !== key) {drafts.delete(key); drafts.set(movedEntry(key), draft);}
  // Open articles take their new paths in place. Reopening them would hide and
  // lay out the article again, so the window would flicker on every move.
  const showing = shownPanes().filter(pane => {const doc = paneActive(pane); return !!doc && !doc.external && doc.ws === ws.key;});
  for (const pane of showing) {const doc = {...paneActive(pane), path: moved(paneActive(pane).path)}; if (pane === P) active = doc; else pane.active = doc;}
  for (const parts = to.split('/').slice(0, -1); parts.length; parts.pop()) ws.expanded.add(parts.join('/'));
  selected = to; selectedWs = ws.key; await applyCatalog(ws, await ws.api.call('catalog'));
  // Updated links (and their timestamps) appear without moving the reading position.
  for (const pane of showing) {
    const doc = paneActive(pane), fresh = withWs(await ws.api.call('getDocument', {path: doc.path}), ws);
    if (paneActive(pane) !== doc) continue;
    const holding = pane === P && dirty || drafts.has(docKey(doc)), next = holding ? {...doc, hash: fresh.hash} : fresh;
    if (pane === P) active = next; else pane.active = next;
    refreshPaneText(pane, holding ? (paneSource(pane) ? pane.raw : pane.live).text : next.text);
    if (pane === P) {updatePath(); await renderConnections(); history.replaceState(null, '', '#note=' + encodeURIComponent(next.path));}
  }
  renderTabs(); await persistSession(); return true;
}
// Drag a file or folder in Files onto a folder, a workspace heading or blank
// space to move it there (pointer events: the desktop host handles native
// drag-and-drop for files dropped from outside). Hovering a closed folder
// opens it; Escape cancels.
let treeDrag = null;
const treeDropTarget = event => {
  const element = document.elementFromPoint(event.clientX, event.clientY);
  if (!element || !$('files-panel').contains(element)) return null;
  const row = element.closest('[data-tree-path]');
  if (row) return {ws: row.dataset.ws, folder: row.dataset.folder === 'true' ? row.dataset.treePath : row.dataset.treePath.split('/').slice(0, -1).join('/'), row: row.dataset.folder === 'true' ? row.dataset.treePath : null};
  const section = element.closest('[data-workspace-root]')?.dataset.workspaceRoot || element.closest('.tree-workspace')?.dataset.ws || workspaces.at(-1)?.key;
  return section ? {ws: section, folder: '', row: null} : null;
};
/** Whether the dragged item can move to `target` (Edit on, same workspace, a new parent, not inside itself). */
const treeDropAllowed = (drag, target) => edit && !!target && target.ws === drag.ws && target.folder !== drag.path.split('/').slice(0, -1).join('/') && target.folder !== drag.path && !target.folder.startsWith(drag.path + '/');
function paintTreeDrag() {
  for (const node of $('tree').querySelectorAll('.drop-target, .dragging')) node.classList.remove('drop-target', 'dragging');
  if (!treeDrag?.active) return;
  const rows = [...$('tree').querySelectorAll('[data-tree-path]')], target = treeDrag.target;
  rows.find(row => row.dataset.ws === treeDrag.ws && row.dataset.treePath === treeDrag.path)?.classList.add('dragging');
  if (!target || !treeDrag.allowed) return;
  if (target.folder) rows.find(row => row.dataset.ws === target.ws && row.dataset.treePath === target.folder && row.dataset.folder === 'true')?.classList.add('drop-target');
  else [...$('tree').querySelectorAll('.tree-workspace')].find(section => section.dataset.ws === target.ws)?.classList.add('drop-target');
}
function endTreeDrag() {
  if (!treeDrag) return;
  clearTimeout(treeDrag.expandTimer); cancelAnimationFrame(treeDrag.scrollFrame);
  if (treeDrag.active) {treeDrag.ghost?.remove(); document.body.classList.remove('tree-dragging'); try {$('tree').releasePointerCapture(treeDrag.pointer);} catch {}}
  treeDrag = null; paintTreeDrag(); kanban?.clearDrops();
}
$('tree').addEventListener('pointerdown', event => {
  // Without Edit, articles can still be dragged onto a Kanban board.
  // A finger drag scrolls the list; touch moves use the context menu's Move.
  if (event.button !== 0 || event.pointerType === 'touch' || !client.writable || !(edit || kanban?.writable()) || treeDrag) return;
  const row = event.target.closest('[data-tree-path]'); if (!row || !wsByKey(row.dataset.ws)) return;
  treeDrag = {ws: row.dataset.ws, path: row.dataset.treePath, x: event.clientX, y: event.clientY, pointer: event.pointerId, active: false};
});
$('tree').addEventListener('pointermove', event => {
  if (!treeDrag || event.pointerId !== treeDrag.pointer) return;
  if (!treeDrag.active) {
    if (Math.hypot(event.clientX - treeDrag.x, event.clientY - treeDrag.y) < 6) return;
    treeDrag.active = true; $('tree').setPointerCapture(event.pointerId); document.body.classList.add('tree-dragging');
    const ghost = treeDrag.ghost = document.createElement('div'); ghost.id = 'tree-drag-ghost'; ghost.textContent = treeDrag.path.split('/').at(-1); document.body.append(ghost);
    for (let node = $('tree').parentElement; node; node = node.parentElement) if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) {treeDrag.scroller = node; break;}
  }
  treeDrag.ghost.style.setProperty('left', event.clientX + 14 + 'px'); treeDrag.ghost.style.setProperty('top', event.clientY + 10 + 'px');
  // Over a Kanban board shown in the article's workspace, the drop places the article in a column.
  const board = kanban?.dropTarget(event.clientX, event.clientY, {ws: wsByKey(treeDrag.ws), path: treeDrag.path});
  treeDrag.board = board;
  if (board || kanban?.boardAt(event.clientX, event.clientY)) {clearTimeout(treeDrag.expandTimer); treeDrag.target = null; treeDrag.allowed = false; treeDrag.ghost.classList.toggle('blocked', !board); paintTreeDrag(); cancelAnimationFrame(treeDrag.scrollFrame); return;}
  const target = treeDropTarget(event), allowed = treeDropAllowed(treeDrag, target);
  if (target?.row !== treeDrag.target?.row || target?.ws !== treeDrag.target?.ws) {
    clearTimeout(treeDrag.expandTimer);
    const ws = wsByKey(target?.ws), folder = target?.row;
    if (ws && folder && allowed && !ws.expanded.has(folder)) treeDrag.expandTimer = setTimeout(() => {if (treeDrag?.target?.row === folder) {ws.expanded.add(folder); renderTree(); paintTreeDrag();}}, 650);
  }
  treeDrag.target = target; treeDrag.allowed = allowed; treeDrag.ghost.classList.toggle('blocked', !allowed);
  paintTreeDrag();
  // Scroll the Files pane while dragging near its top or bottom edge.
  cancelAnimationFrame(treeDrag.scrollFrame);
  const scroller = treeDrag.scroller; if (!scroller) return;
  const bounds = scroller.getBoundingClientRect(), step = event.clientY < bounds.top + 28 ? -12 : event.clientY > bounds.bottom - 28 ? 12 : 0;
  if (step) {const scroll = () => {if (!treeDrag?.active) return; scroller.scrollTop += step; treeDrag.scrollFrame = requestAnimationFrame(scroll);}; treeDrag.scrollFrame = requestAnimationFrame(scroll);}
});
$('tree').addEventListener('pointerup', event => {
  if (!treeDrag || event.pointerId !== treeDrag.pointer) return;
  const drag = treeDrag, target = drag.active && drag.allowed ? drag.target : null, board = drag.active ? drag.board : null;
  if (drag.active) suppressNextClick($('tree'));
  if (drag.active && !target && !board) message(kanban?.boardAt(event.clientX, event.clientY) ? (wsByKey(drag.ws).index.has(drag.path) ? 'Articles can be added only to boards of their own workspace, in a column.' : 'Only Markdown articles can be added to a Kanban board.') : !edit ? 'Turn on Edit to move files.' : drag.target && drag.target.ws !== drag.ws ? 'Files can only be moved within their own workspace.' : 'Drop on a different folder to move ' + drag.path.split('/').at(-1) + '.');
  endTreeDrag();
  if (board) run(() => kanban.dropArticle(board, drag.path))();
  if (target) run(() => moveByDrag(wsByKey(drag.ws), drag.path, target.folder))();
});
$('tree').addEventListener('pointercancel', endTreeDrag);
document.addEventListener('keydown', event => {if (event.key === 'Escape' && treeDrag?.active) {event.preventDefault(); endTreeDrag(); message(ui('Move cancelled.'));}}, true);
/** Ignores the click that ends a drag, so dropping does not also open or select. */
function suppressNextClick(element) {
  const swallow = event => {event.stopImmediatePropagation(); event.preventDefault();};
  element.addEventListener('click', swallow, {capture: true, once: true});
  setTimeout(() => element.removeEventListener('click', swallow, {capture: true}), 0);
}
async function moveByDrag(ws, from, folder) {
  if (!ws || !edit || !await ensureDraftsSaved(key => key.startsWith(ws.key + '\n'), 'moving')) return;
  const name = from.split('/').at(-1), to = [folder, name].filter(Boolean).join('/'), place = folder ? '“' + folder + '”' : multi() ? 'the root of ' + workspaceName(ws) : 'the workspace root';
  if (to === from) return;
  const moved = await relocate(ws, from, to, plan => promptUser('Update links?', `Moving “${name}” to ${place} affects ${affected(plan)}. Update ${plan.links && plan.cards ? 'them' : plan.cards ? 'the cards' : 'those links'}?`, {ok: 'Yes', secondary: 'No', confirmKeys: true}));
  if (moved) message('Moved ' + name + ' to ' + (folder || (multi() ? workspaceName(ws) : 'the workspace root')) + '.');
}
// Copy and paste in Files: Copy remembers a file or folder; Paste writes a copy
// into the selected folder (or beside the selected file). A name already taken
// there gains “copy” (“Notes copy.md”, “Notes copy 2.md”), as does a copied
// board whose filename another board has, since board names stay unique.
let fileClipboard = null;
// Files keeps Ctrl+C/Ctrl+V while it was used last: redrawing the tree after a
// click moves focus to the page body.
let filesActive = false;
document.addEventListener('pointerdown', event => {filesActive = !!event.target.closest?.('#files-panel');}, true);
document.addEventListener('focusin', event => {if (event.target !== document.body) filesActive = $('files-panel').contains(event.target);});
function copyEntry() {
  const ws = wsByKey(selectedWs);
  if (!ws || !selected) return;
  fileClipboard = {ws: ws.key, path: selected, folder: ws.index.isFolder(selected)};
  message('Copied ' + selected.split('/').at(-1) + '. Select a folder in Files and paste with Ctrl+V or right-click › Paste.');
}
function pasteName(ws, folder, name, isFolder, {board = false} = {}) {
  const fold = value => ws.catalog.caseSensitive ? value : value.toLowerCase();
  const siblings = new Set([...(ws.index.children.get(folder) || [])].map(path => fold(path.split('/').at(-1))));
  const extension = isFolder ? '' : name.match(/\.[^.]+$/)?.[0] || '', stem = name.slice(0, name.length - extension.length);
  for (let n = 0; n < 1000; n++) {
    const next = n ? stem + ' copy' + (n > 1 ? ' ' + n : '') + extension : name;
    if (!siblings.has(fold(next)) && !(board && kanban?.boardNamed(ws, next))) return [folder, next].filter(Boolean).join('/');
  }
  throw new Error('Choose another folder: too many copies of ' + name + ' are already there.');
}
async function pasteEntry() {
  const ws = wsByKey(selectedWs) || current(), clip = fileClipboard, from = wsByKey(clip?.ws);
  if (!edit || !ws || !clip) return;
  if (!from) throw new Error('The copied file’s workspace is not active. Reactivate it, or copy the file again.');
  const folder = !selected || selectedWs !== ws.key ? '' : ws.index.isFolder(selected) ? selected : selected.split('/').slice(0, -1).join('/');
  if (from === ws && clip.folder && (folder === clip.path || folder.startsWith(clip.path + '/'))) throw new Error('A folder cannot be pasted inside itself.');
  const name = clip.path.split('/').at(-1), within = path => path === clip.path || path.startsWith(clip.path + '/');
  // Unsaved changes are part of what was copied.
  if (!await ensureDraftsSaved(key => {const p = entryParts(key); return p.ws === from.key && within(p.path);}, 'copying')) return;
  const to = pasteName(ws, folder, name, clip.folder, {board: !clip.folder && !!kanban?.isBoard(from, clip.path)});
  if (from === ws) await ws.api.call('copy', {from: clip.path, to});
  else {
    // Between workspaces, articles are copied through the reader; folders stay in theirs.
    if (clip.folder || !/\.md$/i.test(clip.path)) throw new Error('Folders and other files can be pasted only within their own workspace. Articles can be pasted into another workspace.');
    const doc = await from.api.call('getDocument', {path: clip.path});
    await ws.api.call('create', {path: to, text: doc.text});
  }
  for (const parts = to.split('/').slice(0, -1); parts.length; parts.pop()) ws.expanded.add(parts.join('/'));
  selected = to; selectedWs = ws.key; await applyCatalog(ws, await ws.api.call('catalog'));
  void kanban?.workspaceChanged(ws);
  message('Pasted ' + to + '.');
}
async function retitle() {
  const ws = wsByKey(selectedWs);
  if (!edit || !selected || !ws || !/\.md$/i.test(selected) || ws.index.isFolder(selected) || !await ensureDraftsSaved(key => key === draftKey(ws.key, selected), 'retitling')) return;
  const path = selected, document = await ws.api.call('getDocument', {path});
  const answer = await promptUser('Retitle Article', 'Change the article heading. Its filename and incoming links stay the same.', {value:articlePresentation(document.text,path).title, ok:'Retitle'});
  if (answer.action !== 'ok') return;
  const text = retitleArticle(document.text, answer.value);
  if (text === document.text) return;
  await ws.api.call('save', {path, text: stampArticle(text, {created: document.created}), hash:document.hash});
  await applyCatalog(ws, await ws.api.call('catalog'));
  await reloadChangedPanes(ws);
  message('Article retitled.');
}
async function remove() {
  const ws = wsByKey(selectedWs);
  // Deleting needs no save first; unsaved changes to deleted articles are discarded.
  if (!edit || !selected || !ws) return;
  const backups = panelInfo?.deleteBackups === true;
  const answer = await promptUser('Delete ' + selected + '?', (backups ? 'The selected file or folder and its contents will be removed. Weave keeps a backup copy (Settings › Storage location).' : 'The selected file or folder and its contents will be permanently removed from disk. Weave does not keep a copy; use Git or your own backups to recover it.') + (kanban?.deleteNote(ws, selected) || ''), {ok: 'Delete'});
  if (answer.action !== 'ok') return; const target = selected;
  const result = await ws.api.call('delete', {path: target, confirmed: true});
  const removed = file => file === target || file?.startsWith(target + '/'), removedEntry = entry => {const p = entryParts(entry); return p.ws === ws.key && removed(p.path);};
  for (const key of [...drafts.keys()]) if (removedEntry(key)) drafts.delete(key);
  const showing = new Set(shownPanes().filter(pane => {const doc = paneActive(pane); return !!doc && !doc.external && doc.ws === ws.key && removed(doc.path);}));
  if (showing.has(P)) {setDirty(false); active = null;}
  for (const pane of showing) {if (pane !== P) pane.active = null; pane.el['note-panel'].hidden = true; pane.el.welcome.hidden = false;}
  const prune = (list, chosen) => list.map(t => {
    if (!t.history.some(removedEntry)) return t;
    const kept = entriesFor(t, entry => !removedEntry(entry)), next = {...t, history: kept.history, scroll: undefined};
    if (kept.history.length) setTabAt(next, kept.at); else {next.path = null; next.at = -1; next.emptied = true;}
    return next;
  }).filter(t => !t.emptied || t.id === chosen).map(t => {delete t.emptied; return t;});
  for (const pane of panes) if (pane === P) tabs = prune(tabs, activeTab); else pane.tabs = prune(pane.tabs, pane.activeTab);
  selected = ''; await applyCatalog(ws, await ws.api.call('catalog'));
  for (const pane of shownPanes()) await inPane(pane, async () => {
    const tab = currentTab(), wasShowing = showing.has(pane);
    if (wasShowing && tab?.path) await selectTab(tab.id); else if (!tab) {const shown = visibleTabs(); if (shown.length) await selectTab(shown.at(-1).id); else showEmptyTab();} else if (wasShowing) showEmptyTab();
  });
  renderTabs(); await persistSession(); message('Deleted.' + (result.recovery ? ' Backup copy: ' + result.recovery : ''));
}
// Search preferences (Control panel > Search options).
const searchAll = () => prefs.get('search-all-workspaces') !== 'false';
const searchExcluded = () => {try {return new Set(JSON.parse(prefs.get('search-excluded') || '[]'));} catch {return new Set();}};
/** Workspaces a search covers: every active one (minus those unticked in the
 * filter), or only the workspace in use when cross-workspace search is off. */
const searchTargets = () => (searchAll() ? workspaces : [current()].filter(Boolean)).filter(ws => !searchExcluded().has(ws.key));
function renderSearchFilter() {
  const filter = $('search-filter'), shown = searchAll() ? workspaces : [current()].filter(Boolean);
  filter.hidden = !multi();
  if (filter.hidden) return;
  const excluded = searchExcluded(), included = shown.filter(ws => !excluded.has(ws.key)).length;
  const signature = JSON.stringify([searchAll(), shown.map(ws => [ws.key, workspaceName(ws), workspaceColor(ws)]), [...excluded]]);
  if (signature === filter.dataset.signature) return; filter.dataset.signature = signature;
  filter.querySelector('summary').textContent = searchAll() ? (included === shown.length ? 'All workspaces' : included + ' of ' + shown.length) : 'In use only';
  $('search-filter-list').innerHTML = shown.map(ws => `<label data-workspace-color="${workspaceColor(ws)}"><input type="checkbox" data-search-workspace="${esc(ws.key)}" ${excluded.has(ws.key) ? '' : 'checked'}><span class="workspace-dot" aria-hidden="true"></span><span>${esc(workspaceName(ws))}</span></label>`).join('') + (searchAll() ? '' : '<p class="hint">Cross-workspace search is off in Search options.</p>');
}
function displaySearch(groups, query) {
  const highlight = searchHighlightQuery(query), first = groups[0]?.result || {}, labelled = multi();
  const notices = groups.flatMap(g => g.result.notices || []);
  $('search-method').textContent = (first.method === 'bm25' ? 'Keyword search' : 'Local text search') + (labelled ? ' · ' + count(groups.length, 'workspace') : '') + (notices.length ? ' · ' + notices.join(' ') : '');
  // Results from every searched workspace are interleaved by relevance.
  const results = groups.flatMap(({ws, result}) => result.results.map((r, rank) => ({ws, r, rank}))).sort((a, b) => (b.r.score ?? -b.rank) - (a.r.score ?? -a.rank) || a.rank - b.rank).slice(0, 50);
  const filenames = prefs.get('search-filenames') === 'true';
  $('search-results').innerHTML = results.map(({ws, r}) => `<button class="result${labelled ? ' workspace-result' : ''}" data-open="${esc(r.path)}" data-ws="${esc(ws.key)}"${labelled ? ` data-workspace-color="${workspaceColor(ws)}"` : ''} data-search-term="${esc(highlight)}" data-line="${r.excerpt?.line || 1}" title="${esc(r.path)}"><span class="result-head"><strong>${highlightSearch(r.title, highlight)}</strong>${labelled ? `<em class="result-workspace-label">${esc(workspaceName(ws))}</em>` : ''}</span>${filenames ? `<small>${highlightSearch(r.path, highlight)}</small>` : ''}<span class="result-excerpt">${highlightSearch(passageText(r.excerpt?.text || '', ws), highlight)}</span></button>`).join('') || '<p class="hint">No matching notes.</p>';
}
function applySearchLayout() {
  const lines = Math.max(0, Math.min(6, Number(prefs.get('search-lines') ?? 3)));
  $('search-results').style.setProperty('--search-lines', String(lines)); $('search-results').classList.toggle('no-excerpts', lines === 0);
}
let searchTimer;
function runSearch() { clearTimeout(searchTimer); renderSearchFilter(); const serial = ++searchSerial, query = $('search-query').value; searchTimer = setTimeout(run(async () => {
  if (!workspaces.length) return;
  if (!query.trim()) { $('search-results').innerHTML = ''; $('search-method').textContent = ''; return; }
  const targets = searchTargets();
  const groups = await Promise.all(targets.map(ws => ws.api.call('searchKnowledge', {query, enrich: false, searchChannel:'live'}).then(result => ({ws, result}), error => ({ws, result: {results: [], notices: [workspaceName(ws) + ': ' + error.message]}}))));
  if (serial !== searchSerial) return;
  if (!targets.length) {$('search-results').innerHTML = '<p class="hint">No workspaces are selected in the search filter.</p>'; $('search-method').textContent = ''; return;}
  displaySearch(groups, query);
}), 130); }
$('search-query').oninput = runSearch;
$('search-filter-list').addEventListener('change', event => {
  const box = event.target.closest('[data-search-workspace]'); if (!box) return;
  const excluded = searchExcluded(); box.checked ? excluded.delete(box.dataset.searchWorkspace) : excluded.add(box.dataset.searchWorkspace);
  prefs.set('search-excluded', JSON.stringify([...excluded])); runSearch();
});
for (const [id, key, fallback] of [['search-all-workspaces', 'search-all-workspaces', 'true'], ['search-filenames', 'search-filenames', 'false']]) {
  $(id).checked = (prefs.get(key) ?? fallback) === 'true';
  $(id).onchange = () => {prefs.set(key, String($(id).checked)); runSearch();};
}
for (const [id, key, fallback] of [['search-lines', 'search-lines', '3'], ['deep-seeds', 'deep-seeds', '5'], ['deep-max', 'deep-max', '20']]) {
  $(id).value = prefs.get(key) ?? fallback;
  $(id).onchange = () => {prefs.set(key, $(id).value); applySearchLayout(); runSearch();};
}
applySearchLayout();
// Enter runs a deep search in the workspace in use.
$('ask-form').onsubmit = run(async event => {
  event.preventDefault(); const ws = current(); if (!ws) return;
  const question = $('search-query').value.trim(); if (!question) return;
  clearTimeout(searchTimer); searchSerial++;
  const serial = ++evidenceSerial; $('ask-status').textContent = 'Deep search' + (multi() ? ' in ' + workspaceName(ws) : '') + ': retrieving notes and their connections…';
  try {
    const bundle = await ws.api.call('buildEvidenceBundle', {question, connections: $('use-connections').checked, seedLimit: Number($('deep-seeds').value) || 5, maxDocuments: Number($('deep-max').value) || 20}); if (!workspaces.includes(ws) || serial !== evidenceSerial) return;
    $('evidence-question').textContent = question; $('evidence-notices').textContent = (multi() ? 'Searched ' + workspaceName(ws) + ', the workspace in use. ' : '') + 'Source passages and recorded relationships. No generated answer. ' + (bundle.notices || []).join(' ') + (bundle.truncated ? ' Expansion was limited to keep the result focused.' : '');
    $('evidence').innerHTML = bundle.documents.map(d => `<section class="evidence-card"><h2><button class="wiki-link" data-open="${esc(d.path)}" data-ws="${esc(ws.key)}" data-line="${d.passage?.line || 1}">${esc(d.title || d.path)}</button></h2><small>${esc(d.path)}</small><div class="evidence-passage">${readablePassage(d.passage?.text || d.error || '', d.path, ws)}</div>${(d.relationships || []).slice(0, 12).map(r => `<div class="relationship">${esc(r.relationship_type)} → ${r.resolved ? '<button class="wiki-link" data-open="' + esc(r.target_document_id) + '" data-ws="' + esc(ws.key) + '">' + esc(titles(ws).get(r.target_document_id) || r.target_document_id) + '</button>' : esc(r.authored_target) + ' (unresolved)'}</div>`).join('')}</section>`).join('') || '<p>No supporting articles found. Try a more specific question.</p>';
    // Deep search results take the place of the article in the focused pane.
    evidencePane = P; $p('note-panel').after($('evidence-panel')); $('evidence-panel').hidden = false; updatePanes(); mobileLayout.dismiss(); $('ask-status').textContent = bundle.documents.length + ' source articles';
  } catch (e) { if (workspaces.includes(ws) && serial === evidenceSerial) $('ask-status').textContent = e.message; }
});
document.addEventListener('click', run(async event => {
  if (event.target.closest('[data-suggest]')) return;
  if (!event.target.closest('#file-menu')) $('file-menu').hidden = true;
  if (!event.target.closest('#tab-menu')) $('tab-menu').hidden = true;
  if (!event.target.closest('#app-menu, #app-menu-button')) closeAppMenu();
  if (!event.target.closest('#article-menu')) $('article-menu').hidden = true;
  if (!event.target.closest('#link-menu')) $('link-menu').hidden = true;
  if (!event.target.closest('#search-filter')) $('search-filter').open = false;
  const link = event.target.closest('[data-open], [data-chat-entity]');
  if (link) {const ws = wsByKey(link.dataset.ws) || activeWs() || current(); let file = link.dataset.open || link.dataset.chatEntity; file = ws?.graphData.entities.find(n => n.stableId === file)?.file || file; await openNote(file, Number(link.dataset.line) || null, {searchTerm:link.dataset.searchTerm || '', ws}); return; }
  const broken = event.target.closest('button[data-broken]'); if (broken) {message('Unresolved link: ' + broken.dataset.broken + '. Check the path or create the target article.'); return; }
  const anchor = event.target.closest('a[href]'); if (anchor) { event.preventDefault(); if (/^https?:\/\//i.test(anchor.href)) await client.openResource(anchor.href); }
}));
document.addEventListener('weave-follow-link', run(async event => {if (event.detail.external) await client.openResource(event.detail.path); else await openNote(event.detail.path);}));
$('tree').onclick = run(async event => {
  const collapse = event.target.closest('[data-collapse-workspace]'); if (collapse) {wsByKey(collapse.dataset.collapseWorkspace)?.expanded.clear(); renderTree(); return;}
  const more = event.target.closest('[data-tree-more]'); if (more) {const ws = wsByKey(more.dataset.treeMore); if (ws) {ws.treeLimit += 1000; renderTree();} return;}
  const heading = event.target.closest('[data-workspace-root]'); if (heading) {const ws = wsByKey(heading.dataset.workspaceRoot); selected = ''; selectedWs = focusKey = ws.key; renderTree(); message(workspaceName(ws) + ' root selected.'); return;}
  const row = event.target.closest('[data-tree-path]'); if (!row) return; const ws = wsByKey(row.dataset.ws); if (!ws) return;
  selected = row.dataset.treePath; selectedWs = ws.key;
  if (row.dataset.folder === 'true') { ws.expanded.has(selected) ? ws.expanded.delete(selected) : ws.expanded.add(selected); renderTree(); } else if (/\.md$/i.test(selected)) await openNote(selected, null, {ws}); else {renderTree(); message('This file is shown for organization. Weave reads Markdown articles.');}
});
$('files-panel').addEventListener('click', event => {
  if (event.target.closest('button,a,input,select')) return;
  const ws = wsByKey(event.target.closest('[data-ws]')?.dataset.ws) || current(); if (!ws) return;
  selected = ''; selectedWs = ws.key; renderTree(); message(multi() ? workspaceName(ws) + ' root selected.' : 'Workspace root selected.');
});
function showFilesMenu(event) {
  if (!workspaces.length) return;
  event.preventDefault(); const row = event.target.closest('[data-tree-path]');
  const ws = wsByKey(row?.dataset.ws || event.target.closest('[data-ws]')?.dataset.ws) || current();
  selected = row?.dataset.treePath || ''; selectedWs = ws.key; renderTree();
  const menu = $('file-menu'), visibility = folderPreferences(ws);
  menu.dataset.path = selected; menu.dataset.workspace = ws.key;
  for (const button of menu.querySelectorAll('[data-file-action]')) button.hidden = !edit && !['hide-folder', 'show-hidden', 'open-tab', 'open-side', 'reveal', 'close-workspace', 'collapse-workspace', 'export-workspace', 'export-folder', 'copy'].includes(button.dataset.fileAction);
  menu.querySelector('[data-file-action="copy"]').hidden = !selected || !client.writable;
  const paste = menu.querySelector('[data-file-action="paste"]'); paste.hidden = !edit || !fileClipboard;
  if (fileClipboard) paste.innerHTML = 'Paste “' + esc(fileClipboard.path.split('/').at(-1)) + '” <kbd>Ctrl+V</kbd>';
  const hide = menu.querySelector('[data-file-action="hide-folder"]');
  hide.hidden = row?.dataset.folder !== 'true'; hide.textContent = visibility.hiddenFolders.includes(selected) ? 'Unhide folder' : 'Hide folder';
  const show = menu.querySelector('[data-file-action="show-hidden"]');
  show.hidden = !!row && row.dataset.folder !== 'true';
  show.setAttribute('aria-checked', String(visibility.showHiddenFolders));
  const article = selected && row?.dataset.folder !== 'true' && /\.md$/i.test(selected);
  menu.querySelector('[data-file-action="open-tab"]').hidden = !article;
  const side = menu.querySelector('[data-file-action="open-side"]'); side.hidden = !article; side.textContent = sideLabel();
  menu.querySelector('[data-file-action="reveal"]').hidden = !selected || !client.capabilities.nativeWindow;
  const exportWorkspaceItem = menu.querySelector('[data-file-action="export-workspace"]'), exportFolderItem = menu.querySelector('[data-file-action="export-folder"]');
  exportWorkspaceItem.hidden = !client.capabilities.export || !!row; exportWorkspaceItem.textContent = 'Export ' + (multi() ? workspaceName(ws) : 'workspace') + ' as HTML…';
  exportFolderItem.hidden = !client.capabilities.export || row?.dataset.folder !== 'true';
  const collapseItem = menu.querySelector('[data-file-action="collapse-workspace"]');
  collapseItem.hidden = !!row && row.dataset.folder !== 'true'; collapseItem.textContent = 'Collapse all folders' + (multi() ? ' in ' + workspaceName(ws) : '');
  const close = menu.querySelector('[data-file-action="close-workspace"]');
  close.hidden = !!row || !client.capabilities.workspaces; close.textContent = 'Deactivate ' + (multi() ? workspaceName(ws) : 'workspace');
  menu.querySelector('[data-file-action="rename"]').innerHTML = (row?.dataset.folder === 'true' ? 'Rename folder' : 'Rename file') + (article ? '' : ' <kbd>F2</kbd>');
  menu.querySelector('[data-file-action="retitle"]').innerHTML = 'Retitle Article' + (article ? ' <kbd>F2</kbd>' : '');
  menu.querySelector('[data-file-action="rename"]').disabled = !selected; menu.querySelector('[data-file-action="delete"]').disabled = !selected; menu.querySelector('[data-file-action="move"]').disabled = !selected;
  menu.querySelector('[data-file-action="retitle"]').disabled = !selected || row?.dataset.folder === 'true' || !/\.md$/i.test(selected);
  // Kanban: open a board, preview or place a card, or create a board in a folder.
  for (const [action, show] of Object.entries(kanban?.fileMenu(ws, selected, {folder: row?.dataset.folder === 'true', blank: !row}) || {})) menu.querySelector(`[data-file-action="${action}"]`).hidden = !show;
  menu.hidden = false; menu.style.left = Math.max(0, Math.min(event.clientX, innerWidth - menu.offsetWidth)) + 'px'; menu.style.top = Math.max(0, Math.min(event.clientY, innerHeight - menu.offsetHeight)) + 'px';
  menu.querySelector('button:not([hidden]):not(:disabled)').focus();
}
$('files-panel').oncontextmenu = showFilesMenu;
document.addEventListener('contextmenu', event => {
  const heading = event.target.closest('.panel-heading');
  if (heading && !$('files-panel').hidden && heading.parentElement === $('files-panel').parentElement) showFilesMenu(event);
});
$('file-menu').onclick = run(async e => {
  const action = e.target.closest('[data-file-action]')?.dataset.fileAction; $('file-menu').hidden = true;
  const ws = wsByKey($('file-menu').dataset.workspace);
  if (!action || !ws) return;
  // Loading a tab can change tree selection while its context menu is open.
  selected = $('file-menu').dataset.path || ''; selectedWs = ws.key;
  if (action === 'hide-folder' && ws.index.isFolder(selected)) {
    const {hiddenFolders} = folderPreferences(ws);
    storeHiddenFolders(ws, hiddenFolders.includes(selected) ? hiddenFolders.filter(path => path !== selected) : [...hiddenFolders, selected]);
    renderTree();
  }
  if (action === 'open-tab') await openNote(selected, null, {tabId:null, ws});
  if (action === 'open-side') await openToSide(selected, {ws});
  if (action === 'reveal') await ws.api.call('revealPath',{path:selected});
  if (action === 'show-hidden') {prefs.set('show-hidden-folders:' + ws.key, String(!folderPreferences(ws).showHiddenFolders)); renderTree();}
  if (action === 'close-workspace') await closeWorkspace(ws);
  if (action === 'collapse-workspace') {ws.expanded.clear(); renderTree();}
  if (action === 'export-workspace') await exportHtml(ws);
  if (action === 'export-folder' && ws.index.isFolder(selected)) await exportHtml(ws, selected);
  if (kanban?.fileActions.has(action)) await kanban.fileAction(action, ws, selected, {folder: ws.index.isFolder(selected)});
  if (action === 'copy') copyEntry(); if (action === 'paste') await pasteEntry();
  if (action === 'create') await create(false); if (action === 'folder') await create(true); if (action === 'rename') await rename(); if (action === 'retitle') await retitle(); if (action === 'move') await rename(true); if (action === 'delete') await remove();
});
$('choose-workspace').onclick = run(choose);
$('create-workspace').onclick = run(createWorkspace);
$('menu-git-setup').onclick = run(() => setupGit(current()));
for (const pane of panes) pane.el['incoming-banner'].addEventListener('click', run(async event => {
  const button = event.target.closest('[data-incoming]'), ws = paneWs(pane); if (!button || button.disabled || !ws) return;
  if (button.dataset.incoming === 'review') {sidebars.select('right', 'git'); focusGitSection(ws); ws.gitSection.open = true; return;}
  const result = await ws.git.perform('pull', {remote: ws.git.status?.syncRemote}); message(result.message || 'Pulled incoming changes.');
}));
for (const pane of panes) pane.el.welcome.addEventListener('click', run(async event => {
  const button = event.target.closest('[data-welcome]'); if (!button || button.disabled) return;
  const ws = wsByKey(button.dataset.ws), action = button.dataset.welcome;
  if (pane !== P) focusPane(pane);
  if (action === 'create-workspace') await createWorkspace();
  if (action === 'open-workspace') await choose();
  if (action === 'browse') sidebars.select('left', 'files');
  if (action === 'open-folder') await openServerFolder(button.dataset.folder);
  if (!ws) return;
  if (action === 'new-article') {
    if (!edit) {edit = true; prefs.set('edit', 'true'); updateMode();}
    focusKey = selectedWs = ws.key; selected = ''; await create(false, {atRoot: true});
  }
  if (action === 'random-article') await randomArticle(ws);
  if (action === 'setup-git') await setupGit(ws);
}));
$('window-controls').hidden = !client.capabilities.nativeWindow;
for (const action of ['minimize','maximize','close']) $('window-' + action).onclick = run(async () => {
  if (action === 'close') {
    if (dirty || drafts.size) {
      const answer = await promptUser('Save changes?', count((dirty ? 1 : 0) + drafts.size, 'article') + ' ' + ((dirty ? 1 : 0) + drafts.size === 1 ? 'has' : 'have') + ' unsaved changes. Save before closing Weave?', {ok: 'Save all', secondary: "Don't save"});
      if (answer.action === 'cancel') return;
      if (answer.action === 'ok') await saveAll(); else {drafts.clear(); setDirty(false);}
    }
    await persistSession();
  }
  const state = await client.windowAction(action); if (action === 'maximize') {$('window-maximize').textContent = state?.maximized ? '❐' : '□'; $('window-maximize').title = state?.maximized ? 'Restore window' : ui('Maximise');}
});
$('titlebar').onmousedown = run(async e => {if (!client.capabilities.nativeWindow || e.button !== 0 || e.detail > 1 || e.target.closest('button,input')) return; await client.windowAction('drag');});
$('titlebar').ondblclick = e => {if (client.capabilities.nativeWindow && !e.target.closest('button,input')) $('window-maximize').click();};
// The W menu holds the title bar's less frequent actions, so the bar itself
// keeps only Graph, the right sidebar and Edit.
const appMenu = $('app-menu'), appMenuButton = $('app-menu-button');
if (client.serverAccount) {
  const account = document.createElement('button'); account.id = 'server-account'; account.setAttribute('role', 'menuitem'); account.textContent = 'Server account…';
  account.onclick = () => client.serverAccount(); appMenu.append(account);
}
const appMenuItems = () => [...appMenu.querySelectorAll('button')].filter(item => !item.hidden && !item.disabled);
function closeAppMenu(focusButton = false) {if (appMenu.hidden) return; appMenu.hidden = true; appMenuButton.setAttribute('aria-expanded', 'false'); if (focusButton) appMenuButton.focus();}
function openAppMenu() {
  // Separators show only between groups that have visible items (exports hide several).
  let seen = false, pending = null;
  for (const child of appMenu.children) {
    if (child.matches('.context-separator')) {child.hidden = true; if (seen) pending = child;}
    else if (!child.hidden) {if (pending) pending.hidden = false; pending = null; seen = true;}
  }
  appMenu.hidden = false; appMenuButton.setAttribute('aria-expanded', 'true');
  const box = appMenuButton.getBoundingClientRect();
  appMenu.style.left = Math.max(0, Math.min(box.left, innerWidth - appMenu.offsetWidth)) + 'px'; appMenu.style.top = Math.round(box.bottom + 4) + 'px';
  appMenuItems()[0]?.focus();
}
appMenuButton.onclick = () => appMenu.hidden ? openAppMenu() : closeAppMenu();
appMenuButton.onkeydown = e => {if (e.key === 'ArrowDown' && appMenu.hidden) {e.preventDefault(); openAppMenu();}};
appMenu.addEventListener('click', e => {if (e.target.closest('button:not(:disabled)')) closeAppMenu();});
appMenu.addEventListener('keydown', e => {
  const items = appMenuItems(), index = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {e.preventDefault(); items[(index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();}
  else if (e.key === 'Home' || e.key === 'End') {e.preventDefault(); items.at(e.key === 'Home' ? 0 : -1)?.focus();}
  else if (e.key === 'Escape' || e.key === 'Tab') {e.preventDefault(); closeAppMenu(true);}
});
$('menu-settings').onclick = () => settingsDialog.open();
for (const button of document.querySelectorAll('[data-panel]')) button.onclick = () => setPanel(button.dataset.panel, {toggle:true});
$('collapse-panel').onclick = collapseSidebar;
$('collapse-all').onclick = () => {for (const ws of workspaces) ws.expanded.clear(); renderTree();};
$('new-note').onclick = run(() => create(false)); $('new-folder').onclick = run(() => create(true));
$('save').onclick = run(() => save({explicit: true}));
$('source-mode').onclick = $('source-toggle').onclick = run(async () => {if (!active) return; (source ? raw : live).commitTableEdit(); const text = (source ? raw : live).text, unsaved = dirty; source = !source; live.setText(text); raw.setText(text); setDirty(unsaved); updateMode(); kanban?.update(P); restoreScroll(currentTab()); await persistSession();});
let contextTab = null;
/** "to the right" from the left side (or with one side), else "to the left". */
const sideLabel = (verb = 'Open') => verb + ' to the ' + (split && P === sides[1] ? 'left' : 'right');
for (const pane of panes) {
  const strip = pane.el['file-tabs'];
  strip.onclick = run(async e => {const close = e.target.closest('[data-close-tab]'); if (close) return closeTab(close.dataset.closeTab); const tab = e.target.closest('[data-tab]'); if (tab) await selectTab(tab.dataset.tab);});
  strip.onmousedown = e => {if (e.button === 1) e.preventDefault();};
  strip.onauxclick = run(async e => {const tab = e.target.closest('[data-tab-id]'); if (e.button === 1 && tab) {e.preventDefault(); await closeTab(tab.dataset.tabId);}});
  pane.el['tab-bar'].oncontextmenu = e => {
    const tab = e.target.closest('[data-tab-id]'); e.preventDefault(); contextTab = tab?.dataset.tabId || null; const menu = $('tab-menu'); $('context-close-tab').hidden = !tab;
    // A tab can be opened on the other side as well, or moved there.
    const path = tab && allTabs().find(t => t.id === contextTab)?.path;
    $('context-split-tab').hidden = !path; $('context-split-tab').firstChild.textContent = (split && P === sides[1] ? 'Split left' : 'Split right') + ' ';
    $('context-move-tab').hidden = !tab || !split && visibleTabs().length < 2; $('context-move-tab').textContent = 'Move to ' + (split && P === sides[1] ? 'left' : 'right') + ' side';
    menu.querySelector('.context-separator').hidden = $('context-split-tab').hidden && $('context-move-tab').hidden;
    menu.hidden = false; menu.style.left = Math.max(0,Math.min(e.clientX, innerWidth - menu.offsetWidth)) + 'px'; menu.style.top = Math.max(0,Math.min(e.clientY, innerHeight - menu.offsetHeight)) + 'px'; $(tab ? 'context-close-tab' : 'context-new-tab').focus();
  };
  pane.el['new-tab'].onclick = run(newTab);
  pane.el['close-tabs'].onclick = run(() => closeTab('', true));
}
initTitlebarTabs({titlebar: $('titlebar'), shell: document.querySelector('.shell'), start: document.querySelector('.titlebar-start'), end: document.querySelector('.titlebar-end'), tabBars: () => panes.map(pane => pane.el['tab-bar']),
  onDrag: run(async () => {if (client.capabilities.nativeWindow) await client.windowAction('drag');}), onMaximize: () => {if (client.capabilities.nativeWindow) $('window-maximize').click();}});
$('context-new-tab').onclick = run(async () => {$('tab-menu').hidden = true; await newTab();});
$('context-close-tab').onclick = run(async () => {$('tab-menu').hidden = true; await closeTab(contextTab);});
$('context-split-tab').onclick = run(async () => {$('tab-menu').hidden = true; await splitTab(contextTab);});
$('context-move-tab').onclick = run(async () => {$('tab-menu').hidden = true; await moveTabToSide(contextTab);});
// Drag a tab left or right to reorder the tabs, or onto the other side of a
// split view to move it there. A tab carries its own Back/Forward history and
// reading positions, so moving it changes only where it is shown.
let tabDrag = null;
/** Moves a tab to `index` among the other visible tabs; tabs hidden with a
 * deactivated workspace keep their places. Returns whether the order changed. */
function moveTab(id, index) {
  const tab = tabs.find(t => t.id === id); if (!tab) return false;
  const shown = visibleTabs().filter(t => t !== tab), rest = tabs.filter(t => t !== tab), before = shown[index];
  rest.splice(before ? rest.indexOf(before) : shown.length ? rest.indexOf(shown.at(-1)) + 1 : rest.length, 0, tab);
  if (rest.every((t, i) => t === tabs[i])) return false;
  tabs = rest; return true;
}
/** Where a dragged tab would go among a pane's visible tabs at `x`. */
const tabIndexAt = (pane, x, id) => [...pane.el['file-tabs'].querySelectorAll('[data-tab-id]')].filter(node => node.dataset.tabId !== id && (() => {const box = node.getBoundingClientRect(); return box.left + box.width / 2 < x;})()).length;
for (const pane of panes) {
  const strip = pane.el['file-tabs'];
  strip.addEventListener('pointerdown', event => {
    // A finger drag scrolls the strip instead.
    if (event.button !== 0 || event.pointerType === 'touch' || event.target.closest('.close-tab') || tabDrag) return;
    const node = event.target.closest('[data-tab-id]'); if (node) tabDrag = {id: node.dataset.tabId, pane, x: event.clientX, pointer: event.pointerId, active: false};
  });
  strip.addEventListener('pointermove', event => {
    if (!tabDrag || event.pointerId !== tabDrag.pointer) return;
    if (!tabDrag.active) {
      if (Math.abs(event.clientX - tabDrag.x) < 6) return;
      tabDrag.active = true; strip.setPointerCapture(event.pointerId); document.body.classList.add('tab-dragging'); renderTabs();
    }
    // Over the other side of a split view, the tab will move there.
    const over = paneAt(document.elementFromPoint(event.clientX, event.clientY)), across = split && over && over !== pane ? over : null;
    tabDrag.target = across;
    for (const each of panes) each.el['tab-bar'].classList.toggle('drop-target', each === across);
    if (!across && moveTab(tabDrag.id, tabIndexAt(pane, event.clientX, tabDrag.id))) {tabDrag.moved = true; renderTabs();}
  });
  const endTabDrag = event => {
    if (!tabDrag || event.pointerId !== tabDrag.pointer) return;
    const drag = tabDrag; tabDrag = null;
    for (const each of panes) each.el['tab-bar'].classList.remove('drop-target');
    if (!drag.active) return;
    suppressNextClick(strip); document.body.classList.remove('tab-dragging'); renderTabs();
    if (drag.target && event.type === 'pointerup') run(() => moveTabToSide(drag.id, drag.target, tabIndexAt(drag.target, event.clientX, drag.id)))();
    else if (drag.moved) run(persistSession)();
  };
  strip.addEventListener('pointerup', endTabDrag); strip.addEventListener('pointercancel', endTabDrag);
}
// Right-clicking an article link (in the article, Connections, search results
// or Deep search evidence) offers Open and Open in new tab.
let linkTarget = null;
function articleLinkAt(event, editor = null) {
  const node = event.target.closest('[data-editor-link], [data-open], [data-chat-entity]');
  if (node && node.dataset.editorLink !== undefined) return node.dataset.broken || node.dataset.external || !activeWs() ? null : {path: node.dataset.editorLink, ws: activeWs()};
  if (node) {
    const ws = wsByKey(node.dataset.ws) || activeWs() || current(); if (!ws) return null;
    let file = node.dataset.open || node.dataset.chatEntity; file = ws.graphData.entities.find(n => n.stableId === file)?.file || file;
    return {path: file, ws, line: Number(node.dataset.line) || null, searchTerm: node.dataset.searchTerm || ''};
  }
  // While editing, a link whose source is shown has no link element.
  const link = editor?.view && activeWs() ? editor.linkAt(editor.view.posAtCoords({x: event.clientX, y: event.clientY})) : null;
  return link && !link.external ? {path: link.path, ws: activeWs()} : null;
}
function placeMenu(menu, event) {menu.hidden = false; menu.style.left = Math.max(0, Math.min(event.clientX, innerWidth - menu.offsetWidth)) + 'px'; menu.style.top = Math.max(0, Math.min(event.clientY, innerHeight - menu.offsetHeight)) + 'px';}
document.addEventListener('contextmenu', event => {
  if (event.defaultPrevented) return;
  const target = articleLinkAt(event); if (!target) return;
  event.preventDefault(); linkTarget = target; placeMenu($('link-menu'), event); $('link-menu').querySelector('button').focus();
});
document.addEventListener('click', run(async event => {
  const button = event.target.closest('[data-link-action]'); if (!button) return;
  $('link-menu').hidden = $('article-menu').hidden = true;
  const target = linkTarget; linkTarget = null;
  if (!target || !workspaces.includes(target.ws)) return;
  if (button.dataset.linkAction === 'open-side') {await openToSide(target.path, {ws: target.ws, line: target.line || null, searchTerm: target.searchTerm || ''}); return;}
  await openNote(target.path, target.line || null, {ws: target.ws, searchTerm: target.searchTerm || '', ...(button.dataset.linkAction === 'open-tab' ? {tabId: null} : {})});
}));
$('link-menu').addEventListener('keydown', event => {
  const items = [...$('link-menu').querySelectorAll('button')], index = items.indexOf(document.activeElement);
  if (['ArrowDown','ArrowUp'].includes(event.key)) {event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();}
});
let tableInsertion = null;
document.addEventListener('contextmenu',() => {$('article-menu').hidden=true;$('link-menu').hidden=true;for (const item of document.querySelectorAll('[data-link-action="open-side"]')) item.textContent = sideLabel();},true);
// The editor's context menu follows Obsidian's: spelling suggestions, then
// Add link, Format, Paragraph and Insert submenus, then the clipboard.
for (const [element, editor] of panes.flatMap(pane => [[pane.el.article,pane.live],[pane.el['source-editor'],pane.raw]])) element.addEventListener('contextmenu',event => {
  if (!edit || !active || event.defaultPrevented || event.target.closest('.cm-table-preview')) return;
  event.preventDefault(); editor.commitTableEdit();
  const {state} = editor.view, at = editor.view.posAtCoords({x:event.clientX,y:event.clientY}), position = editor.view.posAtCoords({x:event.clientX,y:event.clientY},false) ?? state.selection.main.head;
  const inSelection = state.selection.ranges.some(range => !range.empty && position >= range.from && position <= range.to);
  tableInsertion = {editor, path:active.path, position};
  linkTarget = articleLinkAt(event, editor); $('article-link-actions').hidden = !linkTarget;
  renderSpellMenu(editor, editor.spellingAt(at));
  $('highlight-menu').hidden = !editor.syntaxAt(at).has('Highlight'); renderHighlightSwatches();
  // A table is never inserted over the text the user selected and right-clicked.
  $('insert-table').hidden = inSelection;
  for (const command of ['cut','copy']) $('article-menu').querySelector(`[data-editor-command="${command}"]`).disabled = state.selection.ranges.every(range => range.empty);
  const menu=$('article-menu'); closeSubmenus(); menu.hidden=false;
  menu.style.left=Math.max(0,Math.min(event.clientX,innerWidth-menu.offsetWidth))+'px';menu.style.top=Math.max(0,Math.min(event.clientY,innerHeight-menu.offsetHeight))+'px';
  (menu.querySelector('#spell-menu:not([hidden]) button:not(:disabled), #highlight-menu:not([hidden]) button') || menuItems(menu)[0]).focus();
});
function copySelection(view) {
  const text = view.state.selection.ranges.filter(range => !range.empty).map(range => view.state.sliceDoc(range.from, range.to)).join(view.state.lineBreak);
  if (text) Promise.resolve().then(() => navigator.clipboard.writeText(text)).catch(() => message('Copy with Ctrl+C: Weave cannot write to the clipboard here.'));
  return !!text;
}
const editorCommands = {
  link: insertMarkdownLink, ...formatCommands, clear: clearFormatting,
  ...Object.fromEntries(['bullet','numbered','task','body','quote',...[1,2,3,4,5,6].map(n => 'h'+n)].map(kind => [kind, setBlockFormat(kind)])),
  rule: insertHorizontalRule, codeblock: insertCodeBlock,
  selectAll: view => {view.dispatch({selection:{anchor:0,head:view.state.doc.length},userEvent:'select'}); return true;},
  copy: view => {copySelection(view); return true;},
  cut: view => {if (copySelection(view)) view.dispatch({...view.state.replaceSelection(''),scrollIntoView:true,userEvent:'delete.cut'}); return true;},
  paste: view => {pasteFromClipboard(view, false); return true;},
  pastePlain: view => {pasteFromClipboard(view, true); return true;},
};
/** The clipboard's HTML and plain text; only the text where HTML cannot be read. */
async function readClipboard() {
  try {
    const data = {html: '', text: ''};
    for (const item of await navigator.clipboard.read()) {
      if (!data.html && item.types.includes('text/html')) data.html = await (await item.getType('text/html')).text();
      if (!data.text && item.types.includes('text/plain')) data.text = await (await item.getType('text/plain')).text();
    }
    return data;
  } catch {return {html: '', text: await navigator.clipboard.readText()};}
}
/** Code keeps the clipboard's text exactly: Markdown is not converted into it. */
const inCode = view => {const editor = panes.flatMap(pane => [pane.live, pane.raw]).find(item => item.view === view); return !!editor?.syntaxAt(view.state.selection.main.head)?.has?.('FencedCode') || !!editor?.syntaxAt(view.state.selection.main.head)?.has?.('InlineCode');};
function insertPaste(view, data, plain) {
  const text = pasteText(data, {plain: plain || inCode(view), underline: underlineEnabled()});
  if (text && !view.state.readOnly) view.dispatch({...view.state.replaceSelection(text), scrollIntoView: true, userEvent: 'input.paste'});
}
function pasteFromClipboard(view, plain) {
  readClipboard().then(data => insertPaste(view, data, plain)).catch(() => message('Paste with Ctrl+V: Weave cannot read the clipboard here.'));
}
// Ctrl+V converts formatted HTML as the menu's Paste does; Ctrl+Shift+V pastes plain text.
let plainPaste = false;
for (const [element, editor] of panes.flatMap(pane => [[pane.el.article,pane.live],[pane.el['source-editor'],pane.raw]])) {
  element.addEventListener('keydown', event => {plainPaste = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v';}, true);
  element.addEventListener('paste', event => {
    const plain = plainPaste; plainPaste = false;
    const view = editor.view, data = event.clipboardData;
    if (!data || view.state.readOnly || !view.contentDOM.contains(event.target) || event.target.closest('.cm-table-preview')) return;
    // Plain text is left to the editor, which also pastes whole copied lines as lines.
    const html = data.getData('text/html');
    if (plain || inCode(view) || !hasFormatting(html)) return;
    event.preventDefault(); event.stopPropagation();
    insertPaste(view, {html, text: data.getData('text/plain')}, false);
  }, true);
}
$('article-menu').addEventListener('click', event => {
  const button = event.target.closest('[data-editor-command]');
  if (!button) {const opener = event.target.closest('[data-submenu]'); if (opener) openSubmenu(opener, true); return;}
  $('article-menu').hidden = true; const insertion = tableInsertion;
  if (!edit || active?.path !== insertion?.path) return;
  insertion.editor.runCommand(editorCommands[button.dataset.editorCommand]);
});
const menuItems = menu => [...menu.querySelectorAll('button[role=menuitem]')].filter(item => !item.disabled && item.closest('[role=menu]') === menu && !item.closest('[hidden]'));
function closeSubmenus(keep) {
  for (const submenu of $('article-menu').querySelectorAll('.context-submenu')) if (submenu !== keep) {submenu.hidden = true; $('article-menu').querySelector(`[data-submenu="${submenu.id}"]`).setAttribute('aria-expanded','false');}
}
function openSubmenu(opener, focus = false) {
  const submenu = $(opener.dataset.submenu); closeSubmenus(submenu);
  if (submenu.hidden) {
    submenu.hidden = false; opener.setAttribute('aria-expanded','true');
    // Open to the right, or to the left near the window edge; stay on screen.
    submenu.classList.remove('flip'); submenu.style.removeProperty('top');
    if (submenu.getBoundingClientRect().right > innerWidth) submenu.classList.add('flip');
    const overflow = submenu.getBoundingClientRect().bottom - innerHeight + 4;
    if (overflow > 0) submenu.style.top = (-5 - overflow) + 'px';
  }
  if (focus) menuItems(submenu)[0]?.focus();
}
$('article-menu').addEventListener('mouseover', event => {
  const item = event.target.closest('button[role=menuitem]'); if (!item) return;
  if (item.dataset.submenu) openSubmenu(item); else if (!item.closest('.context-submenu')) closeSubmenus();
});
$('article-menu').addEventListener('keydown', event => {
  const item = event.target.closest('button'), menu = item?.closest('[role=menu]'); if (!menu) return;
  const items = menuItems(menu), index = items.indexOf(item);
  if (['ArrowDown','ArrowUp'].includes(event.key)) {event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();}
  else if (event.key === 'ArrowRight' && item.dataset.submenu) {event.preventDefault(); openSubmenu(item, true);}
  else if ((event.key === 'ArrowLeft' || event.key === 'Escape') && menu.classList.contains('context-submenu')) {
    event.preventDefault(); event.stopPropagation(); closeSubmenus(); $('article-menu').querySelector(`[data-submenu="${menu.id}"]`).focus();
  }
});
// Highlights share one colour, a display preference (Appearance › Reading &
// editing). Right-clicking a highlight offers a palette to change it.
const highlightPalette = [['#ffd43b','Yellow'],['#ffa94d','Orange'],['#ff6b6b','Red'],['#f783ac','Pink'],['#b197fc','Purple'],['#74c0fc','Blue'],['#69db7c','Green']];
function renderHighlightSwatches() {
  if ($('highlight-menu').hidden) return;
  $('highlight-swatches').replaceChildren(...highlightPalette.map(([color, name]) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'highlight-swatch'; button.dataset.highlightColor = color;
    button.title = name; button.setAttribute('aria-label', name); button.setAttribute('aria-pressed', String(color === appearance.highlightColor)); button.style.setProperty('--swatch', color);
    return button;
  }));
}
$('highlight-swatches').addEventListener('click', event => {
  const button = event.target.closest('[data-highlight-color]'); if (!button) return;
  appearance.setHighlightColor(button.dataset.highlightColor); $('article-menu').hidden = true; tableInsertion?.editor.view?.focus();
});
$('highlight-swatches').addEventListener('keydown', event => {
  const swatches = [...$('highlight-swatches').children], index = swatches.indexOf(document.activeElement);
  if (['ArrowLeft','ArrowRight'].includes(event.key)) {event.preventDefault(); swatches[(index + (event.key === 'ArrowRight' ? 1 : -1) + swatches.length) % swatches.length]?.focus();}
  else if (event.key === 'ArrowDown') {event.preventDefault(); event.stopPropagation(); menuItems($('article-menu'))[0]?.focus();}
});
// Right-clicking a misspelled word offers suggestions and Ignore.
let spellTarget = null;
function renderSpellMenu(editor, word) {
  spellTarget = word ? {editor, word, path: active?.path} : null;
  $('spell-menu').hidden = !word;
  if (!word) {$('spell-menu').replaceChildren(); return;}
  const suggestions = spellChecker.suggestions(word.word, 5);
  $('spell-menu').innerHTML = (suggestions.length ? suggestions.map(s => `<button class="spell-suggestion" role="menuitem" data-spell-replace="${esc(s)}">${esc(s)}</button>`).join('') : '<button class="spell-none" role="menuitem" disabled>No suggestions</button>') + `<button role="menuitem" data-spell-ignore>${esc(localizeText('Ignore', spellVariant()))} “${esc(word.word)}”</button>`;
}
$('spell-menu').addEventListener('click', event => {
  const button = event.target.closest('button'); $('article-menu').hidden = true;
  if (!button || !spellTarget || spellTarget.path !== active?.path) return;
  if (button.dataset.spellReplace) spellTarget.editor.replaceSpelling(spellTarget.word, button.dataset.spellReplace);
  if (button.hasAttribute('data-spell-ignore')) ignoreSpelling(spellTarget.word.word);
  spellTarget = null;
});
function ignoreSpelling(word) {
  const words = spellIgnored(), normal = word.trim().toLowerCase().replace(/’/g, "'");
  if (!normal) return;
  words.add(normal); prefs.set('spell-ignored', JSON.stringify([...words].sort())); renderSpellSettings(); refreshSpelling();
}
function renderSpellSettings() {
  $('spell-settings').hidden = $('spell-heading').hidden = !spellAvailable;
  if (!spellAvailable) return;
  $('spell-enabled').checked = prefs.get('spell-enabled') !== 'false';
  $('spell-prose').checked = prefs.get('spell-prose') !== 'false'; $('spell-code').checked = prefs.get('spell-code') === 'true'; $('spell-wait').checked = prefs.get('spell-wait') !== 'false';
  for (const id of ['spell-prose', 'spell-code', 'spell-wait', 'spell-dictionary']) $(id).disabled = !$('spell-enabled').checked;
  $('spell-dictionary').options[0].textContent = 'Follow system (' + (englishVariant() === 'en-US' ? 'English (US)' : 'English (UK)') + ')';
  $('spell-dictionary').value = ['en-GB', 'en-US'].includes(prefs.get('spell-dictionary')) ? prefs.get('spell-dictionary') : 'system';
  const words = [...spellIgnored()].sort();
  $('spell-ignored').innerHTML = words.map(word => `<li><span>${esc(word)}</span><button type="button" data-unignore="${esc(word)}" aria-label="Check “${esc(word)}” again" title="Check this word again">×</button></li>`).join('') || '<li class="hint">No ignored words. Add one above, or right-click a misspelled word and choose Ignore.</li>';
}
for (const [id, key] of [['spell-enabled', 'spell-enabled'], ['spell-prose', 'spell-prose'], ['spell-code', 'spell-code'], ['spell-wait', 'spell-wait']]) $(id).onchange = () => {prefs.set(key, String($(id).checked)); renderSpellSettings(); loadSpelling();};
$('spell-dictionary').onchange = () => {prefs.set('spell-dictionary', $('spell-dictionary').value); renderSpellSettings(); loadSpelling();};
$('spell-ignored').addEventListener('click', event => {
  const button = event.target.closest('[data-unignore]'); if (!button) return;
  const words = spellIgnored(); words.delete(button.dataset.unignore);
  prefs.set('spell-ignored', JSON.stringify([...words].sort())); renderSpellSettings(); refreshSpelling();
});
$('spell-ignore-form').onsubmit = event => {event.preventDefault(); ignoreSpelling($('spell-ignore-word').value); $('spell-ignore-word').value = ''; $('spell-ignore-word').focus();};
renderSpellSettings(); loadSpelling();
// Right-click > Insert > Table adds an empty two-column table: header, separator
// and one row, with the caret in the first header cell.
$('insert-table').onclick = () => {
  $('article-menu').hidden=true;const insertion=tableInsertion;
  if (!edit || active?.path!==insertion?.path) return;
  insertion.editor.insertTable({position:insertion.position,rows:1,columns:2,headers:false});
};
$('nav-back').onclick = run(() => navigate(-1)); $('nav-forward').onclick = run(() => navigate(1));
$('reload-note').onclick = run(async () => { if (!active) return; if (dirty) { const answer = await promptUser('Reload from disk?', 'Discard the current draft and read the latest Markdown file.', {ok: 'Discard and reload'}); if (answer.action !== 'ok') return; } clearTimeout(saveTimer); if (saving) await saving.catch(() => {}); setDirty(false); await openNote(active.path, null, {ws: activeWs()}); });
$('refresh').onclick = run(async () => {
  if (!workspaces.length) return;
  for (const ws of [...workspaces]) {await ws.api.call('refresh'); await syncWorkspace(ws, null, {force: true});}
});
$('edit-mode').onclick = run(async () => { if (autosaveMode() !== 'off' && !await canLeave()) return; edit = !edit; prefs.set('edit', String(edit)); updateMode(); kanban?.refreshViews(); });
$('close-evidence').onclick = () => {evidenceSerial++; $('evidence-panel').hidden = true; $('ask-status').textContent = ''; updatePanes();};
// Find in article (Ctrl+F) replaces the WebView's own find bar, which would
// cover the window controls. Matches follow the editor's search highlighting.
let findMatches = [], findIndex = -1;
const findEditor = () => source ? raw : live;
function findIn(step = 0) {
  const editor = findEditor(), term = $('find-query').value.trim();
  live.setSearchTerm(term); raw.setSearchTerm(term);
  findMatches = editor.view && term ? literalMatches(editor.view.state.doc.toString(), term) : [];
  if (!findMatches.length) findIndex = -1;
  else if (step) findIndex = (findIndex + step + findMatches.length) % findMatches.length;
  else {const head = editor.view.state.selection.main.from; findIndex = Math.max(0, findMatches.findIndex(match => match.from >= head));}
  $('find-count').textContent = term ? (findMatches.length ? findIndex + 1 + '/' + findMatches.length : 'No matches') : '';
  $('find-bar').classList.toggle('no-match', !!term && !findMatches.length);
  const match = findMatches[findIndex];
  if (match) editor.view.dispatch({selection: {anchor: match.from, head: match.to}, scrollIntoView: true});
}
function openFind() {
  if (!active || !$('evidence-panel').hidden && evidencePane === P || kanban?.boardShown(P)) return;
  const editor = findEditor(), selection = editor.view?.state.sliceDoc(editor.view.state.selection.main.from, editor.view.state.selection.main.to) || '';
  $('find-bar').hidden = false; if (selection && !selection.includes('\n')) $('find-query').value = selection;
  $('find-query').focus(); $('find-query').select(); findIn();
}
function hideFind() {$('find-bar').hidden = true; live.setSearchTerm(''); raw.setSearchTerm(''); findMatches = [];}
function closeFind() {hideFind(); findEditor().view?.focus();}
$('find-query').oninput = () => findIn();
$('find-query').onkeydown = event => {
  if (event.key === 'Enter') {event.preventDefault(); findIn(event.shiftKey ? -1 : 1);}
  if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); closeFind();}
};
$('find-next').onclick = () => findIn(1); $('find-previous').onclick = () => findIn(-1); $('find-close').onclick = closeFind;
document.addEventListener('keydown', event => {
  if (findMode() === 'weave' && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {event.preventDefault(); event.stopPropagation(); if (!document.querySelector('dialog[open]')) openFind();}
}, true);
// The graph sits above the article of one pane (the focused one when it was
// shown) and follows that pane's article; Deep search covers the pane it ran in.
function updatePanes() {
  const evidence = !$('evidence-panel').hidden, graphDoc = paneActive(graphPane), graphAvailable = !!graphDoc && !graphDoc.external && !(evidence && evidencePane === graphPane), graphShown = showGraph && graphAvailable;
  $('toggle-graph').setAttribute('aria-pressed', String(showGraph)); $('view-graph').setAttribute('aria-pressed', String(showGraph)); $('view-article').setAttribute('aria-pressed', String(showArticle)); $('view-article').setAttribute('aria-checked', String(showArticle));
  $('graph-panel').hidden = !graphShown;
  graph.setVisible(showGraph, graphAvailable);
  for (const pane of panes) {
    const doc = paneActive(pane), covered = evidence && evidencePane === pane, withGraph = showGraph && pane === graphPane && !!doc && !covered;
    pane.el['note-panel'].hidden = !doc || covered; pane.el.welcome.hidden = !!doc || covered;
    pane.group.classList.toggle('article-minimized', withGraph && !showArticle);
    pane.group.classList.toggle('graph-with-article', withGraph && showArticle);
    pane.el['article-resize'].textContent = withGraph && !showArticle ? 'Article — drag up or click to expand' : '⋯';
    pane.el['article-resize'].setAttribute('aria-expanded', String(showArticle));
  }
}
/** The graph sits above the article of `pane`. */
function placeGraph(pane) {graphPane = pane; pane.el['note-panel'].before($('graph-panel'));}
async function setGraphView(value) {
  // Showing the graph from the other side of a split view moves it there.
  if (value && showGraph && graphPane !== P) await setGraphView(false);
  if (value) placeGraph(P);
  const main = graphPane.group, notes = graphPane.el['note-panel'];
  const articleScroll = showGraph && showArticle ? Math.max(0, main.scrollTop - $('graph-panel').getBoundingClientRect().height) : notes.scrollTop;
  showGraph = value; if (!showGraph) showArticle = true; updatePanes(); main.scrollTop = 0;
  if (!showGraph) notes.scrollTop = articleScroll;
  if (showGraph && paneWs(graphPane)) {await refreshGraph(paneWs(graphPane)); graph.fit();}
}
$('toggle-graph').onclick = $('view-graph').onclick = run(() => setGraphView(!(showGraph && graphPane === P)));
$('view-article').onclick = run(async () => {if (showGraph && graphPane !== P) await setGraphView(true); showArticle = !showArticle; if (!showArticle) showGraph = true; updatePanes(); if (showGraph && paneWs(graphPane)) await refreshGraph(paneWs(graphPane));});
let articleDrag = null;
for (const pane of panes) {
  const articleResize = pane.el['article-resize'] = document.createElement('div'); articleResize.id = paneId('article-resize', pane.index); articleResize.tabIndex = 0; articleResize.setAttribute('role', 'separator'); articleResize.setAttribute('aria-label', 'Expand or resize article'); articleResize.setAttribute('aria-orientation', 'horizontal'); pane.el['note-panel'].prepend(articleResize);
  articleResize.onpointerdown = e => {articleDrag = {y: e.clientY, height: $('graph-panel').getBoundingClientRect().height, moved: false}; articleResize.setPointerCapture(e.pointerId); e.preventDefault();};
  articleResize.onpointermove = e => {if (!articleDrag || !showGraph || graphPane !== pane) return; const dy = e.clientY - articleDrag.y; if (Math.abs(dy) < 4) return; articleDrag.moved = true; showArticle = true; updatePanes(); graph.setHeight(articleDrag.height + dy);};
  articleResize.onpointerup = () => {if (articleDrag && !articleDrag.moved && !showArticle) {showArticle = true; updatePanes();} articleDrag = null;};
  articleResize.onpointercancel = () => {articleDrag = null;};
  articleResize.onkeydown = e => {if (['ArrowUp','Enter',' '].includes(e.key)) {e.preventDefault(); showArticle = true; updatePanes();}};
}
const graph = createGraph($('graph-panel'), run(async node => {if (node.broken) message('Unresolved target: ' + node.name); else await openNote(node.file || node.id);}), {onCollapse: run(() => setGraphView(false)), onExpand: run(() => setGraphView(true)), onError: error => message(error.message), loadNeighborhood: client.graphNeighborhood ? async (query, onChunk) => {const ws = paneWs(graphPane); if (!ws) throw new Error('Open a workspace article to show its graph.'); return ws.api.graphNeighborhood(query, onChunk);} : undefined});
for (const id of ['show-all-files', 'show-extensions']) {$(id).checked = id === 'show-extensions' ? showExtensions() : prefs.get(id) === 'true'; $(id).onchange = () => {prefs.set(id, String($(id).checked)); renderTree();};}
$('hide-dot-folders').checked = prefs.get('hide-dot-folders') !== 'false';
$('hide-dot-folders').onchange = () => {prefs.set('hide-dot-folders', String($('hide-dot-folders').checked)); renderTree();};
/** Workspace refresh settings apply to the workspace chosen beside them. */
const monitorWs = () => wsByKey($('workspace-refresh-target').value) || current();
function renderOperation(status = {}) {
  const busy = status.graph === 'reconciling';
  $('operation-status').hidden = !busy && !status.lastError;
  $('operation-title').textContent = busy ? 'Reading workspace' : 'Workspace needs attention';
  $('operation-progress').hidden = !busy;
  $('operation-progress').removeAttribute('value');
  $('operation-detail').textContent = '';
  $('operation-error').textContent = status.lastError || '';
  const ws = monitorWs(), monitoring = ws?.status?.monitoring || {};
  for (const [id,key] of [['workspace-watch','watchChanges'],['workspace-auto','autoRefresh']]) {$(id).disabled = !ws; $(id).checked = monitoring[key] !== false;}
  if (document.activeElement !== $('workspace-seconds')) $('workspace-seconds').value = monitoring.refreshSeconds || 300;
  $('workspace-seconds').disabled = !ws || monitoring.autoRefresh === false;
  $('workspace-scan').disabled = !ws; $('workspace-scan').value = monitoring.scanMode || 'metadata';
}
for (const [id,key] of [['workspace-watch','watchChanges'],['workspace-auto','autoRefresh'],['workspace-seconds','refreshSeconds'],['workspace-scan','scanMode']]) $(id).onchange = run(async () => {
  const ws = monitorWs(); if (!ws) return;
  const value = $(id).type === 'checkbox' ? $(id).checked : key === 'refreshSeconds' ? Number($(id).value) : $(id).value;
  await applyCatalog(ws, await ws.api.call('configureMonitoring', {[key]: value})); await loadControlPanel();
});
$('workspace-refresh-target').onchange = () => renderOperation(current()?.status || {});
$('use-connections').checked = prefs.get('use-connections') !== 'false';
$('use-connections').onchange = () => prefs.set('use-connections', String($('use-connections').checked));
// Autosave (Control panel > Editing): off by default.
const showAutosave = () => {$('autosave-mode').value = autosaveMode(); $('autosave-delay').value = String(autosaveDelay()); $('autosave-delay-label').hidden = autosaveMode() !== 'delay';};
$('autosave-mode').onchange = run(async () => {prefs.set('autosave', $('autosave-mode').value); showAutosave(); if (autosaveMode() !== 'off') {if (drafts.size || dirty) await saveAll();} else clearTimeout(saveTimer);});
$('autosave-delay').onchange = () => {prefs.set('autosave-delay-ms', String(Math.max(100, Math.min(60000, Math.round(Number($('autosave-delay').value)) || 650)))); showAutosave(); if (dirty) scheduleSave();};
// Ctrl+F uses the WebView's own find bar unless Weave's article find bar is chosen.
// Weave's is the default: the WebView's find bar sees only the lines CodeMirror has drawn near the screen.
const findMode = () => prefs.get('find-mode') === 'webview' ? 'webview' : 'weave';
$('find-mode').value = findMode(); $('find-mode').onchange = () => {prefs.set('find-mode', $('find-mode').value); if (findMode() === 'webview' && !$('find-bar').hidden) closeFind();};
$('underline-enabled').checked = underlineEnabled();
$('underline-enabled').onchange = () => {prefs.set('underline', String($('underline-enabled').checked)); for (const editor of paneEditors()) editor.refreshSyntax(); updateMode();};
showAutosave();
/** Single-workspace hosts replace the open workspace when another is chosen. */
function resetWorkspaces() {
  for (const ws of workspaces) {ws.git.destroy(); ws.gitSection.remove();}
  if (split) setSplit(false);
  for (const pane of panes) if (pane !== P) Object.assign(pane, {tabs: [], activeTab: null, active: null});
  workspaces = []; active = null; selected = ''; selectedWs = focusKey = null; tabs = []; activeTab = null; source = false; openSerial++; searchSerial++; evidenceSerial++; clearTimeout(searchTimer); live.setText(''); raw.setText(''); $('evidence').innerHTML = ''; $('search-results').innerHTML = ''; $('ask-status').textContent = ''; $('evidence-panel').hidden = true; $p('note-panel').hidden = true; $('graph-panel').hidden = true; $p('welcome').hidden = false; renderTabs(); renderGitSections(); updatePanes(); updatePath(); updateMode();
}
// Control panel: open workspaces (switch, rename, recolour, reorder, close) and
// recently used workspaces that can be reopened without the folder picker.
let panelInfo = null, managerRendered = '';
function renderWorkspaceManager() {
  const capable = !!client.capabilities.workspaces, here = current(), list = $('open-workspaces');
  const recent = capable ? (panelInfo?.workspaces || []).filter(w => !w.open) : [];
  const signature = JSON.stringify([workspaces.map(ws => [ws.key, workspaceName(ws), workspaceColor(ws), ws.catalog.root, ws.status?.documents, allTabs().filter(t => t.ws === ws.key).length]), here?.key, recent.map(w => [w.id, w.name, w.color])]);
  // Do not replace a name field while it is being edited.
  if (signature === managerRendered || list.contains(document.activeElement) && document.activeElement.matches('input')) return;
  managerRendered = signature;
  $('workspace-summary').textContent = workspaces.length ? (multi() ? count(workspaces.length, 'active workspace') + ui('. Tabs and Files show each workspace in its colour.') : 'One active workspace. Open another folder to work across several at once.') : 'No workspace is active.';
  list.innerHTML = workspaces.map((ws, index) => {
    const name = workspaceName(ws), tabCount = allTabs().filter(t => t.ws === ws.key).length, folder = ws.catalog.workspace?.name || name;
    return `<li class="workspace-card ${ws === here ? 'current' : ''}" data-ws="${esc(ws.key)}" data-workspace-color="${workspaceColor(ws)}">
      ${capable ? `<input type="color" class="workspace-color" data-ws-color value="${workspaceColor(ws)}" aria-label="${ui('Colour for')} ${esc(name)}" title="${ui('Workspace colour')}">` : '<span class="workspace-dot" aria-hidden="true"></span>'}
      <div class="workspace-card-main">${capable ? `<input class="workspace-name" data-ws-name value="${esc(ws.catalog.workspace?.customName ? name : '')}" placeholder="${esc(folder)}" maxlength="80" aria-label="Name for ${esc(name)}" title="Workspace name. Leave empty to use the folder name.">` : `<strong>${esc(name)}</strong>`}
      <small class="workspace-path" title="${esc(ws.catalog.root)}">${esc(ws.catalog.root)}</small>
      <small class="workspace-meta">${count(ws.status?.documents, 'article')} · ${count(tabCount, 'tab')}${ws === here ? ' · <strong title="The workspace of the active tab">In use</strong>' : ''}</small></div>
      <div class="workspace-card-actions">${capable ? `<button data-ws-move="-1" aria-label="Move ${esc(name)} up" title="Move up" ${index ? '' : 'disabled'}>↑</button><button data-ws-move="1" aria-label="Move ${esc(name)} down" title="Move down" ${index < workspaces.length - 1 ? '' : 'disabled'}>↓</button><button data-ws-close aria-label="Deactivate ${esc(name)}" title="Hide this workspace and its tabs. Reactivate it below at any time.">Deactivate</button>` : ''}</div></li>`;
  }).join('') || '<li class="hint">Open a folder of Markdown files to begin.</li>';
  $('add-workspace').textContent = pageData.mode === 'server' ? 'Open server workspace…' : workspaces.length && capable ? 'Open another folder…' : 'Open source folder…';
  $('add-workspace').disabled = !client.writable || capable && workspaces.length >= (panelInfo?.maxOpen || 12);
  const recentHtml = recent.map(w => `<li class="workspace-recent" data-workspace-color="${/^#[0-9a-f]{6}$/i.test(w.color || '') ? w.color : '#7c8594'}"><span class="workspace-dot" aria-hidden="true"></span><span class="workspace-recent-label"><strong>${esc(w.name)}</strong><small title="${esc(w.root)}">${esc(w.root)}</small></span><button data-ws-reopen="${esc(w.id)}" title="Show ${esc(w.name)} and restore its tabs">Activate</button></li>`).join('');
  $('recent-workspaces').hidden = !recent.length; $('recent-workspace-list').innerHTML = recentHtml;
  // A server lists every workspace folder, deactivated ones included, on its start page.
  $('welcome-recent').hidden = !recent.length || listsServerFolders(); $('welcome-recent-list').innerHTML = recentHtml; renderWelcome();
  $('workspace-refresh-target-label').hidden = !multi();
  const target = $('workspace-refresh-target').value;
  $('workspace-refresh-target').innerHTML = workspaces.map(ws => `<option value="${esc(ws.key)}">${esc(workspaceName(ws))}</option>`).join('');
  $('workspace-refresh-target').value = wsByKey(target)?.key || here?.key || '';
}
const workspaceFromCard = node => wsByKey(node.closest('[data-ws]')?.dataset.ws);
$('workspace-manager').addEventListener('click', run(async event => {
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  const ws = workspaceFromCard(button);
  if (button.matches('[data-ws-move]') && ws) await moveWorkspace(ws, Number(button.dataset.wsMove));
  if (button.matches('[data-ws-close]') && ws) await closeWorkspace(ws);
}));
$('workspace-manager').addEventListener('change', run(async event => {
  const ws = workspaceFromCard(event.target); if (!ws) return;
  if (event.target.matches('[data-ws-color]')) await configureWorkspace(ws, {color: event.target.value});
  if (event.target.matches('[data-ws-name]')) {event.target.blur(); await configureWorkspace(ws, {name: event.target.value.trim()}); message('Workspace renamed.');}
}));
$('workspace-manager').addEventListener('keydown', event => {if (event.key === 'Enter' && event.target.matches('[data-ws-name]')) {event.preventDefault(); event.target.blur();}});
for (const list of [$('recent-workspace-list'), $('welcome-recent-list')]) list.addEventListener('click', run(async event => {
  const button = event.target.closest('[data-ws-reopen]'); if (!button) return;
  await persistSession();
  button.disabled = true;
  try {const ws = await adoptWorkspace(await client.call('reopen', {id: button.dataset.wsReopen})); message(workspaceName(ws) + ' activated.');}
  finally {button.disabled = false;}
}));
// Export workspace: one portable, read-only HTML reader per workspace.
function renderExport() {
  if (!client.capabilities.export) return;
  const select = $('export-workspace'), chosen = select.value;
  select.innerHTML = workspaces.map(ws => `<option value="${esc(ws.key)}">${esc(workspaceName(ws))}</option>`).join('');
  select.value = wsByKey(chosen)?.key || current()?.key || '';
  $('export-workspace-label').hidden = !multi();
  $('export-run').disabled = !workspaces.length;
  $('export-run').textContent = workspaces.length ? 'Export ' + workspaceName(wsByKey(select.value)) + '…' : 'Open a workspace to export it';
}
$('export-workspace').onchange = renderExport;
// Whether exports draw Mermaid diagrams is remembered on this device.
$('export-diagrams').checked = prefs.get('export-diagrams') !== 'false';
$('export-diagrams').onchange = () => prefs.set('export-diagrams', String($('export-diagrams').checked));
/** Exports a workspace, or one of its folders, using the Export panel's options. */
async function exportHtml(ws, folder = null) {
  // Exports read the files on disk, so save first.
  if (!await ensureDraftsSaved(key => key.startsWith(ws.key + '\n') && (!folder || key.slice(ws.key.length + 1).startsWith(folder + '/')), 'exporting')) return;
  $('export-run').disabled = true; $('export-status').textContent = 'Choose where to save the file…';
  try {
    const name = folder ? folder.split('/').at(-1) : workspaceName(ws);
    const result = await client.exportWorkspace(ws.api.scope, {name, folder, graph: $('export-graph').checked, otherFiles: $('export-other-files').checked, diagrams: $('export-diagrams').checked});
    if (!result) {$('export-status').textContent = ''; return;}
    $('export-status').textContent = `Exported ${folder ? 'folder ' + folder + ': ' : ''}${count(result.documents, 'article')}${$('export-graph').checked ? ' and ' + count(result.relationships, 'link') : ''} (${(result.bytes / 1048576).toFixed(1)} MB${result.diagrams ? ', with Mermaid diagrams' : ''}) to ${result.path}`;
    $('export-reveal').hidden = !client.capabilities.nativeWindow; message((folder ? 'Folder' : 'Workspace') + ' exported to ' + result.path);
  } catch (error) {$('export-status').textContent = error.message; throw error;}
  finally {renderExport();}
}
$('export-run').onclick = run(async () => {const ws = wsByKey($('export-workspace').value) || current(); if (ws) await exportHtml(ws);});
$('export-reveal').onclick = run(() => client.revealExport());
async function loadControlPanel() {
  await serverControls.refresh();
  if (client.serverFolders && client.writable) serverFolders = await client.serverFolders().catch(() => serverFolders);
  for (const button of document.querySelectorAll('[data-storage]')) button.disabled = !client.capabilities.storage || !client.chooseDirectory;
  if (client.capabilities.storage) {
    const info = await client.call('controlPanel', {scope: monitorWs()?.api.scope});
    panelInfo = info;
    renderOperation(info.status || {});
    $('delete-backups').checked = info.deleteBackups === true; $('trash-directory').textContent = info.trashDirectory || '';
    $('database-directory').textContent = info.pendingDataDirectory ? `${info.dataDirectory} → ${info.pendingDataDirectory} (after restart)` : info.dataDirectory;
  }
  renderWorkspaceManager();
}
$('add-workspace').onclick = run(async () => {await choose(); await loadControlPanel();});
$('delete-backups').onchange = run(async () => {panelInfo = await client.call('configureDeletion', {backups: $('delete-backups').checked}); await loadControlPanel(); message($('delete-backups').checked ? 'Files deleted in Weave will be backed up first.' : 'Files deleted in Weave are removed from disk without a backup.');});
$('storage-form').onclick = run(async e => {
  const button = e.target.closest('[data-storage]'); if (!button || !await ensureDraftsSaved(() => true, 'changing the data folder')) return;
  const directory = await client.chooseDirectory(); if (!directory) return;
  await persistSession(); button.disabled = true;
  try {const result = await client.call('configureStorage', {[button.dataset.storage]: directory});
    await loadControlPanel(); message(result.restartRequired ? 'Storage location saved. Restart Weave to move the data folder.' : 'Storage location is unchanged.');
  } finally {button.disabled = false;}
});
const appearance = initAppearance({prefs,onChange:() => {for (const editor of paneEditors()) editor.requestMeasure();},onFileLabelsChange:renderTree});
$('tab-workspace-names').checked = prefs.get('tab-workspace-names') !== 'false';
$('tab-workspace-names').onchange = () => {prefs.set('tab-workspace-names', String($('tab-workspace-names').checked)); renderTabs();};
for (const element of panes.flatMap(pane => [pane.el.article, pane.el['source-editor']])) element.addEventListener('wheel', event => {
  if (!event.ctrlKey || !event.deltaY) return;
  event.preventDefault(); event.stopPropagation(); appearance.zoomBy(-Math.sign(event.deltaY));
}, {passive:false});
kanban = createKanban({
  client, prefs, $, message, run, promptUser, panes, paneActive, paneWs, docKey, draftKey, titles, underlineEnabled, openNote, openToSide, sideLabel, ensureDraftsSaved, refreshWorkspace, renderTree, multi, wsByKey, workspaceName, workspaceColor,
  workspaces: () => workspaces, shownPanes, focusedPane: () => P, editing: () => edit, sidebars: () => sidebars, settingsDialog: () => settingsDialog, paneSource,
  leaveSource: pane => {if (pane !== P) focusPane(pane); if (source) $('source-mode').click();},
  selection: () => {const ws = wsByKey(selectedWs) || current(); return {ws, folder: !ws || !selected ? '' : ws.index.isFolder(selected) ? selected : selected.split('/').slice(0, -1).join('/')};},
  revealInFiles: (ws, path) => {selected = path; selectedWs = ws.key; for (const parts = path.split('/').slice(0, -1); parts.length; parts.pop()) ws.expanded.add(parts.join('/')); ws.treeLimit = Math.max(ws.treeLimit, ws.index.size + ws.index.folders.size); setPanel('files'); renderTree(); [...$('tree').querySelectorAll('[data-tree-path]')].find(row => row.dataset.treePath === path && row.dataset.ws === ws.key)?.scrollIntoView({block: 'nearest'});},
  renameEntry: async (ws, path) => {selected = path; selectedWs = ws.key; if (!edit) throw new Error('Turn on Edit to rename files.'); await rename();},
  deleteEntry: async (ws, path) => {selected = path; selectedWs = ws.key; await remove();},
});
sidebars = createSidebars({prefs,onActivate:(next, side) => {
  if (next === 'search' && side !== 'passive') $('search-query').focus();
  if (next === 'kanban') kanban.renderSidebar();
  if (next === 'card') void kanban.renderPreview();
  if (next === 'settings') run(loadControlPanel)();
  if (next === 'files' && side !== 'passive') revealFile();
  if (next === 'git') for (const ws of workspaces) run(() => ws.git.refresh())();
  if (next === 'export') renderExport();
}});
const mobileLayout = initMobileLayout({sidebars, onChange: () => renderWelcome(), back: () => {if ($('nav-back').disabled) return false; $('nav-back').click(); return true;}});
// The left sidebar follows the pointer all the way to the rail, like the right
// one; released below 100 px it collapses and keeps its last usable width.
const resize = $('sidebar-resize'); let resizing = null;
const sidebarWidth = width => document.documentElement.style.setProperty('--sidebar', width + 'px');
resize.onpointerdown = e => {if (e.button !== 0) return; const box = $('sidebar').getBoundingClientRect(); resizing = {x: e.clientX, width: box.width, saved: document.documentElement.style.getPropertyValue('--sidebar')}; resize.setPointerCapture(e.pointerId); document.body.classList.add('sidebar-resizing'); e.preventDefault();};
resize.onpointermove = e => {if (resizing) sidebarWidth(Math.max(0, Math.min(650, resizing.width + e.clientX - resizing.x)));};
resize.onpointerup = resize.onpointercancel = e => {
  if (!resizing) return;
  const width = resizing.width + e.clientX - resizing.x, {saved} = resizing; resizing = null;
  document.body.classList.remove('sidebar-resizing');
  if (resize.hasPointerCapture(e.pointerId)) resize.releasePointerCapture(e.pointerId);
  const restore = () => {if (saved) document.documentElement.style.setProperty('--sidebar', saved); else document.documentElement.style.removeProperty('--sidebar');};
  if (e.type === 'pointercancel') restore();
  else if (width < 100) {restore(); collapseSidebar();}
  else sidebarWidth(Math.max(180, Math.min(650, width)));
};
resize.onkeydown = e => {if (!['ArrowLeft','ArrowRight'].includes(e.key)) return; e.preventDefault(); const width=$('sidebar').getBoundingClientRect().width; document.documentElement.style.setProperty('--sidebar',Math.max(180,Math.min(520,width+(e.key==='ArrowRight'?15:-15)))+'px');};
document.addEventListener('keydown', event => {
  const modifier = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
  if (modifier && key === 'n' && !event.altKey && !event.shiftKey) {
    event.preventDefault();
    if (!document.querySelector('dialog[open]') && client.writable && workspaces.length) run(async () => {
      if (!edit) {edit = true; prefs.set('edit', 'true'); updateMode();}
      await create(false, {atRoot: true});
    })();
    return;
  }
  if (event.altKey && ['ArrowLeft','ArrowRight'].includes(event.key)) {event.preventDefault(); run(() => navigate(event.key === 'ArrowLeft' ? -1 : 1))();}
  if (modifier && key === 'o' && !event.altKey && !event.shiftKey) {event.preventDefault(); if (!document.querySelector('dialog[open]')) run(openFileDialog)(); return;}
  if (modifier && key === ',') {event.preventDefault(); settingsDialog.open(); return;}
  if (modifier && key === 't') {event.preventDefault(); run(newTab)();}
  // Ctrl+\ opens the active tab's article on the other side, as in VS Code.
  if (modifier && event.code === 'Backslash' && !event.altKey && !event.shiftKey && !document.querySelector('dialog[open]')) {event.preventDefault(); if (activeTab) run(() => splitTab(activeTab))();}
  if (modifier && key === 'w' && activeTab) {event.preventDefault(); run(() => closeTab(activeTab))();}
  if (modifier && ['c', 'v'].includes(key) && !event.shiftKey && !event.altKey && filesActive && (event.target === document.body || $('files-panel').contains(event.target)) && !event.target.closest('textarea,input,[contenteditable="true"]')) {
    event.preventDefault();
    if (key === 'c') copyEntry(); else run(pasteEntry)();
    return;
  }
  if (event.key === 'F2' && edit && selected && !event.target.closest('textarea,input,dialog,[contenteditable="true"]')) {event.preventDefault(); const ws = wsByKey(selectedWs); run(() => ws && /\.md$/i.test(selected) && !ws.index.isFolder(selected) ? retitle() : rename())();}
  if (modifier && key === 's') {event.preventDefault(); run(() => event.shiftKey ? saveAll() : save({explicit: true}))();}
  if (modifier && key === 'p') {event.preventDefault(); setPanel('search');}
  if (event.key === 'Escape') {closeAppMenu(); $('suggestions').hidden = true; $('file-menu').hidden = true; $('tab-menu').hidden = true; $('article-menu').hidden=true; $('link-menu').hidden = true; kanban.hideMenu();}
});
window.addEventListener('beforeunload', event => {if (dirty || drafts.size) {event.preventDefault(); event.returnValue = '';}});
const settingsDialog = createSettingsDialog({sources: [{panel: $('settings-panel'), group: 'Options', kind: 'headings'}, ...(client.capabilities.export ? [{panel: $('export-panel'), group: 'Export', kind: 'headings'}] : []), {panel: $('appearance-panel'), group: 'Appearance', kind: 'details'}], onOpen: run(async () => {await loadControlPanel(); renderExport();})});
$('open-settings').onclick = () => settingsDialog.open();
// Markdown files dropped on the window open in new tabs, outside the workspace.
// The desktop host receives native drops (with paths) and grants only those
// files; browsers read dropped files read-only.
client.onOpenExternal?.(run(async ({paths = [], rejected = 0}) => {
  for (const path of paths) await openExternal(await client.readExternal(path));
  if (rejected) message(rejected + (rejected === 1 ? ' dropped file is' : ' dropped files are') + ' not Markdown and ' + (rejected === 1 ? 'was' : 'were') + ' not opened.');
}));
const draggingFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragover', event => {if (!draggingFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; document.body.classList.add('file-drop');});
document.addEventListener('dragleave', event => {if (!event.relatedTarget) document.body.classList.remove('file-drop');});
document.addEventListener('drop', run(async event => {
  if (!draggingFiles(event)) return; event.preventDefault(); document.body.classList.remove('file-drop');
  for (const file of event.dataTransfer.files) await openBrowserFile(file);
}));
setInterval(run(async () => {if ((sidebars.visible('settings') || settingsDialog.isOpen) && client.capabilities.storage && !document.hidden) await loadControlPanel();}), 6000);
let syncAgain = false;
async function syncAll() {
  if (!workspaces.length) return;
  if (pollBusy) {syncAgain = true; return;} pollBusy = true;
  try {
    for (const ws of [...workspaces]) {
      let status;
      try {status = await ws.api.call('status');} catch (error) {if (workspaces.includes(ws)) throw error; continue;}
      if (workspaces.includes(ws)) await syncWorkspace(ws, status);
    }
  } finally {pollBusy = false; if (syncAgain) {syncAgain = false; setTimeout(run(syncAll), 50);}}
}
// The native host reports changes as they happen; polling remains a slow fallback.
if (client.events) await client.onChanged(() => void run(syncAll)());
setInterval(run(syncAll), client.events ? 5000 : 1400);
// Only Windows calls its file manager Explorer.
if (!/Windows/.test(navigator.userAgent)) for (const button of document.querySelectorAll('#export-reveal, [data-file-action="reveal"]')) button.textContent = 'Show in folder';
// In-app text uses American or British spelling to match the system's English.
// Interface spelling: Weave converts only its own text (ui() strings, the panels it
// builds and [data-ui] static markup), never articles, names or other user content.
localizeMarked();
setSplit(false); updateMode(); renderTree(); renderGitSections();
try {
  const health = await client.call('health'); if (!health.ok) throw new Error(health.error);
  let initial = client.initial;
  if (client.capabilities.session) {initial = await client.call('restore'); if (initial?.restoreError) {message(initial.restoreError); initial = null;}}
  else if (!initial && JSON.parse($('weave-data').textContent).mode === 'dynamic') initial = await client.choose();
  if (initial) {
    await restoreWorkspaces(initial);
    if (initial.restoreErrors?.length) message(initial.restoreErrors.join(' '));
    const deep = new URLSearchParams(location.hash.slice(1)).get('note'), ws = current();
    if (deep && ws?.index.has(deep)) await openNote(deep, null, {ws});
  }
  await loadControlPanel();
  renderWelcome();
} catch (e) {message(e.message); $p('welcome').querySelector('.hint').textContent = e.message;}
