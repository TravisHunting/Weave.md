// Development preview cache registry. Desktop uses the Rust unified database.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const collectionId = (identity, {opaque = false} = {}) => 'kb-' + createHash('sha256').update(!opaque && process.platform === 'win32' ? identity.toLowerCase() : identity).digest('hex').slice(0, 20);
export async function readStorage(runtime) {
  let saved = {};
  try { saved = JSON.parse(await fs.readFile(path.join(runtime, 'storage.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return {weaveDirectory: path.join(runtime, 'graphs'), collections: [], ...saved};
}
export async function writeStorage(runtime, config) {
  await fs.mkdir(runtime, {recursive: true});
  const file = path.join(runtime, 'storage.json'), temp = file + '.tmp';
  await fs.writeFile(temp, JSON.stringify(config, null, 2)); await fs.rename(temp, file);
}
export async function registerWorkspace(runtime, root, {identity = root, opaqueIdentity = false} = {}) {
  const config = await readStorage(runtime), id = collectionId(identity, {opaque: opaqueIdentity});
  if (!config.collections.some(c => c.id === id)) {config.collections.push({id, root, name: path.basename(root), ...(opaqueIdentity ? {sourceKind:'logical'} : {})}); await writeStorage(runtime, config);}
await fs.mkdir(config.weaveDirectory, {recursive: true});
  return config;
}
