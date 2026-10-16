/** Desktop-only controls; never reachable through the HTTP allowlist. */
export function serverSettings(client, $, {choose} = {}) {
  if (!client.serverControl) return {refresh: async () => {}};
  $('server-settings-heading').hidden = $('server-settings').hidden = false;
  let state, busy = false, initial = true, selectionDirty = false, selected = new Set(), listSignature, linkSignature;
  // An error from the last action stays until the next one; polling never hides it.
  let message = '';
  const fields = ['host', 'port', 'origin', 'background'];
  const authFields = ['username', 'password', 'turnstile-enabled', 'turnstile-site', 'turnstile-secret', 'turnstile-hostname'];
  const listen = ['local', 'all'].map(name => $('server-listen-' + name));
  let authFilled = false;
  // Tauri rejects with the host's error string, not an Error.
  const text = error => typeof error === 'string' ? error : error?.message || String(error);
  const loopback = host => /^(127\.|::1$|localhost$)/i.test(host.trim());
  function network() {
    const host = $('server-host').value.trim();
    for (const radio of listen) radio.checked = radio.value === host;
    $('server-network-warning').hidden = !host || loopback(host) || /^https:\/\//i.test($('server-origin').value.trim());
  }
  function passwordError(text = '') {
    const error = $('server-password-error'), input = $('server-password');
    error.textContent = text; error.hidden = !text;
    if (text) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  }
  /** Starting needs a password; point at the field instead of failing quietly. */
  function needsPassword() {
    if (state?.authentication?.configured || $('server-password').value) return false;
    passwordError('Set an administrator password before starting the server.');
    const input = $('server-password');
    input.scrollIntoView({block: 'center', behavior: 'smooth'});
    input.focus({preventScroll: true});
    return true;
  }
  function links(urls) {
    const list = $('server-links'), signature = JSON.stringify(urls);
    list.hidden = !urls.length;
    if (signature === linkSignature) return;
    linkSignature = signature; list.replaceChildren();
    for (const url of urls) {
      const item = document.createElement('li'), link = document.createElement('a');
      link.href = url; link.textContent = url; link.title = 'Open ' + url + ' in your browser';
      link.onclick = event => {event.preventDefault(); client.openResource(url).catch(error => {message = text(error); status();});};
      item.append(link); list.append(item);
    }
  }
  function status() {
    const next = state, configured = next?.authentication?.configured;
    $('server-state').dataset.state = busy ? 'busy' : next?.running ? 'running' : 'stopped';
    $('server-state-title').textContent = next?.running ? 'Server running' : 'Server stopped';
    $('server-status').textContent = message || next?.error || (next && !next.running && !configured ? 'Set an administrator password below to start the server.' : next?.running && next.urls?.length > 1 ? 'Open one of these addresses in a browser.' : '');
    $('server-status').classList.toggle('server-error', !!(message || next?.error));
  }
  function render(next, fill = false) {
    fill ||= !!state && JSON.stringify(state.settings) !== JSON.stringify(next.settings);
    state = next;
    if (next.authentication && (!authFilled || fill)) {
      const auth = next.authentication, turnstile = auth.turnstile;
      $('server-username').value = auth.username;
      $('server-password').value = ''; $('server-password').placeholder = auth.configured ? 'Configured — unchanged' : 'Required before starting';
      $('server-turnstile-enabled').checked = turnstile.enabled;
      $('server-turnstile-site').value = turnstile.siteKey;
      $('server-turnstile-hostname').value = turnstile.hostname;
      $('server-turnstile-secret').value = ''; $('server-turnstile-secret').placeholder = auth.secretConfigured ? 'Configured — unchanged' : 'Secret key';
      authFilled = true;
    }
    if (next.authentication?.configured) passwordError();
    for (const field of authFields) $('server-' + field).disabled = busy;
    $('server-auth-save').disabled = busy;
    $('server-restart').disabled = busy || !next.running;
    if (fill || initial) {
      for (const name of fields) {const input = $('server-' + name); if (name === 'background') input.checked = next.settings[name]; else input.value = next.settings[name];}
      if (!['127.0.0.1', '0.0.0.0'].includes(next.settings.host)) $('server-advanced').open = true;
      selected = new Set(next.settings.workspaces ?? next.workspaceChoices.filter(w => w.open).map(w => w.id));
      selectionDirty = false; initial = false;
    } else if (!selectionDirty && next.settings.workspaces == null) selected = new Set(next.workspaceChoices.filter(w => w.open).map(w => w.id));
    for (const name of fields) $('server-' + name).disabled = busy || next.running || name === 'background' && !next.backgroundAvailable;
    for (const radio of listen) radio.disabled = busy || next.running;
    network();
    const signature = () => JSON.stringify([next.workspaceChoices, [...selected], busy, next.running]);
    const list = $('server-workspaces');
    if (listSignature !== signature()) {
      const focused = list.contains(document.activeElement) ? document.activeElement.value : null;
      list.replaceChildren();
      for (const workspace of next.workspaceChoices) {
        const label = document.createElement('label'), input = document.createElement('input'), dot = document.createElement('span'), info = document.createElement('span');
        label.className = 'server-workspace'; label.classList.toggle('unavailable', !workspace.available);
        input.type = 'checkbox'; input.value = workspace.id; input.checked = selected.has(workspace.id); input.disabled = busy || next.running || !workspace.available;
        dot.className = 'workspace-dot'; if (workspace.color) dot.style.setProperty('--workspace-color', workspace.color);
        info.className = 'server-workspace-info';
        const title = document.createElement('span'), name = document.createElement('strong'), path = document.createElement('small');
        title.className = 'server-workspace-title'; name.textContent = workspace.name; title.append(name);
        for (const [shown, words] of [[workspace.open, 'Active'], [!workspace.available, 'Unavailable']]) if (shown) {const badge = document.createElement('span'); badge.className = 'server-badge'; badge.textContent = words; title.append(badge);}
        path.textContent = workspace.root; path.title = workspace.root;
        info.append(title, path); label.append(input, dot, info); list.append(label);
        input.onchange = () => {selectionDirty = true; if (input.checked) selected.add(workspace.id); else selected.delete(workspace.id); listSignature = signature();};
      }
      if (!next.workspaceChoices.length) {const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'Open a workspace in Weave to serve it in a browser.'; list.append(empty);}
      listSignature = signature();
      if (focused) [...list.querySelectorAll('input')].find(input => input.value === focused)?.focus();
    }
    for (const id of ['server-browse', 'server-active', 'server-save', 'server-start']) $(id).disabled = busy || next.running;
    $('server-stop').disabled = busy || !next.running;
    $('server-open').disabled = busy || !next.running || !next.url;
    links(next.running ? next.urls ?? (next.url ? [next.url] : []) : []);
    status();
  }
  async function refresh() {if (!busy) {try {render(await client.serverControl('status'));} catch (error) {message = text(error); status();}}}
  async function act(action) {
    if (busy) return;
    message = '';
    if (action === 'start' && needsPassword()) {status(); return;}
    busy = true; if (state) render(state);
    try {
      if (action === 'start' || action === 'configure' || action === 'credentials') {
        const settings = Object.fromEntries(fields.map(name => [name, name === 'background' ? $('server-background').checked : name === 'port' ? Number($('server-port').value) : $('server-' + name).value.trim()]));
        settings.workspaces = [...selected];
        settings.username = $('server-username').value.trim();
        settings.password = $('server-password').value;
        settings.turnstile = {enabled: $('server-turnstile-enabled').checked, siteKey: $('server-turnstile-site').value.trim(), hostname: $('server-turnstile-hostname').value.trim(), secret: $('server-turnstile-secret').value};
        if (!Number.isInteger(settings.port) || settings.port < 0 || settings.port > 65535) throw new Error('Port must be between 0 and 65535.');
        render(await client.serverControl(action === 'credentials' ? 'credentials' : 'configure', settings), true);
      }
      if (action === 'restart') {render(await client.serverControl('stop')); render(await client.serverControl('start'));}
      else if (action !== 'configure' && action !== 'credentials') render(await client.serverControl(action));
    } catch (error) {
      message = text(error);
      if (/password/i.test(message)) passwordError(message);
      busy = false; if (state) render(state); else status();
      return;
    } finally {busy = false;}
    if (state) render(state);
  }
  $('server-start').onclick = () => act('start');
  $('server-stop').onclick = () => act('stop');
  $('server-save').onclick = () => act('configure');
  $('server-auth-save').onclick = () => act('credentials');
  $('server-restart').onclick = () => act('restart');
  $('server-password').addEventListener('input', () => passwordError());
  for (const radio of listen) radio.onchange = () => {if (radio.checked) {$('server-host').value = radio.value; network();}};
  $('server-host').addEventListener('input', network);
  $('server-origin').addEventListener('input', network);
  $('server-active').onclick = () => {selected = new Set(state.workspaceChoices.filter(w => w.open && w.available).map(w => w.id)); selectionDirty = true; render(state);};
  $('server-open').onclick = () => client.openResource(state.url).catch(error => {message = text(error); status();});
  $('server-browse').onclick = async () => {try {await choose?.(); await refresh();} catch (error) {message = text(error); status();}};
  setInterval(() => {if (!document.hidden && $('server-settings').getClientRects().length) refresh();}, 3000);
  refresh();
  return {refresh};
}
