export const DEFAULT_MONITORING_SETTINGS = Object.freeze({
  watchChanges: true,
  autoRefresh: true,
  refreshSeconds: 300,
  scanMode: 'metadata',
});

export function monitoringSettings(changes = {}, previous = DEFAULT_MONITORING_SETTINGS) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Monitoring settings must be an object.');
  const result = {...DEFAULT_MONITORING_SETTINGS, ...previous};
  for (const [key, value] of Object.entries(changes)) {
    if (!Object.hasOwn(DEFAULT_MONITORING_SETTINGS, key)) throw new Error('Unknown monitoring setting: ' + key);
    if (typeof DEFAULT_MONITORING_SETTINGS[key] === 'boolean' && typeof value !== 'boolean') throw new Error('Choose whether ' + key + ' is enabled.');
    if (key === 'refreshSeconds' && (!Number.isInteger(value) || value < 10 || value > 86400)) throw new Error('Use a refresh period from 10 to 86400 seconds.');
    if (key === 'scanMode' && !['metadata', 'content'].includes(value)) throw new Error('Choose file details or file contents for change detection.');
    result[key] = value;
  }
  return result;
}
