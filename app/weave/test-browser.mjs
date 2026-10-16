// The Playwright browser the verification suites run in. Edge by default;
// WEAVE_BROWSER names another Chromium channel (for example "chromium" on
// Linux) or "webkit" for the engine family behind Linux's WebKitGTK.
// Playwright is a pinned devDependency; WEAVE_PLAYWRIGHT can still point at
// another Playwright index.mjs to override it.
import {pathToFileURL} from 'node:url';

export const browserName = process.env.WEAVE_BROWSER || 'msedge';
export const webkit = browserName === 'webkit';

// The packaged CSP refuses the <style> elements CodeMirror injects (by design);
// these are the console errors that produces in Chromium and WebKit.
export const blockedStyleElementMessage = text => text.startsWith('Applying inline style violates') || text.startsWith('Refused to apply a stylesheet because');

// Init script: records inline style attributes the CSP blocks in
// window.__blockedStyles. Chromium reports blocked <style> elements against the
// element and WebKit against the document, so attributes are told apart by the
// CSP3 directive (or, without it, by an element target other than <style>).
export function recordBlockedStyleAttributes() {
  window.__blockedStyles = [];
  document.addEventListener('securitypolicyviolation', e => {
    const attribute = e.effectiveDirective === 'style-src-attr' || (e.effectiveDirective === 'style-src' && e.target?.nodeType === 1 && e.target.tagName !== 'STYLE');
    if (attribute) window.__blockedStyles.push((e.target?.outerHTML || e.sample || '').slice(0, 160));
  });
}

export async function launchBrowser(options = {}) {
  const playwright = await import(process.env.WEAVE_PLAYWRIGHT ? pathToFileURL(process.env.WEAVE_PLAYWRIGHT).href : 'playwright');
  if (webkit) {
    const {args, ...rest} = options;
    return playwright.webkit.launch({headless: true, ...rest});
  }
  return playwright.chromium.launch({channel: browserName, headless: true, ...options});
}

/** Clicks an item of the title bar's W menu (Open workspace, Save, Reload, Source
 * mode, Show article, Settings), opening the menu first. */
export async function menuItem(page, id) {
  await page.locator('#app-menu-button').click();
  await page.locator('#app-menu #' + id).click();
}
