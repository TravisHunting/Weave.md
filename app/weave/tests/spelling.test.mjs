import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {englishVariant, localizeText} from '../locale.mjs';
import {checkableWords, editDistance, rankSuggestions, createSpellChecker} from '../spellcheck.mjs';

const dictionary = name => {const dir = path.resolve(import.meta.dirname, '../../../node_modules', name); return {aff: fs.readFileSync(path.join(dir, 'index.aff'), 'utf8'), dic: fs.readFileSync(path.join(dir, 'index.dic'), 'utf8')};};

test('the system English variant chooses American or British spelling', () => {
  assert.equal(englishVariant(['en-US']), 'en-US');
  assert.equal(englishVariant(['en']), 'en-US');
  for (const tag of ['en-GB', 'en-NZ', 'en-AU', 'en-IE', 'en-CA']) assert.equal(englishVariant([tag]), 'en-GB');
  assert.equal(englishVariant(['fr-FR', 'en-US']), 'en-US', 'the first English preference counts');
  assert.equal(englishVariant(['de-DE']), 'en-GB');
});

test('interface text follows the variant, keeping case and whole words', () => {
  assert.equal(localizeText('Colours and Themes', 'en-US'), 'Colors and Themes');
  assert.equal(localizeText('Light grey · Minimize · CENTRE', 'en-US'), 'Light gray · Minimize · CENTER');
  assert.equal(localizeText('Minimize the colors', 'en-GB'), 'Minimise the colours');
  assert.equal(localizeText('Greyhound colourful', 'en-US'), 'Greyhound colourful', 'only whole listed words change');
});

test('only prose words are checked', () => {
  const words = checkableWords('Teh API uses getValue in file.md, v2beta and user@example.com; well-known it\'s');
  assert.deepEqual(words.map(w => w.word), ['Teh', 'uses', 'in', 'and', 'well', 'known', "it's"]);
  assert.deepEqual(checkableWords('a recieve', 10)[0], {word: 'recieve', from: 12, to: 19});
});

test('suggestions put the closest correction first and keep capitalization', () => {
  assert.equal(editDistance('teh', 'the'), 1);
  const ranked = rankSuggestions('teh', ['ten', 'eh', 'tea', 'the', 'Th', 'NEH']);
  assert.equal(ranked[0], 'the'); assert(ranked.indexOf('NEH') < 0 || ranked.indexOf('NEH') > ranked.indexOf('ten'), 'acronyms come after ordinary words');
  assert.equal(rankSuggestions('Teh', ['ten', 'the'])[0], 'The');
  assert.deepEqual(rankSuggestions('Thh', ['THC', 'the', 'tho', 'thu']).at(-1), 'THC', 'acronyms come last for a title-case slip');
  assert.equal(rankSuggestions('THH', ['THC', 'the'])[0], 'THC');
});

test('British and American dictionaries disagree where they should', () => {
  const us = createSpellChecker(dictionary('dictionary-en')), gb = createSpellChecker(dictionary('dictionary-en-gb'));
  assert(us.correct('color') && !us.correct('colour') && gb.correct('colour') && !gb.correct('color'));
  assert(us.correct('organize') && gb.correct('organise'));
  assert(!us.correct('recieve'));
  assert.equal(us.suggestions('recieve')[0], 'receive');
  assert.equal(gb.suggestions('teh')[0], 'the');
  assert(us.correct("article's"), 'possessives of known words are accepted');
});
