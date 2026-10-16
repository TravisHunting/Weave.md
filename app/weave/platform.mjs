/** Host features are independent: a writable workspace does not imply FTS,
 * a Git executable, physical directory pickers, or desktop window controls. */
export const readerCapabilities = Object.freeze({write: false, fts: false, git: false, storage: false, session: false, nativeWindow: false, graphStream: false, resources: false, workspaces: false, export: false, catalogChanges: false});
export const desktopCapabilities = Object.freeze({...readerCapabilities, write: true, fts: true, git: true, storage: true, session: true, nativeWindow: true, resources: true});

export function capabilities(value = {}) {
  return Object.freeze(Object.fromEntries(Object.keys(readerCapabilities).map(key => [key, value?.[key] === true])));
}

const required = {
  save: 'write', kanbanSave: 'write', create: 'write', renamePreview: 'write', rename: 'write', delete: 'write',
  gitStatus: 'git', gitDiff: 'git', gitHistory: 'git', gitCommitDiff: 'git', gitAction: 'git', gitIgnore: 'git', revealPath: 'nativeWindow',
  configureMonitoring: 'storage', controlPanel: 'storage', configureStorage: 'storage', configureDeletion: 'storage',
  workspaceSession: 'session', restore: 'session', catalogChanges: 'catalogChanges', catalogPage: 'catalogChanges',
  close: 'workspaces', reopen: 'workspaces', configureWorkspace: 'workspaces', workspaceLayout: 'workspaces',
};
export function assertCapability(features, operation) {
  const feature = required[operation];
  if (feature && !features[feature]) throw new Error(`This host does not provide ${feature}.`);
}

/** Logical paths are absolute within a granted workspace, never OS paths or
 * paths relative to a process working directory. Article wiki targets remain
 * workspace-relative Markdown strings; convert only at the service boundary. */
export function logicalPath(value, kind = 'file') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\\') || value.length > 2049) throw new Error('Use an absolute logical workspace path.');
  if (value === '/' && kind === 'directory') return value;
  const parts = value.slice(1).split('/');
  if (parts.length > 64 || parts.some(part => !part || part === '.' || part === '..' || /[\x00-\x1f:]/.test(part))) throw new Error('Invalid logical workspace path.');
  return value;
}
export function resource(workspaceId, path, kind = 'file') {
  if (typeof workspaceId !== 'string' || !workspaceId || !['file', 'directory', 'entry'].includes(kind)) throw new Error('A workspace and resource kind are required.');
  return Object.freeze({workspaceId, kind, logicalPath: logicalPath(path, kind)});
}
export function articleResource(workspaceId, path, kind = 'file') {
  return resource(workspaceId, '/' + path, kind);
}
export function resourcePath(value, workspaceId, expectedKind) {
  if (!value || value.workspaceId !== workspaceId) throw new Error('The resource belongs to a different workspace.');
  if (!['file', 'directory', 'entry'].includes(value.kind) || expectedKind && value.kind !== expectedKind) throw new Error('Wrong workspace resource kind.');
  return logicalPath(value.logicalPath, value.kind).slice(1);
}

// The adapter alone translates the reader's article identities to storage
// resources. A future document-provider adapter can map these to opaque handles.
export function encodeResourceArgs(op, args, workspaceId) {
  const result = {...args};
  if (['getDocument', 'kanbanBoard', 'save', 'create', 'delete', 'getOutgoingRelationships', 'getIncomingRelationships', 'getNeighbors'].includes(op) && typeof result.path === 'string') {
    result.resource = articleResource(workspaceId, result.path, op === 'create' && args.folder ? 'directory' : op === 'delete' ? 'entry' : 'file');
    delete result.path;
  }
  if (result.resource) resourcePath(result.resource, workspaceId, op === 'create' ? (args.folder ? 'directory' : 'file') : ['getDocument', 'kanbanBoard', 'save', 'getOutgoingRelationships', 'getIncomingRelationships', 'getNeighbors'].includes(op) ? 'file' : undefined);
  // Each article a Kanban move saves is named by its resource.
  if (op === 'kanbanSave' && Array.isArray(result.writes)) result.writes = result.writes.map(({path, ...write}) => ({...write, resource: articleResource(workspaceId, path)}));
  if (op === 'renamePreview') {
    if (typeof result.from === 'string') result.source = articleResource(workspaceId, result.from, 'entry');
    if (typeof result.to === 'string') result.destination = articleResource(workspaceId, result.to, 'entry');
    resourcePath(result.source, workspaceId); resourcePath(result.destination, workspaceId);
    delete result.from; delete result.to;
  }
  return result;
}
export function decodeResourceArgs(op, args, workspaceId) {
  const result = {...args};
  if (result.resource) result.path = resourcePath(result.resource, workspaceId, op === 'create' ? (args.folder ? 'directory' : 'file') : ['getDocument', 'kanbanBoard', 'save', 'getOutgoingRelationships', 'getIncomingRelationships', 'getNeighbors'].includes(op) ? 'file' : undefined);
  if (op === 'renamePreview' && (result.source || result.destination)) {
    result.from = resourcePath(result.source, workspaceId);
    result.to = resourcePath(result.destination, workspaceId);
  }
  return result;
}

/** A random UUID in every browsing context. `crypto.randomUUID` exists only in
 * secure contexts, and Weave Server over plain HTTP on a LAN is not one;
 * `getRandomValues` is available everywhere. */
export function randomId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = bytes[6] & 0x0f | 0x40; bytes[8] = bytes[8] & 0x3f | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
