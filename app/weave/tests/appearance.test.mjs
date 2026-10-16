import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAppearance,normalizeSavedSchemes,saveColourScheme,readingDefaults,schemes,colorFields,fontFamilies,codeFontFamilies} from '../appearance.mjs';

test('appearance defaults to Aurora Flow and Lavender without relying on the OS theme',()=>{
  const settings=normalizeAppearance();
  assert.equal(settings.preset,'lavender');assert.equal(schemes[settings.preset].mode,'light');
  assert.deepEqual(settings.reading,readingDefaults);assert.equal(settings.skin,'aurora-flow');
  assert.deepEqual(Object.values(settings.colors),schemes.lavender.colors);
});
test('appearance validates persisted colors, font choices and bounded reading values',()=>{
  const settings=normalizeAppearance({preset:'ocean',colors:{ink:'#abcdef',paper:'url(https://bad.test)',bg:'red'},reading:{fontSize:999,lineHeight:0,paragraphSpacing:Infinity,font:'url(bad)',width:-5,readableWidth:true}});
  assert.equal(settings.colors.ink,'#abcdef');assert.equal(settings.colors.paper,schemes.ocean.colors[1]);
  assert.equal(settings.reading.fontSize,28);assert.equal(settings.reading.lineHeight,1.2);assert.equal(settings.reading.paragraphSpacing,0);assert.equal(settings.reading.width,560);assert.equal(settings.reading.font,'system');assert.equal(settings.reading.readableWidth,true);
  assert.equal(normalizeAppearance({preset:'toString'}).preset,'lavender');
  for(const scheme of Object.values(schemes)){assert.equal(scheme.colors.length,Object.keys(colorFields).length);assert(scheme.colors.every(color=>/^#[a-f0-9]{6}$/.test(color)));}
});

test('named colour schemes round-trip separately from reading preferences and update by name',()=>{
  const appearance = normalizeAppearance({preset:'ocean',colors:{accent:'#2468ab'},reading:{fontSize:24}});
  const saved = saveColourScheme([], '  Evening notes  ', appearance);
  assert.equal(saved[0].name,'Evening notes'); assert.equal(saved[0].preset,'ocean');
  assert.equal(saved[0].colors.accent,'#2468ab'); assert.equal(saved[0].reading,undefined);
  assert.deepEqual(normalizeSavedSchemes(JSON.parse(JSON.stringify(saved))),saved);
  const updated = saveColourScheme(saved,'evening notes',{...appearance,colors:{...appearance.colors,accent:'#123456'}});
  assert.equal(updated.length,1); assert.equal(updated[0].colors.accent,'#123456'); assert.equal(saved[0].colors.accent,'#2468ab');
  assert.throws(()=>saveColourScheme(saved,' ',appearance),/Enter a name for this theme/);
});

test('primary and code fonts are independent, persisted and restricted to local font stacks',()=>{
  const selected=normalizeAppearance({reading:{font:'palatino',codeFont:'cascadia'}});
  assert.equal(selected.reading.font,'palatino');assert.equal(selected.reading.codeFont,'cascadia');
  assert.deepEqual(normalizeAppearance(JSON.parse(JSON.stringify(selected))),selected);
  assert.equal(normalizeAppearance({reading:{font:'serif',codeFont:'url(https://invalid.test/font)'}}).reading.codeFont,'cascadiaMono');
  assert(Object.keys(fontFamilies).length>=10);assert(Object.keys(codeFontFamilies).length>=6);
  for(const font of Object.values({...fontFamilies,...codeFontFamilies})) assert(!/url\(/i.test(font));
});

test('code size, line numbers and table choices persist independently with safe limits',()=>{
  const settings=normalizeAppearance({reading:{fontSize:20,codeFontSize:12,lineNumbers:'edit',lineNumberColor:'#2468ab',lineNumberOpacity:35,tablePadding:5,tableBorders:'rows',tableBorderWidth:2,tableHeaderTint:65,tableStriped:true}});
  assert.equal(settings.reading.fontSize,20);assert.equal(settings.reading.codeFontSize,12);
  assert.equal(settings.reading.lineNumbers,'edit');assert.equal(settings.reading.lineNumberColor,'#2468ab');assert.equal(settings.reading.lineNumberOpacity,35);
  assert.equal(settings.reading.tablePadding,5);assert.equal(settings.reading.tableBorders,'rows');assert.equal(settings.reading.tableBorderWidth,2);assert.equal(settings.reading.tableHeaderTint,65);assert.equal(settings.reading.tableStriped,true);
  assert.deepEqual(normalizeAppearance(JSON.parse(JSON.stringify(settings))),settings);
  const invalid=normalizeAppearance({reading:{codeFontSize:999,lineNumbers:'url(bad)',lineNumberColor:'red;display:none',lineNumberOpacity:-10,tablePadding:999,tableBorders:'dashed;position:fixed',tableBorderWidth:-2,tableHeaderTint:1000,tableStriped:'true'}}).reading;
  assert.equal(invalid.codeFontSize,28);assert.equal(invalid.lineNumbers,'both');assert.equal(invalid.lineNumberColor,null);assert.equal(invalid.lineNumberOpacity,0);
  assert.equal(invalid.tablePadding,18);assert.equal(invalid.tableBorders,'grid');assert.equal(invalid.tableBorderWidth,0);assert.equal(invalid.tableHeaderTint,100);assert.equal(invalid.tableStriped,true);
  assert.equal(readingDefaults.codeFont,'cascadiaMono');
  assert.equal(normalizeAppearance({reading:{lineNumbers:'off'}}).reading.lineNumbers,'off','an explicit saved choice overrides the default');
});

test('new defaults preserve explicit table and line-number preferences',()=>{
  const defaults=normalizeAppearance().reading;
  assert.equal(defaults.lineNumberOpacity,50);assert.equal(defaults.tableBorderWidth,2);assert.equal(defaults.tableStriped,true);
  assert.equal(defaults.tableEditing,'visual');assert.equal(defaults.tableAutoFormat,true);assert.equal(defaults.tableHoverControls,true);
  const explicit=normalizeAppearance({reading:{lineNumberOpacity:60,tableBorderWidth:1,tableStriped:false,tableEditing:'source',tableAutoFormat:false,tableHoverControls:false}}).reading;
  assert.equal(explicit.lineNumberOpacity,60);assert.equal(explicit.tableBorderWidth,1);assert.equal(explicit.tableStriped,false);
  assert.equal(explicit.tableEditing,'source');assert.equal(explicit.tableAutoFormat,false);assert.equal(explicit.tableHoverControls,false);
});

test('article zoom and indent persist without changing independent base font sizes',()=>{
  const settings=normalizeAppearance({reading:{fontSize:20,codeFontSize:13,articleZoom:150,articleIndent:80}});
  assert.equal(settings.reading.fontSize,20);assert.equal(settings.reading.codeFontSize,13);assert.equal(settings.reading.articleZoom,150);assert.equal(settings.reading.articleIndent,80);
  assert.deepEqual(normalizeAppearance(JSON.parse(JSON.stringify(settings))),settings);
  const bounded=normalizeAppearance({reading:{articleZoom:900,articleIndent:-10}}).reading;
  assert.equal(bounded.articleZoom,200);assert.equal(bounded.articleIndent,32);
  const invalid=normalizeAppearance({reading:{articleZoom:NaN,articleIndent:'80'}}).reading;
  assert.equal(invalid.articleZoom,100);assert.equal(invalid.articleIndent,40);
});

test('table border and top bar colours belong to schemes and migrate older border colours',()=>{
  assert.equal(normalizeAppearance({preset:'ocean'}).colors.tableBorder,schemes.ocean.colors[9]);
  assert.equal(normalizeAppearance({preset:'ocean'}).colors.titleBar,schemes.ocean.colors[10]);
  const migrated=normalizeAppearance({preset:'ocean',colors:{line:'#123456'}});
  assert.equal(migrated.colors.tableBorder,'#123456');
  const independent=normalizeAppearance({preset:'ocean',colors:{line:'#123456',tableBorder:'#abcdef'}});
  assert.equal(independent.colors.line,'#123456');assert.equal(independent.colors.tableBorder,'#abcdef');
  const [saved]=saveColourScheme([],'Table palette',independent);
  assert.equal(saved.colors.tableBorder,'#abcdef');assert.equal(normalizeSavedSchemes([saved])[0].colors.tableBorder,'#abcdef');
  assert.equal(normalizeAppearance({preset:'ocean',colors:{tableBorder:'url(https://bad.test)'}}).colors.tableBorder,schemes.ocean.colors[9]);
});

test('saved schemes reject unusable records and normalize untrusted persisted colours',()=>{
  const saved = normalizeSavedSchemes([null,{name:5},{name:' '},{name:'My palette',preset:'toString',colors:{ink:'url(https://bad.test)'}},{name:'my palette',preset:'paper'}]);
  assert.equal(saved.length,1);assert.equal(saved[0].preset,'paper');assert.deepEqual(Object.values(saved[0].colors),schemes.paper.colors);
  assert.deepEqual(normalizeSavedSchemes({name:'invalid list'}),[]);
});
