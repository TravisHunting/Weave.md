// Quotation marks preserve phrases; highlighting uses their literal content.
export function lexicalSearchQuery(value) {
  return String(value ?? '').slice(0, 1000).replace(/[“”]/g, '"').replace(/\s+/gu, ' ').trim();
}

export function literalSearchQuery(value) {
  let query = lexicalSearchQuery(value);
  while (query.length > 1 && query.startsWith('"') && query.endsWith('"') && !query.slice(1, -1).includes('"')) query = query.slice(1, -1).trim();
  return query;
}

export const searchHighlightQuery = literalSearchQuery;

export function lexicalQueryTerms(value) {
  const positive = [], negative = [];
  for (const match of lexicalSearchQuery(value).matchAll(/(-?)(?:"([^"]*)"?|([^\s"]+))/gu)) {
    const term = (match[2] ?? match[3] ?? '').trim().toLowerCase();
    if (term) (match[1] ? negative : positive).push(term);
  }
  return {positive, negative};
}
