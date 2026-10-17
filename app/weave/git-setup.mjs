import {esc} from './render.mjs';

/** Remote addresses people paste: GitHub page URLs, HTTPS clone URLs, SSH
 * URLs or `owner/repository`. Deploy keys authenticate over SSH, so HTTPS
 * addresses become their SSH form. Returns null for anything unrecognised. */
export function sshRemote(input) {
  const text = String(input || '').trim().replace(/\/+$/, '');
  if (!text) return null;
  const short = text.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (short) return {url: `git@github.com:${short[1]}/${short[2]}.git`, host: 'github.com', path: `${short[1]}/${short[2]}`};
  const scp = text.match(/^([\w.-]+)@([\w.-]+):([\w./-]+?)(?:\.git)?$/);
  if (scp) return {url: `${scp[1]}@${scp[2]}:${scp[3]}.git`, host: scp[2].toLowerCase(), path: scp[3]};
  let url; try {url = new URL(text);} catch {return null;}
  if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || !url.hostname || url.password || url.search || url.hash) return null;
  const path = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/(?:tree|blob)\/.*$/, '');
  if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(path)) return null;
  const host = url.hostname.toLowerCase();
  if (url.protocol === 'ssh:') return {url: text.endsWith('.git') ? text : text + '.git', host, path};
  return {url: `git@${host}:${path}.git`, host, path};
}
/** The repository page for GitHub/GitLab remotes, for the deploy-key link. */
export function deployKeyPage(remote) {
  if (!remote) return null;
  if (remote.host === 'github.com') return {url: `https://github.com/${remote.path}/settings/keys/new`, site: 'GitHub'};
  if (remote.host === 'gitlab.com') return {url: `https://gitlab.com/${remote.path}/-/settings/repository#js-deploy-keys-settings`, site: 'GitLab'};
  return null;
}
const isSsh = url => /^ssh:\/\//.test(url || '') || /^[\w.-]+@[\w.-]+:/.test(url || '');

/** A guided dialog that sets up Git for one workspace: repository, commit
 * author, remote, deploy key, connection test and the first sync. Each step
 * shows whether it is done, so the guide can be reopened at any point. */
export function openGitSetup({git, name, server, openResource, showSourceControl, ask}) {
  const dialog = document.createElement('dialog'); dialog.className = 'git-setup-dialog'; dialog.setAttribute('aria-labelledby', 'git-setup-title');
  document.body.append(dialog);
  let tested = null, busy = false, notice = '', failed = false, skipKey = false, remoteDraft = '', lastAt = null;
  const expanded = new Set();
  const status = () => git.status || {};
  const origin = () => {const s = status(); return s.remotes?.find(r => r.name === (s.syncRemote || 'origin')) || s.remotes?.find(r => r.name === 'origin') || s.remotes?.[0] || null;};
  // Finished steps fold to a one-line summary (Change reopens them), so the current step stays in view.
  const step = (index, title, done, current, body, summary = '') => {
    const open = current || done && expanded.has(index);
    return `<section class="git-setup-step${done ? ' done' : ''}${current ? ' current' : ''}" aria-current="${current ? 'step' : 'false'}"><h3><span class="git-setup-index" aria-hidden="true">${done ? '✓' : index}</span>${esc(title)}${done ? '<span class="git-visually-hidden"> (done)</span>' : ''}</h3>${done && !open ? `<p class="git-setup-summary"><span>${esc(summary)}</span> <button type="button" class="git-setup-link" data-expand="${index}">Change</button></p>` : ''}${open ? `<div class="git-setup-body">${body}</div>` : ''}</section>`;
  };
  function render() {
    const s = status(), remote = origin(), parsed = remote ? sshRemote(remote.fetch || '') : null, page = deployKeyPage(parsed);
    const repo = !!s.repository, identity = !!(s.identity?.name && s.identity?.email), key = s.deployKey, sshUrl = remote && isSsh(remote.fetch);
    const keyNeeded = server || !skipKey && !(remote && !sshUrl);
    const synced = !!s.upstream, connected = !!tested?.connected || synced;
    const steps = [repo, identity, !!remote && (sshUrl || !server), !keyNeeded || !!key && connected, synced];
    const at = steps.findIndex(done => !done);
    const parts = [];
    parts.push(step(1, 'Create a Git repository', repo, at === 0, s.parentRepository
      ? `<p class="git-error">This folder is inside another Git repository (${esc(s.parentRepository)}). Open that repository's folder as the workspace instead.</p>`
      : repo ? `<p>History is kept in this workspace's <code>.git</code> folder.</p>` : `<p>Git records versions of your articles so you can review, undo and share changes. This creates an empty history in <strong>${esc(name)}</strong>; your files are not changed.</p><button type="button" class="primary" data-setup="init">Create repository</button>`, "History is kept in this workspace's .git folder."));
    parts.push(step(2, 'Name your commits', identity, at === 1, `<p>Each saved version (commit) records who made it. This is shown on GitHub next to your changes and stays with this repository.</p>
      <form data-setup-form="identity" class="git-setup-form"><label>Name<input name="name" maxlength="200" autocomplete="name" required value="${esc(s.identity?.name || '')}"></label><label>Email<input name="email" type="email" maxlength="200" autocomplete="email" required value="${esc(s.identity?.email || '')}"></label><p class="hint">GitHub can keep your address private: use the <code>…@users.noreply.github.com</code> address from GitHub › Settings › Emails.</p><button type="submit" class="primary">${identity ? 'Update author' : 'Save author'}</button></form>`, `${s.identity?.name || ''} · ${s.identity?.email || ''}`));
    const remoteBody = remote && !sshUrl && server
      ? `<p>The remote <strong>${esc(remote.name)}</strong> uses <code>${esc(remote.fetch)}</code>. Deploy keys work over SSH, so this server needs the SSH address.</p>${sshRemote(remote.fetch) ? `<button type="button" class="primary" data-setup="ssh">Switch to <code>${esc(sshRemote(remote.fetch).url)}</code></button>` : ''}`
      : remote ? `<p>Connected to <strong>${esc(remote.name)}</strong>: <code>${esc(remote.fetch)}</code></p><details><summary>Use a different repository</summary>${remoteForm(remote.fetch)}</details>`
      : `<ol class="git-setup-list"><li>On <a href="#" data-open="https://github.com/new">GitHub, create a new repository</a> (or choose an existing one). For a new repository leave the README, .gitignore and licence options off, so it starts empty.</li><li>Copy its address from the repository page, for example <code>https://github.com/you/notes</code>, and paste it here.</li></ol>${remoteForm('')}`;
    parts.push(step(3, 'Choose the GitHub repository', steps[2], at === 2, remoteBody, remote ? `${remote.name}: ${remote.fetch}` : ''));
    const title = `Weave – ${name}`;
    const keyBody = !keyNeeded ? `<p>Pushing uses your own Git credentials on this computer.</p>${remote && sshUrl ? '<button type="button" data-setup="use-key">Use a deploy key instead</button>' : ''}`
      : !key ? `<p>A <strong>deploy key</strong> lets ${server ? 'this server' : 'Weave'} push to this one repository and nothing else. Weave creates the key and keeps its private half in its own data folder; you only copy the public half to GitHub.</p><button type="button" class="primary" data-setup="key">Create deploy key</button>${!server ? ' <button type="button" data-setup="skip-key">Use my own Git credentials</button>' : ''}`
      : `<ol class="git-setup-list">
        <li>${page ? `<button type="button" data-open="${esc(page.url)}">Open ${esc(page.site)} deploy keys ↗</button>` : 'On your Git host, open the repository\'s <strong>Settings › Deploy keys</strong>.'}${page?.site === 'GitHub' ? ' (repository › <strong>Settings</strong> › <strong>Deploy keys</strong> › <strong>Add deploy key</strong>). You need to be the repository\'s owner or an admin.' : ''}</li>
        <li>Title: <code>${esc(title)}</code> <button type="button" class="git-setup-copy" data-copy-text="${esc(title)}">Copy</button></li>
        <li>Key: paste this public key.<textarea class="git-setup-key" readonly rows="3" spellcheck="false" aria-label="Public deploy key">${esc(key.publicKey)}</textarea><button type="button" class="primary git-setup-copy" data-copy-key>Copy public key</button>${key.fingerprint ? `<small class="git-setup-fingerprint">Fingerprint ${esc(key.fingerprint)}</small>` : ''}</li>
        <li>Tick <strong>Allow write access</strong>, so Weave can push your changes.</li>
        <li>Select <strong>Add key</strong>, then test the connection.</li></ol>
        ${connected ? `<p>✓ ${server ? 'The server' : 'Weave'} can reach the repository with this key.</p>` : '<button type="button" class="primary" data-setup="test">Test connection</button>'}
        <p class="hint">GitHub accepts a deploy key in one repository only; each workspace has its own. <button type="button" class="git-setup-link" data-setup="replace-key">Create a new key</button> · <button type="button" class="git-setup-link" data-setup="remove-key">Remove key</button></p>`;
    parts.push(step(4, 'Give Weave access with a deploy key', steps[3], at === 3, keyBody, key ? `Deploy key ${key.fingerprint || ''} added and working` : 'Uses your own Git credentials'));
    const unborn = s.unborn, branch = tested?.defaultBranch;
    const syncBody = synced ? `<p>This workspace follows <code>${esc(s.upstream)}</code>. Use <strong>Commit all &amp; sync</strong> in Source control to save and share changes.</p>`
      : !tested?.connected ? `<p>Check that Weave can reach the repository, then send or receive the first version.</p><button type="button" class="primary" data-setup="test">Test connection</button>`
      : `${(unborn && branch ? `<p>The remote already has articles on <code>${esc(branch)}</code>. Download them into this workspace; files here that the remote lacks are kept.</p><button type="button" class="primary" data-setup="download" data-branch="${esc(branch)}">Download from ${esc(remote?.name || 'origin')}</button>`
          : unborn && !s.files?.length ? '<p>This workspace is empty, so there is nothing to upload yet. Close this guide, add an article with <strong>New article</strong>, then reopen <strong>Set up Git</strong> to upload it.</p>'
          : `<p>${tested.remoteBranches?.length ? 'Combine this workspace with the remote and upload its changes.' : 'The remote is empty. Upload this workspace as its first version.'}</p><button type="button" class="primary" data-setup="sync">${tested.remoteBranches?.length ? 'Sync now' : 'Upload and sync'}</button>`)}`;
    parts.push(step(5, 'Connect and sync', synced, at === 4, syncBody, `Following ${s.upstream || ''}. Use Commit all & sync in Source control.`));
    dialog.innerHTML = `<div class="git-setup-heading"><div><p class="eyebrow">SOURCE CONTROL</p><h2 id="git-setup-title">Set up Git for ${esc(name)}</h2></div><button type="button" data-setup-close aria-label="Close Git setup" title="Close (Esc)">×</button></div>
      <div class="git-setup-steps">${parts.join('')}</div>
      <p class="git-setup-notice${failed ? ' git-error' : ''}" role="status" aria-live="polite">${esc(notice)}</p>
      <div class="dialog-actions">${at < 0 ? '<button type="button" data-setup="source">Open Source control</button>' : ''}<button type="button" data-setup-close${at < 0 ? ' class="primary"' : ''}>${at < 0 ? 'Done' : 'Close'}</button></div>`;
    for (const node of dialog.querySelectorAll('button,input')) if (busy && !node.matches('[data-setup-close]')) node.disabled = true;
    const field = dialog.querySelector('[data-setup-form="remote"] input'); if (field && remoteDraft) field.value = remoteDraft;
    if (at !== lastAt) {lastAt = at; dialog.querySelector('.git-setup-step.current')?.scrollIntoView({block: 'nearest'});}
  }
  const remoteForm = value => `<form data-setup-form="remote" class="git-setup-form"><label>Repository address<input name="remote" maxlength="2000" required autocomplete="off" spellcheck="false" placeholder="https://github.com/you/notes" value="${esc(value)}"></label><p class="hint">An HTTPS page address, an SSH address (<code>git@github.com:you/notes.git</code>) or just <code>you/notes</code>.</p><button type="submit" class="primary">Connect repository</button></form>`;
  async function act(work, message) {
    if (busy) return; busy = true; failed = false; notice = 'Working…'; render();
    try {const result = await work(); notice = message || result?.message || 'Done.';}
    catch (error) {failed = true; notice = String(error?.message || error);}
    finally {busy = false; render();}
  }
  async function copy(text, label) {
    let copied = false;
    // The Clipboard API exists only in secure contexts; plain-HTTP LAN pages fall back.
    if (window.isSecureContext && navigator.clipboard?.writeText) {try {await navigator.clipboard.writeText(text); copied = true;} catch {}}
    if (!copied) {
      const area = document.createElement('textarea'); area.value = text; area.className = 'git-visually-hidden'; dialog.append(area); area.select();
      try {copied = document.execCommand('copy');} catch {} area.remove();
    }
    failed = !copied; notice = copied ? label + ' copied.' : 'Select the text and copy it.'; render();
    if (!copied) dialog.querySelector('.git-setup-key')?.select();
  }
  dialog.addEventListener('input', event => {if (event.target.name === 'remote') remoteDraft = event.target.value;});
  dialog.addEventListener('submit', event => {
    event.preventDefault(); const form = event.target, data = new FormData(form);
    if (form.dataset.setupForm === 'identity') void act(() => git.perform('configureIdentity', {name: data.get('name'), email: data.get('email')}));
    if (form.dataset.setupForm === 'remote') {
      const typed = String(data.get('remote') || ''), parsed = sshRemote(typed);
      if (!parsed) {failed = true; notice = 'Enter a repository address such as https://github.com/you/notes.'; render(); return;}
      // Desktop users with their own credentials may keep an HTTPS address.
      const url = !server && skipKey && /^https:\/\//i.test(typed.trim()) ? typed.trim() : parsed.url;
      tested = null;
      void act(async () => {const result = await git.perform('addRemote', {name: origin()?.name || 'origin', url, replace: true}); remoteDraft = ''; return result;});
    }
  });
  dialog.addEventListener('click', event => {
    const target = event.target.closest('button,a'); if (!target) return;
    if (target.matches('[data-open]')) {event.preventDefault(); void Promise.resolve(openResource(target.dataset.open)).catch(error => {failed = true; notice = error?.message || String(error); render();}); return;}
    if (target.matches('[data-setup-close]')) {dialog.close(); return;}
    if (target.matches('[data-copy-key]')) return void copy(status().deployKey?.publicKey || '', 'Public key');
    if (target.matches('[data-copy-text]')) return void copy(target.dataset.copyText, 'Title');
    if (target.matches('[data-expand]')) {expanded.add(Number(target.dataset.expand)); render(); return;}
    const action = target.dataset.setup; if (!action) return;
    const remote = origin();
    if (action === 'init') void act(() => git.perform('init'));
    if (action === 'ssh') void act(() => git.perform('addRemote', {name: remote.name, url: sshRemote(remote.fetch).url, replace: true}));
    if (action === 'key') void act(() => git.perform('createDeployKey'));
    if (action === 'replace-key') void ask('Create a new deploy key?', 'The current key stops working here. Add the new key to the repository on GitHub and delete the old one there.', 'Create new key').then(ok => {if (ok) {tested = null; void act(() => git.perform('createDeployKey', {replace: true}));}});
    if (action === 'remove-key') void ask('Remove deploy key?', "Weave can no longer push with it. Also delete it from the repository's deploy keys on GitHub.", 'Remove key').then(ok => {if (ok) {tested = null; void act(() => git.perform('removeDeployKey', {confirmed: true}));}});
    if (action === 'skip-key') {skipKey = true; render();}
    if (action === 'use-key') {skipKey = false; render();}
    if (action === 'test') void act(async () => {tested = null; const result = await git.perform('testRemote', {remote: remote.name}); tested = result; return result;});
    if (action === 'download') void act(() => git.perform('useRemoteBranch', {remote: remote.name, branch: target.dataset.branch}));
    if (action === 'sync') void act(async () => {
      const s = status();
      return git.perform('sync', {remote: remote.name, pushRemotes: s.pushRemotes?.length ? s.pushRemotes : [remote.name], message: s.unborn ? 'First version from Weave' : new Date().toISOString()});
    });
    if (action === 'source') {dialog.close(); showSourceControl();}
  });
  dialog.addEventListener('close', () => dialog.remove());
  render(); dialog.showModal();
  return dialog;
}
