// Spell checking with nspell (a JavaScript Hunspell implementation) and the
// SCOWL-based Hunspell dictionaries from dictionary-en / dictionary-en-gb.
import nspell from 'nspell';

const WORD = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;

/** Words worth checking in a stretch of prose, with their document offsets.
 * Acronyms, mixed-case identifiers and words joined to digits, paths, e-mail
 * addresses or identifiers are left alone. */
export function checkableWords(text, offset = 0) {
  const words = [];
  for (const match of text.matchAll(WORD)) {
    const word = match[0], before = text[match.index - 1] || '', after = text[match.index + word.length] || '';
    if (word.length < 2 || /[\d_@/\\.:#$%&=+~]/.test(before)) continue;
    if (/[\d_@/\\]/.test(after) || /[.:]/.test(after) && /[\p{L}\d]/u.test(text[match.index + word.length + 1] || '')) continue;
    if (word === word.toUpperCase() || /\p{Ll}\p{Lu}/u.test(word)) continue;
    words.push({word, from: offset + match.index, to: offset + match.index + word.length});
  }
  return words;
}

// Optimal string alignment distance: an adjacent swap ("teh" → "the") is one edit.
export function editDistance(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const rows = Array.from({length: a.length + 1}, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
  }
  return rows[a.length][b.length];
}
const shape = word => word === word.toUpperCase() ? 'upper' : word[0] === word[0].toUpperCase() ? 'title' : 'lower';
const reshape = (word, like) => {const kind = shape(like); return kind === 'upper' ? word.toUpperCase() : kind === 'title' ? word[0].toUpperCase() + word.slice(1) : word;};

/** Hunspell suggestions ranked by closeness: fewest edits, then the same first
 * letter, then similar length; ordinary words before proper nouns and acronyms
 * unless the misspelling was capitalized. The word's capitalization is kept. */
export function rankSuggestions(word, candidates, limit = 5) {
  const scored = [...new Set(candidates)].map(candidate => {
    // Names rank after ordinary words for a lower-case slip; acronyms rank last
    // unless the misspelling itself was typed in capitals.
    const proper = candidate !== candidate.toLowerCase() && shape(word) === 'lower', acronym = candidate.length > 1 && candidate === candidate.toUpperCase() && shape(word) !== 'upper';
    // Same letters in another order ("teh" → "the") is the commonest typing slip.
    const sameLetters = [...candidate.toLowerCase()].sort().join('') === [...word.toLowerCase()].sort().join('');
    return {candidate, score: editDistance(word, candidate) * 10 + (candidate[0].toLowerCase() === word[0].toLowerCase() ? 0 : 3) + Math.abs(candidate.length - word.length) + (proper ? 6 : 0) + (acronym ? 8 : 0) - (sameLetters ? 2 : 0)};
  }).sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate));
  return [...new Set(scored.map(({candidate}) => candidate === candidate.toLowerCase() ? reshape(candidate, word) : candidate))].slice(0, limit);
}

export function createSpellChecker({aff, dic}) {
  const dictionary = nspell(aff, dic), cache = new Map();
  const normal = word => word.replace(/’/g, "'");
  return {
    correct(word) {
      word = normal(word);
      if (cache.has(word)) return cache.get(word);
      // Possessives: accept "Weave's" when "Weave" is a word.
      const ok = dictionary.correct(word) || /'s$/i.test(word) && dictionary.correct(word.slice(0, -2));
      if (cache.size > 50000) cache.clear();
      cache.set(word, ok); return ok;
    },
    suggestions(word, limit = 5) {return rankSuggestions(word, dictionary.suggest(normal(word)), limit);},
  };
}
