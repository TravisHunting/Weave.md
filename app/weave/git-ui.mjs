import {ui} from './locale.mjs';
import {esc} from './render.mjs';

const button = (action, text, label = text, extra = '') => `<button type="button" data-git-action="${action}" aria-label="${esc(label)}" title="${esc(label)}" ${extra}>${text}</button>`;
const icons = {
  sync:'<path d="M20 7a8 8 0 0 0-13-3L4 7m0-5v5h5M4 17a8 8 0 0 0 13 3l3-3m0 5v-5h-5"/>',
  commit:'<path d="m5 12 4 4L19 6"/>', stageAll:'<path d="M12 5v14M5 12h14"/>', unstageAll:'<path d="M5 12h14"/>',
  push:'<path d="m7 10 5-5 5 5M12 5v12M5 19h14"/>', pull:'<path d="m7 12 5 5 5-5M12 4v13M5 20h14"/>',
  fetch:'<path d="M5 4h14M12 7v13m-5-5 5 5 5-5"/>', refresh:'<path d="M20 10a8 8 0 1 0-2 8M20 4v6h-6"/>',
};
const iconButton = (action,label,extra = '') => button(action,`<svg viewBox="0 0 24 24" aria-hidden="true">${icons[action]}</svg>`,label,extra);
const statusLabel = file => file.conflict ? 'Conflict' : file.untracked ? 'Untracked' : ({A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed'}[file.index !== '.' ? file.index : file.worktree] || 'Changed');
/** Preserve exact text/line endings around merge and diff3 conflict blocks. */
export function conflictHunks(text) {
  const lines = [...text.matchAll(/.*(?:\r\n|\n|$)/g)].filter(match => match[0]);
  const hunks = [];
  for (let index = 0; index < lines.length; index++) {
    const start = lines[index], marker = start[0].match(/^(<{7,})(?: |\r?\n|$)/);
    if (!marker) continue;
    const length = marker[1].length;
    let base = -1, separator = -1, end = -1;
    for (let next = index + 1; next < lines.length; next++) {
      const line = lines[next][0];
      if (new RegExp('^\\|{' + length + '}(?: |\\r?\\n|$)').test(line)) base = next;
      if (new RegExp('^={' + length + '}(?:\\r?\\n|$)').test(line)) separator = next;
      if (new RegExp('^>{' + length + '}(?: |\\r?\\n|$)').test(line)) {end = next; break;}
    }
    if (separator < 0 || end < separator) continue;
    hunks.push({from: start.index, to: lines[end].index + lines[end][0].length,
      ours: lines.slice(index + 1, base > index && base < separator ? base : separator).map(line => line[0]).join(''),
      theirs: lines.slice(separator + 1, end).map(line => line[0]).join('')});
    index = end;
  }
  return hunks;
}
export function diffRows(text) {
  let old = 0, next = 0, insideHunk = false;
  return text.replace(/\r\n/g, '\n').split('\n').map(line => {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {old = Number(hunk[1]); next = Number(hunk[2]); insideHunk = true; return {kind: 'hunk', text: line};}
    if (line.startsWith('diff --git ')) insideHunk = false;
    if (!insideHunk) return {kind: 'meta', text: line};
    if (line[0] === '+') return {kind: 'add', next: next++, text: line.slice(1)};
    if (line[0] === '-') return {kind: 'remove', old: old++, text: line.slice(1)};
    if (line[0] === ' ') return {kind: 'context', old: old++, next: next++, text: line.slice(1)};
    return {kind: 'meta', text: line};
  });
}
function renderDiff(text, split = false) {
  const rows = diffRows(text);
  if (!split) return rows.map(row => `<div class="git-diff-row git-diff-${row.kind}"><span class="git-line-number">${row.old ?? ''}</span><span class="git-line-number">${row.next ?? ''}</span><span class="git-diff-sign" aria-hidden="true">${row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ''}</span><span class="git-diff-code">${esc(row.text) || ' '}</span></div>`).join('');
  let html = '';
  const half = (row, kind = row?.kind || 'empty', number = row?.old ?? row?.next) => `<div class="git-diff-half git-diff-${kind}"><span class="git-line-number">${number ?? ''}</span><span class="git-diff-code">${esc(row?.text || '') || ' '}</span></div>`;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.kind === 'meta' || row.kind === 'hunk') {html += `<div class="git-diff-row git-diff-${row.kind}"><span class="git-diff-code">${esc(row.text) || ' '}</span></div>`; continue;}
    if (row.kind === 'context') {html += `<div class="git-diff-pair">${half(row, 'context', row.old)}${half(row, 'context', row.next)}</div>`; continue;}
    const removed = [], added = [];
    while (rows[i]?.kind === 'remove') removed.push(rows[i++]);
    while (rows[i]?.kind === 'add') added.push(rows[i++]);
    i--;
    for (let j = 0; j < Math.max(removed.length, added.length); j++) html += `<div class="git-diff-pair">${half(removed[j])}${half(added[j])}</div>`;
  }
  return html;
}

// Several panels can exist, one per open workspace; `idSuffix` keeps their element IDs unique.
export function createGitPanel({client, container, beforeAction = async () => {}, afterMutation = async () => {}, openFile = async () => {}, idSuffix = '', onPendingCount, onBusy}) {
  let state = null, busy = false, generation = 0, refreshing = false, refreshedAt = 0, refreshCost = 0, selectedRemote = '', pushRemotes = [], defaultMessage = '', historyLoaded = false, diff = null, split = true, conflict = null, conflictChoice = 'manual';
  const dialog = document.createElement('dialog'); dialog.id = 'git-diff-dialog' + idSuffix; dialog.className = 'git-diff-dialog'; dialog.setAttribute('aria-labelledby', 'git-diff-title'); document.body.append(dialog);
  const conflictDialog = document.createElement('dialog'); conflictDialog.id = 'git-conflict-dialog' + idSuffix; conflictDialog.className = 'git-diff-dialog git-conflict-dialog'; conflictDialog.setAttribute('aria-labelledby', 'git-conflict-title'); document.body.append(conflictDialog);
  container.innerHTML = `<div class="git-toolbar" role="toolbar" aria-label="Source control actions">${iconButton('sync','Commit all & sync','id="git-commit-sync"')}${iconButton('commit','Commit staged changes','id="git-commit"')}${iconButton('stageAll','Stage all changes')}${iconButton('unstageAll','Unstage all changes')}${iconButton('push','Push branch to selected remotes')}${iconButton('pull','Pull (fast-forward only)')}${iconButton('fetch','Fetch remote updates')}${iconButton('refresh','Refresh source control')}</div>
    <div class="git-summary"><strong id="git-branch">Source control</strong></div><p id="git-repository-note" class="hint"></p><div id="git-notice" class="git-notice" role="status" aria-live="polite"></div><div id="git-setup" hidden></div>
    <div id="git-repository" hidden><form id="git-commit-form"><label for="git-commit-message" class="git-visually-hidden">Commit message</label><input id="git-commit-message" type="text" maxlength="10000" placeholder="Commit message (Ctrl+Enter)" aria-label="Commit message" title="Current UTC timestamp by default. Enter your own message to replace it." autocomplete="off"></form><p id="git-sync-status" class="hint"></p><div id="git-changes"></div>
    <div class="git-repository-controls"><div class="git-branch-control"><label for="git-branches">Branch</label><select id="git-branches" aria-label="Current Git branch"></select>${button('newBranch', '+', 'Create branch')}</div></div>
    ${button('editIgnore','Edit .gitignore')}<details id="git-remote-management"><summary>Remote management</summary><div class="git-remote-control"><label for="git-remotes">Fetch / pull</label><select id="git-remotes" aria-label="Git fetch and pull remote"></select></div><p class="hint">Sync fetches and merges from this remote, then pushes to every checked remote. Only this remote can set the branch upstream.</p><fieldset class="git-push-remotes"><legend>Push to</legend><div id="git-push-remotes"></div></fieldset><form id="git-add-remote-form"><label for="git-remote-name">Remote name</label><input id="git-remote-name" maxlength="100" placeholder="origin" required autocomplete="off"><label for="git-remote-url">Clone URL (HTTPS or SSH)</label><input id="git-remote-url" maxlength="2000" placeholder="https://host/repository.git" required autocomplete="off"><button type="submit">Add remote</button></form></details>
    <details id="git-recent-pulls"><summary>Recently pulled files</summary><div id="git-recent-pull-list"></div></details><details id="git-more"><summary>Branches &amp; stashes</summary><p class="hint">Save tracked changes in a stash before switching branches. Stage new files to include them.</p>${button('stash', 'Stash tracked changes')}<div id="git-stashes"></div></details><details id="git-history"><summary>Recent commits</summary><div id="git-history-list"></div></details></div>`;
  const ignoreDialog = document.createElement('dialog'); ignoreDialog.id='git-ignore-dialog'+idSuffix; ignoreDialog.className='git-diff-dialog';
  ignoreDialog.innerHTML='<form><div class="git-diff-heading"><h2>Edit .gitignore</h2><button type="button" data-ignore-close aria-label="Close .gitignore editor">×</button></div><p class="hint">Patterns are relative to the repository root. Saving does not stage or commit the file.</p><label for="git-ignore-text">Ignored files and folders</label><textarea id="git-ignore-text" spellcheck="false"></textarea><p data-ignore-error role="alert"></p><div class="git-diff-footer"><button type="button" data-ignore-close>Cancel</button><button type="submit">Save .gitignore</button></div></form>';
  document.body.append(ignoreDialog);
  let ignoreRevision=null;
  for(const node of ignoreDialog.querySelectorAll('[data-ignore-close]'))node.onclick=()=>ignoreDialog.close();
  ignoreDialog.querySelector('form').onsubmit=async event=>{
    event.preventDefault();if(busy)return;const serial=generation;lock(true);
    const controls=[...ignoreDialog.querySelectorAll('button,textarea')];controls.forEach(node=>node.disabled=true);
    try {
      await beforeAction('saveIgnore');if(serial!==generation)return;
      const result=await client.call('gitAction',{action:'saveIgnore',text:ignoreDialog.querySelector('textarea').value,revision:ignoreRevision});
      if(serial!==generation)return;
      state=result.status;ignoreDialog.close();render();announce(result.message);await afterMutation('saveIgnore');
    } catch(error) {if(serial===generation)ignoreDialog.querySelector('[data-ignore-error]').textContent=error.message;}
    finally {lock(false);controls.forEach(node=>node.disabled=false);}
  };
  async function editIgnore() {
    if(busy)return;const serial=generation;
    try {
      const snapshot=await client.call('gitIgnore');if(serial!==generation)return;
      ignoreRevision=snapshot.revision;ignoreDialog.querySelector('textarea').value=snapshot.text;
      ignoreDialog.querySelector('[data-ignore-error]').textContent='';ignoreDialog.showModal();ignoreDialog.querySelector('textarea').focus();
    } catch(error) {announce(error.message,true);}
  }
  const fileMenu=document.createElement('div');fileMenu.id='git-file-menu'+idSuffix;fileMenu.className='article-context-menu';fileMenu.setAttribute('role','menu');fileMenu.hidden=true;
  fileMenu.innerHTML='<button role="menuitem">Show in explorer</button>';document.body.append(fileMenu);
  let revealPath=null;
  container.addEventListener('contextmenu',event=>{
    const row=event.target.closest('.git-file');if(!row || !client.capabilities.nativeWindow)return;
    event.preventDefault();revealPath=row.dataset.path;fileMenu.hidden=false;
    fileMenu.style.left=Math.max(0,Math.min(event.clientX,innerWidth-fileMenu.offsetWidth))+'px';fileMenu.style.top=Math.max(0,Math.min(event.clientY,innerHeight-fileMenu.offsetHeight))+'px';fileMenu.firstChild.focus();
  });
  fileMenu.firstChild.onclick=async()=>{fileMenu.hidden=true;try{await client.call('revealPath',{path:revealPath});}catch(error){announce(error.message,true);}};
  const closeMenu=event=>{if(event.type==='keydown' ? event.key==='Escape' : !fileMenu.contains(event.target))fileMenu.hidden=true;};
  document.addEventListener('click',closeMenu);document.addEventListener('keydown',closeMenu);
  if (idSuffix) for (const node of container.querySelectorAll('[id],label[for]')) {if (node.id) node.id += idSuffix; if (node.htmlFor) node.htmlFor += idSuffix;}
  const find = id => container.querySelector('#' + id + idSuffix);
  const announce = (text, error = false) => {find('git-notice').textContent = text; find('git-notice').classList.toggle('git-error', error);};
  function timestampMessage(force = false, submitting = false) {
    const input = find('git-commit-message');
    if (force || input.value === defaultMessage && (submitting || document.activeElement !== input)) {defaultMessage = new Date().toISOString(); input.value = defaultMessage;}
    return input.value.trim() || new Date().toISOString();
  }
  const commitMessage = () => timestampMessage(!find('git-commit-message').value.trim(), true);
  function lock(value) {
    busy = value; container.setAttribute('aria-busy', String(value)); onBusy?.(value);
    for (const node of container.querySelectorAll('button,select,input')) node.disabled = value;
    if (!value) updateControls();
  }
  function updateControls() {
    const repo = state?.repository, changes = state?.files || [], remote = state?.remotes?.length;
    for (const node of container.querySelectorAll('button,select,input')) node.disabled = busy;
    find('git-commit').disabled = busy || !repo || state?.privateStaged || changes.some(file => file.conflict) || !state?.merging && !changes.some(file => !file.untracked && file.index !== '.');
    find('git-commit-sync').disabled = busy || !repo || !remote || !pushRemotes.length || state?.privateStaged || state?.detached || changes.some(file=>file.conflict);
    for (const action of ['fetch', 'pull', 'push']) container.querySelector(`[data-git-action="${action}"]`).disabled = busy || !repo || !remote;
    container.querySelector('[data-git-action="push"]').disabled ||= !pushRemotes.length || state?.unborn || state?.detached;
    container.querySelector('[data-git-action="stageAll"]').disabled = busy || !repo || !changes.some(file=>file.untracked || file.worktree !== '.' || file.conflict);
    container.querySelector('[data-git-action="unstageAll"]').disabled = busy || !repo || !changes.some(file=>!file.untracked && file.index !== '.');
    container.querySelector('[data-git-action="stash"]').disabled = busy || !repo || state?.unborn || !changes.length;
  }
  function fileGroup(title, files, staged) {
    if (!files.length) return '';
    const action = staged ? 'unstage' : 'stage';
    return `<section class="git-change-group"><div class="git-group-heading"><h3>${title} <span>${files.length}</span></h3></div>${files.map(file => `<div class="git-file" data-path="${esc(file.path)}" data-staged="${staged}" data-untracked="${!!file.untracked}"><button type="button" class="git-file-diff" ${file.conflict ? 'data-git-conflict' : 'data-git-diff'} title="${esc(file.previousPath ? file.previousPath + ' → ' + file.path : file.path)}"><span class="git-file-label">${esc(file.path.split('/').at(-1))}<small>${esc(file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : '')}</small></span><span class="git-file-status ${file.conflict ? 'git-conflict' : ''}" aria-label="${statusLabel(file)}">${file.conflict ? '!' : file.untracked ? 'U' : staged ? file.index : file.worktree}</span></button>${!staged && !file.conflict ? button('discard', '↶', (file.untracked ? 'Discard untracked file ' : 'Discard unstaged changes to ') + file.path) : ''}${file.conflict ? `<button type="button" data-git-conflict aria-label="Resolve ${esc(file.path)}">Resolve</button>` : button(action, staged ? '−' : '+', (staged ? 'Unstage ' : 'Stage ') + file.path)}</div>`).join('')}</section>`;
  }
  function render() {
    const count=state?.repository ? state.pendingFileCount ?? new Set((state.files || []).map(file=>file.path)).size : 0;
    const badge=document.getElementById('git-pending-badge');
    if(onPendingCount) onPendingCount(count);
    else if(badge) {badge.textContent=String(count);badge.hidden=!count;badge.parentElement.title=count ? 'Source control · '+count+' pending '+(count===1?'file':'files') : 'Source control';}

    find('git-repository').hidden = !state?.repository; find('git-setup').hidden = !!state?.repository;
    find('git-branch').textContent = state?.repository ? (state.detached ? 'Detached HEAD · ' + state.oid.slice(0, 8) : '⑂ ' + state.branch) : 'Source control';
    if (!state?.repository) {
      find('git-repository-note').textContent = !client.capabilities.git ? 'Source control is available in the desktop application.' : state?.parentRepository ? 'Open the repository root to manage every change together: ' + state.parentRepository : state?.error || 'This workspace is not a Git repository.';
      find('git-setup').innerHTML = client.capabilities.git && state?.available && !state.parentRepository ? button('init', ui('Initialise repository')) : '';
      updateControls();
      return;
    }
    find('git-repository-note').textContent = state.root; find('git-repository-note').title = state.root;
    const branches = state.branches || [];
    find('git-branches').innerHTML = (state.unborn || state.detached ? `<option value="">${esc(state.branch)}</option>` : '') + branches.map(branch => `<option ${branch.current ? 'selected' : ''} value="${esc(branch.name)}">${esc(branch.name)}</option>`).join('');
    selectedRemote = state.syncRemote || state.remotes.find(remote => remote.name === 'origin')?.name || state.remotes[0]?.name || '';
    pushRemotes = state.pushRemotes || (selectedRemote ? [selectedRemote] : []);
    find('git-remotes').innerHTML = state.remotes.length ? state.remotes.map(remote => `<option value="${esc(remote.name)}" ${remote.name === selectedRemote ? 'selected' : ''}>${esc(remote.name)}</option>`).join('') : '<option value="">No remote</option>';
    find('git-remotes').title = state.remotes.find(remote => remote.name === selectedRemote)?.fetch || '';
    find('git-push-remotes').innerHTML = state.remotes.map(remote => `<label class="git-push-remote"><input type="checkbox" data-push-remote="${esc(remote.name)}" aria-label="Push to ${esc(remote.name)}" ${pushRemotes.includes(remote.name) ? 'checked' : ''}><span><strong>${esc(remote.name)}</strong><small title="${esc(remote.push || remote.fetch || '')}">${esc(remote.push || remote.fetch || '')}</small>${remote.fetch !== remote.push ? `<small>Fetch: ${esc(remote.fetch || '')}</small>` : ''}</span></label>`).join('') || '<p class="hint">Add a remote to publish this workspace.</p>';
    timestampMessage();
    find('git-sync-status').textContent = state.upstream ? `${state.ahead} outgoing ↑ · ${state.behind} incoming ↓ · ${state.upstream}` : selectedRemote ? `No upstream branch. Pushing to ${selectedRemote} sets this branch's upstream.` : 'No upstream branch. Add a remote to publish this branch.';
    find('git-recent-pull-list').innerHTML = (state.recentPulls || []).map(pull => `<section class="git-pull"><p class="hint">${esc(new Date(pull.at).toLocaleString())}<br>${esc(pull.remote+'/'+pull.branch)} · ${pull.totalFiles} ${pull.totalFiles===1?'file':'files'}</p>${pull.files.map(file=>`<button type="button" class="git-pulled-file" data-pull-id="${esc(pull.to)}" data-pull-path="${esc(file.path)}" title="${esc(file.previousPath ? file.previousPath+' → '+file.path : file.path)}"><span>${esc(file.path)}</span><strong>${esc(file.status)}</strong></button>`).join('')}${pull.totalFiles>pull.files.length?'<p class="hint">Showing the first 200 files.</p>':''}</section>`).join('') || '<p class="hint">Files received by Pull or Sync will appear here, including modified, added, renamed and deleted files.</p>';
    const conflicts = state.files.filter(file => file.conflict), staged = state.files.filter(file => !file.untracked && !file.conflict && file.index !== '.'), unstaged = state.files.filter(file => !file.conflict && (file.untracked || file.worktree !== '.'));
    find('git-changes').innerHTML = fileGroup('Merge changes', conflicts, false) + fileGroup('Staged changes', staged, true) + fileGroup('Changes', unstaged, false) + (!state.files.length ? `<div class="git-clean"><span aria-hidden="true">✓</span><strong>${state.merging ? 'Conflicts resolved' : 'Working tree clean'}</strong><p>${state.merging ? 'Commit to complete the merge.' : 'All changes are committed.'}</p></div>` : '');
    find('git-stashes').innerHTML = state.stashes.map(stash => `<div class="git-stash"><span>${esc(stash.message)}</span>${button('applyStash', 'Apply', 'Apply ' + stash.ref + ' (keep stash)', `data-ref="${esc(stash.ref)}"`)}</div>`).join('') || '<p class="hint">No saved stashes.</p>';
    if (state.privateStaged) announce('Private Weave data is staged. Unstage it in an external Git client before committing.', true);
    updateControls();
  }
  async function refresh({quiet = false} = {}) {
    if (refreshing || busy || !client.capabilities.git) {if (!client.capabilities.git) render(); return;}
    // Background refreshes are spaced by what the last one cost, so Git status
    // of a very large repository never runs back to back.
    if (quiet && Date.now() - refreshedAt < Math.max(1000, refreshCost * 5)) return;
    refreshing = true; refreshedAt = Date.now(); const serial = generation;
    try {const next = await client.call('gitStatus'); if (serial !== generation) return; const changed = JSON.stringify(next) !== JSON.stringify(state); state = next; if (changed) render(); if (!quiet && state.error) announce(state.error, true);}
    catch (error) {if (serial === generation && !quiet) announce(error.message, true);}
    finally {refreshing = false; refreshCost = Date.now() - refreshedAt;}
  }
  async function ask(title, description, {input, confirm = 'Continue'} = {}) {
    const prompt = document.createElement('dialog'); prompt.className = 'git-prompt';
    prompt.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><p>${esc(description)}</p>${input !== undefined ? `<label>${esc(title)}<input name="value" value="${esc(input)}" autocomplete="off" required></label>` : ''}<div class="dialog-actions"><button value="cancel" formnovalidate>Cancel</button><button value="ok">${esc(confirm)}</button></div></form>`;
    document.body.append(prompt); prompt.showModal(); prompt.querySelector('input')?.select();
    return new Promise(resolve => {prompt.onclose = () => {const value = prompt.returnValue === 'ok' ? prompt.querySelector('input')?.value.trim() ?? true : null; prompt.remove(); resolve(value);};});
  }
  async function action(name, args = {}) {
    if (busy) return; const serial = generation; lock(true); announce(({fetch: 'Fetching remote updates…', pull: 'Pulling changes…', push: 'Pushing branch…', sync: 'Committing all changes and syncing…', commit: 'Committing staged changes…'}[name]) || 'Updating repository…');
    try {
      if (name !== 'configureRemotes') await beforeAction(name); if (serial !== generation) return; const result = await client.call('gitAction', {action: name, remote: selectedRemote, ...(['push', 'sync'].includes(name) ? {pushRemotes} : {}), ...args}); if (serial !== generation) return;
      state = result.status; if (name === 'commit' || name === 'sync' && result.committed) timestampMessage(true);
      if (name === 'addRemote') {find('git-remote-name').value = ''; find('git-remote-url').value = '';}
      historyLoaded = false; render(); announce(result.message || 'Done.');
      if (name !== 'configureRemotes') await afterMutation(name); if (find('git-history').open) await loadHistory();
    } catch (error) {if (serial === generation) {announce(error.message, true); try {state = await client.call('gitStatus'); render(); if (name !== 'configureRemotes') await afterMutation(name);} catch {}}}
    finally {lock(false);}
  }
  function renderDiffDialog() {
    const rows = diffRows(diff.text), additions = rows.filter(row => row.kind === 'add').length, deletions = rows.filter(row => row.kind === 'remove').length;
    dialog.innerHTML = `<div class="git-diff-heading"><div><p class="eyebrow">${diff.pulled ? 'PULLED CHANGES' : diff.commit ? 'COMMIT' : diff.staged ? 'INDEX · STAGED CHANGES' : 'WORKING TREE · CHANGES'}</p><h2 id="git-diff-title">${esc(diff.path)}</h2></div><span class="git-diff-count"><span>+${additions}</span> <span>−${deletions}</span></span><button type="button" data-diff-close aria-label="Close diff" title="Close diff (Esc)">×</button></div><div class="git-diff-toolbar"><div role="group" aria-label="Diff layout"><button data-diff-layout="unified" aria-pressed="${!split}">Unified</button><button data-diff-layout="split" aria-pressed="${split}">Side by side</button></div><div class="spacer"></div>${!diff.commit && !diff.deleted && /\.md$/i.test(diff.path) ? '<button data-diff-open>Open article</button>' : ''}${!diff.commit && !diff.pulled ? `<button data-diff-stage>${diff.staged ? '− Unstage file' : '+ Stage file'}</button>` : ''}</div><div class="git-diff-body ${split ? 'git-diff-split' : ''}" tabindex="0" aria-label="${esc(diff.path)} diff">${diff.text ? renderDiff(diff.text, split) : '<p class="hint">No changes in this version.</p>'}</div><div class="git-diff-footer">${diff.binary ? 'Binary content cannot be shown as text.' : diff.pulled ? 'Workspace changes brought in by this pull.' : diff.commit ? 'Commit details and file changes' : diff.staged ? 'HEAD → Index · These changes will be committed.' : 'Index → Working tree · Stage this version to include it in a commit.'}<span>Esc to close</span></div>`;
    dialog.querySelector('[data-diff-close]').onclick = () => dialog.close();
    dialog.querySelectorAll('[data-diff-layout]').forEach(node => node.onclick = () => {split = node.dataset.diffLayout === 'split'; renderDiffDialog();});
    const stage = dialog.querySelector('[data-diff-stage]'); if (stage) stage.onclick = async () => {dialog.close(); await action(diff.staged ? 'unstage' : 'stage', {path: diff.path});};
    const open = dialog.querySelector('[data-diff-open]'); if (open) open.onclick = async () => {dialog.close(); try {await openFile(diff.path);} catch (error) {announce(error.message, true);}};
  }
  async function openDiff(file, staged) {
    if (busy) return;
    const serial = generation;
    try {await beforeAction('diff'); if (serial !== generation) return; const result = await client.call('gitDiff', {path: file, staged}); if (serial !== generation) return; diff = result; split = true; renderDiffDialog(); dialog.showModal(); dialog.querySelector('[data-diff-close]').focus();}
    catch (error) {announce(error.message, true);}
  }
  function renderConflictHunks() {
    const editor = conflictDialog.querySelector('#git-conflict-result'), body = conflictDialog.querySelector('.git-conflict-hunks');
    if (!editor || !body) return;
    const hunks = conflictHunks(editor.value);
    body.innerHTML = hunks.map((hunk, index) => `<section class="git-conflict-hunk"><div class="git-conflict-hunk-heading"><strong>Conflict ${index + 1}</strong><button data-hunk="${index}" data-choice="ours">Use current</button><button data-hunk="${index}" data-choice="theirs">Use incoming</button><button data-hunk="${index}" data-choice="both">Use both</button></div><div class="git-conflict-versions"><div><h3>Current · ours</h3><pre>${esc(hunk.ours) || '(empty)'}</pre></div><div><h3>Incoming · theirs</h3><pre>${esc(hunk.theirs) || '(empty)'}</pre></div></div></section>`).join('') || '<p class="hint">No remaining conflict blocks. Review the result before staging.</p>';
    conflictDialog.querySelector('[data-conflict-count]').textContent = hunks.length + (hunks.length === 1 ? ' conflict block' : ' conflict blocks');
    for (const node of body.querySelectorAll('[data-hunk]')) node.onclick = () => {
      const hunk = conflictHunks(editor.value)[Number(node.dataset.hunk)]; if (!hunk) return;
      const replacement = node.dataset.choice === 'both' ? hunk.ours + hunk.theirs : hunk[node.dataset.choice];
      editor.value = editor.value.slice(0, hunk.from) + replacement + editor.value.slice(hunk.to);
      conflictChoice = 'manual'; conflictDialog.querySelector('[data-conflict-error]').textContent = ''; renderConflictHunks(); editor.focus(); editor.setSelectionRange(hunk.from, hunk.from + replacement.length);
    };
  }
  function renderConflictDialog() {
    const version = (side, label) => `<section><h3>${label}</h3><pre>${esc(side.deleted ? '(deleted)' : side.binary ? '(binary content)' : side.text) || '(empty file)'}</pre></section>`;
    conflictChoice = 'manual';
    conflictDialog.innerHTML = `<div class="git-diff-heading"><div><p class="eyebrow">RESOLVE MERGE CONFLICT</p><h2 id="git-conflict-title">${esc(conflict.path)}</h2></div><button type="button" data-conflict-close aria-label="Close conflict resolver">×</button></div>${conflict.unsupported ? `<div class="git-conflict-content"><p>${esc(conflict.reason)}</p></div>` : `<div class="git-diff-toolbar"><button data-conflict-choice="ours">${conflict.ours.deleted ? 'Accept current deletion' : 'Use entire current file'}</button><button data-conflict-choice="theirs">${conflict.theirs.deleted ? 'Accept incoming deletion' : 'Use entire incoming file'}</button><span class="spacer"></span><span data-conflict-count></span></div><div class="git-conflict-content"><p class="hint">Current is Git’s “ours”; incoming is “theirs”. During a rebase these describe the rebased branch and replayed commit. Whole-file choices replace the complete result.</p><div class="git-notice git-error" data-conflict-error role="alert"></div>${conflict.binary || conflict.ours.deleted || conflict.theirs.deleted ? `<div class="git-conflict-versions">${version(conflict.ours, 'Current · ours')}${version(conflict.theirs, 'Incoming · theirs')}</div>` : ''}${conflict.binary ? '<p class="hint">Binary content is preserved exactly. Choose which complete version to keep.</p>' : `<div class="git-conflict-hunks"></div><label class="git-conflict-result-label" for="git-conflict-result">Result · edit freely</label><textarea id="git-conflict-result" spellcheck="false" aria-label="Conflict resolution result"></textarea>`}<p class="hint" data-conflict-selection></p></div><div class="git-diff-footer"><span>Save a draft to continue later, or stage the reviewed resolution.</span><div><button data-conflict-save="draft">Save draft</button><button data-conflict-save="stage">Save &amp; stage</button></div></div>`}`;
    conflictDialog.querySelector('[data-conflict-close]').onclick = () => conflictDialog.close();
    if (conflict.unsupported) return;
    const editor = conflictDialog.querySelector('#git-conflict-result');
    if (editor) {editor.value = conflict.text; editor.oninput = () => {conflictChoice = 'manual'; editor.disabled = false; conflictDialog.querySelector('[data-conflict-selection]').textContent = ''; conflictDialog.querySelector('[data-conflict-error]').textContent = ''; renderConflictHunks();}; renderConflictHunks();}
    for (const node of conflictDialog.querySelectorAll('[data-conflict-choice]')) node.onclick = () => {
      const side = conflict[node.dataset.conflictChoice]; conflictChoice = node.dataset.conflictChoice;
      if (editor) {editor.value = side.text; editor.disabled = side.deleted; renderConflictHunks();}
      conflictDialog.querySelector('[data-conflict-selection]').textContent = side.deleted ? 'The selected version deletes this file.' : 'The complete ' + (conflictChoice === 'ours' ? 'current' : 'incoming') + ' version is selected. Review before saving.';
      conflictDialog.querySelector('[data-conflict-error]').textContent = '';
    };
    for (const node of conflictDialog.querySelectorAll('[data-conflict-save]')) node.onclick = async () => {
      if (busy) return;
      const serial = generation, error = conflictDialog.querySelector('[data-conflict-error]');
      if (conflict.binary && conflictChoice === 'manual') {error.textContent = 'Choose the current or incoming version first.'; return;}
      const args = {action: 'resolveConflict', path: conflict.path, revision: conflict.revision, choice: conflictChoice, text: editor?.value, stage: node.dataset.conflictSave === 'stage'};
      lock(true); for (const control of conflictDialog.querySelectorAll('button,textarea')) control.disabled = true;
      try {
        await beforeAction('resolveConflict'); if (serial !== generation) return;
        const result = await client.call('gitAction', args); if (serial !== generation) return;
        conflictDialog.close(); state = result.status; historyLoaded = false; render(); announce(result.message); await afterMutation('resolveConflict');
      } catch (failure) {if (serial === generation) error.textContent = failure.message;}
      finally {lock(false); for (const control of conflictDialog.querySelectorAll('button,textarea')) control.disabled = false; if (editor && ['ours', 'theirs'].includes(conflictChoice) && conflict[conflictChoice].deleted) editor.disabled = true;}
    };
  }
  async function openConflict(file) {
    if (busy) return; const serial = generation;
    try {await beforeAction('diff'); const result = await client.call('gitDiff', {path: file, conflict: true}); if (serial !== generation) return; conflict = result; renderConflictDialog(); conflictDialog.showModal(); conflictDialog.querySelector('[data-conflict-close]').focus();}
    catch (error) {announce(error.message, true);}
  }
  async function loadHistory() {
    if (historyLoaded || !state?.repository) return;
    const serial = generation;
    try {const history = await client.call('gitHistory'); if (serial !== generation) return; historyLoaded = true; find('git-history-list').innerHTML = history.map(item => `<button type="button" class="git-history-item" data-commit="${esc(item.id)}"><strong>${esc(item.subject)}</strong><small>${esc(item.short)} · ${esc(item.author)} · ${esc(new Date(item.date).toLocaleDateString())}</small>${item.refs ? `<small class="git-history-refs">${esc(item.refs)}</small>` : ''}</button>`).join('') || '<p class="hint">Your first commit will appear here.</p>';}
    catch (error) {announce(error.message, true);}
  }
  container.addEventListener('click', async event => {
    const target = event.target.closest('button'), serial = generation; if (!target || target.disabled) return;
    if (target.dataset.pullId) {
      try {const result=await client.call('gitDiff',{path:target.dataset.pullPath,pullId:target.dataset.pullId});if(serial!==generation)return;diff=result;split=true;renderDiffDialog();dialog.showModal();}
      catch(error){announce(error.message,true);} return;
    }
    if (target.hasAttribute('data-git-diff')) {const row = target.closest('.git-file'); return openDiff(row.dataset.path, row.dataset.staged === 'true');}
    if (target.hasAttribute('data-git-conflict')) return openConflict(target.closest('.git-file').dataset.path);
    if (target.dataset.commit) {try {const result = await client.call('gitCommitDiff', {id: target.dataset.commit}); if (serial !== generation) return; diff = {...result, commit: true}; split = true; renderDiffDialog(); dialog.showModal();} catch (error) {announce(error.message, true);} return;}
    const name = target.dataset.gitAction; if (!name) return;
    if (name === 'commit' || name === 'sync') {await action(name,{message:commitMessage()});return;}
    if (name === 'refresh') {await refresh(); historyLoaded = false; if (find('git-history').open) await loadHistory(); return;}
    if (name === 'newBranch') {const branch = await ask('Create branch', 'Create and switch to a new branch at the current commit.', {input: '', confirm: 'Create branch'}); if (branch && serial === generation) await action('createBranch', {branch}); return;}
    if (name === 'discard') {
      const row=target.closest('.git-file'), file=row.dataset.path, untracked=row.dataset.untracked==='true';
      if (await ask(untracked ? 'Delete untracked file?' : 'Discard changes?', untracked ? 'Permanently delete '+file+' from this workspace? Git has no staged version to restore. Its current contents will be lost.' : 'Restore ' + file + ' to its staged version. Unstaged edits will be lost.', {confirm: untracked ? 'Delete file' : 'Discard changes'})) {
        if (serial === generation) await action(name,{path:file,confirmed:true,untracked});
      } return;
    }
    if (name === 'editIgnore') return editIgnore();
    if (name === 'init' && !await ask(ui('Initialise repository?'), 'Create Git history for this workspace. Stage and commit selected files to record your first version.', {confirm: ui('Initialise')})) return;
    if (serial !== generation) return;
    await action(name, {path: target.closest('.git-file')?.dataset.path, ref: target.dataset.ref});
  });
  find('git-branches').onchange = () => action('switch', {branch: find('git-branches').value});
  find('git-remotes').onchange = () => action('configureRemotes', {remote: find('git-remotes').value, pushRemotes});
  find('git-push-remotes').onchange = () => action('configureRemotes', {pushRemotes: [...container.querySelectorAll('[data-push-remote]:checked')].map(input => input.dataset.pushRemote)});
  find('git-add-remote-form').onsubmit = event => {event.preventDefault(); action('addRemote', {name: find('git-remote-name').value.trim(), url: find('git-remote-url').value.trim()});};
  find('git-commit-form').onsubmit = event => {event.preventDefault(); if (!find('git-commit').disabled) action('commit', {message: commitMessage()});};
  find('git-commit-message').onkeydown = event => {if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {event.preventDefault(); if (!find('git-commit').disabled) action('commit', {message: commitMessage()});}};
  find('git-history').ontoggle = () => {if (find('git-history').open) loadHistory();};
  dialog.addEventListener('click', event => {if (event.target === dialog) {const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();}});
  const timer = setInterval(() => {if (!document.hidden) {if (!busy) timestampMessage(); refresh({quiet: true});}}, 6000);
  render();
  return {refresh, reset() {generation++; state = null; historyLoaded = false; selectedRemote = ''; pushRemotes = []; timestampMessage(true); find('git-remote-name').value = ''; find('git-remote-url').value = ''; find('git-history-list').innerHTML = ''; announce(''); dialog.close(); conflictDialog.close(); ignoreDialog.close();fileMenu.hidden=true;render();}, destroy() {clearInterval(timer); dialog.remove(); conflictDialog.remove();ignoreDialog.remove();fileMenu.remove();document.removeEventListener('click',closeMenu);document.removeEventListener('keydown',closeMenu);}};
}
