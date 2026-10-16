'use strict';
(async () => {
  const $ = id => document.getElementById(id), message = $('status');
  let state, widget, challenge = '', busy = false;
  async function refresh() {
    const response = await fetch('/auth/status', {credentials: 'same-origin', cache: 'no-store'});
    if (!response.ok) throw new Error('Authentication is unavailable. Contact the server administrator.');
    state = await response.json();
    $('setup').hidden = !state.setup;
    $('login').hidden = state.authenticated || state.setup;
    $('password').hidden = !state.authenticated;
    $('account').hidden = !state.authenticated;
    $('account').querySelector('a').hidden = state.mustChange;
    $('intro').textContent = state.setup ? 'Create the administrator account for this server. Use a password of at least 12 characters.' : state.mustChange ? 'Change your initial password before opening workspaces. Use at least 12 characters.' : state.authenticated ? 'Manage your password. Changing it signs out every browser session.' : 'Sign in to your workspace server.';
    if (!state.authenticated && state.turnstile && !window.turnstile) {
      await new Promise((resolve, reject) => {const script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.onload = resolve; script.onerror = () => reject(new Error('Login verification is unavailable. Try again later.')); document.head.append(script);});
    }
    if (!state.authenticated && state.turnstile && widget == null) widget = window.turnstile.render('#challenge', {sitekey: state.turnstile.siteKey, action: state.turnstile.action, callback: token => {challenge = token;}, 'expired-callback': () => {challenge = '';}, 'error-callback': () => {challenge = ''; message.textContent = 'Login verification failed. Try again.';}});
  }
  async function submit(op, args) {
    if (busy) return; busy = true;
    for (const button of document.querySelectorAll('button')) button.disabled = true;
    message.textContent = 'Working…';
    try {
      const response = await fetch('/api/auth', {method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: {'Content-Type': 'application/json', 'X-Weave-Request': '1', ...(state.csrf ? {'X-Weave-CSRF': state.csrf} : {})}, body: JSON.stringify({op, args})});
      const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Authentication failed.');
      for (const form of document.querySelectorAll('form')) form.reset();
      if ((op === 'login' || op === 'setup') && !value.mustChange) {window.location.replace('/'); return;}
      await refresh(); message.textContent = op === 'password' ? 'Password changed. Sign in with your new password.' : '';
    } catch (error) {message.textContent = error.message;}
    finally {busy = false; for (const button of document.querySelectorAll('button')) button.disabled = false; if (widget != null) {window.turnstile.reset(widget); challenge = '';}}
  }
  $('login').onsubmit = event => {event.preventDefault(); const values = new FormData(event.currentTarget); void submit('login', {username: values.get('username'), password: values.get('password'), challenge});};
  $('setup').onsubmit = event => {event.preventDefault(); const values = new FormData(event.currentTarget); if (values.get('password') !== values.get('confirm')) {message.textContent = 'Passwords do not match.'; return;} void submit('setup', {username: values.get('username'), password: values.get('password')});};
  $('password').onsubmit = event => {event.preventDefault(); const values = new FormData(event.currentTarget); if (values.get('password') !== values.get('confirm')) {message.textContent = 'Passwords do not match.'; return;} void submit('password', {current: values.get('current'), password: values.get('password')});};
  $('logout').onclick = () => submit('logout', {});
  await refresh();
})().catch(error => {document.getElementById('status').textContent = error.message;});
