export function hiddenFolderPaths(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(path => typeof path === 'string' && path && !path.includes('\\') && !path.split('/').some(part => !part || part === '.' || part === '..')))];
}

export function folderIsHidden(path, {hideDotFolders = true, hiddenFolders = []} = {}, caseSensitive = true) {
  if (hideDotFolders && path.split('/').some(part => part.startsWith('.'))) return true;
  const key = value => caseSensitive ? value : value.toLowerCase();
  const target = key(path);
  return hiddenFolders.some(folder => target === key(folder) || target.startsWith(key(folder) + '/'));
}

export function moveHiddenFolders(folders, from, to) {
  return hiddenFolderPaths(folders.map(folder => folder === from || folder.startsWith(from + '/') ? to + folder.slice(from.length) : folder));
}
