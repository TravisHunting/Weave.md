// English variant for interface text and spell checking, from the system's
// preferred languages. American spelling for the United States (and plain "en"),
// British spelling for other English-speaking regions and for non-English systems.
const AMERICAN = new Set(['US', 'PH', 'PR', 'UM', 'VI', 'AS', 'GU', 'MP', 'LR']);
export function englishVariant(languages = globalThis.navigator?.languages || [globalThis.navigator?.language || 'en-GB']) {
  const english = languages.find(tag => /^en\b/i.test(tag || ''));
  if (!english) return 'en-GB';
  const region = english.split(/[-_]/)[1]?.toUpperCase();
  return !region || AMERICAN.has(region) ? 'en-US' : 'en-GB';
}

// [British, American] interface words. Only whole words change, keeping case.
const PAIRS = [
  ['colour', 'color'], ['colours', 'colors'], ['coloured', 'colored'], ['colouring', 'coloring'],
  ['grey', 'gray'], ['greys', 'grays'], ['centre', 'center'], ['centred', 'centered'], ['centres', 'centers'], ['centring', 'centering'],
  ['organise', 'organize'], ['organised', 'organized'], ['organising', 'organizing'], ['organisation', 'organization'],
  ['customise', 'customize'], ['customised', 'customized'], ['customisation', 'customization'],
  ['recognise', 'recognize'], ['recognised', 'recognized'], ['behaviour', 'behavior'], ['behaviours', 'behaviors'],
  ['favourite', 'favorite'], ['favourites', 'favorites'], ['analyse', 'analyze'], ['analysed', 'analyzed'],
  ['catalogue', 'catalog'], ['catalogues', 'catalogs'], ['minimise', 'minimize'], ['minimised', 'minimized'], ['minimising', 'minimizing'],
  ['maximise', 'maximize'], ['maximised', 'maximized'], ['normalise', 'normalize'], ['normalised', 'normalized'],
  ['synchronise', 'synchronize'], ['initialise', 'initialize'], ['initialised', 'initialized'], ['prioritise', 'prioritize'],
  ['optimise', 'optimize'], ['summarise', 'summarize'], ['utilise', 'utilize'], ['visualise', 'visualize'], ['emphasise', 'emphasize'],
  ['cancelled', 'canceled'], ['cancelling', 'canceling'], ['labelled', 'labeled'], ['labelling', 'labeling'],
  ['travelled', 'traveled'], ['travelling', 'traveling'], ['modelling', 'modeling'],
  ['neighbour', 'neighbor'], ['neighbours', 'neighbors'], ['neighbourhood', 'neighborhood'], ['neighbourhoods', 'neighborhoods'],
];
const matchCase = (source, word) => source === source.toUpperCase() ? word.toUpperCase() : source[0] === source[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word;
function converter(variant) {
  const map = new Map(PAIRS.map(([gb, us]) => variant === 'en-US' ? [gb, us] : [us, gb]));
  const pattern = new RegExp('\\b(' + [...map.keys()].sort((a, b) => b.length - a.length).join('|') + ')\\b', 'gi');
  return text => typeof text === 'string' && text ? text.replace(pattern, word => matchCase(word, map.get(word.toLowerCase()))) : text;
}
const converters = new Map();
/** Interface text in the given English variant. */
export function localizeText(text, variant = englishVariant()) {
  if (!converters.has(variant)) converters.set(variant, converter(variant));
  return converters.get(variant)(text);
}

// Interface text is converted only where Weave opts in: strings passed through
// ui(), markup Weave builds itself (localizeTree) and [data-ui] elements of the
// static page (localizeMarked). Nothing walks or watches the page, so articles,
// names, paths, diagrams, embedded scripts and other user content are never touched.
let interfaceVariant = null;
/** A Weave interface string in the system's English. */
export const ui = text => localizeText(text, interfaceVariant ??= englishVariant());

const ATTRIBUTES = ['title', 'aria-label', 'placeholder'], RAW = 'script, style, template, noscript, textarea';
/** Converts a subtree of Weave's own markup once: its text and its title,
 * aria-label and placeholder attributes. Call it as the markup is built,
 * before any user content is put into it. */
export function localizeTree(root) {
  const visit = node => {
    if (node.nodeType === 3) {const next = ui(node.nodeValue); if (next !== node.nodeValue) node.nodeValue = next; return;}
    if (node.nodeType !== 1 || node.matches(RAW)) return;
    for (const name of ATTRIBUTES) if (node.hasAttribute(name)) {const value = node.getAttribute(name), next = ui(value); if (next !== value) node.setAttribute(name, next);}
    for (const child of node.childNodes) visit(child);
  };
  if (root) visit(root);
}
/** Converts the static page's interface text: elements marked data-ui. */
export function localizeMarked(root = document) {
  for (const element of root.querySelectorAll('[data-ui]')) localizeTree(element);
}
