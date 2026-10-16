// Deterministic, realistic Markdown vaults for scale benchmarks. Generated
// libraries are disposable caches: a completed vault is reused when its
// marker matches, so 100k/500k runs do not rewrite hundreds of thousands of files.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const VAULT_VERSION = 2;
const random = seed => () => {seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296;};
const SYLLABLES = ['ka', 'lo', 'mi', 'ne', 'ra', 'to', 'vu', 'shi', 'pe', 'dar', 'kin', 'mor', 'tal', 'ven', 'qui', 'ser', 'bel', 'nor', 'ost', 'gra'];
// Real words at fixed Zipf ranks give broad and selective search terms.
const ANCHORS = {warehouse: 3, pipeline: 8, lineage: 40, reporting: 15, replication: 120, snowflake: 300, latency: 900, kubernetes: 2500};
export const SEARCH_TERMS = {broad: 'warehouse', medium: 'replication', rare: 'kubernetes', phrase: '"warehouse pipeline"', prefix: 'repl*'};
const RELATIONSHIPS = ['depends-on', 'reads-from', 'writes-to', 'hosted-in', 'triggers', 'documents'];
const TYPES = ['Note', 'Concept', 'Runbook', 'System', 'Decision', 'Meeting'];

function vocabulary() {
  const next = random(7), words = [];
  const anchors = new Map(Object.entries(ANCHORS).map(([word, rank]) => [rank, word]));
  for (let i = 0; words.length < 6000; i++) {
    if (anchors.has(words.length)) {words.push(anchors.get(words.length)); continue;}
    const n = 2 + Math.floor(next() * 3); let word = '';
    for (let s = 0; s < n; s++) word += SYLLABLES[Math.floor(next() * SYLLABLES.length)];
    if (!Object.hasOwn(ANCHORS, word)) words.push(word);
  }
  // Zipf (s = 1.05) cumulative weights for word sampling.
  const weights = words.map((_, i) => 1 / Math.pow(i + 1, 1.05)), cdf = []; let sum = 0;
  for (const w of weights) cdf.push(sum += w);
  return {words, cdf, total: sum};
}

/** Folder layout: areas / topics / articles, about `perFolder` articles each. */
export function layout(count) {
  const perFolder = count >= 200000 ? 500 : count >= 20000 ? 100 : 25;
  const folders = Math.max(1, Math.ceil(count / perFolder)), areas = Math.max(1, Math.min(25, Math.ceil(folders / 8)));
  const topicsPerArea = Math.ceil(folders / areas);
  const folder = f => `area-${String(f % areas).padStart(2, '0')}/topic-${String(Math.floor(f / areas)).padStart(3, '0')}`;
  const file = i => {const f = Math.floor(i / perFolder); return `${folder(f)}/${i % 7 === 0 ? `Note ${i}` : `note-${i}`}.md`;};
  return {perFolder, folders, areas, topicsPerArea, folder, file};
}

export function article(i, count, {words, cdf, total}, plan = layout(count)) {
  const next = random(i * 2654435761 + 1);
  const word = () => {const x = next() * total; let lo = 0, hi = cdf.length - 1; while (lo < hi) {const mid = lo + hi >> 1; if (cdf[mid] < x) lo = mid + 1; else hi = mid;} return words[lo];};
  const sentence = n => {const parts = []; for (let k = 0; k < n; k++) parts.push(word()); const s = parts.join(' '); return s[0].toUpperCase() + s.slice(1) + '.';};
  const self = plan.file(i), dir = self.split('/').slice(0, -1);
  const relative = target => {
    const to = target.split('/'); let shared = 0;
    while (shared < dir.length && shared < to.length - 1 && dir[shared] === to[shared]) shared++;
    const result = (shared < dir.length ? '../'.repeat(dir.length - shared) : './') + to.slice(shared).join('/');
    return /[ ()<>]/.test(result) ? `<${result}>` : result;
  };
  const title = `${sentence(3).slice(0, -1)} ${i}`, tags = [word(), word(), word()];
  const lines = [];
  if (next() < 0.7) {
    lines.push('---', `type: ${TYPES[i % TYPES.length]}`, `title: ${title}`, `description: ${sentence(10)}`, 'tags:', ...tags.map(t => `  - ${t}`), `created_at: 2025-0${1 + i % 9}-1${i % 9}T09:00:00+12:00`);
    // About 1% of articles are cards on their area's board.
    if (i % 100 === 1) lines.push('weave:', '  kanban:', `    board: board-${self.split('/')[0]}.md`, `    column: ${['todo', 'doing', 'done'][i % 3]}`, `    rank: ${i}`);
    lines.push('---');
  }
  lines.push(`# ${title}`, '');
  const paragraphs = 3 + Math.floor(next() * 7);
  const linkCount = 2 + Math.floor(next() * 6);
  const links = [];
  for (let k = 0; k < linkCount; k++) {
    const roll = next(); let target;
    if (roll < 0.6) target = plan.file(Math.max(0, Math.min(count - 1, i - (i % plan.perFolder) + Math.floor(next() * plan.perFolder))));
    else if (roll < 0.93) target = plan.file(Math.floor(next() * count));
    else if (roll < 0.97) {links.push(`[missing](./missing-${i}-${k}.md)`); continue;}
    else {const t = plan.file(Math.floor(next() * count)); links.push(`[bare](${t.split('/').at(-1).replaceAll(' ', '%20')})`); continue;}
    const typed = next() < 0.35 ? ` "${RELATIONSHIPS[Math.floor(next() * RELATIONSHIPS.length)]}"` : '';
    links.push(`[${sentence(2).slice(0, -1)}](${relative(target)}${typed})`);
  }
  for (let p = 0; p < paragraphs; p++) {
    const parts = [];
    for (let s = 0, n = 2 + Math.floor(next() * 4); s < n; s++) parts.push(sentence(6 + Math.floor(next() * 12)));
    if (links.length && next() < 0.8) parts.splice(Math.floor(next() * parts.length), 0, 'See ' + links.shift() + '.');
    lines.push(parts.join(' '), '');
    if (p === 1 && next() < 0.1) lines.push('```sql', `SELECT * FROM table_${i} WHERE id = ${i};`, '```', '');
  }
  if (links.length) lines.push('Related: ' + links.join(', ') + '.', '');
  lines.push(`Unique marker uniqdoc${i}.`, '', `Tags: ${tags.join(', ')}`, '');
  return lines.join('\n');
}

function board(area) {
  return ['---', 'type: Kanban Board', `title: Board ${area}`, 'weave:', '  kanban:', '    columns:', '      - id: todo', '        title: To do', '      - id: doing', '        title: Doing', '      - id: done', '        title: Done', '---', `# Board ${area}`, ''].join('\n');
}

/** Creates (or reuses) a vault of `count` articles under `directory`. */
export async function ensureVault(directory, count, {log = () => {}} = {}) {
  const marker = path.join(directory, '.scale-vault.json'), expected = JSON.stringify({version: VAULT_VERSION, count});
  try {if (fs.readFileSync(marker, 'utf8') === expected) return {directory, reused: true};} catch {}
  await fsp.rm(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  const plan = layout(count), vocab = vocabulary(), started = performance.now();
  const created = new Set();
  for (let f = 0; f < plan.folders; f++) {const d = path.join(directory, plan.folder(f)); if (!created.has(d)) {fs.mkdirSync(d, {recursive: true}); created.add(d);}}
  for (let a = 0; a < plan.areas; a++) {const area = `area-${String(a).padStart(2, '0')}`; fs.writeFileSync(path.join(directory, area, `board-${area}.md`), board(area));}
  let written = 0, bytes = 0;
  const worker = async () => {
    while (written < count) {
      const i = written++, text = article(i, count, vocab, plan); bytes += Buffer.byteLength(text);
      await fsp.writeFile(path.join(directory, plan.file(i)), text);
      if (i % 20000 === 0) log(`  wrote ${i.toLocaleString()} / ${count.toLocaleString()} articles`);
    }
  };
  await Promise.all(Array.from({length: 48}, worker));
  // A few non-Markdown files, as real libraries have attachments.
  for (let a = 0; a < plan.areas; a++) fs.writeFileSync(path.join(directory, `area-${String(a).padStart(2, '0')}`, 'diagram.png'), Buffer.alloc(64));
  fs.writeFileSync(marker, expected);
  log(`  generated ${count.toLocaleString()} articles (${(bytes / 1048576).toFixed(0)} MB) in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  return {directory, reused: false, bytes};
}
export const vaultFile = (count, i) => layout(count).file(i);
