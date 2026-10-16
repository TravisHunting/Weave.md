import {createNativeClient} from './native-client.mjs';
import {createReaderClient} from './reader-client.mjs';
import {readerCapabilities} from './platform.mjs';
import {createHttpClient} from './http-client.mjs';

export async function createClient() {
  const initial = JSON.parse(document.getElementById('weave-data').textContent);
  if (initial.mode === 'server') return createHttpClient();
  const core = window.__TAURI__?.core;
  if (core?.invoke || window.__WEAVE_TEST_INVOKE__) return createNativeClient({
    invoke: core?.invoke || window.__WEAVE_TEST_INVOKE__, Channel: core?.Channel,
    listen: window.__TAURI__?.event?.listen,
  });
  if (initial.mode === 'dynamic') return {
    capabilities: readerCapabilities, writable: false,
    async choose() {return this.call('catalog');},
    async call(op, args = {}) {
      const response = await fetch('/api/weave?' + new URLSearchParams({op, args: JSON.stringify(args)}));
      const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
    },
    dirty() {}, openResource(url) {window.open(url, '_blank', 'noopener,noreferrer');},
  };
  return createReaderClient(initial);
}
