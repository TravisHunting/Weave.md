import {createNativeClient} from './native-client.mjs';
import {randomId} from './platform.mjs';

/** HTTP transport for the same reader and resource protocol as desktop. A
 * browser tab owns its navigation; only content and workspace metadata are shared. */
export async function createHttpClient({fetch: fetcher = globalThis.fetch.bind(globalThis), storage = sessionStorage, durable = localStorage, choose = chooseServerWorkspace, csrf} = {}) {
  if (csrf === undefined) {
    const response = await fetcher('/auth/status', {credentials: 'same-origin', cache: 'no-store'});
    const authentication = await response.json();
    if (!response.ok || !authentication.authenticated || authentication.mustChange) {window.location.assign('/login'); throw new Error('Sign in to Weave Server.');}
    csrf = authentication.csrf;
  }
  const key = 'weave.server.session.v1';
  let freshTab = !storage.getItem(key);
  let state;
  try {state = JSON.parse(storage.getItem(key) || durable.getItem(key));} catch {}
  if (!state || typeof state !== 'object') state = {};
  state.sessions ||= {}; state.layout ||= {};
  const scopes = new Map(), channel = randomId();
  let instance;
  function persist() {storage.setItem(key, JSON.stringify(state)); durable.setItem(key, JSON.stringify(state));}
  async function post(op, args = {}, endpoint = '/api/request') {
    const response = await fetcher(endpoint, {method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: {'Content-Type': 'application/json', 'X-Weave-Request': '1', 'X-Weave-CSRF': csrf, ...(instance ? {'X-Weave-Instance': instance} : {})}, body: JSON.stringify({op, args})});
    if (!response.ok) {const value = await response.json().catch(() => ({})); throw new Error(value.error || `Weave Server returned ${response.status}.`);}
    if (endpoint === '/api/export') return {blob: await response.blob(), documents: Number(response.headers.get('x-weave-documents')), relationships: Number(response.headers.get('x-weave-relationships')), diagrams: response.headers.get('x-weave-diagrams') === 'true'};
    const result = await response.json();
    if (op === 'health') instance = result.instance;
    return result;
  }
  function adopt(catalog) {
    if (!catalog?.workspace) return catalog;
    const id = catalog.workspace.id; scopes.set(catalog.scope, id);
    catalog.session = state.sessions[id] || {};
    state.open ||= [];
    if (!state.open.includes(id)) state.open.push(id);
    persist();
    return catalog;
  }
  async function call(op, args) {
    if (op === 'workspaceSession') {
      const id = scopes.get(args.scope); if (!id) throw new Error('Unknown workspace session.');
      const {scope, ...session} = args; state.sessions[id] = session; persist(); return session;
    }
    if (op === 'workspaceLayout') {
      const {scope, order, ...layout} = args;
      Object.assign(state.layout, layout);
      if (order) state.open = [...order];
      persist(); return {order: state.open};
    }
    if (op === 'close') {
      state.open = (state.open || []).filter(id => id !== scopes.get(args.scope)); persist();
      // Other tabs may still use this workspace; stop showing it only here.
      return {closed: true};
    }
    if (op === 'restore') {
      const panel = await post('controlPanel'), known = new Set(panel.workspaces.map(w => w.id));
      const defaults = panel.defaultWorkspaces || panel.workspaces.map(w => w.id);
      const selection = JSON.stringify(defaults);
      const reset = panel.managedWorkspaces && (freshTab || state.selection !== selection);
      const wanted = (reset ? defaults : state.open || defaults).filter(id => known.has(id));
      state.selection = selection; freshTab = false;
      const catalogs = [], errors = []; state.open = [];
      for (const id of wanted) {
        try {catalogs.push(adopt(await post('reopen', {id})));}
        catch (error) {errors.push(error.message);}
      }
      persist();
      if (!catalogs.length) return errors.length ? {restoreError: errors.join('\n')} : null;
      const {tree, ...first} = catalogs[0];
      return {...first, workspaces: catalogs, layout: state.layout, restoreErrors: errors};
    }
    if (op === 'controlPanel') {
      const panel = await post(op, args);
      panel.workspaces = panel.workspaces.map(w => ({...w, open: (state.open || []).includes(w.id)}));
      panel.open = state.open || []; return panel;
    }
    if (op === 'searchKnowledge' && args.searchChannel) args = {...args, searchChannel: channel + ':' + args.searchChannel};
    const result = await post(op, args);
    if (op === 'reopen') return adopt(result);
    if (result?.workspace) result.session = state.sessions[result.workspace.id] || {};
    return result;
  }
  // Reuse resource translation, scope binding and capability negotiation. HTTP
  // graph responses contain the same bounded depth chunks as a Tauri Channel.
  class Channel {onmessage() {}}
  const client = await createNativeClient({Channel, invoke: async (command, input = {}) => {
    if (command === 'weave_request') return call(input.op, input.args || {});
    if (command === 'choose_workspace') return adopt(await choose(post));
    if (command === 'weave_graph_neighborhood') {
      const result = await post('graphNeighborhood', input.args);
      for (const chunk of result.chunks) input.onChunk.onmessage(chunk);
      return result.summary;
    }
    if (command === 'editor_state') return;
    if (command === 'open_resource') {
      const url = new URL(input.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) resources without credentials can be opened.');
      window.open(url.href, '_blank', 'noopener,noreferrer'); return;
    }
    throw new Error('This desktop operation is unavailable in a browser.');
  }});
  delete client.chooseDirectory;
  delete client.chooseMarkdownFile; // The existing read-only browser file picker applies.
  delete client.readExternal; delete client.saveExternal;
  client.serverAccount = () => window.open('/account', '_blank', 'noopener,noreferrer');
  client.exportWorkspace = async (scope, {name = 'workspace', ...options} = {}) => {
    const {blob, documents, relationships, diagrams} = await post('export', {scope, ...options}, '/api/export');
    const filename = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, '_') + '.html';
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    return {path: filename, bytes: blob.size, documents, relationships, diagrams};
  };
  return client;
}

async function chooseServerWorkspace(post) {
  const [{folders, managed}, panel] = await Promise.all([post('serverFolders'), post('controlPanel')]);
  const dialog = document.createElement('dialog'); dialog.id = 'server-workspace-picker';
  dialog.setAttribute('aria-labelledby', 'server-workspace-title');
  dialog.innerHTML = `<h2 id="server-workspace-title">Server workspaces</h2><p>${managed ? 'Open a workspace selected by the desktop server controller.' : 'Open a folder on this server, or create a new workspace.'}</p>
    <div class="server-folders"></div><form><label>New workspace folder<input name="name" aria-label="New workspace folder" maxlength="120" required autocomplete="off"></label>
    <p class="hint" role="status"></p><div class="dialog-actions"><button type="button" data-cancel>Cancel</button><button type="submit">Create workspace</button></div></form>`;
  const list = dialog.querySelector('.server-folders'), status = dialog.querySelector('[role=status]');
  document.body.append(dialog);
  return new Promise(resolve => {
    let busy = false;
    const finish = result => {dialog.close(); dialog.remove(); resolve(result);};
    const action = async task => {
      if (busy) return; busy = true;
      const buttons = [...dialog.querySelectorAll('button')].map(button => [button, button.disabled]);
      for (const [button] of buttons) button.disabled = true;
      status.textContent = 'Working…';
      try {await task();} catch (error) {status.textContent = error.message;}
      finally {busy = false; for (const [button, disabled] of buttons) button.disabled = disabled;}
    };
    if (managed) {
      dialog.querySelector('form label').hidden = true;
      dialog.querySelector('[type=submit]').hidden = true;
      for (const workspace of panel.workspaces) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'server-folder-name'; button.textContent = workspace.name;
        button.onclick = () => action(async () => finish(await post('reopen', {id: workspace.id})));
        list.append(button);
      }
      if (!panel.workspaces.length) list.textContent = 'No workspaces have been selected by the controller.';
    }
    const names = managed ? [] : [...new Set([...folders, ...panel.workspaces.map(w => w.root)])].sort();
    for (const folder of names) {
      const row = document.createElement('div'); row.className = 'server-folder';
      const open = document.createElement('button'); open.type = 'button'; open.className = 'server-folder-name'; open.textContent = folder; open.disabled = !folders.includes(folder);
      if (open.disabled) open.title = 'This workspace folder is unavailable on the server.';
      open.onclick = () => action(async () => finish(await post('serverOpen', {name: folder})));
      row.append(open);
      const registered = panel.workspaces.find(w => w.root === folder);
      if (registered) {
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove from server';
        remove.onclick = () => action(async () => {
          if (!window.confirm(`Remove ${registered.name} from this server? Its files and saved settings are kept. Other browser tabs using it will need to reload. You can open its folder again later.`)) {status.textContent = ''; return;}
          await post('serverRemove', {id: registered.id, confirmed: true}); window.location.reload();
        });
        row.append(remove);
      }
      list.append(row);
    }
    if (!managed && !names.length) list.textContent = 'No workspace folders yet.';
    dialog.querySelector('form').onsubmit = event => {event.preventDefault(); void action(async () => finish(await post('serverOpen', {name: dialog.querySelector('input').value.trim(), create: true})));};
    dialog.querySelector('[data-cancel]').onclick = () => finish(null);
    dialog.oncancel = event => {event.preventDefault(); if (!busy) finish(null);};
    dialog.showModal();
  });
}
