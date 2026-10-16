// Interface skins. A skin restyles shape, type, spacing and depth through the
// tokens in skin-contract.css (plus a few scoped selectors in skins/<id>.css);
// colour schemes stay separate, so every skin works with every scheme. Classic
// is the contract's own values and has no stylesheet. The build appends each
// other skin's stylesheet in this order.
//
// A skin may extend an earlier one: the root's data-skin then lists the chain,
// base first ("aurora aurora-thin"), skin stylesheets select with
// :root[data-skin~=<id>], and the extending skin's later stylesheet overrides
// only what differs.
export const skins = {
  classic: {name: 'Classic', description: 'The original Weave look: bordered controls, tabbed panes and compact chrome.'},
  studio: {name: 'Studio', description: 'Floating rounded panels, borderless controls and soft depth.'},
  'studio-flow': {name: 'Studio Flow', extends: 'studio', description: 'Studio pared back for space, with tabs that curve into the article like a browser.'},
  compact: {name: 'Compact', description: 'A dense, square-cornered workbench with an activity bar and coloured status bar.'},
  slate: {name: 'Slate', extends: 'compact', description: 'Compact density with softened corners and tabs that merge into the editor.'},
  editorial: {name: 'Editorial', description: 'Quiet paper chrome, serif headings, hairline rules and generous spacing.'},
  folio: {name: 'Folio', extends: 'editorial', description: 'Editorial with folder tabs that join the page and slimmer margins.'},
  aurora: {name: 'Aurora', description: 'Translucent glass panels over a soft gradient drawn from the accent colour.'},
  'aurora-thin': {name: 'Aurora Thin', extends: 'aurora', description: 'Aurora with slim bars, tight margins, roomier tabs and hairline glass scrollbars.'},
  'aurora-flow': {name: 'Aurora Flow', extends: 'aurora-thin', description: 'Aurora Thin with glass tabs that flow into the article from the gradient.'}
};
export const defaultSkin = 'aurora-flow';
export const skinStylesheets = Object.keys(skins).filter(id => id !== 'classic').map(id => `skins/${id}.css`);
export const normalizeSkin = value => typeof value === 'string' && Object.hasOwn(skins, value) ? value : defaultSkin;
/** The skin and the skins it extends, base first. */
export function skinChain(id) {
  const chain = [];
  for (let skin = normalizeSkin(id); skin && !chain.includes(skin); skin = skins[skin].extends) chain.unshift(skin);
  return chain;
}
