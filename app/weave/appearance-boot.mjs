// The page's first script, inlined in <head> by build.mjs. It applies the saved
// skin, colour scheme and layout choices to the root before the body is parsed,
// so the first frame already shows them instead of the unstyled defaults that
// the main script (at the end of the body) would otherwise correct a moment later.
import {savedAppearance, applyRootAppearance} from './appearance.mjs';
import {MOBILE_QUERY} from './mobile.mjs';

try {
  const prefs = {get: key => localStorage.getItem('weave:' + key)};
  applyRootAppearance(savedAppearance(prefs));
} catch {
  try {applyRootAppearance(savedAppearance({get: () => null}));} catch {}
}
if (matchMedia(MOBILE_QUERY).matches) document.documentElement.dataset.layout = 'mobile';
