import {skins,normalizeSkin,skinChain} from './skins.mjs';
import {mermaidPalettes} from './mermaid-palettes.mjs';
import {ui, localizeTree} from './locale.mjs';
export {skins};
export const schemes = {
  grey: {name: 'Light grey', mode: 'light', colors: ['#eeeeee','#fafafa','#292929','#666666','#d4d4d4','#505968','#e3e5e8','#e9e9e9','#b9cce8','#a0a0a0','#fafafa']},
  graphite: {name: 'Graphite', mode: 'dark', colors: ['#202124','#292a2d','#e8eaed','#b0b3bb','#474950','#abc4ef','#383e49','#34363c','#4e6385','#777a83','#292a2d']},
  paper: {name: 'Warm paper', mode: 'light', colors: ['#eee8dc','#fffaf0','#3c342b','#736657','#d9cfbd','#80613b','#eee2cd','#f2e9da','#e6cfa7','#ad9d84','#fffaf0']},
  sage: {name: 'Sage', mode: 'light', colors: ['#edf1eb','#fafcf8','#293b30','#5c7163','#cdd9ce','#34664d','#dfeadc','#e8efe3','#b5d7bd','#91a493','#fafcf8']},
  ocean: {name: 'Ocean', mode: 'dark', colors: ['#182731','#20333f','#e4eff4','#a5bdcb','#405764','#99cfe6','#304b5b','#29414e','#446d86','#668799','#20333f']},
  lavender: {name: 'Lavender', mode: 'light', colors: ['#eeebf2','#fcfaff','#36303f','#70667f','#d9d0e5','#735494','#e8e0f0','#eee8f4','#d2bce9','#ad9ebf','#fcfaff']}
};
export const colorFields = {bg:'Sidebar & background',paper:'Article & panels',ink:'Text',muted:'Secondary text',line:'Borders',accent:'Links & accents',wash:'Selected & hover',code:'Code background',selection:'Text selection',tableBorder:'Table borders',titleBar:'Top bar'};
export const fontFamilies = {system:'"Segoe UI", system-ui, Arial, sans-serif',serif:'Georgia, "Times New Roman", serif',sans:'Arial, Helvetica, sans-serif',mono:'Consolas, "Courier New", monospace',calibri:'Calibri, "Segoe UI", sans-serif',cambria:'Cambria, Georgia, serif',verdana:'Verdana, Geneva, sans-serif',tahoma:'Tahoma, "Segoe UI", sans-serif',trebuchet:'"Trebuchet MS", Arial, sans-serif',palatino:'"Palatino Linotype", Palatino, Georgia, serif',times:'"Times New Roman", Times, serif',cascadia:'"Cascadia Code", "Cascadia Mono", Consolas, monospace'};
// Segoe UI is Windows' interface font; elsewhere system-ui is the desktop's own.
export const fontLabels = {system:typeof navigator !== 'undefined' && !/Windows/.test(navigator.userAgent) ? 'System' : 'System (Segoe UI)',serif:'Georgia',sans:'Arial',mono:'Consolas',calibri:'Calibri',cambria:'Cambria',verdana:'Verdana',tahoma:'Tahoma',trebuchet:'Trebuchet MS',palatino:'Palatino',times:'Times New Roman',cascadia:'Cascadia Code'};
export const codeFontFamilies = {consolas:fontFamilies.mono,cascadia:fontFamilies.cascadia,cascadiaMono:'"Cascadia Mono", Consolas, monospace',courier:'"Courier New", Courier, monospace',lucida:'"Lucida Console", Consolas, monospace',jetbrains:'"JetBrains Mono", Consolas, monospace',fira:'"Fira Code", Consolas, monospace',source:'"Source Code Pro", Consolas, monospace'};
export const codeFontLabels = {consolas:'Consolas',cascadia:'Cascadia Code',cascadiaMono:'Cascadia Mono',courier:'Courier New',lucida:'Lucida Console',jetbrains:'JetBrains Mono',fira:'Fira Code',source:'Source Code Pro'};
export const readingDefaults = {fontSize:15,fontWeight:400,lineHeight:1.7,codeLineSpacing:0,paragraphSpacing:0,font:'system',codeFont:'cascadiaMono',codeFontSize:15,articleZoom:100,articleIndent:40,readableWidth:false,width:880,lineNumbers:'both',lineNumberColor:null,lineNumberOpacity:50,lineNumberSize:9,titlebarTabs:true,tabTint:true,tabTintOpacity:10,graphCounts:false,graphSpacing:false,graphColours:false,spellColor:'#e5484d',highlightColor:'#ffd43b',spellOpacity:55,spellThickness:1.5,spellStyle:'wavy',tablePadding:9,tableBorders:'grid',tableBorderWidth:2,tableHeaderTint:100,tableStriped:true,tableEditing:'visual',tableAutoFormat:true,tableHoverControls:true,mermaid:true,mermaidPreview:true,mermaidPalette:'scheme',mermaidAccent:null,mermaidLook:'classic',mermaidCurve:'smooth',mermaidFrame:'card',mermaidSize:'fit',mermaidAlign:'centre'};
// Diagram choices (Visual styling › Diagrams) and their allowed values.
const mermaidChoices = {mermaidPalette:Object.keys(mermaidPalettes),mermaidLook:['classic','handDrawn'],mermaidCurve:['smooth','rounded','straight','stepped'],mermaidFrame:['card','plain'],mermaidSize:['fit','natural'],mermaidAlign:['centre','left']};
const mermaidControl = key => 'mermaid-' + key.slice(7).toLowerCase();
const mermaidSelect = (key,label,options) => `<label class="appearance-field" for="${mermaidControl(key)}">${label}<select id="${mermaidControl(key)}">${Object.entries(options).map(([value,text])=>`<option value="${value}">${text}</option>`).join('')}</select></label>`;
const limits = {fontSize:[12,28],fontWeight:[100,900],codeLineSpacing:[-.8,1.2],codeFontSize:[10,28],articleZoom:[50,200],articleIndent:[32,160],lineHeight:[1.2,2.4],paragraphSpacing:[0,1.5],width:[560,1400],lineNumberOpacity:[0,100],lineNumberSize:[7,20],spellOpacity:[10,100],spellThickness:[1,4],tabTintOpacity:[5,100],tablePadding:[2,18],tableBorderWidth:[0,3],tableHeaderTint:[0,100]};
export function normalizeAppearance(value) {
  const input = value && typeof value === 'object' ? value : {};
  const preset = Object.hasOwn(schemes,input.preset) ? input.preset : 'lavender';
  const colors = Object.fromEntries(Object.keys(colorFields).map((key,i)=>[key,/^#[0-9a-f]{6}$/i.test(input.colors?.[key]) ? input.colors[key] : schemes[preset].colors[i]]));
  if (input.colors?.tableBorder === undefined && /^#[0-9a-f]{6}$/i.test(input.colors?.line)) colors.tableBorder = input.colors.line;
  const reading = {...readingDefaults};
  for (const [key,[min,max]] of Object.entries(limits)) {
    const value = input.reading?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) reading[key] = Math.max(min,Math.min(max,value));
  }
  // Remove the previous default's extra padding once; explicit custom gaps
  // and preferences saved by this version keep their chosen values.
  if (input.reading && input.reading.fontWeight === undefined && input.reading.paragraphSpacing === .45) reading.paragraphSpacing = 0;
  if (Object.hasOwn(fontFamilies,input.reading?.font)) reading.font = input.reading.font;
  if (Object.hasOwn(codeFontFamilies,input.reading?.codeFont)) reading.codeFont = input.reading.codeFont;
  if (['off','read','edit','both'].includes(input.reading?.lineNumbers)) reading.lineNumbers = input.reading.lineNumbers;
  if (/^#[0-9a-f]{6}$/i.test(input.reading?.lineNumberColor)) reading.lineNumberColor = input.reading.lineNumberColor;
  if (/^#[0-9a-f]{6}$/i.test(input.reading?.spellColor)) reading.spellColor = input.reading.spellColor;
  if (/^#[0-9a-f]{6}$/i.test(input.reading?.highlightColor)) reading.highlightColor = input.reading.highlightColor.toLowerCase();
  if (['wavy','dotted','dashed','solid'].includes(input.reading?.spellStyle)) reading.spellStyle = input.reading.spellStyle;
  if (['grid','rows','none'].includes(input.reading?.tableBorders)) reading.tableBorders = input.reading.tableBorders;
  if (['visual','source'].includes(input.reading?.tableEditing)) reading.tableEditing = input.reading.tableEditing;
  for (const [key,values] of Object.entries(mermaidChoices)) if (values.includes(input.reading?.[key])) reading[key] = input.reading[key];
  if (/^#[0-9a-f]{6}$/i.test(input.reading?.mermaidAccent)) reading.mermaidAccent = input.reading.mermaidAccent.toLowerCase();
  for (const key of ['tableStriped','tableAutoFormat','tableHoverControls','titlebarTabs','tabTint','graphCounts','graphSpacing','graphColours','mermaid','mermaidPreview']) if (typeof input.reading?.[key] === 'boolean') reading[key] = input.reading[key];
  reading.readableWidth = input.reading?.readableWidth === true;
  return {preset,colors,reading,skin:normalizeSkin(input.skin)};
}

export function normalizeSavedSchemes(value) {
  const saved = new Map();
  for (const entry of Array.isArray(value) ? value.slice(0,100) : []) {
    if (!entry || typeof entry.name !== 'string') continue;
    const name = entry.name.trim().slice(0,80);
    if (!name) continue;
    const {preset,colors} = normalizeAppearance(entry);
    saved.set(name.toLocaleLowerCase(), {name,preset,colors});
  }
  return [...saved.values()];
}

export function saveColourScheme(schemes, name, appearance) {
  const saved = normalizeSavedSchemes(schemes), label = String(name || '').trim().slice(0,80);
  if (!label) throw new Error('Enter a name for this theme.');
  const {preset,colors} = normalizeAppearance(appearance), entry = {name:label,preset,colors};
  const index = saved.findIndex(scheme => scheme.name.toLocaleLowerCase() === label.toLocaleLowerCase());
  if (index >= 0) saved[index] = entry;
  else {
    if (saved.length >= 100) throw new Error('You have saved 100 colour schemes. Use an existing name to update one.');
    saved.push(entry);
  }
  return saved;
}

// Most installed prose fonts have only a few static faces (for example Segoe UI:
// Light, Regular, Semibold, Bold, Black), so CSS weights between faces render
// identically. A thin text stroke adds the remaining weight above the face the
// browser chose, making every slider step visible. Variable code fonts need none.
const faceStarts = new Map();
export function weightStroke(family, weight) {
  if (typeof document === 'undefined') return 0;
  let starts = faceStarts.get(family);
  if (!starts) {
    const context = document.createElement('canvas').getContext('2d'), sample = 'The quick brown fox jumps over the lazy dog 0123456789';
    if (!context) return 0;
    starts = new Map(); let previous = null, start = 100;
    for (let value = 100; value <= 900; value += 10) {
      context.font = `${value} 48px ${family}`;
      const width = context.measureText(sample).width.toFixed(2);
      if (width !== previous) {start = value; previous = width;}
      starts.set(value, start);
    }
    if (document.fonts?.status !== 'loading') faceStarts.set(family, starts);
  }
  const rounded = Math.max(100, Math.min(900, Math.round(weight / 10) * 10));
  return Number(((rounded - (starts.get(rounded) ?? rounded)) / 100 * .018).toFixed(4));
}
/** The saved appearance, or the defaults (honouring the older light/dark `theme` preference). */
export function savedAppearance(prefs) {
  let saved; try {saved = JSON.parse(prefs.get('appearance'));} catch {}
  return normalizeAppearance(saved || {preset:prefs.get('theme') === 'dark' ? 'graphite' : prefs.get('theme') === 'light' ? 'grey' : 'lavender'});
}

// Writes the appearance onto the root element: data attributes for the skin, scheme
// and layout choices, and the colour and reading custom properties. The page's
// first inline script (appearance-boot.mjs) calls it before the body is parsed, so
// Weave paints with the saved skin and theme from the first frame.
export function applyRootAppearance(state, root = document.documentElement) {
  const mode = schemes[state.preset].mode;
  root.dataset.theme = mode; root.dataset.scheme = state.preset; root.dataset.skin = skinChain(state.skin).join(' ');
  root.dataset.lineNumbers = state.reading.lineNumbers;
  root.dataset.tableBorders = state.reading.tableBorders;
  root.dataset.tableStriped = String(state.reading.tableStriped);
  root.dataset.tableEditing = state.reading.tableEditing;
  root.dataset.tableAutoFormat = String(state.reading.tableAutoFormat);
  root.dataset.tableHoverControls = String(state.reading.tableHoverControls);
  root.dataset.tabTint = String(state.reading.tabTint);
  root.dataset.mermaid = String(state.reading.mermaid); root.dataset.mermaidPreview = String(state.reading.mermaidPreview);
  for (const key of Object.keys(mermaidChoices)) root.dataset[key] = state.reading[key];
  root.dataset.mermaidAccent = state.reading.mermaidAccent || '';
  root.dataset.titlebarTabs = String(state.reading.titlebarTabs);
  root.style.setProperty('--highlight-color', state.reading.highlightColor);
  root.style.setProperty('--spell-color', state.reading.spellColor); root.style.setProperty('--spell-opacity', state.reading.spellOpacity + '%');
  root.style.setProperty('--spell-thickness', state.reading.spellThickness + 'px'); root.style.setProperty('--spell-style', state.reading.spellStyle);
  root.dataset.graphCounts = String(state.reading.graphCounts); root.dataset.graphSpacing = String(state.reading.graphSpacing); root.dataset.graphColours = String(state.reading.graphColours);
  root.style.setProperty('--tab-tint',state.reading.tabTintOpacity+'%');
  root.style.setProperty('--tab-tint-active',Math.min(100,Math.round(state.reading.tabTintOpacity*1.5))+'%');
  for (const [key,value] of Object.entries(state.colors)) root.style.setProperty('--'+key,value);
  const zoom = state.reading.articleZoom / 100;
  root.style.setProperty('--reading-font-size',Number((state.reading.fontSize*zoom).toFixed(2))+'px');
  root.style.setProperty('--reading-line-height',state.reading.lineHeight);
  root.style.setProperty('--reading-font-weight',state.reading.fontWeight);
  root.style.setProperty('--code-line-height',Math.max(1,state.reading.lineHeight+state.reading.codeLineSpacing));
  root.style.setProperty('--reading-paragraph-spacing',state.reading.paragraphSpacing+'em');
  root.style.setProperty('--reading-font-family',fontFamilies[state.reading.font]);
  root.style.setProperty('--code-font-family',codeFontFamilies[state.reading.codeFont]);
  root.style.setProperty('--code-font-size',Number((state.reading.codeFontSize*zoom).toFixed(2))+'px');
  root.style.setProperty('--article-indent',state.reading.articleIndent+'px');
  root.style.setProperty('--article-zoom',zoom);
  root.style.setProperty('--line-number-color',state.reading.lineNumberColor || state.colors.muted);
  root.style.setProperty('--line-number-opacity',state.reading.lineNumberOpacity/100);
  root.style.setProperty('--line-number-size',Number((state.reading.lineNumberSize*zoom).toFixed(2))+'px');
  root.style.setProperty('--table-cell-padding',state.reading.tablePadding+'px');
  root.style.setProperty('--table-border-width',state.reading.tableBorderWidth+'px');
  root.style.setProperty('--table-header-tint',state.reading.tableHeaderTint+'%');
  root.style.setProperty('--reading-width',state.reading.readableWidth ? state.reading.width+'px' : 'none');
  return mode;
}

export function initAppearance({prefs,onChange = () => {},onFileLabelsChange = () => {}}) {
  const $ = id => document.getElementById(id);
  let state = savedAppearance(prefs);
  let savedSchemes; try {savedSchemes = JSON.parse(prefs.get('appearance-schemes'));} catch {}
  savedSchemes = normalizeSavedSchemes(savedSchemes);
  const panel = $('appearance-panel');
  panel.innerHTML = `<details id="appearance-skin" class="appearance-section"><summary>Skin</summary><p class="hint">A skin changes the shape, type, spacing and depth of the interface. It works with every colour scheme and leaves your reading settings alone.</p><div id="skin-options" class="skin-options" role="radiogroup" aria-label="Skin">${Object.entries(skins).map(([key,skin])=>`<label class="skin-option" for="skin-${key}"><input id="skin-${key}" type="radio" name="skin" value="${key}"><span class="skin-preview" data-preview="${skinChain(key).join(' ')}" aria-hidden="true"><i class="sp-title"></i><i class="sp-rail"></i><i class="sp-side"></i><i class="sp-main"><i class="sp-tab"></i><i class="sp-lines"></i></i></span><span class="skin-text"><strong>${skin.name}</strong><small>${skin.description}</small></span></label>`).join('')}</div></details>
    <details id="appearance-colours" class="appearance-section"><summary>Colours and Themes</summary><label class="appearance-field" for="appearance-scheme">Choose a scheme<select id="appearance-scheme"><option value="custom" disabled>Custom colours</option><optgroup label="Built-in">${Object.entries(schemes).map(([key,scheme])=>`<option value="${key}">${scheme.name}</option>`).join('')}</optgroup><optgroup id="saved-schemes" label="Saved schemes"></optgroup></select></label>
    <details class="appearance-colors"><summary>Individual colours</summary>${Object.entries(colorFields).filter(([key])=>key !== 'tableBorder').map(([key,label])=>`<label class="appearance-color" for="color-${key}"><span>${label}</span><input id="color-${key}" type="color" data-color="${key}"></label>`).join('')}<button id="reset-colors">Reset scheme colours</button></details>
    <form id="save-colour-scheme"><label class="appearance-field" for="scheme-name">Save current colours as<input id="scheme-name" maxlength="80" placeholder="Theme name" autocomplete="off" required></label><button type="submit">Save colour scheme</button><p id="scheme-status" class="hint" role="status"></p></form></details>
    <details id="appearance-files" class="appearance-section"><summary>File sidebar</summary><label class="appearance-field" for="file-labels">File labels<select id="file-labels"><option value="title">Article title</option><option value="filename">Filename</option><option value="title-first">Title - Filename</option><option value="filename-first">Filename - Title</option></select></label><label class="appearance-check"><input id="right-align-file-labels" type="checkbox"> Align secondary file labels to the right</label></details>
    <details id="appearance-reading" class="appearance-section"><summary>Reading &amp; editing</summary><label class="appearance-field" for="reading-font">Primary font<select id="reading-font">${Object.entries(fontLabels).map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select></label>
    <label class="appearance-field" for="reading-size"><span>Font size <output id="reading-size-value" for="reading-size"></output></span><input id="reading-size" type="range" min="12" max="28" step="1" data-reading="fontSize"></label>
    <label class="appearance-field" for="reading-weight"><span>Font weight <output id="reading-weight-value" for="reading-weight"></output></span><input id="reading-weight" type="range" min="100" max="900" step="10" data-reading="fontWeight"></label>
    <label class="appearance-field" for="reading-height"><span>Line spacing <output id="reading-height-value" for="reading-height"></output></span><input id="reading-height" type="range" min="1.2" max="2.4" step="0.05" data-reading="lineHeight"></label>
    <label class="appearance-field" for="reading-gap"><span>Additional row spacing <output id="reading-gap-value" for="reading-gap"></output></span><input id="reading-gap" type="range" min="0" max="1.5" step="0.05" data-reading="paragraphSpacing"></label><p class="hint">Adds equal space after prose and blank rows in the reader and editor.</p>
    <label class="appearance-field" for="article-indent"><span>Article indent <output id="article-indent-value" for="article-indent"></output></span><input id="article-indent" type="range" min="32" max="160" step="4" data-reading="articleIndent"></label>
    <label class="appearance-field" for="article-zoom"><span>Article zoom <output id="article-zoom-value" for="article-zoom"></output></span><input id="article-zoom" type="range" min="50" max="200" step="10" data-reading="articleZoom"></label><button id="reset-article-zoom" type="button">Reset zoom to 100%</button><p class="hint">Ctrl + mouse wheel over an article adjusts zoom. Your font sizes remain independent.</p>
    <label class="appearance-color" for="highlight-color"><span>Highlight colour</span><input id="highlight-color" type="color"></label><p class="hint">Used for ==highlighted== text. Right-click a highlight while editing to pick another colour.</p>
    <label class="appearance-check"><input id="reading-limit" type="checkbox"> Limit article width</label><label class="appearance-field" for="reading-width"><span>Article width <output id="reading-width-value" for="reading-width"></output></span><input id="reading-width" type="range" min="560" max="1400" step="20" data-reading="width"></label></details>
    <details id="appearance-code" class="appearance-section"><summary>Code blocks</summary><label class="appearance-field" for="code-font">Code font<select id="code-font">${Object.entries(codeFontLabels).map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select></label><label class="appearance-field" for="code-size"><span>Code block font size <output id="code-size-value" for="code-size"></output></span><input id="code-size" type="range" min="10" max="28" step="1" data-reading="codeFontSize"></label><label class="appearance-field" for="code-spacing"><span>Line spacing adjustment <output id="code-spacing-value" for="code-spacing"></output></span><input id="code-spacing" type="range" min="-0.8" max="1.2" step="0.05" data-reading="codeLineSpacing"></label><p class="hint">Adds to or subtracts from global line spacing, with a minimum of 1.00.</p><p class="hint">Fonts use installed typefaces, with local fallbacks. Code font also applies to inline code and Source; inline code keeps the surrounding text size.</p></details>
    <details id="appearance-lines" class="appearance-section"><summary>Line numbers</summary><label class="appearance-field" for="line-numbers">Show line numbers<select id="line-numbers"><option value="off">Off</option><option value="read">While reading</option><option value="edit">While editing</option><option value="both">Reading and editing</option></select></label><label class="appearance-color" for="line-number-color"><span>Line number colour</span><input id="line-number-color" type="color"></label><button id="line-number-reset" type="button">Use scheme colour</button><label class="appearance-field" for="line-number-opacity"><span>Opacity <output id="line-number-opacity-value" for="line-number-opacity"></output></span><input id="line-number-opacity" type="range" min="0" max="100" step="5" data-reading="lineNumberOpacity"></label><label class="appearance-field" for="line-number-size"><span>Line number font size <output id="line-number-size-value" for="line-number-size"></output></span><input id="line-number-size" type="range" min="7" max="20" step="1" data-reading="lineNumberSize"></label></details>
    <details id="appearance-tabs" class="appearance-section"><summary>Tabs</summary><label class="appearance-check"><input id="titlebar-tabs" type="checkbox"> Show tabs in the title bar</label><p class="hint">Tabs share the top row with the menu, Back, Forward, Graph and Edit, giving the article a bar's worth more height. Empty space in that row moves the window.</p><p class="hint">With more than one active workspace, each tab can take its workspace's colour.</p><label class="appearance-check"><input id="tab-tint" type="checkbox"> Colour tab backgrounds by workspace</label><label class="appearance-field" for="tab-tint-opacity"><span>Tab colour opacity <output id="tab-tint-opacity-value" for="tab-tint-opacity"></output></span><input id="tab-tint-opacity" type="range" min="5" max="100" step="5" data-reading="tabTintOpacity"></label><label class="appearance-check"><input id="tab-workspace-names" type="checkbox"> Show workspace names in tabs</label></details>
    <details id="appearance-graph" class="appearance-section"><summary>Graph controls</summary><p class="hint">Extra controls in the graph's floating control bar.</p><label class="appearance-check"><input id="graph-show-counts" type="checkbox" data-graph-option="graphCounts"> Show note and link counts</label><label class="appearance-check"><input id="graph-show-spacing" type="checkbox" data-graph-option="graphSpacing"> Show the node spacing slider</label><label class="appearance-check"><input id="graph-show-colours" type="checkbox" data-graph-option="graphColours"> Show the Colours button</label></details>
    <details id="appearance-spelling" class="appearance-section" data-settings-category="Spellchecking"><summary>Spelling underline</summary><p class="hint">How misspelled words are marked while editing. Spell checking itself is set in Control panel › Spellchecking; the Settings window shows both together.</p><label class="appearance-color" for="spell-color"><span>Underline colour</span><input id="spell-color" type="color"></label><label class="appearance-field" for="spell-opacity"><span>Opacity <output id="spell-opacity-value" for="spell-opacity"></output></span><input id="spell-opacity" type="range" min="10" max="100" step="5" data-reading="spellOpacity"></label><label class="appearance-field" for="spell-thickness"><span>Thickness <output id="spell-thickness-value" for="spell-thickness"></output></span><input id="spell-thickness" type="range" min="1" max="4" step="0.5" data-reading="spellThickness"></label><label class="appearance-field" for="spell-style">Style<select id="spell-style"><option value="wavy">Wavy</option><option value="dotted">Dotted</option><option value="dashed">Dashed</option><option value="solid">Straight</option></select></label><p class="spell-preview">Preview: a <span class="spell-error">mispeled</span> word.</p></details>
    <details id="appearance-tables" class="appearance-section"><summary>Tables</summary><label class="appearance-field" for="table-editing">Table editing<select id="table-editing"><option value="visual">Visual cells</option><option value="source">Markdown source</option></select></label><label class="appearance-check"><input id="table-auto-format" type="checkbox"> Automatically format tables</label><label class="appearance-check"><input id="table-hover-controls" type="checkbox"> Show row and column controls on hover</label><label class="appearance-field" for="table-padding"><span>Cell padding <output id="table-padding-value" for="table-padding"></output></span><input id="table-padding" type="range" min="2" max="18" step="1" data-reading="tablePadding"></label><label class="appearance-field" for="table-borders">Borders<select id="table-borders"><option value="grid">Full grid</option><option value="rows">Horizontal lines</option><option value="none">None</option></select></label><label class="appearance-color" for="color-tableBorder"><span>Table border colour</span><input id="color-tableBorder" type="color" data-color="tableBorder"></label><label class="appearance-field" for="table-border-width"><span>Border thickness <output id="table-border-width-value" for="table-border-width"></output></span><input id="table-border-width" type="range" min="0" max="3" step="1" data-reading="tableBorderWidth"></label><label class="appearance-field" for="table-header-tint"><span>Header tint <output id="table-header-tint-value" for="table-header-tint"></output></span><input id="table-header-tint" type="range" min="0" max="100" step="5" data-reading="tableHeaderTint"></label><label class="appearance-check"><input id="table-striped" type="checkbox"> Alternate row shading</label></details>
    <details id="appearance-diagrams" class="appearance-section"><summary>Diagrams</summary><p class="hint">Mermaid diagrams are drawn from code blocks marked <code>mermaid</code>. Articles keep the Mermaid source; drawings follow the colour scheme and skin.</p><label class="appearance-check"><input id="mermaid-enabled" type="checkbox"> Draw Mermaid diagrams</label><label class="appearance-check"><input id="mermaid-preview" type="checkbox"> Preview a diagram below its source while editing it</label>${mermaidSelect('mermaidPalette','Colours',mermaidPalettes)}<label class="appearance-color" for="mermaid-accent"><span>Diagram accent</span><input id="mermaid-accent" type="color"></label><button id="mermaid-accent-reset" type="button">Use scheme accent</button>${mermaidSelect('mermaidLook','Style',{classic:'Clean lines',handDrawn:'Hand-drawn'})}${mermaidSelect('mermaidCurve','Connectors',{smooth:'Curved',rounded:'Gently curved',straight:'Straight',stepped:'Right angles'})}${mermaidSelect('mermaidFrame','Frame',{card:'Card',plain:'None'})}${mermaidSelect('mermaidSize','Size',{fit:'Fit the article width',natural:'Actual size (scroll wide diagrams)'})}${mermaidSelect('mermaidAlign','Alignment',{centre:'Centre',left:'Left'})}</details>
    <p class="hint">Changes apply immediately and are remembered on this device. Markdown files keep their original content.</p><button id="reset-appearance">Restore defaults</button>`;
  // The panel is Weave's own markup: convert its spelling now, before saved
  // scheme names (user content) are added to it.
  localizeTree(panel);
  function renderSavedSchemes() {
    $('saved-schemes').replaceChildren(...savedSchemes.map((scheme,index) => {
      const option = document.createElement('option'); option.value = 'saved:' + index; option.textContent = scheme.name; return option;
    }));
    $('saved-schemes').hidden = !savedSchemes.length;
  }
  const sameColours = scheme => scheme.preset === state.preset && Object.keys(colorFields).every(key => scheme.colors[key] === state.colors[key]);
  // The theme name box follows the loaded custom theme, so editing its colours
  // and saving updates that theme. A name the user typed is left alone.
  let themeName = prefs.get('appearance-theme-name') || '', autoName = '';
  const rememberTheme = name => {themeName = name || ''; prefs.set('appearance-theme-name', themeName);};
  function syncThemeName() {
    const input = $('scheme-name');
    if (document.activeElement === input || input.value && input.value !== autoName) return;
    input.value = autoName = themeName;
  }
  function syncControls() {
    const savedIndex = savedSchemes.findIndex(sameColours);
    if (savedIndex >= 0 && savedSchemes[savedIndex].name !== themeName) rememberTheme(savedSchemes[savedIndex].name);
    syncThemeName();
    for (const input of panel.querySelectorAll('input[name=skin]')) input.checked = input.value === state.skin;
    $('appearance-scheme').value = savedIndex >= 0 ? 'saved:' + savedIndex : sameColours(normalizeAppearance({preset:state.preset})) ? state.preset : 'custom';
    for (const key of Object.keys(colorFields)) $('color-'+key).value = state.colors[key];
    $('reading-font').value = state.reading.font;
    $('code-font').value = state.reading.codeFont;
    $('line-numbers').value = state.reading.lineNumbers;
    $('line-number-color').value = state.reading.lineNumberColor || state.colors.muted;
    $('line-number-reset').disabled = state.reading.lineNumberColor === null;
    $('table-borders').value = state.reading.tableBorders;
    $('table-striped').checked = state.reading.tableStriped;
    $('table-editing').value = state.reading.tableEditing;
    $('table-auto-format').checked = state.reading.tableAutoFormat;
    $('table-hover-controls').checked = state.reading.tableHoverControls;
    // The diagram accent applies to the palette that matches the colour scheme.
    const diagrams = state.reading.mermaid, accented = diagrams && state.reading.mermaidPalette === 'scheme';
    $('mermaid-enabled').checked = diagrams; $('mermaid-preview').checked = state.reading.mermaidPreview; $('mermaid-preview').disabled = !diagrams;
    for (const key of Object.keys(mermaidChoices)) {$(mermaidControl(key)).value = state.reading[key]; $(mermaidControl(key)).disabled = !diagrams;}
    $('mermaid-accent').value = state.reading.mermaidAccent || state.colors.accent; $('mermaid-accent').disabled = !accented;
    $('mermaid-accent-reset').disabled = !accented || state.reading.mermaidAccent === null;
    for (const input of panel.querySelectorAll('[data-graph-option]')) input.checked = state.reading[input.dataset.graphOption];
    $('highlight-color').value = state.reading.highlightColor;
    $('spell-color').value = state.reading.spellColor; $('spell-style').value = state.reading.spellStyle;
    $('titlebar-tabs').checked = state.reading.titlebarTabs;
    $('tab-tint').checked = state.reading.tabTint; $('tab-tint-opacity').disabled = !state.reading.tabTint;
    $('reading-limit').checked = state.reading.readableWidth;
    $('reading-width').disabled = !state.reading.readableWidth;
    for (const input of panel.querySelectorAll('[data-reading]')) input.value = state.reading[input.dataset.reading];
    $('reading-size-value').value = state.reading.fontSize+' px';
    $('reading-height-value').value = state.reading.lineHeight.toFixed(2);
    $('reading-weight-value').value = state.reading.fontWeight;
    $('code-spacing-value').value = (state.reading.codeLineSpacing >= 0 ? '+' : '') + state.reading.codeLineSpacing.toFixed(2);
    $('reading-gap-value').value = state.reading.paragraphSpacing.toFixed(2)+' em';
    $('reading-width-value').value = state.reading.width+' px';
    for (const [id,key,unit] of [['code-size','codeFontSize',' px'],['article-indent','articleIndent',' px'],['article-zoom','articleZoom','%'],['line-number-opacity','lineNumberOpacity','%'],['line-number-size','lineNumberSize',' px'],['tab-tint-opacity','tabTintOpacity','%'],['spell-opacity','spellOpacity','%'],['spell-thickness','spellThickness',' px'],['table-padding','tablePadding',' px'],['table-border-width','tableBorderWidth',' px'],['table-header-tint','tableHeaderTint','%']]) $(id+'-value').value = state.reading[key]+unit;
    $('table-border-width').disabled = state.reading.tableBorders === 'none';
    $('reset-article-zoom').disabled = state.reading.articleZoom === 100;
  }
  function apply(save = true) {
    const root = document.documentElement, mode = applyRootAppearance(state, root);
    root.style.setProperty('--reading-weight-stroke',weightStroke(fontFamilies[state.reading.font],state.reading.fontWeight)+'em');
    $('theme').title = ui(mode === 'dark' ? 'Switch to light grey theme' : 'Switch to graphite theme');
    syncControls();
    if (save) {prefs.set('appearance',JSON.stringify(state)); prefs.set('theme',mode);}
    onChange();
  }
  $('appearance-scheme').onchange = event => {
    const scheme = event.target.value.startsWith('saved:') ? savedSchemes[Number(event.target.value.slice(6))] : {preset:event.target.value};
    if (!scheme) return;
    rememberTheme(scheme.name); state = normalizeAppearance({...scheme,reading:state.reading,skin:state.skin}); $('scheme-name').value = autoName = themeName; $('scheme-status').textContent = ''; apply();
  };
  $('save-colour-scheme').onsubmit = event => {
    event.preventDefault();
    try {
      savedSchemes = saveColourScheme(savedSchemes, $('scheme-name').value, state); rememberTheme($('scheme-name').value.trim()); autoName = $('scheme-name').value;
      prefs.set('appearance-schemes', JSON.stringify(savedSchemes)); renderSavedSchemes(); syncControls();
      $('scheme-status').textContent = ui('Colour scheme saved. Select it above to reload these colours.');
    } catch (error) {$('scheme-status').textContent = ui(error.message);}
  };
  for (const input of panel.querySelectorAll('[data-color],[data-reading]')) input.addEventListener('input',()=>{
    if (input.dataset.color) state.colors[input.dataset.color] = input.value;
    else if (input.dataset.reading) state.reading[input.dataset.reading] = Number(input.value);
    state = normalizeAppearance(state); apply();
  });
  $('reading-font').onchange = event => {state.reading.font = event.target.value; apply();};
  $('code-font').onchange = event => {state.reading.codeFont = event.target.value; apply();};
  $('line-numbers').onchange = event => {state.reading.lineNumbers = event.target.value; apply();};
  $('line-number-color').oninput = event => {state.reading.lineNumberColor = event.target.value; apply();};
  $('line-number-reset').onclick = () => {state.reading.lineNumberColor = null; apply();};
  $('table-borders').onchange = event => {state.reading.tableBorders = event.target.value; apply();};
  $('table-striped').onchange = event => {state.reading.tableStriped = event.target.checked; apply();};
  $('table-editing').onchange = event => {state.reading.tableEditing = event.target.value; apply();};
  $('table-auto-format').onchange = event => {state.reading.tableAutoFormat = event.target.checked; apply();};
  $('table-hover-controls').onchange = event => {state.reading.tableHoverControls = event.target.checked; apply();};
  $('mermaid-enabled').onchange = event => {state.reading.mermaid = event.target.checked; apply();};
  $('mermaid-preview').onchange = event => {state.reading.mermaidPreview = event.target.checked; apply();};
  for (const key of Object.keys(mermaidChoices)) $(mermaidControl(key)).onchange = event => {state.reading[key] = event.target.value; apply();};
  $('mermaid-accent').oninput = event => {state.reading.mermaidAccent = event.target.value.toLowerCase(); apply();};
  $('mermaid-accent-reset').onclick = () => {state.reading.mermaidAccent = null; apply();};
  $('tab-tint').onchange = event => {state.reading.tabTint = event.target.checked; apply();};
  $('titlebar-tabs').onchange = event => {state.reading.titlebarTabs = event.target.checked; apply();};
  $('highlight-color').oninput = event => {state.reading.highlightColor = event.target.value; apply();};
  $('spell-color').oninput = event => {state.reading.spellColor = event.target.value; apply();};
  $('spell-style').onchange = event => {state.reading.spellStyle = event.target.value; apply();};
  for (const input of panel.querySelectorAll('[data-graph-option]')) input.onchange = () => {state.reading[input.dataset.graphOption] = input.checked; apply();};
  $('file-labels').value = prefs.get('file-labels') || 'title-first';
  $('file-labels').onchange = () => {prefs.set('file-labels',$('file-labels').value); onFileLabelsChange();};
  $('right-align-file-labels').checked = prefs.get('right-align-file-labels') !== 'false';
  const alignLabels = () => document.body.classList.toggle('file-labels-right',$('right-align-file-labels').checked);
  $('right-align-file-labels').onchange = () => {prefs.set('right-align-file-labels',String($('right-align-file-labels').checked)); alignLabels();};
  alignLabels();
  for (const input of panel.querySelectorAll('input[name=skin]')) input.onchange = () => {if (input.checked) {state.skin = normalizeSkin(input.value); apply();}};
  $('reading-limit').onchange = event => {state.reading.readableWidth = event.target.checked; apply();};
  $('reset-colors').onclick = () => {state = normalizeAppearance({preset:state.preset,reading:state.reading,skin:state.skin}); apply();};
  $('reset-appearance').onclick = () => {state = normalizeAppearance(); apply();};
  $('theme').onclick = () => {state = normalizeAppearance({preset:schemes[state.preset].mode === 'dark' ? 'grey' : 'graphite',reading:state.reading,skin:state.skin}); apply();};
  const setZoom = value => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return state.reading.articleZoom;
    state.reading.articleZoom = Math.min(200,Math.max(50,value)); apply(); return state.reading.articleZoom;
  };
  $('reset-article-zoom').onclick = () => setZoom(100);
  renderSavedSchemes(); apply(false);
  const setHighlightColor = color => {if (/^#[0-9a-f]{6}$/i.test(color)) {state.reading.highlightColor = color.toLowerCase(); apply();} return state.reading.highlightColor;};
  const setSkin = skin => {state.skin = normalizeSkin(skin); apply(); return state.skin;};
  return {setZoom,setHighlightColor,setSkin,get skin() {return state.skin;},get highlightColor() {return state.reading.highlightColor;},zoomBy(direction) {return typeof direction === 'number' && Number.isFinite(direction) && direction ? setZoom(state.reading.articleZoom+Math.sign(direction)*10) : state.reading.articleZoom;},get zoom() {return state.reading.articleZoom;}};
}
