import {capabilities, desktopCapabilities, assertCapability, encodeResourceArgs, resource} from './platform.mjs';

/** Native transport adapter. The reader never imports Tauri or assumes that a
 * native host has sidecars. Feature negotiation precedes optional operations. */
export async function createNativeClient({invoke, listen, Channel}) {
  let scope = 0, workspace = null;
  const health = await invoke('weave_request', {op: 'health', args: {}});
  // Compatibility for the existing desktop IPC harness/older native host.
  const features = capabilities(health.capabilities || {...desktopCapabilities, resources: false});
  function adopt(result) {
    if (result?.scope != null) scope = result.scope;
    if (result?.workspace) workspace = result.workspace;
    return result;
  }
  const client = {
    capabilities: features, writable: features.write,
    get workspace() {return workspace;},
    async choose() {return adopt(await invoke('choose_workspace'));},
    // A new, empty workspace folder: the desktop asks where to put it; the server creates it in its workspace directory.
    async createWorkspace(name) {return adopt(await invoke('create_workspace', {name}));},
    chooseDirectory() {if (!features.storage) throw new Error('This host does not provide storage locations.'); return invoke('choose_storage_directory');},
    async call(op, args = {}) {
      assertCapability(features, op);
      const requestedScope = scope;
      const request = features.resources && workspace ? encodeResourceArgs(op, args, workspace.id) : {...args};
      if (op === 'graph' && features.graphStream && Channel) request.summaryOnly = true;
      const result = await invoke('weave_request', {op, args: {scope: requestedScope, ...request}});
      if (!['restore', 'configureMonitoring', 'configureStorage'].includes(op) && scope !== requestedScope) throw new Error('The workspace changed while this request was running.');
      return adopt(result);
    },
    // Explicit file and directory references for consumers which do not use
    // Markdown identities. '/' is a directory, never a filesystem root grant.
    file(path) {return resource(workspace?.id, path, 'file');},
    directory(path = '/') {return resource(workspace?.id, path, 'directory');},
    dirty(value) {if (features.write) return invoke('editor_state', {dirty: value});},
    windowAction(action) {if (!features.nativeWindow) throw new Error('Window controls are unavailable on this host.'); return invoke('window_action', {action});},
    openResource(url) {return invoke('open_resource', {url});},
    // Portable export: the native save dialog chooses the destination.
    exportWorkspace(scope, {name, graph = true, otherFiles = true, folder = null, diagrams = true} = {}) {if (!features.export) throw new Error('This host cannot export workspaces.'); return invoke('export_workspace', {scope, name, graph, otherFiles, folder, diagrams});},
    revealExport() {return invoke('reveal_export');},
    // True when the host pushes change events, so the reader polls only as a fallback.
    events: !!listen,
    async onChanged(callback) {return listen ? listen('weave-changed', event => callback(event.payload)) : () => {};},
    // Individual Markdown files outside the workspace. The native host only
    // reads or writes files the user chose in its picker or dropped on the window.
    chooseMarkdownFile(directory = null) {return invoke('choose_markdown_file', {directory});},
    readExternal(path) {return invoke('read_external', {path});},
    saveExternal(path, text, hash) {return invoke('save_external', {path, text, hash});},
    async onOpenExternal(callback) {return listen ? listen('weave-open-external', event => callback(event.payload)) : () => {};},
  };
  if (health.serverControl === true) client.serverControl = (action, settings) => invoke('server_control', {action, settings: settings ?? null});
  if (features.graphStream && Channel) client.graphNeighborhood = async (query, onChunk) => {
    const channel = new Channel(); channel.onmessage = onChunk;
    return invoke('weave_graph_neighborhood', {args: {...query, scope}, onChunk: channel});
  };
  // A view bound to one open workspace. Several workspaces can be open at once;
  // each request names its workspace's scope, so a closed workspace's requests fail.
  client.bind = catalog => {
    const bound = catalog.scope, id = catalog.workspace?.id;
    const view = {
      capabilities: features, writable: features.write, scope: bound, workspaceId: id,
      call(op, args = {}) {
        assertCapability(features, op);
        const request = features.resources && id ? encodeResourceArgs(op, args, id) : {...args};
        if (op === 'graph' && features.graphStream && Channel) request.summaryOnly = true;
        return invoke('weave_request', {op, args: {...request, scope: bound}});
      },
      file(path) {return resource(id, path, 'file');},
      directory(path = '/') {return resource(id, path, 'directory');},
    };
    if (client.graphNeighborhood) view.graphNeighborhood = async (query, onChunk) => {
      const channel = new Channel(); channel.onmessage = onChunk;
      return invoke('weave_graph_neighborhood', {args: {...query, scope: bound}, onChunk: channel});
    };
    return view;
  };
  return client;
}
